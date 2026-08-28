import { BigNumber, utils } from "ethers";

// Present in the hardhat repos, absent in the Foundry ones.
const deployments: any = (() => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require("../deployments.json");
    } catch {
        return {};
    }
})();
import {
    Call, DexEntry, IAERO_ROUTER, IALGEBRA, IBALANCER_DEX, IBVAULT, IDEX, IERC20, IFACTORY, IREGISTRY,
    Manifest, Res, ZERO, decode, key, lc, loadManifest, multicall, provider, readChainPaths,
} from "./utils/registry";

// AUDIT_STRICT=1 makes warnings fail the run too.
const STRICT = process.env.AUDIT_STRICT === "1";

const IPOOL = new utils.Interface(["function factory() view returns (address)"]);
const ICURVE = new utils.Interface(["function params(address,address) view returns (uint256[5])"]);
const IUL = new utils.Interface(["function pathRegistry() view returns (address)"]);

type Sev = "ERROR" | "WARN";
const findings: { sev: Sev; group: string; msg: string }[] = [];
const report = (sev: Sev, group: string, msg: string) => findings.push({ sev, group, msg });

const isZero = (a?: string) => !a || /^0x0+$/.test(a);
const units = (v: BigNumber, d: number) => Number(utils.formatUnits(v, d));

interface Hop { pathIdx: number; i: number; a: string; b: string; dex: DexEntry; pool?: string; note?: string; ts?: number }

async function main() {
    const p = provider();
    const m: Manifest = loadManifest();
    const sym = (t: string) => m.tokens[lc(t)] ?? t.slice(0, 8);
    const dexByName = new Map(m.dexes.map((d) => [d.name, d]));

    // ---------- wiring ----------
    // A cold-started manifest may not know the UniversalLiquidator yet; that is
    // worth flagging, not worth crashing over.
    const wiringCall = m.universalLiquidator
        ? [{ target: m.universalLiquidator, data: IUL.encodeFunctionData("pathRegistry") }]
        : [];
    const head = await multicall(p, [
        { target: m.registry, data: IREGISTRY.encodeFunctionData("getAllDexes") },
        { target: m.registry, data: IREGISTRY.encodeFunctionData("getAllIntermediateTokens") },
        { target: m.registry, data: IREGISTRY.encodeFunctionData("owner") },
        ...wiringCall,
    ]);
    const chainDexes = (decode<string[]>(IREGISTRY, "getAllDexes", head[0]) ?? []).map(lc);
    const chainInter = (decode<string[]>(IREGISTRY, "getAllIntermediateTokens", head[1]) ?? []).map(lc);
    const owner = lc(decode<string>(IREGISTRY, "owner", head[2]) ?? ZERO);
    if (!m.universalLiquidator) {
        report("WARN", "wiring", "manifest has no universalLiquidator; set UL_ADDRESS and re-seed");
    } else {
        const wired = lc(decode<string>(IUL, "pathRegistry", head[3]) ?? ZERO);
        if (wired !== lc(m.registry))
            report("ERROR", "wiring", `UniversalLiquidator.pathRegistry is ${wired}, manifest registry is ${lc(m.registry)}`);
    }
    if (owner !== lc(m.owner))
        report("ERROR", "wiring", `registry owner is ${owner}, manifest says ${lc(m.owner)}`);

    // Auditing one chain's manifest against another chain's RPC would compare
    // unrelated state and report nonsense, so refuse before doing any of it.
    const chainId = (await p.getNetwork()).chainId;
    if (m.chainId && chainId !== m.chainId)
        report("ERROR", "wiring", `connected to chain ${chainId} but the manifest is for ${m.chainId} (${m.network})`);
    else if (!m.chainId)
        report("WARN", "wiring", "manifest has no chainId; re-seed to record it");

    // ---------- dexes ----------
    const addrs = await multicall(p, chainDexes.map((h) => ({
        target: m.registry, data: IREGISTRY.encodeFunctionData("dexesInfo", [h]),
    })));
    const chainDexAddr = new Map<string, string>();
    chainDexes.forEach((h, i) => chainDexAddr.set(h, lc(decode<string>(IREGISTRY, "dexesInfo", addrs[i]) ?? ZERO)));

    const depByHex = new Map(Object.entries(deployments.Dexes ?? {}).map(([n, d]: [string, any]) => [lc(d.hex), { n, a: lc(d.address) }]));
    for (const d of m.dexes) {
        const onChain = chainDexAddr.get(lc(d.hex));
        if (onChain === undefined) { report("ERROR", "dexes", `${d.name} is in the manifest but not registered on chain`); continue; }
        if (isZero(onChain)) report("ERROR", "dexes", `${d.name} resolves to address(0) — every path using it reverts`);
        else if (onChain !== lc(d.address)) report("ERROR", "dexes", `${d.name} drift: chain ${onChain}, manifest ${lc(d.address)}`);
        // Only meaningful where the repo keeps a deployments.json at all; the
        // Foundry repos do not.
        const dep = depByHex.get(lc(d.hex));
        if (!dep) { if (depByHex.size) report("WARN", "dexes", `${d.name} is not recorded in deployments.json`); }
        else if (dep.a !== onChain) report("WARN", "dexes", `${d.name} deployments.json says ${dep.a}, chain says ${onChain}`);
        if (d.kind === "unknown") report("WARN", "dexes", `${d.name} has kind "unknown" — its hops cannot be checked`);
    }
    for (const h of chainDexes)
        if (!m.dexes.some((d) => lc(d.hex) === h))
            report("ERROR", "dexes", `${h} is registered on chain but missing from the manifest`);

    // ---------- intermediate tokens (order decides routing) ----------
    const wantI = m.intermediateTokens.map(lc);
    if (chainInter.join(",") !== wantI.join(","))
        report("ERROR", "intermediates",
            `chain [${chainInter.map(sym).join(", ")}] != manifest [${wantI.map(sym).join(", ")}] (order is significant)`);

    // ---------- manifest self-consistency ----------
    // setPath keys off path[0]/path[last], so a hand-edited array that disagrees
    // with sellToken/buyToken would be written under a different pair entirely.
    for (const x of m.paths) {
        if (lc(x.path[0]) !== lc(x.sellToken) || lc(x.path[x.path.length - 1]) !== lc(x.buyToken))
            report("ERROR", "manifest",
                `${x.symbols}: path ends (${sym(x.path[0])}, ${sym(x.path[x.path.length - 1])}) do not match sellToken/buyToken (${sym(x.sellToken)}, ${sym(x.buyToken)})`);
        if (x.path.length < 2)
            report("ERROR", "manifest", `${x.symbols}: path needs at least 2 tokens`);
        const expected = x.path.map((t) => sym(t)).join(" > ");
        if (x.symbols !== expected)
            report("WARN", "manifest", `symbols "${x.symbols}" is stale, path reads ${expected}`);
        if (!dexByName.has(x.dex))
            report("ERROR", "manifest", `${x.symbols}: unknown dex "${x.dex}"`);
    }

    // ---------- paths: manifest vs chain, and chain vs manifest ----------
    const tokens = Object.keys(m.tokens).map(lc);
    const { diffs, extra } = await readChainPaths(p, m);
    const nameOfHex = (h: string) => m.dexes.find((d) => lc(d.hex) === h)?.name ?? h;

    for (const e of extra)
        report("ERROR", "paths", `on chain but not in manifest: ${sym(e.sellToken)} > ${sym(e.buyToken)} [${nameOfHex(e.dexHex)}]`);

    for (const d of diffs) {
        const x = d.entry;
        if (d.status === "missing") report("ERROR", "paths", `in manifest but not on chain: ${x.symbols} [${x.dex}]`);
        else if (d.status === "dexMismatch")
            report("ERROR", "paths", `${x.symbols}: chain routes via ${nameOfHex(d.chainDexHex!)}, manifest says ${x.dex}`);
        else if (d.status === "routeMismatch")
            report("ERROR", "paths", d.chainRoute
                ? `${x.symbols}: chain route is ${d.chainRoute.map(sym).join(" > ")}`
                : `${x.symbols}: getPath no longer resolves as a direct path`);
    }

    const listed = new Set(m.paths.map((x) => key(x.sellToken, x.buyToken)));
    for (const x of m.paths)
        if (!listed.has(key(x.buyToken, x.sellToken)))
            report("WARN", "one-way", `${sym(x.sellToken)} > ${sym(x.buyToken)} [${x.dex}] has no reverse path`);

    // ---------- hops: resolve every hop to a real pool ----------
    const hops: Hop[] = [];
    m.paths.forEach((x, pathIdx) => {
        const dex = dexByName.get(x.dex);
        if (!dex || dex.kind === "erc4626" || dex.kind === "unknown") return;
        for (let i = 0; i < x.path.length - 1; i++)
            hops.push({ pathIdx, i, a: lc(x.path[i]), b: lc(x.path[i + 1]), dex });
    });

    const paramCalls: Call[] = hops.map((h) => {
        const t = h.dex.address;
        switch (h.dex.kind) {
            case "cl":       return { target: t, data: IDEX.encodeFunctionData("tickSpacing", [h.a, h.b]) };
            case "uniV3":    return { target: t, data: IDEX.encodeFunctionData("pairFee", [h.a, h.b]) };
            case "solidly":  return { target: t, data: IDEX.encodeFunctionData("stable", [h.a, h.b]) };
            case "curve":
            case "balancer": return { target: t, data: IDEX.encodeFunctionData("pool", [h.a, h.b]) };
            // algebra prices dynamically, so there is no per-pair config to read
            case "algebra":  return { target: t, data: IDEX.encodeFunctionData("owner") };
            default:         return { target: t, data: IDEX.encodeFunctionData("router") };
        }
    });
    const extraCalls: Call[] = hops.map((h) => {
        if (h.dex.kind === "solidly") return { target: h.dex.address, data: IDEX.encodeFunctionData("factory", [h.a, h.b]) };
        // CurveDex differs per chain: Base keys nTokens off the pool, mainnet and
        // arbitrum route through Curve's router with a params array, polygon has
        // neither. Ask for params and let whichever exists answer.
        if (h.dex.kind === "curve") return { target: h.dex.address, data: ICURVE.encodeFunctionData("params", [h.a, h.b]) };
        return { target: h.dex.address, data: IDEX.encodeFunctionData("router") };
    });
    const [params, extras] = [await multicall(p, paramCalls), await multicall(p, extraCalls)];

    const unreadable = new Set<Hop>();
    const readable = (r: Res) => r.success && r.data !== "0x";

    const resolveCalls: Call[] = hops.map((h, i) => {
        const r = params[i];
        if (!["univ2", "algebra"].includes(h.dex.kind) && !readable(r)) unreadable.add(h);
        switch (h.dex.kind) {
            case "cl": {
                const ts = decode<number>(IDEX, "tickSpacing", r) ?? 0;
                h.ts = ts;
                h.note = `tickSpacing ${ts}`;
                if (!ts) return { target: h.dex.address, data: IDEX.encodeFunctionData("router") };
                return { target: h.dex.poolFactory!, data: IFACTORY.encodeFunctionData("getPool(address,address,int24)", [h.a, h.b, ts]) };
            }
            case "uniV3": {
                const fee = decode<number>(IDEX, "pairFee", r) ?? h.dex.defaultFee!;
                h.note = `fee ${fee}`;
                return { target: h.dex.poolFactory!, data: IFACTORY.encodeFunctionData("getPool(address,address,uint24)", [h.a, h.b, fee]) };
            }
            case "univ2":
                return { target: h.dex.poolFactory!, data: IFACTORY.encodeFunctionData("getPair", [h.a, h.b]) };
            case "algebra":
                h.note = "dynamic fee";
                return { target: h.dex.poolFactory!, data: IALGEBRA.encodeFunctionData("poolByPair", [h.a, h.b]) };
            case "solidly": {
                const stable = decode<boolean>(IDEX, "stable", r) ?? false;
                // factory(0) is legitimate: the Aerodrome router falls back to its default factory.
                const factory = decode<string>(IDEX, "factory", extras[i]) ?? ZERO;
                h.note = `stable ${stable}`;
                return { target: h.dex.router!, data: IAERO_ROUTER.encodeFunctionData("poolFor", [h.a, h.b, stable, factory]) };
            }
            case "curve": {
                const pool = decode<string>(IDEX, "pool", r) ?? ZERO;
                h.pool = lc(pool);
                return { target: h.dex.address, data: IDEX.encodeFunctionData("nTokens", [pool]) };
            }
            case "balancer": {
                const id = decode<string>(IBALANCER_DEX, "pool", r);
                h.note = id;
                return { target: h.dex.vault!, data: IBVAULT.encodeFunctionData("getPoolTokens", [id ?? utils.hexZeroPad("0x", 32)]) };
            }
            default:
                return { target: h.dex.address, data: IDEX.encodeFunctionData("router") };
        }
    });
    const resolved = await multicall(p, resolveCalls);

    const bad = (h: Hop, why: string) =>
        report("ERROR", "hops", `${m.paths[h.pathIdx].symbols} [${h.dex.name}] hop${h.i} ${sym(h.a)}/${sym(h.b)}: ${why}`);

    const balCalls: Call[] = [];
    const balOf: { hop: Hop; token: string; idx: number }[] = [];
    hops.forEach((h, i) => {
        const r = resolved[i];
        if (unreadable.has(h))
            return bad(h, `cannot read pair config from ${h.dex.name} at ${h.dex.address}`);
        if (h.dex.kind === "curve") {
            if (isZero(h.pool)) return bad(h, "pool not set");
            // Only judge a variant's config when that variant actually has it: a
            // reverting getter means this chain's CurveDex does not use it.
            if (r.success && r.data !== "0x" && !decode<BigNumber>(IDEX, "nTokens", r)?.gt(0))
                return bad(h, `nTokens not set for pool ${h.pool}`);
            const px = extras[i];
            if (px.success && px.data !== "0x") {
                const arr = decode<BigNumber[]>(ICURVE, "params", px);
                if (arr && arr.every((v) => v.isZero())) return bad(h, `params not set for ${sym(h.a)}/${sym(h.b)}`);
            }
        } else if (h.dex.kind === "balancer") {
            if (!h.note || isZero(h.note)) return bad(h, "poolId not set");
            if (!r.success) return bad(h, `poolId ${h.note} is not registered in the vault`);
            return; // vault balances are read below from getPoolTokens
        } else if (h.dex.kind === "cl" && !h.ts) {
            return bad(h, "tickSpacing not set (0)");
        } else {
            const pool = decode<string>(IFACTORY, "getPair", r);
            if (isZero(pool)) return bad(h, `no pool (${h.note})`);
            h.pool = lc(pool!);
        }
        for (const t of [h.a, h.b]) {
            balOf.push({ hop: h, token: t, idx: balCalls.length });
            balCalls.push({ target: t, data: IERC20.encodeFunctionData("balanceOf", [h.pool!]) });
        }
        // factory() is a reliable "was this deployed" probe on AMM pools, but not
        // on Curve pools, which mostly do not expose it. There, an address that
        // holds none of either token is the signal instead.
        if (h.dex.kind !== "curve") {
            balOf.push({ hop: h, token: "", idx: balCalls.length });
            balCalls.push({ target: h.pool!, data: IPOOL.encodeFunctionData("factory") });
        }
    });
    const bals = await multicall(p, balCalls);

    const decCalls = tokens.map((t) => ({ target: t, data: IERC20.encodeFunctionData("decimals") }));
    const decs = await multicall(p, decCalls);
    const DEC = new Map<string, number>();
    tokens.forEach((t, i) => DEC.set(t, decode<number>(IERC20, "decimals", decs[i]) ?? 18));

    const seen = new Set<Hop>();
    const held = new Map<Hop, boolean>();
    for (const { hop, token, idx } of balOf) {
        if (token === "") {
            const probe = bals[idx];
            if ((!probe.success || probe.data === "0x") && !seen.has(hop)) {
                seen.add(hop);
                bad(hop, `resolved pool ${hop.pool} has no code (${hop.note})`);
            }
            continue;
        }
        const raw = decode<BigNumber>(IERC20, "balanceOf", bals[idx]);
        if (raw?.gt(0)) held.set(hop, true);
        const floor = m.minLiquidity[token];
        if (!floor) continue;
        if (!raw) continue;
        const have = units(raw, DEC.get(token) ?? 18);
        if (have < Number(floor))
            report("WARN", "liquidity",
                `${m.paths[hop.pathIdx].symbols} [${hop.dex.name}] hop${hop.i} ${sym(hop.a)}/${sym(hop.b)}: pool holds ${have.toFixed(4)} ${sym(token)} (floor ${floor})`);
    }

    for (const h of hops)
        if (h.dex.kind === "curve" && h.pool && !isZero(h.pool) && !held.get(h))
            bad(h, `pool ${h.pool} holds none of ${sym(h.a)} or ${sym(h.b)}`);

    for (const h of hops)
        if (h.dex.kind === "uniV3" && h.note === `fee ${h.dex.defaultFee}`)
            report("WARN", "implicit-fee",
                `${m.paths[h.pathIdx].symbols} hop${h.i} ${sym(h.a)}/${sym(h.b)} uses fee ${h.dex.defaultFee} — indistinguishable from unset`);

    // ---------- output ----------
    const errors = findings.filter((f) => f.sev === "ERROR");
    const warns = findings.filter((f) => f.sev === "WARN");
    console.log(`registry ${m.registry} @ block ${await p.getBlockNumber()}`);
    console.log(`  ${m.dexes.length} dexes | ${m.paths.length} paths | ${hops.length} hops | ${tokens.length} tokens\n`);
    for (const sev of ["ERROR", "WARN"] as Sev[]) {
        const list = findings.filter((f) => f.sev === sev);
        const groups = [...new Set(list.map((f) => f.group))];
        for (const g of groups) {
            const items = list.filter((f) => f.group === g);
            console.log(`${sev} ${g} (${items.length})`);
            for (const f of items.slice(0, 40)) console.log(`  - ${f.msg}`);
            if (items.length > 40) console.log(`  ... and ${items.length - 40} more`);
        }
    }
    console.log(`\n${errors.length} error(s), ${warns.length} warning(s)`);
    if (errors.length || (STRICT && warns.length)) process.exitCode = 1;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
