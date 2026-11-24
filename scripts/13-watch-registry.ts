import { spawnSync } from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { URL } from "url";

import { Manifest, ProposalFile, loadManifest } from "./utils/registry";

// Runs the checks a maintainer would run, and speaks up only when something
// needs doing. Meant for a scheduler: no signer, no transactions, read only.
//
// WATCH_MODE              audit | routes | both        (default both)
// WATCH_MIN_BPS           report improvements at or above this (default 100, 1%)
// WATCH_ALWAYS=1          post even when there is nothing to do
// WATCH_DRY=1             print the message instead of posting it
// WATCH_KEEP=1            keep the proposals file this run produces
// WATCH_LINK              url to append, e.g. the CI run
// WATCH_DISCORD_WEBHOOK   discord webhook to post to
// WATCH_TELEGRAM_TOKEN    telegram bot token, with
// WATCH_TELEGRAM_CHAT     the chat id to post to
const MODE = process.env.WATCH_MODE ?? "both";
const MIN_BPS = Number(process.env.WATCH_MIN_BPS ?? 100);
const ALWAYS = process.env.WATCH_ALWAYS === "1";
const DRY = process.env.WATCH_DRY === "1";
const LINK = process.env.WATCH_LINK;

/** Run one of the sibling scripts and hand back what it said. */
function run(script: string, extra: Record<string, string> = {}) {
    const file = path.join(__dirname, script);
    const res = spawnSync(process.execPath, ["-r", "ts-node/register", file], {
        encoding: "utf8",
        env: { ...process.env, ...extra },
        maxBuffer: 32 * 1024 * 1024,
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    return { code: res.status ?? 1, out };
}

interface AuditResult { errors: number; warnings: number; accepted: number; lines: string[]; ran: boolean }

/**
 * The audit prints its findings grouped under ERROR/WARN headings and ends with
 * a count, so the count is the verdict and the ERROR bullets are the detail.
 * Findings the manifest accepts are counted apart and never fail the run, but
 * the count is kept: a silence nobody is reminded of is one nobody revisits.
 *
 * The count is a line of its own, and is only read as one. Everything above it
 * is indented, and since the audit prints each accepted entry's reason, some of
 * it is prose a maintainer wrote --- which must never be taken for the verdict.
 */
function readAudit(out: string): AuditResult {
    const tally = out.match(/^(\d+) error\(s\), (\d+) warning\(s\)(?:, (\d+) accepted)?$/m);
    const lines: string[] = [];
    let inError = false;
    for (const line of out.split("\n")) {
        if (/^ERROR /.test(line)) { inError = true; lines.push(line.trim()); continue; }
        if (/^WARN /.test(line) || /^\s*$/.test(line)) { inError = false; continue; }
        if (inError && /^\s+- /.test(line)) lines.push(line.trim());
    }
    return {
        ran: !!tally,
        errors: tally ? Number(tally[1]) : 0,
        warnings: tally ? Number(tally[2]) : 0,
        accepted: tally?.[3] ? Number(tally[3]) : 0,
        lines,
    };
}

/** The counts that are not errors, as they read after the verdict. */
function aside(a: AuditResult) {
    return `${a.warnings} warning(s)${a.accepted ? `, ${a.accepted} accepted` : ""}`;
}

/**
 * Why a script stopped, in its own words. A thrown error ends in its stack, and
 * after that in a dump of its own fields, so the last lines of a failed run are
 * node internals or a stray `code:` and a closing brace. The line that names
 * the error is the one worth reading, so that is where this starts: the last
 * such line and what follows it, stack frames aside. A script that stopped
 * without throwing has no such line, and then its last three are the answer.
 *
 * "Names the error" is `Error:` or `SomethingError:` at the start of a line,
 * capital and colon both --- the dump has fields like `serverError:` in it, and
 * those are detail, not the reason.
 *
 * This text is posted, and an RPC error quotes the endpoint it could not
 * reach, whose path is where the key lives. So a url keeps its scheme and
 * host and loses the rest, any `user:key@` in front of the host included:
 * enough to say which endpoint, never enough to use it.
 */
function lastWords(out: string) {
    const said = out.split("\n").map((l) => l.trim()).filter((l) => l && !/^at\s/.test(l));
    let named = -1;
    said.forEach((l, i) => { if (/^(?:[A-Z]\w*)?Error\b[^:]*:/.test(l)) named = i; });
    const lines = named >= 0 ? said.slice(named, named + 3) : said.slice(-3);
    return lines.join(" | ")
        .replace(/\b((?:https?|wss?):\/\/)(?:[^@/\s"'`,)]*@)?([^/?#\s"'`,)]+)[^\s"'`,)]*/gi, "$1$2")
        .slice(0, 300);
}

function pct(bps: number) {
    return `${(bps / 100).toFixed(2)}%`;
}

async function post(url: string, body: unknown): Promise<void> {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    await new Promise<void>((resolve, reject) => {
        const req = https.request(
            {
                hostname: target.hostname,
                path: `${target.pathname}${target.search}`,
                method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const status = res.statusCode ?? 0;
                    // the body can carry the token back in an error, so it is never printed
                    if (status >= 200 && status < 300) resolve();
                    else reject(new Error(`${target.hostname} answered ${status}`));
                });
            },
        );
        req.on("error", (e) => reject(new Error(`${target.hostname}: ${e.message}`)));
        req.write(payload);
        req.end();
    });
}

/** Post wherever this run is configured to post. Returns the places it reached. */
async function notify(text: string): Promise<string[]> {
    const sent: string[] = [];
    const discord = process.env.WATCH_DISCORD_WEBHOOK;
    const tgToken = process.env.WATCH_TELEGRAM_TOKEN;
    const tgChat = process.env.WATCH_TELEGRAM_CHAT;
    if (discord) {
        await post(discord, { content: text.slice(0, 1900) });
        sent.push("discord");
    }
    if (tgToken && tgChat) {
        await post(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
            chat_id: tgChat, text: text.slice(0, 4000), disable_web_page_preview: true,
        });
        sent.push("telegram");
    }
    return sent;
}

/**
 * Say it wherever this run posts, and never lose the message: a scheduler that
 * cannot reach discord still has to leave the findings somewhere readable.
 */
async function tell(text: string): Promise<boolean> {
    if (DRY) { console.log(`\n${text}`); return true; }
    try {
        const sent = await notify(text);
        if (sent.length) { console.log(`told ${sent.join(" and ")}`); return true; }
        console.log("nowhere to post --- set WATCH_DISCORD_WEBHOOK, or WATCH_TELEGRAM_TOKEN with WATCH_TELEGRAM_CHAT");
    } catch (e: any) {
        // the error carries the host and status only, never the token
        console.log(`could not post: ${e.message}`);
        process.exitCode = 1;
    }
    console.log(`\n${text}`);
    return false;
}

async function main() {
    const m: Manifest = loadManifest();
    const chain = m.network;
    const doAudit = MODE === "audit" || MODE === "both";
    const doRoutes = MODE === "routes" || MODE === "both";

    let audit: AuditResult = { errors: 0, warnings: 0, accepted: 0, lines: [], ran: false };
    if (doAudit) {
        const r = run("09-audit-registry.ts");
        audit = readAudit(r.out);
        if (!audit.ran) {
            // the audit never reached its own summary, so it did not run to completion
            await tell(`⚠️ ${chain}: the registry audit did not complete (exit ${r.code})\n${lastWords(r.out)}`
                + (LINK ? `\n${LINK}` : ""));
            process.exitCode = 1;
            return;
        }
        console.log(`audit: ${audit.errors} error(s), ${aside(audit)}`);
    }

    let broken: ProposalFile["proposals"] = [];
    let better: ProposalFile["proposals"] = [];
    let unrouted: ProposalFile["proposals"] = [];
    if (doRoutes) {
        // never overwrite the maintainer's own proposals file from a scheduled run
        const out = process.env.WATCH_KEEP === "1"
            ? undefined
            : path.join(os.tmpdir(), `registry-watch-${chain}.json`);
        const r = run("11-propose-routes.ts", out ? { PROPOSE_OUT: out } : {});
        const file = out ?? process.env.REGISTRY_PROPOSALS;
        if (r.code !== 0 || !file || !fs.existsSync(file)) {
            await tell(`⚠️ ${chain}: the route check did not complete (exit ${r.code})\n${lastWords(r.out)}`
                + (LINK ? `\n${LINK}` : ""));
            process.exitCode = 1;
            return;
        }
        const parsed: ProposalFile = JSON.parse(fs.readFileSync(file, "utf8"));
        broken = parsed.proposals.filter((x) => x.gainBps === -1);
        unrouted = parsed.proposals.filter((x) => x.gainBps === -2);
        better = parsed.proposals.filter((x) => x.gainBps >= MIN_BPS).sort((a, b) => b.gainBps - a.gainBps);
        console.log(`routes: ${broken.length} broken, ${better.length} improvement(s) at or above ${pct(MIN_BPS)}`);
    }

    const worth = audit.errors > 0 || broken.length > 0 || better.length > 0 || unrouted.length > 0;
    if (!worth && !ALWAYS) {
        console.log(`${chain}: nothing to do, staying quiet`);
        return;
    }

    const parts: string[] = [];
    parts.push(worth ? `**${chain} — registry needs attention**` : `**${chain} — registry is clean**`);
    if (audit.ran) {
        if (audit.errors) {
            parts.push(`\n🔴 audit: ${audit.errors} error(s), ${aside(audit)}`);
            for (const l of audit.lines.slice(0, 8)) parts.push(`   ${l}`);
            if (audit.lines.length > 8) parts.push(`   … ${audit.lines.length - 8} more`);
        } else {
            parts.push(`\n🟢 audit: clean (${aside(audit)})`);
        }
    }
    if (broken.length) {
        parts.push(`\n🔴 ${broken.length} registered route(s) do not quote — these revert on doHardWork`);
        for (const x of broken.slice(0, 6)) parts.push(`   ${x.current.symbols} → ${x.proposed.symbols} [${x.proposed.dex}]`);
    }
    if (unrouted.length) {
        parts.push(`\n🟠 ${unrouted.length} pair(s) with no route registered`);
        for (const x of unrouted.slice(0, 6)) parts.push(`   ${x.proposed.symbols} [${x.proposed.dex}]`);
    }
    if (better.length) {
        parts.push(`\n🟡 ${better.length} better route(s) at or above ${pct(MIN_BPS)}`);
        for (const x of better.slice(0, 6)) {
            parts.push(`   +${pct(x.gainBps)} ${x.current.symbols} → ${x.proposed.symbols} [${x.proposed.dex}]`);
        }
        if (better.length > 6) parts.push(`   … ${better.length - 6} more`);
    }
    if (worth) parts.push(`\nReview with \`yarn registry:routes\`, then \`APPLY_EXECUTE=1 yarn registry:apply\`.`);
    if (LINK) parts.push(LINK);

    await tell(parts.join("\n"));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
