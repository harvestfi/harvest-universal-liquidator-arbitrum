import { BigNumber, utils } from "ethers";

import fs from "fs";

import {
    Call, DexEntry, IAERO_ROUTER, IALGEBRA, IBVAULT, ICLFACTORY, IDEX, IERC20, IFACTORY, IREGISTRY, Manifest, PROPOSALS,
    Proposal, ProposalFile, ProposalHop, QUOTE_CHUNK, Route, ZERO, alive, buildQuote,
    curveCoinIndex, decode, isZeroHex, lc, loadManifest, multicall, provider, quoteCurve, readQuote,
} from "./utils/registry";

// PROPOSE_USD      value of the test swap in USD (default 1000)
// PROPOSE_MIN_BPS  only report improvements above this (default 0.5%)
// PROPOSE_LIMIT    only look at the first N paths
// PROPOSE_VERBOSE  print the trade size and every quote
const USD = Number(process.env.PROPOSE_USD ?? 1000);
const MIN_BPS = Number(process.env.PROPOSE_MIN_BPS ?? 50);
const LIMIT = process.env.PROPOSE_LIMIT ? Number(process.env.PROPOSE_LIMIT) : undefined;
const VERBOSE = process.env.PROPOSE_VERBOSE === "1";
// sorts above every real percentage, so broken routes lead the report
const BROKEN = Number.MAX_SAFE_INTEGER;
// below BROKEN so failing routes still lead, above ordinary gains
const NEWROUTE = Number.MAX_SAFE_INTEGER - 1;
// A new route has no incumbent to beat, so nothing stops a lossy one from being
// "best". Require it to return most of the value put in.
const MIN_RETENTION = Number(process.env.PROPOSE_MIN_RETENTION ?? 0.9);
// Kinds whose pools are discovered from a factory. For these, a quote that
// fails means the pool genuinely cannot swap. curve and balancer depend on
// per-pair config, and erc4626/aave/traderJoe have no quoter wired at all, so a
// failure there says nothing about the route.
const FACTORY_KINDS = ["uniV3", "cl", "algebra", "univ2", "solidly"];
// Two ways to ask for a route the registry may not have.
//
// PROPOSE_NEW_TOKENS names a token and offers it a route into every
// intermediate, which is what a new reward token needs --- getPath reaches
// everything else from there. PROPOSE_NEW_PAIRS names both ends, for a route
// between two specific tokens.
//
// Either accepts a comma or whitespace separated list, or a path to a file
// holding one, and either side may be an address or a symbol the manifest
// already names.
const entries = (raw?: string) => {
    if (!raw) return [] as string[];
    const text = fs.existsSync(raw) ? fs.readFileSync(raw, "utf8") : raw;
    // an arrow binds its two sides together before the list is split apart,
    // so "A > B, C -> D" survives being written the way it reads
    return text.replace(/\s*-*>\s*/g, ">").split(/[,\s]+/)
        .map((x) => x.replace(/[[\]"']/g, "").trim()).filter(Boolean);
};
const NEW_TOKENS = entries(process.env.PROPOSE_NEW_TOKENS);
const NEW_PAIRS = entries(process.env.PROPOSE_NEW_PAIRS).map((e) => {
    const sides = e.split(">").map((x) => x.trim()).filter(Boolean);
    if (sides.length !== 2) throw new Error(`PROPOSE_NEW_PAIRS wants "SELL>BUY" entries, got "${e}"`);
    return sides as [string, string];
});

const IPOOL = new utils.Interface(["function factory() view returns (address)"]);

/** The vault's balance of one token in a balancer pool, from a getPoolTokens result. */
function decodeVaultBalance(res: { success: boolean; data: string }, token: string): BigNumber | undefined {
    if (!res.success || res.data === "0x") return undefined;
    try {
        const [tokens, balances] = IBVAULT.decodeFunctionResult("getPoolTokens", res.data) as [string[], BigNumber[]];
        const at = tokens.findIndex((t) => lc(t) === lc(token));
        return at < 0 ? undefined : balances[at];
    } catch {
        return undefined;
    }
}

interface HopOption { pool: string; tier: number; stable?: boolean; depth: BigNumber; poolId?: string; idx?: number[] }

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
        pools: picks.map((o) => o.pool), poolIds: picks.map((o) => o.poolId ?? ""),
        curveIdx: picks.map((o) => o.idx ?? []), label: `${dex.name} ${shape.map(sym).join(">")}`,
    };
}

async function main() {
    const p = provider();
    const m: Manifest = loadManifest();
    const sym = (t: string) => m.tokens[lc(t)] ?? t.slice(0, 8);
    const byName = new Map(m.dexes.map((d) => [d.name, d]));
    const paths = LIMIT ? m.paths.slice(0, LIMIT) : [...m.paths];
    const anchor = lc(m.usdAnchor);
    const weth = lc(m.intermediateTokens[0]);

    const clDexes = m.dexes.filter((d) => d.kind === "cl");
    const tsRes = await multicall(p, clDexes.map((d) => ({ target: d.poolFactory!, data: ICLFACTORY.encodeFunctionData("tickSpacings") })));
    clDexes.forEach((d, i) => { d.tiers = d.tiers ?? (decode<number[]>(ICLFACTORY, "tickSpacings", tsRes[i]) ?? []).map(Number); });
    // balancer and curve can only be offered where the dex already has a pool
    // configured for the hop --- neither exposes a lookup from a token pair.
    const candidates = m.dexes.filter((d) => ["uniV3", "cl", "univ2", "solidly", "algebra", "balancer", "curve"].includes(d.kind));

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
    // An address is taken as given; a name has to be one the manifest uses, and
    // has to name one token --- a chain with two "USDC" entries is ambiguous.
    const resolve = (name: string) => {
        if (/^0x[0-9a-fA-F]{40}$/.test(name)) return lc(name);
        const hits = Object.entries(m.tokens).filter(([, s0]) => s0.toLowerCase() === name.toLowerCase());
        if (!hits.length) throw new Error(`no token called "${name}" in the manifest --- give its address`);
        if (hits.length > 1) throw new Error(`"${name}" names ${hits.length} tokens (${hits.map(([a]) => a).join(", ")}) --- give an address`);
        return lc(hits[0][0]);
    };
    const requested: [string, string][] = [];
    for (const t of NEW_TOKENS.map(resolve))
        for (const i of m.intermediateTokens.map(lc)) if (i !== t) requested.push([t, i]);
    for (const [a, b] of NEW_PAIRS) requested.push([resolve(a), resolve(b)]);

    const registered = new Set(m.paths.map((x) => `${lc(x.sellToken)}|${lc(x.buyToken)}`));
    const synthetic = new Set<string>();
    const routed: string[] = [];
    const wanted = new Set<string>();
    for (const [sell, buy] of requested) {
        const key = `${sell}|${buy}`;
        if (sell === buy || wanted.has(key)) continue;
        wanted.add(key);
        if (registered.has(key)) routed.push(key);
        else synthetic.add(key);
    }
    if (wanted.size) {
        console.log(`${wanted.size} route(s) requested, ${synthetic.size} with no entry of their own`
            + (routed.length ? `, ${routed.length} registered and compared as usual` : ""));
    }
    // symbols and decimals for tokens the manifest has never seen
    const unseen = [...new Set(requested.flat())].filter((t) => !m.tokens[t]);
    if (unseen.length) {
        const meta = await multicall(p, unseen.flatMap((t) => [
            { target: t, data: IERC20.encodeFunctionData("symbol") },
            { target: t, data: IERC20.encodeFunctionData("decimals") },
        ]));
        unseen.forEach((t, i) => {
            m.tokens[t] = decode<string>(IERC20, "symbol", meta[i * 2]) ?? t.slice(0, 8);
            DEC.set(t, Number(decode<any>(IERC20, "decimals", meta[i * 2 + 1]) ?? 18));
        });
    }
    for (const key of synthetic) {
        const [sell, buy] = key.split("|");
        paths.push({ sellToken: sell, buyToken: buy, dex: "", path: [sell, buy],
            symbols: `${sym(sell)} > ${sym(buy)}` } as any);
    }
    // a pair asked for by name is always answered, even when PROPOSE_LIMIT cut
    // it out of the list
    for (const key of routed) {
        if (paths.some((x) => `${lc(x.sellToken)}|${lc(x.buyToken)}` === key)) continue;
        const entry = m.paths.find((x) => `${lc(x.sellToken)}|${lc(x.buyToken)}` === key);
        if (entry) paths.push(entry);
    }
    const isNew = (pair: string) => synthetic.has(pair);

    // A pair with no entry of its own is not necessarily unreachable: getPath
    // falls back to the first intermediate token that has a path on both sides,
    // and swaps it in two legs. Ask the registry what it does today, so a
    // proposal can be weighed against that rather than against nothing.
    const resolved = new Map<string, string[][]>();
    if (synthetic.size) {
        const keys = [...synthetic];
        const res = await multicall(p, keys.map((k) => {
            const [sell, buy] = k.split("|");
            return { target: m.registry, data: IREGISTRY.encodeFunctionData("getPath", [sell, buy]) };
        }));
        keys.forEach((k, i) => {
            const legs = decode<any[]>(IREGISTRY, "getPath", res[i]);
            if (legs?.length) resolved.set(k, legs.map((l: any) => (l.paths as string[]).map(lc)));
        });
        if (resolved.size) {
            console.log(`getPath already resolves ${resolved.size} of those through an intermediate `
                + `token, so they are weighed against that rather than against nothing`);
        }
    }

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
    const priceable = [...new Set([...sellTokens, ...tokenList, ...requested.flat()])];
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
        } else if (dex.kind === "algebra") {
            probeMap.push({ key: k, tier: 0, idx: probe.length });
            probe.push({ target: dex.poolFactory!, data: IALGEBRA.encodeFunctionData("poolByPair", [a, b]) });
        } else if (dex.kind === "balancer" || dex.kind === "curve") {
            probeMap.push({ key: k, tier: 0, idx: probe.length });
            probe.push({ target: dex.address, data: IDEX.encodeFunctionData("pool", [a, b]) });
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
        .map((pm) => {
            const kind = hopSet.get(pm.key)!.dex.kind;
            if (kind === "balancer") {
                // a pool id, not an address: keep it as the id and resolve the
                // pool address separately for the liveness probe
                const id = probed[pm.idx].data;
                return { ...pm, pool: ZERO, poolId: alive(probed[pm.idx]) && !isZeroHex(id) ? id : undefined };
            }
            return { ...pm, pool: lc(decode<string>(IFACTORY, "getPair", probed[pm.idx]) ?? ZERO), poolId: undefined as string | undefined };
        })
        .filter((f) => (f.poolId ? true : !isZeroHex(f.pool)));
    // a solidly pool address is computed, not looked up, so it may not exist
    const codeRes = await multicall(p, found.map((f) => f.poolId
        ? { target: hopSet.get(f.key)!.dex.vault!, data: IBVAULT.encodeFunctionData("getPoolTokens", [f.poolId]) }
        : { target: f.pool, data: IPOOL.encodeFunctionData("factory") }));
    // keep the probe index, so a balancer row can read its balances back out of
    // the liveness call instead of being measured a second time
    const live = found.map((f, i) => ({ f, probe: i })).filter(({ probe }) => alive(codeRes[probe]));
    const depthRes = await multicall(p, live.map(({ f }) => ({
        target: hopSet.get(f.key)!.a, data: IERC20.encodeFunctionData("balanceOf", [f.pool]),
    })));

    const options = new Map<string, HopOption[]>();
    live.forEach(({ f, probe }, i) => {
        // A balancer pool holds nothing itself --- the vault holds it, keyed by
        // pool id --- so balanceOf(pool) is zero for every balancer hop and
        // would drop the entire dex from consideration. getPoolTokens was
        // already read to prove the pool exists; take the depth from there.
        let depth: BigNumber;
        if (f.poolId) {
            const bal = decodeVaultBalance(codeRes[probe], hopSet.get(f.key)!.a);
            depth = bal ?? BigNumber.from(0);
        } else {
            depth = decode<BigNumber>(IERC20, "balanceOf", depthRes[i]) ?? BigNumber.from(0);
        }
        if (depth.isZero()) return;
        const arr = options.get(f.key) ?? [];
        arr.push({ pool: f.pool, tier: f.tier, stable: f.stable, depth, poolId: f.poolId });
        options.set(f.key, arr);
    });
    for (const arr of options.values()) arr.sort((x, y) => (y.depth.gt(x.depth) ? 1 : -1));
    console.log(`${options.size} of ${hopKeys.length} candidate hops have a live pool`);

    // ---------- curve coin indices ----------
    // A curve pool is quoted per hop with get_dy(i, j, dx), so each pool's coin
    // ordering has to be read before anything can be priced through it.
    const coinIdx = await curveCoinIndex(p, [...options.entries()]
        .filter(([k]) => byName.get(k.split("|")[0])?.kind === "curve")
        .flatMap(([, v]) => v.map((o) => o.pool)));

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
    const curveMeta: { pair: string; route: Route; incumbent: boolean; amount: BigNumber }[] = [];
    const incTiers = new Map<string, { tiers: number[]; stable: boolean[]; factory: string[]; poolIds: string[]; pools: string[] }>();

    // registered params for the incumbent route, read straight off the dex contract
    const incCalls: Call[] = [];
    const incMap: { pair: string; hop: number; kind: string; idx: number }[] = [];
    for (const x of paths) {
        const d = byName.get(x.dex);
        if (!d || !["uniV3", "cl", "solidly", "balancer", "curve"].includes(d.kind)) continue;
        const pair = `${lc(x.sellToken)}|${lc(x.buyToken)}`;
        for (let h = 0; h < x.path.length - 1; h++) {
            const a = lc(x.path[h]), b = lc(x.path[h + 1]);
            if (d.kind === "solidly") {
                incMap.push({ pair, hop: h, kind: "stable", idx: incCalls.length });
                incCalls.push({ target: d.address, data: IDEX.encodeFunctionData("stable", [a, b]) });
                incMap.push({ pair, hop: h, kind: "factory", idx: incCalls.length });
                incCalls.push({ target: d.address, data: IDEX.encodeFunctionData("factory", [a, b]) });
            } else if (d.kind === "balancer" || d.kind === "curve") {
                // balancer keeps a pool id, curve a pool address
                incMap.push({ pair, hop: h, kind: d.kind === "curve" ? "curvePool" : "pool", idx: incCalls.length });
                incCalls.push({ target: d.address, data: IDEX.encodeFunctionData("pool", [a, b]) });
            } else {
                const fn = d.kind === "uniV3" ? "pairFee" : "tickSpacing";
                incMap.push({ pair, hop: h, kind: fn, idx: incCalls.length });
                incCalls.push({ target: d.address, data: IDEX.encodeFunctionData(fn, [a, b]) });
            }
        }
    }
    const incRes = await multicall(p, incCalls);
    for (const im of incMap) {
        const cur = incTiers.get(im.pair) ?? { tiers: [], stable: [], factory: [], poolIds: [], pools: [] };
        if (im.kind === "pool") cur.poolIds[im.hop] = incRes[im.idx].data;
        else if (im.kind === "curvePool") cur.pools[im.hop] = lc(decode<string>(IDEX, "pool", incRes[im.idx]) ?? ZERO);
        else if (im.kind === "stable") cur.stable[im.hop] = decode<boolean>(IDEX, "stable", incRes[im.idx]) ?? false;
        else if (im.kind === "factory") cur.factory[im.hop] = decode<string>(IDEX, "factory", incRes[im.idx]) ?? ZERO;
        else cur.tiers[im.hop] = Number(decode<any>(IDEX, im.kind, incRes[im.idx]) ?? 0);
        incTiers.set(im.pair, cur);
    }

    for (const x of paths) {
        const pair = `${lc(x.sellToken)}|${lc(x.buyToken)}`;
        const notional = notionals.get(lc(x.sellToken));
        if (!notional) continue;

        const inc = byName.get(x.dex);
        if (inc && ["uniV3", "cl", "univ2", "solidly", "algebra", "balancer", "curve"].includes(inc.kind)) {
            const t = incTiers.get(pair);
            const route: Route = {
                dex: inc, tokens: x.path.map(lc), tiers: t?.tiers ?? [], stable: t?.stable ?? [],
                poolIds: t?.poolIds ?? [], pools: t?.pools ?? [], label: `${x.dex} (registered)`,
            };
            route.factories = t?.factory;
            if (inc.kind === "curve") {
                curveMeta.push({ pair, route, incumbent: true, amount: notional });
            } else {
                const call = buildQuote(route, notional);
                if (call) { quoteMeta.push({ pair, route, incumbent: true, idx: quotes.length }); quotes.push(call); }
            }
        }

        for (const d of candidates) for (const shape of shapes.get(pair)!) {
            if (d.name === x.dex && shape.join(",") === x.path.map(lc).join(",")) continue;
            const r = pick(options, d, shape, sym);
            if (!r) continue;
            if (d.kind === "curve") { curveMeta.push({ pair, route: r, incumbent: false, amount: notional }); continue; }
            const call = buildQuote(r, notional);
            if (!call) continue;
            quoteMeta.push({ pair, route: r, incumbent: false, idx: quotes.length });
            quotes.push(call);
        }
    }

    console.log(`quoting ${quotes.length} routes for ${notionals.size} priced tokens...`);
    const quoted = await multicall(p, quotes, QUOTE_CHUNK);

    const curveAmounts = await quoteCurve(p, curveMeta.map((q) => ({ route: q.route, amount: q.amount })), coinIdx);
    const curveOut = new Map<number, BigNumber>();
    curveAmounts.forEach((v, i) => { if (!v.isZero()) curveOut.set(i, v); });

    const out = new Map<string, { route: Route; incumbent: boolean; amount: BigNumber }[]>();
    curveMeta.forEach((q, i) => {
        const amount = curveOut.get(i);
        if (!amount || amount.isZero()) return;
        const arr = out.get(q.pair) ?? [];
        arr.push({ route: q.route, incumbent: q.incumbent, amount });
        out.set(q.pair, arr);
    });
    quoteMeta.forEach((q) => {
        const amount = readQuote(q.route, quoted[q.idx]);
        if (!amount || amount.isZero()) return;
        const arr = out.get(q.pair) ?? [];
        arr.push({ route: q.route, incumbent: q.incumbent, amount });
        out.set(q.pair, arr);
    });

    // ---------- report ----------
    const proposals: { pair: string; gain: number; inc: BigNumber; best: any; broken?: boolean; fresh?: boolean;
        kept?: number; viaLegs?: number; shape?: string }[] = [];
    const unquotable: string[] = [];
    const lossy: string[] = [];
    const unvalued: string[] = [];
    const redundant: string[] = [];
    for (const [pair, list] of out) {
        const inc = list.find((r) => r.incumbent);
        const best = list.reduce((a, b) => (b.amount.gt(a.amount) ? b : a));
        if (!inc) {
            // The registered route did not quote. Only call that broken when the
            // dex resolves its pools from a factory --- there a failed quote means
            // the pool cannot swap, and anything that does quote beats reverting.
            if (isNew(pair)) {
                const target = pair.split("|")[1];
                const price = usdPrice.get(target);
                const outUsd = best && price
                    ? Number(utils.formatUnits(best.amount, dec(target))) * price
                    : undefined;
                const kept = outUsd === undefined ? undefined : outUsd / USD;
                // What the registry manages today, if it manages anything. Each
                // leg is a registered path, so its quote is already in hand ---
                // multiplying the shares each leg keeps approximates the pair,
                // which is enough to say whether an entry of its own helps.
                const legs = resolved.get(pair);
                const perLeg = legs?.map((tokens) => {
                    const legPair = `${tokens[0]}|${tokens[tokens.length - 1]}`;
                    const q = out.get(legPair)?.find((r) => r.incumbent);
                    const legPrice = usdPrice.get(tokens[tokens.length - 1]);
                    if (!q || !legPrice) return undefined;
                    return Number(utils.formatUnits(q.amount, dec(tokens[tokens.length - 1]))) * legPrice / USD;
                });
                const viaLegs = perLeg && perLeg.every((x) => x !== undefined)
                    ? perLeg.reduce((a, b) => a! * b!, 1) : undefined;
                const shape = legs?.map((l) => l.map(sym).join(">")).join(" then ");
                    if (kept !== undefined && viaLegs !== undefined) {
                    // there is something to beat, so beat it by the usual margin
                    if (kept > viaLegs * (1 + MIN_BPS / 10_000))
                        proposals.push({ pair, gain: NEWROUTE, inc: BigNumber.from(0), best, fresh: true, kept, viaLegs, shape });
                    else
                        redundant.push(`${sym(pair.split("|")[0])} > ${sym(target)}: a direct entry keeps `
                            + `${(kept * 100).toFixed(1)}%, the registry already gets ~${(viaLegs * 100).toFixed(1)}% via ${shape}`);
                    continue;
                }
                if (kept === undefined || kept >= MIN_RETENTION) {
                    proposals.push({ pair, gain: NEWROUTE, inc: BigNumber.from(0), best, fresh: true, kept, shape });
                    if (kept === undefined) unvalued.push(pair);
                } else {
                    lossy.push(`${sym(pair.split("|")[0])} > ${sym(target)} keeps only ${(kept * 100).toFixed(1)}% of value`
                        + (shape ? `, and the registry already routes it via ${shape}` : ""));
                }
                continue;
            }
            const x = paths.find((q) => `${lc(q.sellToken)}|${lc(q.buyToken)}` === pair);
            const kind = x ? byName.get(x.dex)?.kind : undefined;
            if (best && !best.incumbent && kind && FACTORY_KINDS.includes(kind))
                proposals.push({ pair, gain: BROKEN, inc: BigNumber.from(0), best, broken: true });
            else unquotable.push(pair);
            continue;
        }
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

    const brokenCount = proposals.filter((x) => x.broken).length;
    const freshCount = proposals.filter((x) => x.fresh).length;
    const notes = [
        brokenCount ? `${brokenCount} because the registered route reverts` : "",
        freshCount ? `${freshCount} with no route registered yet` : "",
    ].filter(Boolean);
    console.log(`\n=== ${proposals.length} route(s) to set on a $${USD} swap`
        + (notes.length ? `, ${notes.join(" and ")}` : ` (>= ${MIN_BPS} bps)`) + " ===\n");
    for (const pr of proposals) {
        const [s, b] = pr.pair.split("|");
        const x = paths.find((q) => lc(q.sellToken) === s && lc(q.buyToken) === b)!;
        // BROKEN and NEWROUTE only exist to sort; they are not percentages
        const headline = pr.fresh
            ? (pr.shape ? `no entry of its own` : `no route registered`)
                + (pr.kept === undefined ? "" : `, keeps ${(pr.kept * 100).toFixed(1)}% of value`)
                + (pr.viaLegs === undefined ? "" : ` against ~${(pr.viaLegs * 100).toFixed(1)}% today`)
            : pr.broken ? "registered route does not quote"
                : `+${(pr.gain / 100).toFixed(2)}%`;
        console.log(`${sym(s)} > ${sym(b)}   ${headline}   on ${fmt(notionals.get(s)!, s)} ${sym(s)}`);
        if (pr.fresh && pr.shape) console.log(`   now  ${pr.shape}  (two legs, resolved by getPath)`);
        if (!pr.fresh) console.log(`   now  ${x.symbols} [${x.dex}]  ->  ${fmt(pr.inc, b)} ${sym(b)}`);
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
                if (r.dex.kind === "balancer") hop.poolId = r.poolIds?.[i];
                else if (r.dex.kind === "curve") hop.pool = r.pools?.[i] ?? ZERO;
                else if (r.dex.kind === "uniV3") hop.fee = r.tiers[i];
                else if (r.dex.kind === "cl") hop.tickSpacing = r.tiers[i];
                else if (r.dex.kind === "solidly") { hop.stable = r.stable?.[i] ?? false; hop.factory = r.factories?.[i] ?? ZERO; }
                return hop;
            });
            return {
                sellToken: s0, buyToken: b0, gainBps: pr.fresh ? -2 : pr.broken ? -1 : pr.gain,
                ...(pr.kept === undefined ? {} : { kept: pr.kept }),
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
    if (unquotable.length) {
        const asked = unquotable.filter((k) => wanted.has(k));
        console.log(`${unquotable.length} pair(s) had no quotable registered route`
            + (asked.length ? `, including ${asked.length} you asked about:` : ""));
        // a pair nobody asked about is noise; one that was requested is an answer owed
        for (const k of asked) {
            const x = paths.find((q) => `${lc(q.sellToken)}|${lc(q.buyToken)}` === k);
            console.log(`  - ${sym(k.split("|")[0])} > ${sym(k.split("|")[1])}: registered on `
                + `${x?.dex ?? "?"}, which this tooling cannot quote, so nothing was compared`);
        }
    }
    if (redundant.length) {
        console.log(`\n${redundant.length} requested route(s) would not improve on what getPath already does:`);
        for (const r of redundant) console.log(`  - ${r}`);
        console.log(`  (per-leg shares multiplied, so treat it as approximate)`);
    }
    if (unvalued.length) {
        console.log(`\n${unvalued.length} proposed route(s) could not be checked for value kept, `
            + `because ${sym(anchor)} is not reachable from the buy token:`);
        for (const k of unvalued) console.log(`  - ${sym(k.split("|")[0])} > ${sym(k.split("|")[1])}`);
    }
    if (lossy.length) {
        console.log(`\n${lossy.length} requested route(s) rejected for losing too much value ` +
            `(floor ${(MIN_RETENTION * 100).toFixed(0)}%, raise with PROPOSE_MIN_RETENTION):`);
        for (const l of lossy) console.log(`  - ${l}`);
    }
    // A pair only reaches `out` once some candidate quoted. One that never got
    // that far is invisible to every bucket above, so ask for it back here ---
    // an unanswered request has to say so, or it reads as "nothing to do".
    const silent = [...wanted].filter((k) => !out.has(k)
        && !proposals.some((pr) => pr.pair === k) && !routed.includes(k));
    if (silent.length) {
        console.log(`\n${silent.length} requested route(s) produced no candidate at all:`);
        for (const k of silent) {
            const [sell, buy] = k.split("|");
            const why = unpriced.includes(sell) ? `${sym(sell)} could not be priced`
                : `no dex the tooling can quote has a pool for every hop`;
            console.log(`  - ${sym(sell)} > ${sym(buy)}: ${why}`);
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
