#!/usr/bin/env node
/**
 * Reports `session -> (repo, branch)` to the board while an executor run is live — the
 * in-container twin of plugins/agent-telemetry. The CLI's OTLP metrics carry a session id and
 * nothing else; without this side channel the attribution join has no span to intersect a PR
 * branch with, and every executor run lands in the dashboard's unmatched bucket.
 *
 * Hard rules, inherited from the plugin:
 *   - never fail a run: every path exits 0, and nothing is written to stdout or stderr — the
 *     stream this container prints is the run output the driver tails and the board stores;
 *   - never lag a run: one short-timeout request per sample, no retries, no queue, no spool;
 *   - send session, repo and branch only. No paths, no credentials, no command text.
 *
 * Environment (set by the driver; FACTORY_STATS_URL is the switch):
 *   FACTORY_STATS_URL    the board's base URL. Unset means inert — a hand-run container
 *                        reports nothing rather than guessing an endpoint.
 *   BELLOWS_SESSION_ID   the session to report. The claude runner is always told (the driver
 *                        mints the uuid); the opencode runner is told only on a follow-up, and
 *                        otherwise discovers the id live from opencode's session database.
 *   INGEST_TOKEN         the board's optional ingest token, sent as a header when set.
 *   WORKDIR              the checkout to sample. Defaults to the current directory.
 *   XDG_DATA_HOME        where opencode keeps its session database (opencode/opencode.db).
 *
 * `--once` takes a single sample and exits; the entrypoint runs it once more after the CLI
 * closes, so a run's last branch state is reported even when the CLI exits the moment the
 * conversation ends.
 */
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

// The one line the two copies differ on: the agent the metrics carry, exactly as agentOf()
// derives it from the OTLP metric names — a branch span under any other name joins to nothing.
const AGENT = 'opencode';

const REQUEST_TIMEOUT_MS = 2_000;
const SAMPLE_INTERVAL_MS = 20_000;
const DISCOVER_INTERVAL_MS = 2_000;

const ENDPOINT = (process.env.FACTORY_STATS_URL ?? '').trim();
const CWD = process.env.WORKDIR ?? process.cwd();

function git(args) {
    try {
        return execFileSync('git', args, {
            cwd: CWD,
            encoding: 'utf8',
            timeout: 1000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return null;
    }
}

/** "owner/name" from the origin URL, covering both SSH and HTTPS remotes — the plugin's regex. */
function repoSlug() {
    const url = git(['remote', 'get-url', 'origin']);
    if (!url) return null;
    const match = /(?:[:/])([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
    return match?.[1] ?? null;
}

/**
 * The session to report. An id handed in by the driver wins: it is the id the runner was
 * actually given, and on a follow-up the whole point is to keep reporting the SAME
 * conversation. Otherwise — an opencode fresh run — discover it live: opencode mints its own
 * ids (`ses_…`) and cannot adopt one, so nobody can hand it in advance. The newest ROOT
 * session is the run's own conversation (subagents create children); the same query and the
 * same judgement as the close-time readout the driver ships.
 */
function resolveSessionId() {
    const handed = (process.env.BELLOWS_SESSION_ID ?? '').trim();
    if (handed) return handed;
    const data = process.env.XDG_DATA_HOME;
    if (!data) return null;
    try {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(join(data, 'opencode', 'opencode.db'), { readOnly: true });
        const row = db.prepare(
            'select id from session where parent_id is null order by time_created desc limit 1',
        ).get();
        db.close();
        return row?.id ?? null;
    } catch {
        // No database yet, or no node:sqlite: there is nothing to discover. The loop looks
        // again, and a handed-in id still works.
        return null;
    }
}

async function report(sessionId) {
    // The plugin fires everywhere, including outside a worktree; so does this. Leave immediately.
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return;
    const repo = repoSlug();
    if (!repo) return;
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const headers = { 'content-type': 'application/json' };
    const token = (process.env.INGEST_TOKEN ?? '').trim();
    if (token) headers['x-factory-ingest-token'] = token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        await fetch(`${ENDPOINT}/api/sessions/branch`, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
                agent: AGENT,
                sessionId,
                repo,
                // Detached HEAD reports null. The literal 'HEAD' is not a branch name and
                // would join to nothing while looking like one.
                branch: branch && branch !== 'HEAD' ? branch : null,
                headSha: git(['rev-parse', 'HEAD']),
                at: new Date().toISOString(),
            }),
        });
    } finally {
        clearTimeout(timer);
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    if (!ENDPOINT) return;

    if (process.argv.includes('--once')) {
        const sessionId = resolveSessionId();
        if (sessionId) await report(sessionId);
        return;
    }

    // Report the moment a session resolves, then re-sample on the interval so the span the join
    // intersects follows the branch as the agent moves it. A CHANGED session id reports
    // immediately regardless of the interval: the boundary between two conversations is
    // precisely what must not blur into one span.
    let reported = null;
    let lastReportAt = 0;
    for (;;) {
        const sessionId = resolveSessionId();
        if (sessionId && (sessionId !== reported || Date.now() - lastReportAt >= SAMPLE_INTERVAL_MS)) {
            await report(sessionId).catch(() => {});
            reported = sessionId;
            lastReportAt = Date.now();
        }
        await sleep(DISCOVER_INTERVAL_MS);
    }
}

// A dashboard that is down, a malformed payload, a missing git — all silent no-ops.
main()
    .catch(() => {})
    .finally(() => process.exit(0));
