/**
 * JSON-RPC proxy that lets this repo's Hardhat (2.13.1) fork Arbitrum again.
 *
 * Arbitrum RPCs stopped returning `totalDifficulty` on blocks, and Hardhat 2.13.1 refuses a fork
 * block without it ("Invalid value undefined supplied to : RpcBlockWithTransactions |
 * null/totalDifficulty"). This forwards every request to FORK_UPSTREAM_URL and adds
 * `totalDifficulty: "0x0"` to any block that lacks it. Nothing else is changed.
 *
 *   FORK_UPSTREAM_URL=https://arb-mainnet.g.alchemy.com/v2/<key> npx ts-node scripts/utils/fork-proxy.ts
 *   FORK_URL=http://127.0.0.1:8546 npx hardhat test
 */
import http from "http";
import https from "https";

const upstream = new URL(process.env.FORK_UPSTREAM_URL ?? "");
const port = Number(process.env.FORK_PROXY_PORT ?? 8546);

function patch(message: any) {
    const block = message?.result;
    if (block && typeof block === "object" && "parentHash" in block && block.totalDifficulty === undefined) {
        block.totalDifficulty = "0x0";
    }
    return message;
}

function forward(body: string): Promise<string> {
    const client = upstream.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
        const req = client.request(upstream, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve(data));
        });
        req.on("error", reject);
        req.end(body);
    });
}

http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
        try {
            const parsed = JSON.parse(await forward(body));
            const out = Array.isArray(parsed) ? parsed.map(patch) : patch(parsed);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(out));
        } catch (e) {
            res.writeHead(502);
            res.end(String(e));
        }
    });
}).listen(port, "127.0.0.1", () => console.log(`fork proxy on http://127.0.0.1:${port} -> ${upstream.host}`));
