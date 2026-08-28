import {
    Call, IREGISTRY, Manifest, ZERO, decode, isZeroHex, lc, loadManifest,
    multicall, provider, readChainPaths, sendTx, signer,
} from "./utils/registry";

// Dry run by default. SYNC_EXECUTE=1 sends the transactions.
const EXECUTE = process.env.SYNC_EXECUTE === "1";

interface Op { kind: string; what: string; data: string }

async function main() {
    const m: Manifest = loadManifest();
    // In execute mode reads must come from the same node that will receive the
    // writes, so the RPC override is ignored.
    const p = provider();
    const sym = (t: string) => m.tokens[lc(t)] ?? t.slice(0, 8);
    const ops: Op[] = [];

    // ---------- dexes (must precede setPath: the registry rejects unknown dexes) ----------
    const head = await multicall(p, [
        { target: m.registry, data: IREGISTRY.encodeFunctionData("getAllDexes") },
        { target: m.registry, data: IREGISTRY.encodeFunctionData("getAllIntermediateTokens") },
        { target: m.registry, data: IREGISTRY.encodeFunctionData("owner") },
    ]);
    const chainDexes = (decode<string[]>(IREGISTRY, "getAllDexes", head[0]) ?? []).map(lc);
    const chainInter = (decode<string[]>(IREGISTRY, "getAllIntermediateTokens", head[1]) ?? []).map(lc);
    const owner = lc(decode<string>(IREGISTRY, "owner", head[2]) ?? ZERO);

    const addrCalls: Call[] = chainDexes.map((h) => ({
        target: m.registry, data: IREGISTRY.encodeFunctionData("dexesInfo", [h]),
    }));
    const addrRes = await multicall(p, addrCalls);
    const chainDexAddr = new Map<string, string>();
    chainDexes.forEach((h, i) => chainDexAddr.set(h, lc(decode<string>(IREGISTRY, "dexesInfo", addrRes[i]) ?? ZERO)));

    for (const d of m.dexes) {
        const on = chainDexAddr.get(lc(d.hex));
        if (on === undefined || isZeroHex(on))
            ops.push({
                kind: "addDex", what: `${d.name} -> ${d.address}`,
                data: IREGISTRY.encodeFunctionData("addDex", [d.hex, d.address]),
            });
        else if (on !== lc(d.address))
            ops.push({
                kind: "changeDexAddress", what: `${d.name} ${on} -> ${d.address}`,
                data: IREGISTRY.encodeFunctionData("changeDexAddress", [d.hex, d.address]),
            });
    }

    // ---------- intermediate tokens (whole array is replaced; order is routing) ----------
    const wantInter = m.intermediateTokens.map(lc);
    if (chainInter.join(",") !== wantInter.join(","))
        ops.push({
            kind: "setIntermediateToken",
            what: `[${chainInter.map(sym).join(", ")}] -> [${wantInter.map(sym).join(", ")}]`,
            data: IREGISTRY.encodeFunctionData("setIntermediateToken", [wantInter]),
        });

    // ---------- paths ----------
    const { diffs, extra } = await readChainPaths(p, m);
    const byName = new Map(m.dexes.map((d) => [d.name, d]));
    for (const d of diffs) {
        if (d.status === "ok") continue;
        const dex = byName.get(d.entry.dex);
        if (!dex) { console.log(`skipping ${d.entry.symbols}: unknown dex "${d.entry.dex}"`); continue; }
        const reason = d.status === "missing" ? "not on chain"
            : d.status === "dexMismatch" ? `chain uses a different dex`
            : `chain route is ${(d.chainRoute ?? []).map(sym).join(" > ") || "unresolvable"}`;
        ops.push({
            kind: "setPath", what: `${d.entry.symbols} [${d.entry.dex}] (${reason})`,
            data: IREGISTRY.encodeFunctionData("setPath", [dex.hex, d.entry.path]),
        });
    }

    // ---------- report ----------
    console.log(`registry ${m.registry} @ block ${await p.getBlockNumber()}`);
    console.log(`owner ${owner}\n`);

    if (extra.length) {
        console.log(`${extra.length} path(s) on chain that the manifest does not list.`);
        console.log("The registry has no removePath, so these can only be repointed or adopted:");
        for (const e of extra.slice(0, 20)) {
            const name = m.dexes.find((x) => lc(x.hex) === e.dexHex)?.name ?? e.dexHex;
            console.log(`  - ${sym(e.sellToken)} > ${sym(e.buyToken)} [${name}]`);
        }
        if (extra.length > 20) console.log(`  ... and ${extra.length - 20} more`);
        console.log("");
    }

    if (!ops.length) { console.log("chain already matches the manifest, nothing to do"); return; }

    console.log(`${ops.length} transaction(s) to converge the chain to the manifest:\n`);
    ops.forEach((o, i) => {
        console.log(`${String(i + 1).padStart(3)}. ${o.kind}  ${o.what}`);
        console.log(`     to   ${m.registry}`);
        console.log(`     data ${o.data}`);
    });

    if (!EXECUTE) { console.log("\ndry run — set SYNC_EXECUTE=1 to send"); return; }

    const sender = await signer();
    const senderAddress = await sender.getAddress();
    if (lc(senderAddress) !== owner)
        throw new Error(`signer ${senderAddress} is not the registry owner ${owner}`);

    console.log(`\nsending as ${senderAddress}`);
    for (const [i, o] of ops.entries()) {
        const tx = await sendTx(sender, { to: m.registry, data: o.data });
        const rcpt = await tx.wait();
        console.log(`  ${i + 1}/${ops.length} ${o.kind} ${o.what} -> ${rcpt.transactionHash}`);
    }
    console.log("\ndone — re-run `yarn registry:audit` to confirm");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
