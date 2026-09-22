import { BigNumber } from "ethers";
import fs from "fs";

import { utils } from "ethers";

import {
    Call, DexEntry, IDEX, IREGISTRY, Manifest, PROPOSALS, ProposalFile, ProposalHop, Res, Route, ZERO,
    IERC20, buildQuote, curveCoinIndex, decode, errText, lc, loadManifest, multicall, provider, quoteCurve, readQuote, saveManifest, sendTx, signer,
} from "./utils/registry";

const IAERO_DEFAULT = new utils.Interface(["function defaultFactory() view returns (address)"]);

// APPLY_EXECUTE=1   send the transactions (dry run otherwise)
// APPLY_ONLY        comma separated indices or "SELL>BUY" symbols; default all
// APPLY_MIN_BPS     re-check threshold; defaults to the file's own minBps
// APPLY_SKIP_RECHECK=1  apply without re-quoting (not recommended)
const EXECUTE = process.env.APPLY_EXECUTE === "1";
const ONLY = process.env.APPLY_ONLY?.split(",").map((x) => x.trim()).filter(Boolean);
const SKIP_RECHECK = process.env.APPLY_SKIP_RECHECK === "1";

interface Op { kind: string; to: string; data: string; what: string; proposal: number; key?: string }

/** The dex-side pair config a route's hops depend on. */
function configCalls(dex: DexEntry, hops: ProposalHop[]): Call[] {
    const calls: Call[] = [];
    for (const h of hops) {
        if (dex.kind === "uniV3") calls.push({ target: dex.address, data: IDEX.encodeFunctionData("pairFee", [h.from, h.to]) });
        else if (dex.kind === "cl") calls.push({ target: dex.address, data: IDEX.encodeFunctionData("tickSpacing", [h.from, h.to]) });
        else if (dex.kind === "solidly") {
            calls.push({ target: dex.address, data: IDEX.encodeFunctionData("stable", [h.from, h.to]) });
            calls.push({ target: dex.address, data: IDEX.encodeFunctionData("factory", [h.from, h.to]) });
        }
    }
    return calls;
}

interface ConfigOp { kind: string; what: string; key: string; data: string; from: string; to: string }

/**
 * The pair-config changes a route still needs, given the values read with
 * configCalls. Empty means the dex already holds what the route wants, which
 * is also how an already-applied proposal is recognised.
 */
function configOps(
    dex: DexEntry, hops: ProposalHop[], cur: Res[], normFactory: (f: string) => string, sym: (t: string) => string,
): ConfigOp[] {
    const out: ConfigOp[] = [];
    let k = 0;
    for (const h of hops) {
        const label = `${dex.name} ${sym(h.from)}/${sym(h.to)}`;
        const key = `${dex.name}|${lc(h.from)}|${lc(h.to)}`;
        if (dex.kind === "uniV3") {
            const have = Number(decode<any>(IDEX, "pairFee", cur[k++]) ?? 0);
            if (have !== h.fee)
                out.push({ kind: "setFee", what: `${label} ${have} -> ${h.fee}`, key, from: h.from, to: h.to,
                    data: IDEX.encodeFunctionData("setFee", [h.from, h.to, h.fee]) });
        } else if (dex.kind === "cl") {
            const have = Number(decode<any>(IDEX, "tickSpacing", cur[k++]) ?? 0);
            if (have !== h.tickSpacing)
                out.push({ kind: "setTickSpacing", what: `${label} ${have} -> ${h.tickSpacing}`, key, from: h.from, to: h.to,
                    data: IDEX.encodeFunctionData("setTickSpacing", [h.from, h.to, h.tickSpacing]) });
        } else if (dex.kind === "solidly") {
            const haveStable = decode<boolean>(IDEX, "stable", cur[k++]) ?? false;
            const haveFactory = lc(decode<string>(IDEX, "factory", cur[k++]) ?? ZERO);
            if (haveStable !== !!h.stable || normFactory(haveFactory) !== normFactory(h.factory ?? ZERO)) {
                // keep whatever factory the dex already names when it resolves the same
                const factory = normFactory(haveFactory) === normFactory(h.factory ?? ZERO) ? haveFactory : (h.factory ?? ZERO);
                out.push({ kind: "pairSetup", what: `${label} stable ${haveStable} -> ${!!h.stable}`, key, from: h.from, to: h.to,
                    data: IDEX.encodeFunctionData("pairSetup", [h.from, h.to, !!h.stable, factory]) });
            }
        }
    }
    return out;
}

async function main() {
    const file: ProposalFile = JSON.parse(fs.readFileSync(process.env.APPLY_IN ?? PROPOSALS, "utf8"));
    const m: Manifest = loadManifest();
    const p = provider();
    const sym = (t: string) => m.tokens[lc(t)] ?? t.slice(0, 8);
    const byName = new Map(m.dexes.map((d) => [d.name, d]));
    const minBps = Number(process.env.APPLY_MIN_BPS ?? file.minBps);

    if (lc(file.registry) !== lc(m.registry))
        throw new Error(`proposals target ${file.registry}, manifest is ${m.registry}`);

    // factory(0) and the router's defaultFactory select the same pool, so treat
    // them as equal rather than writing a pointless change.
    let defaultFactory = ZERO;
    const aero = m.dexes.find((d) => d.kind === "solidly");
    if (aero?.router) {
        const r = await multicall(p, [{ target: aero.router, data: IAERO_DEFAULT.encodeFunctionData("defaultFactory") }]);
        defaultFactory = lc(decode<string>(IAERO_DEFAULT, "defaultFactory", r[0]) ?? ZERO);
    }
    const normFactory = (f: string) => (lc(f) === ZERO ? defaultFactory : lc(f));

    let chosen = file.proposals.map((pr, i) => ({ pr, i }));
    if (ONLY) chosen = chosen.filter(({ pr, i }) =>
        ONLY.includes(String(i)) || ONLY.includes(`${sym(pr.sellToken)}>${sym(pr.buyToken)}`));

    // Anything already on chain is done: re-running after a partial or failed
    // run should pick up where it stopped, not resend what landed. A proposal
    // can also be pair config alone, on a route that is already registered, so
    // the dex side has to match as well before it counts as applied.
    const already = await multicall(p, chosen.flatMap(({ pr }) => [
        { target: m.registry, data: IREGISTRY.encodeFunctionData("paths", [pr.sellToken, pr.buyToken]) },
        { target: m.registry, data: IREGISTRY.encodeFunctionData("getPath", [pr.sellToken, pr.buyToken]) },
    ]));
    const applied = new Set<number>();
    const sameRoute: { n: number; dex: DexEntry; calls: Call[] }[] = [];
    chosen.forEach(({ pr }, n) => {
        const dex = byName.get(pr.proposed.dex);
        const haveHex = decode<string>(IREGISTRY, "paths", already[n * 2]);
        const legs = decode<any[]>(IREGISTRY, "getPath", already[n * 2 + 1]);
        const route = legs?.length === 1 ? (legs[0].paths as string[]).map(lc) : undefined;
        if (dex?.hex && haveHex && lc(haveHex) === lc(dex.hex)
            && route?.join(",") === pr.proposed.path.map(lc).join(","))
            sameRoute.push({ n, dex, calls: configCalls(dex, pr.proposed.hops) });
    });
    if (sameRoute.length) {
        const cfg = await multicall(p, sameRoute.flatMap((x) => x.calls));
        let at = 0;
        for (const { n, dex, calls } of sameRoute) {
            const cur = cfg.slice(at, at + calls.length);
            at += calls.length;
            if (!configOps(dex, chosen[n].pr.proposed.hops, cur, normFactory, sym).length) applied.add(n);
        }
    }
    if (applied.size) {
        console.log(`${applied.size} proposal(s) already on chain, skipping`);
        chosen = chosen.filter((_, n) => !applied.has(n));
    }

    const unnamed = [...new Set(chosen.flatMap(({ pr }) => pr.proposed.path.map(lc)))].filter((t) => !m.tokens[t]);
    if (unnamed.length) {
        const res = await multicall(p, unnamed.map((t) => ({ target: t, data: IERC20.encodeFunctionData("symbol") })));
        unnamed.forEach((t, i) => { m.tokens[t] = decode<string>(IERC20, "symbol", res[i]) ?? t.slice(0, 8); });
    }

    const age = (await p.getBlockNumber()) - file.generatedAtBlock;
    console.log(`${file.proposals.length} proposal(s) from block ${file.generatedAtBlock} (${age} blocks ago), $${file.usd} swaps`);
    console.log(`applying ${chosen.length}\n`);

    // ---------- re-quote before writing anything ----------
    // Prices move between proposing and applying, so a proposal is only worth
    // acting on if it still wins right now.
    const keep: typeof chosen = [];
    if (SKIP_RECHECK) {
        keep.push(...chosen);
        console.log("re-check skipped\n");
    } else {
        const calls: Call[] = [];
        const meta: { idx: number; which: "cur" | "new"; route: Route; size: BigNumber }[] = [];
        const curveJobs: { idx: number; which: "cur" | "new"; route: Route; amount: BigNumber }[] = [];
        for (const { pr, i } of chosen) {
            const size = BigNumber.from(file.sizes[lc(pr.sellToken)] ?? "0");
            if (size.isZero()) continue;
            const nxt = byName.get(pr.proposed.dex);
            if (!nxt) continue;
            // A proposal for a token with no route yet has no current dex.
            const cur = pr.current.dex ? byName.get(pr.current.dex) : undefined;
            const curRoute = cur ? await routeFromChain(p, cur, pr.current.path.map(lc)) : undefined;
            const newRoute: Route = {
                dex: nxt, tokens: pr.proposed.path.map(lc), label: pr.proposed.symbols,
                poolIds: pr.proposed.hops.map((h) => h.poolId ?? ""),
                pools: pr.proposed.hops.map((h) => h.pool ?? ZERO),
                tiers: pr.proposed.hops.map((h) => h.fee ?? h.tickSpacing ?? 0),
                stable: pr.proposed.hops.map((h) => !!h.stable),
                factories: pr.proposed.hops.map((h) => h.factory ?? ZERO),
            };
            for (const [which, route] of ([["cur", curRoute], ["new", newRoute]] as const)) {
                if (!route) continue;
                if (route.dex.kind === "curve") { curveJobs.push({ idx: i, which, route, amount: size }); continue; }
                const c = buildQuote(route, size);
                if (!c) continue;
                meta.push({ idx: i, which, route, size });
                calls.push(c);
            }
        }
        const res = await multicall(p, calls, 8);
        const now = new Map<number, { cur?: BigNumber; nxt?: BigNumber }>();
        meta.forEach((q, k) => {
            const amt = readQuote(q.route, res[k]);
            const e = now.get(q.idx) ?? {};
            if (q.which === "cur") e.cur = amt; else e.nxt = amt;
            now.set(q.idx, e);
        });
        if (curveJobs.length) {
            const coinIdx = await curveCoinIndex(p, curveJobs.flatMap((j) => j.route.pools ?? []));
            const amts = await quoteCurve(p, curveJobs.map((j) => ({ route: j.route, amount: j.amount })), coinIdx);
            curveJobs.forEach((j, k) => {
                const e = now.get(j.idx) ?? {};
                if (j.which === "cur") e.cur = amts[k]; else e.nxt = amts[k];
                now.set(j.idx, e);
            });
        }

        for (const c of chosen) {
            const e = now.get(c.i);
            // A proposal recorded as replacing a route that does not execute
            // (gainBps -1) has no incumbent quote by definition. Skipping those
            // would refuse to fix exactly the routes that most need fixing.
            if (c.pr.gainBps === -1 || c.pr.gainBps === -2) {
                const kept = c.pr.kept === undefined
                    ? " (value kept was never checked --- the buy token could not be priced)"
                    : ` (keeps ${(c.pr.kept * 100).toFixed(1)}% of value)`;
                const label = (c.pr.gainBps === -2 ? "no route registered yet" : "registered route still does not execute")
                    + (c.pr.gainBps === -2 ? kept : "");
                if (e?.nxt?.gt(0)) {
                    console.log(`  ok   ${sym(c.pr.sellToken)} > ${sym(c.pr.buyToken)}: ${label}, proposed route quotes`);
                    keep.push(c);
                } else {
                    console.log(`  skip ${sym(c.pr.sellToken)} > ${sym(c.pr.buyToken)}: proposed route does not quote`);
                }
                continue;
            }
            if (!e?.cur || !e.nxt || e.cur.isZero()) {
                console.log(`  skip ${sym(c.pr.sellToken)} > ${sym(c.pr.buyToken)}: could not re-quote`);
                continue;
            }
            const gain = e.nxt.sub(e.cur).mul(10_000).div(e.cur).toNumber();
            if (gain < minBps) {
                console.log(`  skip ${sym(c.pr.sellToken)} > ${sym(c.pr.buyToken)}: gain is now ${(gain / 100).toFixed(2)}%, below ${(minBps / 100).toFixed(2)}%`);
                continue;
            }
            console.log(`  ok   ${sym(c.pr.sellToken)} > ${sym(c.pr.buyToken)}: ${(gain / 100).toFixed(2)}% (proposed ${(c.pr.gainBps / 100).toFixed(2)}%)`);
            keep.push(c);
        }
        console.log("");
    }
    if (!keep.length) { console.log("nothing left to apply"); return; }

    // ---------- build ops: dex params first, then the path ----------
    // A dex's pair config is global: pairFee/tickSpacing/stable are keyed only by
    // the token pair. The proposer picks each hop's pool by quoting it at a
    // realistic size, so a change here is an improvement to the hop itself and
    // every other registered path crossing it gets it for free --- no setPath
    // needed for those. They are listed so the win is visible, and because the
    // ranking was taken at one size.
    const usesHop = (dexName: string, a: string, b: string) => m.paths.filter((x) => {
        if (x.dex !== dexName) return false;
        for (let i = 0; i < x.path.length - 1; i++) {
            const [f, t] = [lc(x.path[i]), lc(x.path[i + 1])];
            if ((f === lc(a) && t === lc(b)) || (f === lc(b) && t === lc(a))) return true;
        }
        return false;
    });
    const beingApplied = new Set(keep.map(({ pr }) => `${lc(pr.sellToken)}|${lc(pr.buyToken)}`));
    const alsoImproves: string[] = [];

    const ops: Op[] = [];
    // Several proposals can share a hop, so the same pair-config change would
    // otherwise be queued once per proposal. Queue it once and remember which
    // proposals depend on it, so a failure still skips all of them.
    const queued = new Set<string>();
    const needs = keep.map(() => new Set<string>());
    for (const [pi, { pr }] of keep.entries()) {
        const dex = byName.get(pr.proposed.dex)!;
        const cur = await multicall(p, configCalls(dex, pr.proposed.hops));
        for (const o of configOps(dex, pr.proposed.hops, cur, normFactory, sym)) {
            needs[pi].add(o.key);
            if (queued.has(o.key)) continue;
            queued.add(o.key);
            ops.push({ kind: o.kind, to: dex.address, what: o.what, proposal: pi, key: o.key, data: o.data });
            const others = usesHop(dex.name, o.from, o.to)
                .filter((x) => !beingApplied.has(`${lc(x.sellToken)}|${lc(x.buyToken)}`));
            if (others.length) alsoImproves.push(`${o.what}: also applies to ${others.map((x) => x.symbols).join("; ")}`);
        }
        ops.push({
            kind: "setPath", to: m.registry, what: `${pr.proposed.symbols} [${dex.name}]`, proposal: pi,
            data: IREGISTRY.encodeFunctionData("setPath", [dex.hex, pr.proposed.path]),
        });
    }

    if (alsoImproves.length) {
        console.log(`${alsoImproves.length} pair-config change(s) reach paths beyond the ones being applied.`);
        console.log("Those paths keep their route and pick up the better pool automatically:");
        for (const w of alsoImproves) console.log(`  - ${w}`);
        console.log("  (ranked at one trade size; re-run the proposer afterwards to confirm)\n");
    }

    console.log(`${ops.length} transaction(s):\n`);
    ops.forEach((o, i) => {
        console.log(`${String(i + 1).padStart(3)}. ${o.kind}  ${o.what}`);
        console.log(`     to   ${o.to}`);
        console.log(`     data ${o.data}`);
    });

    if (!EXECUTE) { console.log("\ndry run — set APPLY_EXECUTE=1 to send"); return; }

    const sender = await signer();
    const senderAddress = await sender.getAddress();
    const owners = await multicall(p, [...new Set(ops.map((o) => o.to))].map((t) => ({ target: t, data: IDEX.encodeFunctionData("owner") })));
    for (const [i, t] of [...new Set(ops.map((o) => o.to))].entries()) {
        const owner = lc(decode<string>(IDEX, "owner", owners[i]) ?? ZERO);
        if (owner !== lc(senderAddress)) throw new Error(`signer ${senderAddress} does not own ${t} (owner ${owner})`);
    }

    console.log(`\nsending as ${senderAddress}`);
    const failed: { proposal: number; op: Op; error: string }[] = [];
    const brokenKeys = new Set<string>();
    let sent = 0;
    // A shared pair-config op is queued under the first proposal that wants it,
    // so abandoning that proposal abandons config other proposals are counting
    // on. Whatever it does not send has to be marked broken, or a dependent
    // sees nothing missing and sets a path against params that were never
    // written --- a route that then reverts on every swap while the manifest
    // records it as applied.
    const abandon = (pi: number, from: number) => {
        for (const o of ops.filter((x) => x.proposal === pi).slice(from))
            if (o.key) brokenKeys.add(o.key);
    };
    for (const [pi, { pr }] of keep.entries()) {
        const missing = [...needs[pi]].filter((k) => brokenKeys.has(k));
        if (missing.length) {
            failed.push({ proposal: pi, op: ops.find((x) => x.key === missing[0])!, error: "prerequisite pair config failed" });
            console.log(`  -- skipping ${pr.proposed.symbols}: ${missing[0]} could not be configured`);
            abandon(pi, 0);
            continue;
        }
        // a proposal's pair config has to land before the path that depends on
        // it, so a failure part way through skips the rest of that proposal
        let ok = true;
        const mine = ops.filter((x) => x.proposal === pi);
        for (const [oi, o] of mine.entries()) {
            try {
                const tx = await sendTx(sender, { to: o.to, data: o.data });
                const rcpt = await tx.wait();
                console.log(`  ${++sent}/${ops.length} ${o.kind} ${o.what} -> ${rcpt.transactionHash}`);
            } catch (e: any) {
                ok = false;
                failed.push({ proposal: pi, op: o, error: errText(e) });
                console.log(`  !! ${o.kind} ${o.what} FAILED: ${failed[failed.length - 1].error}`);
                console.log(`     skipping the rest of ${pr.proposed.symbols}`);
                abandon(pi, oi);
                break;
            }
        }
        if (!ok) continue;
        // record each proposal as it lands, so an interrupted run is not lost
        let entry = m.paths.find((x) => lc(x.sellToken) === lc(pr.sellToken) && lc(x.buyToken) === lc(pr.buyToken));
        if (!entry) {
            entry = { sellToken: lc(pr.sellToken), buyToken: lc(pr.buyToken), dex: "", path: [], symbols: "" };
            m.paths.push(entry);
            // a token the manifest has never seen needs a readable name
            for (const t of pr.proposed.path.map(lc))
                if (!m.tokens[t]) m.tokens[t] = t.slice(0, 8);
            m.paths.sort((a, b) => a.symbols.localeCompare(b.symbols));
        }
        entry.dex = pr.proposed.dex;
        entry.path = pr.proposed.path;
        entry.symbols = pr.proposed.path.map(sym).join(" > ");
        saveManifest(m);
    }

    if (failed.length) {
        console.log(`\n${failed.length} transaction(s) failed; ${keep.length - new Set(failed.map((f) => f.proposal)).size} of ${keep.length} proposal(s) applied.`);
        console.log("Re-run to retry: setPath is idempotent and applied proposals are already in the manifest.");
    }

    console.log("\nmanifest updated — run `yarn registry:audit` to confirm");
}

/** Rebuild a registered route with whatever params the dex currently holds. */
async function routeFromChain(p: any, dex: DexEntry, tokens: string[]): Promise<Route> {
    const r: Route = { dex, tokens, tiers: [], stable: [], factories: [], poolIds: [], pools: [], label: dex.name };
    if (dex.kind === "univ2" || dex.kind === "algebra") return r;
    const calls: Call[] = [];
    for (let i = 0; i < tokens.length - 1; i++) {
        const a = tokens[i], b = tokens[i + 1];
        if (dex.kind === "uniV3") calls.push({ target: dex.address, data: IDEX.encodeFunctionData("pairFee", [a, b]) });
        else if (dex.kind === "cl") calls.push({ target: dex.address, data: IDEX.encodeFunctionData("tickSpacing", [a, b]) });
        else if (dex.kind === "balancer" || dex.kind === "curve") calls.push({ target: dex.address, data: IDEX.encodeFunctionData("pool", [a, b]) });
        else {
            calls.push({ target: dex.address, data: IDEX.encodeFunctionData("stable", [a, b]) });
            calls.push({ target: dex.address, data: IDEX.encodeFunctionData("factory", [a, b]) });
        }
    }
    const res = await multicall(p, calls);
    let k = 0;
    for (let i = 0; i < tokens.length - 1; i++) {
        if (dex.kind === "uniV3") r.tiers[i] = Number(decode<any>(IDEX, "pairFee", res[k++]) ?? dex.defaultFee ?? 0);
        else if (dex.kind === "cl") r.tiers[i] = Number(decode<any>(IDEX, "tickSpacing", res[k++]) ?? 0);
        else if (dex.kind === "balancer") r.poolIds![i] = res[k++].data;
        else if (dex.kind === "curve") r.pools![i] = lc(decode<string>(IDEX, "pool", res[k++]) ?? ZERO);
        else {
            r.stable![i] = decode<boolean>(IDEX, "stable", res[k++]) ?? false;
            r.factories![i] = decode<string>(IDEX, "factory", res[k++]) ?? ZERO;
        }
    }
    return r;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
