#!/usr/bin/env node
/**
 * Reports `session -> (repo, branch)` to the Factory Stats dashboard.
 *
 * This exists because Claude Code's OpenTelemetry metrics carry no repo name, no branch and
 * no commit SHA — only a session id. Without this side channel, AI usage can never be
 * attributed to the repo the work happened in.
 *
 * Hard rules, because this plugin is enabled at user scope and therefore runs in EVERY repo
 * on the machine:
 *   - never fail a session: every path exits 0, and nothing is written to stderr;
 *   - never lag a session: one short-timeout request, no retries, no queue;
 *   - send repo and branch only. `cwd` and `transcript_path` are absolute host paths and are
 *     used locally but never transmitted.
 *
 * There is deliberately no retry or spool file. The signal is a periodic sample whose loss
 * model is already benign, and a spool would add unbounded disk growth and replay bugs to
 * protect it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ENDPOINT = process.env.FACTORY_STATS_URL ?? 'http://127.0.0.1:8080';
/**
 * The credential: a Factory personal access token (`fat_…`, minted from the dashboard's settings
 * page), sent as `authorization: Bearer`. A board running AUTH_MODE=github refuses a branch write
 * without one — the org the report lands in comes from the token's membership, never from the
 * repo the payload names. Unset keeps the request unauthenticated, which is all a local
 * AUTH_MODE=none dashboard ever asks for. Never logged, never written anywhere.
 */
const TOKEN = (process.env.FACTORY_STATS_TOKEN ?? '').trim();
const REQUEST_TIMEOUT_MS = 200;

/** One sample per session per interval, so a Bash-heavy session does not spawn git per call. */
const SAMPLE_INTERVAL_MS = 20_000;

function git(args, cwd) {
    try {
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            timeout: 1000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return null;
    }
}

/** "owner/name" from the origin URL, covering both SSH and HTTPS remotes. */
function repoSlug(cwd) {
    const url = git(['remote', 'get-url', 'origin'], cwd);
    if (!url) return null;
    const match = /(?:[:/])([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
    return match?.[1] ?? null;
}

function shouldSample(sessionId, event) {
    // Session boundaries always report: they are what open and close the interval the
    // dashboard reads.
    if (event === 'SessionStart' || event === 'SessionEnd') return true;

    const marker = join(tmpdir(), `factory-stats-${sessionId.replace(/[^\w-]/g, '')}`);
    try {
        if (existsSync(marker)) {
            const last = Number(readFileSync(marker, 'utf8'));
            if (Number.isFinite(last) && Date.now() - last < SAMPLE_INTERVAL_MS) return false;
        }
        writeFileSync(marker, String(Date.now()));
    } catch {
        // A tmpdir we cannot write to means sampling every call, which is noisier but correct.
    }
    return true;
}

async function main() {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;

    const hook = JSON.parse(input);
    const cwd = hook.cwd ?? process.cwd();
    const sessionId = hook.session_id;
    if (!sessionId) return;

    // The plugin fires everywhere, including outside a worktree. Leave immediately.
    if (git(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') return;
    if (!shouldSample(sessionId, hook.hook_event_name)) return;

    const repo = repoSlug(cwd);
    if (!repo) return;

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const headers = { 'content-type': 'application/json' };
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        await fetch(`${ENDPOINT}/api/sessions/branch`, {
            method: 'POST',
            // The request may carry the token, and a redirect must not forward it.
            redirect: 'error',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
                agent: 'claude-code',
                sessionId,
                repo,
                // Detached HEAD reports null. The literal 'HEAD' is not a branch name and
                // would join to nothing while looking like one.
                branch: branch && branch !== 'HEAD' ? branch : null,
                headSha: git(['rev-parse', 'HEAD'], cwd),
                at: new Date().toISOString(),
            }),
        });
    } finally {
        clearTimeout(timer);
    }
}

// A dashboard that is down, a malformed payload, a missing git — all silent no-ops.
try {
    await main();
} catch {
    // intentionally empty
}
process.exit(0);
