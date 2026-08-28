import { BigNumber, utils } from "ethers";

import fs from "fs";

import {
    Call, DexEntry, IAERO_ROUTER, ICLFACTORY, IDEX, IERC20, IFACTORY, Manifest, PROPOSALS,
    Proposal, ProposalFile, ProposalHop, QUOTE_CHUNK, Route, ZERO, alive, buildQuote,
    decode, isZeroHex, lc, loadManifest, multicall, provider, readQuote,
} from "./utils/registry";

// PROPOSE_USD      value of the test swap in USD (default 1000)
// PROPOSE_MIN_BPS  only report improvements above this (default 0.5%)
// PROPOSE_LIMIT    only look at the first N paths
// PROPOSE_VERBOSE  print the trade size and every quote
const USD = Number(process.env.PROPOSE_USD ?? 1000);
const MIN_BPS = Number(process.env.PROPOSE_MIN_BPS ?? 50);
const LIMIT = process.env.PROPOSE_LIMIT ? Number(process.env.PROPOSE_LIMIT) : undefined;
const VERBOSE = process.env.PROPOSE_VERBOSE === "1";

const IPOOL = new utils.Interface(["function factory() view returns (address)"]);

interface HopOption { pool: string; tier: number; stable?: boolean; depth: BigNumber }

function toUnits(x: number, dec: number): BigNumber {
    if (!isFinite(x) || x <= 0) return BigNumber.from(0);
    try { return utils.parseUnits(x.toFixed(Math.min(dec, 18)), dec); } catch { return BigNumber.from(0); }
}

/** Build the deepest available route for a shape on a dex, or undefined if any hop has no pool. */
function pick(options: Map<string, HopOption[]>, dex: DexEntry, shape: string[], sym: (t: string) => string): Route | undefined {
    const picks: HopOption[] = [];
    for (let h = 0; h < shape.length - 1; h++) {
        const o = options.get(`${dex.name}|${shape[h]}|${shape[h + 1]}`);
        if (!o?.length) return undefined;
        picks.push(o[0]);
    }
    return {
        dex, tokens: shape, tiers: picks.map((o) => o.tier), stable: picks.map((o) => !!o.stable),
        pools: picks.map((o) => o.pool), label: `${dex.name} ${shape.map(sym).join(">")}`,
    };
}

async function main() {
    const p = provider();
    const m: Manifest = loadManifest();
    const sym = (t: string) => m.tokens[lc(t)] ?? t.slice(0, 8);
    const byName = new Map(m.dexes.map((d) => [d.name, d]));
    const paths = LIMIT ? m.paths.slice(0, LIMIT) : m.paths;
    const anchor = lc(m.usdAnchor);
    const weth = lc(m.intermediateTokens[0]);

    const clDexes = m.dexes.filter((d) => d.kind === "cl");
    const tsRes = await multicall(p, clDexes.map((d) => ({ target: d.poolFactory!, data: ICLFACTORY.encodeFunctionData("tickSpacings") })));
    clDexes.forEach((d, i) => { d.tiers = d.tiers ?? (decode<number[]>(ICLFACTORY, "tickSpacings", tsRes[i]) ?? []).map(Number); });
    const candidates = m.dexes.filter((d) => ["uniV3", "cl", "univ2", "solidly"].includes(d.kind));

    const tokenList = Object.keys(m.tokens).map(lc);
    const decRes = await multicall(p, tokenList.map((t) => ({ target: t, data: IERC20.encodeFunctionData("decimals") })));
    const DEC = new Map<string, number>();
    tokenList.forEach((t, i) => DEC.set(t, Number(decode<any>(IERC20, "decimals", decRes[i]) ?? 18)));
    const dec = (t: string) => DEC.get(lc(t)) ?? 18;
    const fmt = (v: BigNumber, t: string) => {
        const n = Number(utils.formatUnits(v, dec(t)));
        return n >= 1000 ? n.toFixed(0) : n >= 1 ? n.toFixed(3) : n.toPrecision(3);
    };

    // ---------- shapes: routing candidates, plus a way to price each sell token ----------
    const shapes = new Map<string, string[][]>();
    for (const x of paths) {
        const list: string[][] = [[lc(x.sellToken), lc(x.buyToken)]];
        for (const i of m.intermediateTokens.map(lc))
            if (i !== lc(x.sellToken) && i !== lc(x.buyToken)) list.push([lc(x.sellToken), i, lc(x.buyToken)]);
        shapes.set(`${lc(x.sellToken)}|${lc(x.buyToken)}`, list);
    }
    const sellTokens = [...new Set(paths.map((x) => lc(x.sellToken)))];
    // Every token that can be the input side of a hop needs a price, so hop
    // tiers can be compared at the same realistic size wherever they appear.
    const priceable = [...new Set([...sellTokens, ...tokenList])];
    const priceShapes = new Map<string, string[][]>();
    for (const t of priceable) {
        if (t === anchor) continue;
        const list = [[t, anchor]];
        if (t !== weth) list.push([t, weth, anchor]);
        priceShapes.set(t, list);
    }

    const hopSet = new Map<string, { a: string; b: string; dex: DexEntry }>();
    const addShape = (shape: string[]) => {
        for (let h = 0; h < shape.length - 1; h++)
            for (const d of candidates)
                hopSet.set(`${d.name}|${shape[h]}|${shape[h + 1]}`, { a: shape[h], b: shape[h + 1], dex: d });
    };
    for (const list of shapes.values()) list.forEach(addShape);
    for (const list of priceShapes.values()) list.forEach(addShape);
    for (const x of paths) addShape(x.path.map(lc));

    // ---------- phase 1: which pools exist, and how deep ----------
    const hopKeys = [...hopSet.keys()];
    const probe: Call[] = [];
    const probeMap: { key: string; tier: number; stable?: boolean; idx: number }[] = [];
    for (const k of hopKeys) {
        const { a, b, dex } = hopSet.get(k)!;
        if (dex.kind === "uniV3" || dex.kind === "cl") {
            const fn = dex.kind === "uniV3" ? "getPool(address,address,uint24)" : "getPool(address,address,int24)";
            for (const tier of dex.tiers ?? []) {
                probeMap.push({ key: k, tier, idx: probe.length });
                probe.push({ target: dex.poolFactory!, data: IFACTORY.encodeFunctionData(fn, [a, b, tier]) });
            }
        } else if (dex.kind === "univ2") {
            probeMap.push({ key: k, tier: 0, idx: probe.length });
            probe.push({ target: dex.poolFactory!, data: IFACTORY.encodeFunctionData("getPair", [a, b]) });
        } else {
            for (const stable of [false, true]) {
                probeMap.push({ key: k, tier: 0, stable, idx: probe.length });
                probe.push({ target: dex.router!, data: IAERO_ROUTER.encodeFunctionData("poolFor", [a, b, stable, ZERO]) });
            }
        }
    }
    console.log(`probing ${probe.length} candidate pools across ${candidates.length} dexes...`);
    const probed = await multicall(p, probe);

    const found = probeMap
        .map((pm) => ({ ...pm, pool: lc(decode<string>(IFACTORY, "getPair", probed[pm.idx]) ?? ZERO) }))
        .filter((f) => !isZeroHex(f.pool));
    // a solidly pool address is computed, not looked up, so it may not exist
    const codeRes = await multicall(p, found.map((f) => ({ target: f.pool, data: IPOOL.encodeFunctionData("factory") })));
    const live = found.filter((_, i) => alive(codeRes[i]));
    const depthRes = await multicall(p, live.map((f) => ({
        target: hopSet.get(f.key)!.a, data: IERC20.encodeFunctionData("balanceOf", [f.pool]),
    })));

    const options = new Map<string, HopOption[]>();
    live.forEach((f, i) => {
        const depth = decode<BigNumber>(IERC20, "balanceOf", depthRes[i]) ?? BigNumber.from(0);
        if (depth.isZero()) return;
        const arr = options.get(f.key) ?? [];
        arr.push({ pool: f.pool, tier: f.tier, stable: f.stable, depth });
        options.set(f.key, arr);
    });
    for (const arr of options.values()) arr.sort((x, y) => (y.depth.gt(x.depth) ? 1 : -1));
    console.log(`${options.size} of ${hopKeys.length} candidate hops have a live pool`);

    // ---------- phase 2: price every sell token in USD ----------
    // A test swap should be the size a liquidation actually is, so it is set in
    // dollars. Price comes from the dexes themselves: quote a sliver of the
    // deepest pool into the anchor stablecoin, where price impact is negligible,
    // and read the marginal rate off that.
    const priceCalls: Call[] = [];
    const priceMeta: { token: string; route: Route; probeIn: BigNumber; idx: number }[] = [];
    for (const [t, list] of priceShapes) {
        let deepest = BigNumber.from(0);
        for (const d of candidates) for (const shape of list) {
            const o = options.get(`${d.name}|${shape[0]}|${shape[1]}`);
            if (o?.[0] && o[0].depth.gt(deepest)) deepest = o[0].depth;
        }
        if (deepest.isZero()) continue;
        const probeIn = deepest.div(10_000);
        if (probeIn.isZero()) continue;
        for (const d of candidates) for (const shape of list) {
            const r = pick(options, d, shape, sym);
            if (!r) continue;
            const call = buildQuote(r, probeIn);
            if (!call) continue;
            priceMeta.push({ token: t, route: r, probeIn, idx: priceCalls.length });
            priceCalls.push(call);
        }
    }
    console.log(`pricing ${priceShapes.size} sell tokens with ${priceCalls.length} probe quotes...`);
    const priced = await multicall(p, priceCalls, QUOTE_CHUNK);

    const usdPrice = new Map<string, number>();
    priceMeta.forEach((q) => {
        const outAmt = readQuote(q.route, priced[q.idx]);
        if (!outAmt || outAmt.isZero()) return;
        const rate = Number(utils.formatUnits(outAmt, dec(anchor))) / Number(utils.formatUnits(q.probeIn, dec(q.token)));
        if (!isFinite(rate) || rate <= 0) return;
        // best quote wins: a stale or shallow pool should not set the price
        if (rate > (usdPrice.get(q.token) ?? 0)) usdPrice.set(q.token, rate);
    });
    usdPrice.set(anchor, 1);

    const usdSize = (t: string) => {
        const price = usdPrice.get(lc(t));
        return price ? toUnits(USD / price, dec(t)) : BigNumber.from(0);
    };

    // ---------- phase 2b: pick each hop's tier by quote, not by depth ----------
    // Which pool is best is a property of the hop, so it is decided once, at $USD
    // of the hop's input token, and reused by every route that crosses it. That
    // also means the choice improves every other registered path using that hop.
    const tierCalls: Call[] = [];
    const tierMeta: { key: string; opt: HopOption; idx: number }[] = [];
    for (const [key_, opts] of options) {
        if (opts.length < 2) continue;
        const [dexName, a, b] = key_.split("|");
        const d = byName.get(dexName)!;
        if (d.kind === "univ2" ) continue;
        const size = usdSize(a);
        if (size.isZero()) continue;
        for (const o of opts) {
            const r: Route = {
                dex: d, tokens: [a, b], tiers: [o.tier], stable: [!!o.stable],
                factories: [ZERO], pools: [o.pool], label: "",
            };
            const c = buildQuote(r, size);
            if (!c) continue;
            tierMeta.push({ key: key_, opt: o, idx: tierCalls.length });
            tierCalls.push(c);
        }
    }
    console.log(`ranking ${tierMeta.length} pool variants across ${options.size} hops by quote...`);
    const tierRes = await multicall(p, tierCalls, QUOTE_CHUNK);
    const bestOut = new Map<string, BigNumber>();
    tierMeta.forEach((q) => {
        const d = byName.get(q.key.split("|")[0])!;
        const out = readQuote({ dex: d, tokens: [], tiers: [], label: "" }, tierRes[q.idx]);
        if (!out) return;
        if (out.gt(bestOut.get(q.key) ?? BigNumber.from(0))) {
            bestOut.set(q.key, out);
            const arr = options.get(q.key)!;
            options.set(q.key, [q.opt, ...arr.filter((x) => x !== q.opt)]);
        }
    });

    const notionals = new Map<string, BigNumber>();
    for (const t of sellTokens) {
        const price = usdPrice.get(t);
        if (!price) continue;
        const amt = toUnits(USD / price, dec(t));
        if (!amt.isZero()) notionals.set(t, amt);
    }
    const unpriced = sellTokens.filter((t) => !notionals.has(t));

    // ---------- phase 3: quote every candidate at the same dollar size ----------
    const quotes: Call[] = [];
    const quoteMeta: { pair: string; route: Route; incumbent: boolean; idx: number }[] = [];
    const incTiers = new Map<string, { tiers: number[]; stable: boolean[]; factory: string[] }>();

    // registered params for the incumbent route, read straight off the dex contract
    const incCalls: Call[] = [];
    const incMap: { pair: string; hop: number; kind: string; idx: number }[] = [];
    for (const x of paths) {
        const d = byName.get(x.dex);
        if (!d || !["uniV3", "cl", "solidly"].includes(d.kind)) continue;
        const pair = `${lc(x.sellToken)}|${lc(x.buyToken)}`;
        for (let h = 0; h < x.path.length - 1; h++) {
            const a = lc(x.path[h]), b = lc(x.path[h + 1]);
            if (d.kind === "solidly") {
                incMap.push({ pair, hop: h, kind: "stable", idx: incCalls.length });
                incCalls.push({ target: d.address, data: IDEX.encodeFunctionData("stable", [a, b]) });
                incMap.push({ pair, hop: h, kind: "factory", idx: incCalls.length });
                incCalls.push({ target: d.address, data: IDEX.encodeFunctionData("factory", [a, b]) });
            } else {
                const fn = d.kind === "uniV3" ? "pairFee" : "tickSpacing";
                incMap.push({ pair, hop: h, kind: fn, idx: incCalls.length });
                incCalls.push({ target: d.address, data: IDEX.encodeFunctionData(fn, [a, b]) });
            }
        }
    }
    const incRes = await multicall(p, incCalls);
    for (const im of incMap) {
        const cur = incTiers.get(im.pair) ?? { tiers: [], stable: [], factory: [] };
        if (im.kind === "stable") cur.stable[im.hop] = decode<boolean>(IDEX, "stable", incRes[im.idx]) ?? false;
        else if (im.kind === "factory") cur.factory[im.hop] = decode<string>(IDEX, "factory", incRes[im.idx]) ?? ZERO;
        else cur.tiers[im.hop] = Number(decode<any>(IDEX, im.kind, incRes[im.idx]) ?? 0);
        incTiers.set(im.pair, cur);
    }

    for (const x of paths) {
        const pair = `${lc(x.sellToken)}|${lc(x.buyToken)}`;
        const notional = notionals.get(lc(x.sellToken));
        if (!notional) continue;

        const inc = byName.get(x.dex);
        if (inc && ["uniV3", "cl", "univ2", "solidly"].includes(inc.kind)) {
            const t = incTiers.get(pair);
            const route: Route = {
                dex: inc, tokens: x.path.map(lc), tiers: t?.tiers ?? [], stable: t?.stable ?? [],
                label: `${x.dex} (registered)`,
            };
            route.factories = t?.factory;
            const call = buildQuote(route, notional);
            if (call) { quoteMeta.push({ pair, route, incumbent: true, idx: quotes.length }); quotes.push(call); }
        }

        for (const d of candidates) for (const shape of shapes.get(pair)!) {
            if (d.name === x.dex && shape.join(",") === x.path.map(lc).join(",")) continue;
            const r = pick(options, d, shape, sym);
            if (!r) continue;
            const call = buildQuote(r, notional);
            if (!call) continue;
            quoteMeta.push({ pair, route: r, incumbent: false, idx: quotes.length });
            quotes.push(call);
        }
    }

    console.log(`quoting ${quotes.length} routes for ${notionals.size} priced tokens...`);
    const quoted = await multicall(p, quotes, QUOTE_CHUNK);

    const out = new Map<string, { route: Route; incumbent: boolean; amount: BigNumber }[]>();
    quoteMeta.forEach((q) => {
        const amount = readQuote(q.route, quoted[q.idx]);
        if (!amount || amount.isZero()) return;
        const arr = out.get(q.pair) ?? [];
        arr.push({ route: q.route, incumbent: q.incumbent, amount });
        out.set(q.pair, arr);
    });

    // ---------- report ----------
    const proposals: { pair: string; gain: number; inc: BigNumber; best: any }[] = [];
    const unquotable: string[] = [];
    for (const [pair, list] of out) {
        const inc = list.find((r) => r.incumbent);
        const best = list.reduce((a, b) => (b.amount.gt(a.amount) ? b : a));
        if (!inc) { unquotable.push(pair); continue; }
        if (best.incumbent) continue;
        const gain = best.amount.sub(inc.amount).mul(10_000).div(inc.amount.isZero() ? 1 : inc.amount).toNumber();
        if (gain >= MIN_BPS) proposals.push({ pair, gain, inc: inc.amount, best });
    }
    proposals.sort((a, b) => b.gain - a.gain);

    if (VERBOSE) for (const [pair, list] of out) {
        const [s0, b0] = pair.split("|");
        console.log(`\n${sym(s0)} > ${sym(b0)}   $${USD} = ${fmt(notionals.get(s0)!, s0)} ${sym(s0)}`);
        for (const r of [...list].sort((a, b) => (b.amount.gt(a.amount) ? 1 : -1)))
            console.log(`   ${fmt(r.amount, b0).padStart(16)} ${sym(b0).padEnd(10)} ${r.route.label}${r.incumbent ? "  <- registered" : ""}`);
    }

    console.log(`\n=== ${proposals.length} route(s) beaten by an alternative on a $${USD} swap (>= ${MIN_BPS} bps) ===\n`);
    for (const pr of proposals) {
        const [s, b] = pr.pair.split("|");
        const x = paths.find((q) => lc(q.sellToken) === s && lc(q.buyToken) === b)!;
        console.log(`${sym(s)} > ${sym(b)}   +${(pr.gain / 100).toFixed(2)}%   on ${fmt(notionals.get(s)!, s)} ${sym(s)}`);
        console.log(`   now  ${x.symbols} [${x.dex}]  ->  ${fmt(pr.inc, b)} ${sym(b)}`);
        console.log(`   alt  ${pr.best.route.label}  ->  ${fmt(pr.best.amount, b)} ${sym(b)}`);
    }
    const file: ProposalFile = {
        network: m.network, registry: m.registry, generatedAtBlock: await p.getBlockNumber(),
        usd: USD, minBps: MIN_BPS,
        sizes: Object.fromEntries([...notionals].map(([t, v]) => [t, v.toString()])),
        proposals: proposals.map((pr) => {
            const [s0, b0] = pr.pair.split("|");
            const x = paths.find((q) => lc(q.sellToken) === s0 && lc(q.buyToken) === b0)!;
            const r: Route = pr.best.route;
            const hops: ProposalHop[] = r.tokens.slice(0, -1).map((from, i) => {
                const hop: ProposalHop = { from, to: r.tokens[i + 1], pool: r.pools?.[i] ?? ZERO };
                if (r.dex.kind === "uniV3") hop.fee = r.tiers[i];
                else if (r.dex.kind === "cl") hop.tickSpacing = r.tiers[i];
                else if (r.dex.kind === "solidly") { hop.stable = r.stable?.[i] ?? false; hop.factory = r.factories?.[i] ?? ZERO; }
                return hop;
            });
            return {
                sellToken: s0, buyToken: b0, gainBps: pr.gain,
                current: { dex: x.dex, path: x.path.map(lc), symbols: x.symbols, out: pr.inc.toString() },
                proposed: {
                    dex: r.dex.name, kind: r.dex.kind, path: r.tokens,
                    symbols: r.tokens.map(sym).join(" > "), out: pr.best.amount.toString(), hops,
                },
            } as Proposal;
        }),
    };
    const outPath = process.env.PROPOSE_OUT ?? PROPOSALS;
    fs.writeFileSync(outPath, JSON.stringify(file, null, 4) + "\n");
    console.log(`\nwrote ${file.proposals.length} proposal(s) to ${outPath}`);
    console.log("review it, then apply with: yarn registry:apply");

    if (unpriced.length)
        console.log(`\n${unpriced.length} sell token(s) could not be priced against ${sym(anchor)}: ${unpriced.map(sym).join(", ")}`);
    if (unquotable.length)
        console.log(`${unquotable.length} pair(s) had no quotable registered route (curve/balancer/erc4626 are not quoted here)`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
