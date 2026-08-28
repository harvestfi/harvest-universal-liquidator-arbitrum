import { BigNumber, Signer, Wallet, providers, utils } from "ethers";
import fs from "fs";
import path from "path";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
// Layouts differ between repos: the hardhat ones keep this in helpers/, the
// Foundry ones under tools/. Resolve either, and let an env var win.
function locate(name: string, candidates: string[]): string {
    const override = process.env[name];
    if (override) return path.resolve(override);
    for (const c of candidates) if (fs.existsSync(path.resolve(__dirname, c))) return path.resolve(__dirname, c);
    return path.resolve(__dirname, candidates[0]);
}

export const MANIFEST = locate("REGISTRY_MANIFEST", ["../../helpers/registry.json", "../registry.json"]);
export const ZERO = "0x0000000000000000000000000000000000000000";

// One multicall carries many staticcalls, so the whole audit fits in a handful
// of eth_call requests instead of thousands.
const CHUNK = 250;
// Quoter calls burn real gas inside eth_call, so they need far smaller batches.
export const QUOTE_CHUNK = 8;

export type DexKind =
    | "uniV3"     // uniswap v3 style, uint24 fee per pair
    | "cl"        // slipstream style, int24 tickSpacing per pair
    | "algebra"   // algebra style, dynamic fee so no per-pair tier and no fee in the path
    | "solidly"   // aerodrome style, (stable, factory) per pair
    | "univ2"     // constant product router, no per-pair config
    | "curve"
    | "balancer"
    | "erc4626"
    | "unknown";

export interface DexEntry {
    name: string;
    kind: DexKind;
    hex: string;
    address: string;
    poolFactory?: string;
    router?: string;
    vault?: string;
    quoter?: string;
    defaultFee?: number;
    /** uniV3 fee tiers / CL tick spacings worth probing for alternative routes */
    tiers?: number[];
}

export interface PathEntry {
    sellToken: string;
    buyToken: string;
    symbols: string;
    dex: string;
    path: string[];
}

export const CHAIN_NAMES: Record<number, string> = {
    1: "ethereum", 10: "optimism", 137: "polygon", 8453: "base", 42161: "arbitrum",
};

export interface Manifest {
    network: string;
    /** read from the chain, so a manifest cannot silently describe another one */
    chainId: number;
    registry: string;
    universalLiquidator: string;
    owner: string;
    generatedAtBlock: number;
    intermediateTokens: string[];
    /** token treated as $1 when sizing test swaps */
    usdAnchor: string;
    tokens: Record<string, string>;
    minLiquidity: Record<string, string>;
    dexes: DexEntry[];
    paths: PathEntry[];
}

export const IREGISTRY = new utils.Interface([
    "function getAllDexes() view returns (bytes32[])",
    "function getAllIntermediateTokens() view returns (address[])",
    "function owner() view returns (address)",
    "function dexesInfo(bytes32) view returns (address)",
    "function paths(address,address) view returns (bytes32)",
    "function getPath(address,address) view returns (tuple(address dex, address[] paths)[])",
    "function addDex(bytes32,address)",
    "function changeDexAddress(bytes32,address)",
    "function setPath(bytes32,address[])",
    "function setIntermediateToken(address[])",
]);

export const IERC20 = new utils.Interface([
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
]);

export const IDEX = new utils.Interface([
    "function tickSpacing(address,address) view returns (int24)",
    "function pairFee(address,address) view returns (uint24)",
    "function pool(address,address) view returns (address)",
    "function factory(address,address) view returns (address)",
    "function stable(address,address) view returns (bool)",
    "function nTokens(address) view returns (uint256)",
    "function router() view returns (address)",
    "function owner() view returns (address)",
    "function setFee(address,address,uint24)",
    "function setTickSpacing(address,address,int24)",
    "function pairSetup(address,address,bool,address)",
]);

// pool(address,address) returns bytes32 on BalancerDex and address on CurveDex.
// Same selector, so encode with IDEX and decode with whichever matches the kind.
export const IBALANCER_DEX = new utils.Interface([
    "function pool(address,address) view returns (bytes32)",
]);

export const IFACTORY = new utils.Interface([
    "function getPool(address,address,int24) view returns (address)",
    "function getPool(address,address,uint24) view returns (address)",
    "function getPair(address,address) view returns (address)",
]);

export const IAERO_ROUTER = new utils.Interface([
    "function poolFor(address,address,bool,address) view returns (address)",
    "function getAmountsOut(uint256,tuple(address from, address to, bool stable, address factory)[]) view returns (uint256[])",
]);

export const IBVAULT = new utils.Interface([
    "function getPoolTokens(bytes32) view returns (address[], uint256[], uint256)",
    "function queryBatchSwap(uint8 kind, tuple(bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, tuple(address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds) returns (int256[])",
]);

export const ICURVE_POOL = new utils.Interface([
    "function get_dy(int128,int128,uint256) view returns (uint256)",
    "function coins(uint256) view returns (address)",
]);

// Curve's newer pools index with uint256 rather than int128.
export const ICURVE_POOL_U = new utils.Interface([
    "function get_dy(uint256,uint256,uint256) view returns (uint256)",
]);

export const IALGEBRA = new utils.Interface([
    "function poolByPair(address,address) view returns (address)",
    "function quoteExactInput(bytes,uint256) returns (uint256 amountOut, uint16[] fees)",
]);

export const IQUOTER = new utils.Interface([
    "function quoteExactInput(bytes,uint256) returns (uint256 amountOut, uint160[] sqrtPriceX96After, uint32[] initializedTicksCrossed, uint256 gasEstimate)",
]);

export const IV2ROUTER = new utils.Interface([
    "function getAmountsOut(uint256,address[]) view returns (uint256[])",
]);

export const ICLFACTORY = new utils.Interface([
    "function tickSpacings() view returns (int24[])",
]);

const IMULTICALL = new utils.Interface([
    "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[]) payable returns (tuple(bool success, bytes returnData)[])",
]);

export interface Call { target: string; data: string }
export interface Res { success: boolean; data: string }

// The tooling only needs an RPC and, to send, a key. Hardhat is used when it is
// there so the hardhat repos keep working unchanged, but it is never required ---
// the Foundry repos have no hardhat to import.
function hardhatEthers(): any | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require("hardhat").ethers;
    } catch {
        return undefined;
    }
}

// The endpoint hardhat.config uses for `mainnet` throttles hard enough that the
// quoting passes crawl, so say so once rather than letting a run look hung.
const THROTTLED = "developer-access-mainnet.base.org";
let warned = false;

export function provider(): providers.Provider {
    const url = process.env.REGISTRY_RPC_URL;
    if (url) return new providers.JsonRpcProvider(url);
    const hh = hardhatEthers();
    if (!hh) throw new Error("set REGISTRY_RPC_URL (no hardhat runtime to fall back to)");
    const fallback: any = hh.provider;
    if (!warned && String(fallback?.connection?.url ?? "").includes(THROTTLED)) {
        warned = true;
        console.log(`note: ${THROTTLED} rate-limits heavily; set REGISTRY_RPC_URL for a faster, steadier run\n`);
    }
    return fallback;
}

/** Signer for the scripts that write. Reads and writes share one provider. */
export async function signer(): Promise<Signer> {
    const p = provider();
    const key = process.env.REGISTRY_PRIVATE_KEY;
    if (key) return new Wallet(key.startsWith("0x") ? key : `0x${key}`, p);
    if (process.env.REGISTRY_RPC_URL && process.env.MNEMONIC)
        return Wallet.fromMnemonic(process.env.MNEMONIC).connect(p);
    const hh = hardhatEthers();
    if (hh) {
        const signers = await hh.getSigners();
        if (signers.length) return signers[0];
    }
    throw new Error("no signer: set REGISTRY_PRIVATE_KEY, or MNEMONIC alongside REGISTRY_RPC_URL");
}

let pacing = 0; // ms to wait between requests, raised when the node rate-limits
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function classify(e: any): "gas" | "rate" | "other" {
    const msg = JSON.stringify(e?.error ?? e?.body ?? e?.message ?? e).toLowerCase();
    if (msg.includes("out of gas") || msg.includes("gas required exceeds") || msg.includes("gas limit")) return "gas";
    if (msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("-32016") || msg.includes("429")) return "rate";
    return "other";
}

export async function multicall(p: providers.Provider, calls: Call[], chunk = CHUNK): Promise<Res[]> {
    const out: Res[] = [];
    for (let i = 0; i < calls.length; i += chunk) out.push(...await run(p, calls.slice(i, i + chunk)));
    return out;
}

/**
 * A reverting call comes back inside the aggregate3 result, so any thrown error
 * is the node's problem, not the chain's. Gas caps are fixed by sending fewer
 * calls; rate limits are made worse by it, and are backed off instead. Nothing
 * is ever reported as an empty result on the node's behalf --- doing so would
 * silently turn a throttled endpoint into "no pool" and quietly change results.
 */
async function run(p: providers.Provider, slice: Call[], depth = 0): Promise<Res[]> {
    if (!slice.length) return [];
    const data = IMULTICALL.encodeFunctionData("aggregate3", [
        slice.map((c) => ({ target: c.target, allowFailure: true, callData: c.data })),
    ]);
    let last: any;
    for (let attempt = 0; attempt < 7; attempt++) {
        try {
            if (pacing) await sleep(pacing);
            const raw = await p.call({ to: MULTICALL3, data });
            const [decoded] = IMULTICALL.decodeFunctionResult("aggregate3", raw);
            if (pacing > 0 && attempt === 0) pacing = Math.max(0, pacing - 5);
            return decoded.map((r: any) => ({ success: r.success, data: r.returnData }));
        } catch (e) {
            last = e;
            const kind = classify(e);
            if (kind === "gas") {
                if (slice.length === 1) throw new Error(`single call to ${slice[0].target} exceeds the node gas cap`);
                const half = Math.ceil(slice.length / 2);
                return [...await run(p, slice.slice(0, half), depth + 1), ...await run(p, slice.slice(half), depth + 1)];
            }
            if (kind === "rate") pacing = Math.min(2000, pacing + 100);
            await sleep(250 * 2 ** attempt);
        }
    }
    throw new Error(
        `RPC failed after 7 attempts for a batch of ${slice.length} (${classify(last)}): ${last?.message ?? last}\n` +
        `Set REGISTRY_RPC_URL to an endpoint that tolerates this load.`);
}

/** Decode a result, returning undefined when the call reverted or produced nothing. */
export function decode<T>(iface: utils.Interface, fn: string, r: Res): T | undefined {
    if (!r.success || r.data === "0x") return undefined;
    try {
        return iface.decodeFunctionResult(fn, r.data)[0] as T;
    } catch {
        return undefined;
    }
}

export function loadManifest(): Manifest {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
}

export function saveManifest(m: Manifest) {
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 4) + "\n");
}

export const PROPOSALS = locate("REGISTRY_PROPOSALS", ["../../helpers/proposals.json", "../proposals.json"]);

/** A hop of a proposed route, with the dex-side params it was quoted with. */
export interface ProposalHop {
    from: string;
    to: string;
    pool: string;
    fee?: number;
    tickSpacing?: number;
    stable?: boolean;
    factory?: string;
    /** balancer: the pool id the quote used */
    poolId?: string;
}

export interface Proposal {
    sellToken: string;
    buyToken: string;
    gainBps: number;
    current: { dex: string; path: string[]; symbols: string; out: string };
    proposed: { dex: string; kind: DexKind; path: string[]; symbols: string; out: string; hops: ProposalHop[] };
}

export interface ProposalFile {
    network: string;
    registry: string;
    generatedAtBlock: number;
    usd: number;
    minBps: number;
    sizes: Record<string, string>;
    proposals: Proposal[];
}

/** One concrete way to get from a to b: a dex, a token route, and params per hop. */
export interface Route {
    dex: DexEntry;
    tokens: string[];
    tiers: number[];
    stable?: boolean[];
    pools?: string[];
    factories?: string[];
    /** balancer: the pool id per hop */
    poolIds?: string[];
    /** curve: the [i, j] coin indices per hop */
    curveIdx?: number[][];
    label: string;
}

export const alive = (r: Res) => r.success && r.data !== "0x";

export function encodePath(tokens: string[], tiers: number[], type: "uint24" | "int24") {
    const types: string[] = ["address"];
    const values: any[] = [tokens[0]];
    for (let i = 1; i < tokens.length; i++) { types.push(type, "address"); values.push(tiers[i - 1], tokens[i]); }
    return utils.solidityPack(types, values);
}

/** Encode an amountIn quote for a route, or undefined when the dex has no quoter. */
export function buildQuote(r: Route, amountIn: BigNumber): Call | undefined {
    const d = r.dex;
    if (d.kind === "uniV3" || d.kind === "cl") {
        if (!d.quoter) return undefined;
        const tiers = r.tokens.slice(1).map((_, i) => r.tiers[i] || d.defaultFee || 0);
        if (tiers.some((t) => !t)) return undefined;
        const path = encodePath(r.tokens, tiers, d.kind === "uniV3" ? "uint24" : "int24");
        return { target: d.quoter, data: IQUOTER.encodeFunctionData("quoteExactInput", [path, amountIn]) };
    }
    if (d.kind === "algebra") {
        // dynamic fees, so the path is just the tokens with nothing between them
        if (!d.quoter) return undefined;
        return { target: d.quoter, data: IALGEBRA.encodeFunctionData("quoteExactInput", [utils.solidityPack(r.tokens.map(() => "address"), r.tokens), amountIn]) };
    }
    if (d.kind === "balancer") {
        // GIVEN_IN chains hops by giving only the first step an amount
        if (!d.vault || !r.poolIds?.length) return undefined;
        const swaps = r.poolIds.map((poolId, i) => ({
            poolId, assetInIndex: i, assetOutIndex: i + 1,
            amount: i === 0 ? amountIn : 0, userData: "0x",
        }));
        const funds = { sender: ZERO, fromInternalBalance: false, recipient: ZERO, toInternalBalance: false };
        return { target: d.vault, data: IBVAULT.encodeFunctionData("queryBatchSwap", [0, swaps, r.tokens, funds]) };
    }
    if (d.kind === "univ2") {
        if (!d.router) return undefined;
        return { target: d.router, data: IV2ROUTER.encodeFunctionData("getAmountsOut", [amountIn, r.tokens]) };
    }
    if (d.kind === "solidly") {
        if (!d.router) return undefined;
        const legs = r.tokens.slice(0, -1).map((from, i) => ({
            from, to: r.tokens[i + 1], stable: r.stable?.[i] ?? false, factory: r.factories?.[i] ?? ZERO,
        }));
        return { target: d.router, data: IAERO_ROUTER.encodeFunctionData("getAmountsOut", [amountIn, legs]) };
    }
    return undefined;
}

/** Read each curve pool's coin ordering, needed before any get_dy call. */
export async function curveCoinIndex(p: providers.Provider, pools: string[]): Promise<Map<string, Map<string, number>>> {
    const uniq = [...new Set(pools.filter((x) => x && !isZeroHex(x)))];
    const calls: Call[] = [];
    for (const pool of uniq) for (let k = 0; k < 8; k++)
        calls.push({ target: pool, data: ICURVE_POOL.encodeFunctionData("coins", [k]) });
    const res = await multicall(p, calls);
    const out = new Map<string, Map<string, number>>();
    uniq.forEach((pool, pi) => {
        const m = new Map<string, number>();
        for (let k = 0; k < 8; k++) {
            const c = decode<string>(ICURVE_POOL, "coins", res[pi * 8 + k]);
            if (!c || isZeroHex(c)) break;
            m.set(lc(c), k);
        }
        if (m.size) out.set(lc(pool), m);
    });
    return out;
}

/**
 * Curve prices one pool at a time, so a multi-hop route is walked hop by hop
 * with each hop's output feeding the next. Returns the final amount per job,
 * zero where any hop could not be priced.
 */
export async function quoteCurve(
    p: providers.Provider,
    jobs: { route: Route; amount: BigNumber }[],
    coinIdx: Map<string, Map<string, number>>,
): Promise<BigNumber[]> {
    const amounts = jobs.map((j) => j.amount);
    const maxHops = Math.max(0, ...jobs.map((j) => j.route.tokens.length - 1));
    for (let h = 0; h < maxHops; h++) {
        const calls: Call[] = [];
        const idx: number[] = [];
        jobs.forEach((j, i) => {
            if (h >= j.route.tokens.length - 1 || amounts[i].isZero()) return;
            const pool = j.route.pools?.[h] ? lc(j.route.pools[h]) : undefined;
            const map = pool ? coinIdx.get(pool) : undefined;
            const from = map?.get(lc(j.route.tokens[h]));
            const to = map?.get(lc(j.route.tokens[h + 1]));
            if (from === undefined || to === undefined) { amounts[i] = BigNumber.from(0); return; }
            idx.push(i);
            // stableswap indexes with int128, newer crypto pools with uint256
            calls.push({ target: pool!, data: ICURVE_POOL.encodeFunctionData("get_dy", [from, to, amounts[i]]) });
            calls.push({ target: pool!, data: ICURVE_POOL_U.encodeFunctionData("get_dy", [from, to, amounts[i]]) });
        });
        if (!calls.length) break;
        const res = await multicall(p, calls, QUOTE_CHUNK);
        idx.forEach((i, k) => {
            amounts[i] = decode<BigNumber>(ICURVE_POOL, "get_dy", res[k * 2])
                ?? decode<BigNumber>(ICURVE_POOL_U, "get_dy", res[k * 2 + 1])
                ?? BigNumber.from(0);
        });
    }
    return amounts;
}

export function readQuote(r: Route, res: Res): BigNumber | undefined {
    if (!alive(res)) return undefined;
    if (r.dex.kind === "uniV3" || r.dex.kind === "cl") return decode<BigNumber>(IQUOTER, "quoteExactInput", res);
    if (r.dex.kind === "algebra") return decode<BigNumber>(IALGEBRA, "quoteExactInput", res);
    if (r.dex.kind === "balancer") {
        // deltas are signed: positive is paid in, negative is received
        const deltas = decode<BigNumber[]>(IBVAULT, "queryBatchSwap", res);
        const last = deltas?.[deltas.length - 1];
        return last?.isNegative() ? last.mul(-1) : undefined;
    }
    const amts = decode<BigNumber[]>(r.dex.kind === "solidly" ? IAERO_ROUTER : IV2ROUTER, "getAmountsOut", res);
    return amts?.[amts.length - 1];
}

export const lc = (a: string) => a.toLowerCase();
export const key = (a: string, b: string) => `${lc(a)}|${lc(b)}`;
export const isZeroHex = (v?: string) => !v || /^0x0+$/.test(v);

export type PathStatus = "ok" | "missing" | "dexMismatch" | "routeMismatch";

export interface PathDiff {
    entry: PathEntry;
    status: PathStatus;
    chainDexHex?: string;
    chainRoute?: string[];
}

export interface ChainPaths {
    /** every ordered pair in the manifest token universe that has a direct path */
    configured: Map<string, string>;
    /** manifest paths classified against the chain */
    diffs: PathDiff[];
    /** pairs configured on chain that the manifest does not list */
    extra: { sellToken: string; buyToken: string; dexHex: string }[];
}

/**
 * Reconcile the manifest against the registry. Shared by the audit and the sync
 * script so the two can never disagree about what "drifted" means.
 */
export async function readChainPaths(p: providers.Provider, m: Manifest): Promise<ChainPaths> {
    const tokens = Object.keys(m.tokens).map(lc);
    const probes: Call[] = [];
    const pairs: [string, string][] = [];
    for (const a of tokens) for (const b of tokens) {
        if (a === b) continue;
        pairs.push([a, b]);
        probes.push({ target: m.registry, data: IREGISTRY.encodeFunctionData("paths", [a, b]) });
    }
    const probed = await multicall(p, probes);
    const configured = new Map<string, string>();
    probed.forEach((r, i) => {
        const dex = decode<string>(IREGISTRY, "paths", r);
        if (!isZeroHex(dex)) configured.set(key(...pairs[i]), lc(dex!));
    });

    const listed = new Set(m.paths.map((x) => key(x.sellToken, x.buyToken)));
    const extra = [...configured.entries()]
        .filter(([k]) => !listed.has(k))
        .map(([k, dexHex]) => {
            const [sellToken, buyToken] = k.split("|");
            return { sellToken, buyToken, dexHex };
        });

    const full = await multicall(p, m.paths.map((x) => ({
        target: m.registry, data: IREGISTRY.encodeFunctionData("getPath", [x.sellToken, x.buyToken]),
    })));
    const byName = new Map(m.dexes.map((d) => [d.name, d]));
    const diffs: PathDiff[] = m.paths.map((entry, i) => {
        const chainDexHex = configured.get(key(entry.sellToken, entry.buyToken));
        if (!chainDexHex) return { entry, status: "missing" };
        const want = byName.get(entry.dex);
        if (want && chainDexHex !== lc(want.hex)) return { entry, status: "dexMismatch", chainDexHex };
        const legs = decode<any[]>(IREGISTRY, "getPath", full[i]);
        const chainRoute = legs && legs.length === 1 ? (legs[0].paths as string[]).map(lc) : undefined;
        if (!chainRoute || chainRoute.join(",") !== entry.path.map(lc).join(","))
            return { entry, status: "routeMismatch", chainDexHex, chainRoute };
        return { entry, status: "ok", chainDexHex, chainRoute };
    });

    return { configured, diffs, extra };
}
