#!/usr/bin/env node
/**
 * The rate-limit watch: kills the CLI when the provider has rate-limited it into a zombie.
 *
 * Measured 2026-09-13 (job 3f7aa94c): opencode's `run` took a 429 "Rate limit exceeded" on its
 * first model call, logged the stream error, and then hung on its spinner for an hour — no exit,
 * no retry, no output — while the driver dutifully renewed the lease and the board showed
 * "running". The error reaches only opencode's own log file; the session database keeps an empty
 * stub for the step, and the CLI's stdout carries the spinner line, so this is the one place the
 * failure is visible.
 *
 * A background SIBLING of the CLI, like branch-reporter.cjs: it tails the log file the run
 * writes, and when OUR run's newest word is a rate-limit stream error that has stayed the newest
 * word past the quiet window, it terminates the CLI so the attempt fails and the board records
 * the rate limit instead of a two-hour timeout. Until then it never speaks: stdout and stderr
 * belong to the run, and the one line it ever prints is the kill reason, which the driver's
 * output tail carries into the failed attempt's report.
 *
 * Scoping: the log under XDG_DATA_HOME is the member's, shared by every run the member has
 * live. This run is bound by its boot line — `run=<id> message="creating instance"
 * directory=<WORKDIR>` — read from the watcher's start offset, so a concurrent task in another
 * worktree (or a previous attempt's stale lines) can never kill us and we can never kill them.
 *
 * Environment (set by the entrypoint; paths, never credentials):
 *   WORKDIR             the working directory the CLI runs in — the boot line's directory.
 *   XDG_DATA_HOME       where opencode writes opencode/log/opencode.log. Unset means inert.
 *   CLI_PID             the CLI process to terminate. Unset or dead means inert.
 *   RATE_LIMIT_QUIET_MS how long the rate limit must stay the run's last word before the kill.
 *                       Default 300000 — opencode's own retries give up in seconds, so five
 *                       minutes of total silence is a zombie with room to spare.
 */
const { openSync, readSync, fstatSync, closeSync } = require('node:fs');
const { join } = require('node:path');

const QUIET_MS = Math.max(1_000, Number(process.env.RATE_LIMIT_QUIET_MS ?? 300_000));
// Each tick re-reads and re-judges, so a small quiet window wants a small poll — this is what
// makes the smoke test take seconds instead of minutes. Capped at 15s so a production run
// watches at a leisurely cadence.
const POLL_MS = Math.min(15_000, Math.max(500, Math.floor(QUIET_MS / 4)));

const WORKDIR = process.env.WORKDIR ?? process.cwd();
const DATA = (process.env.XDG_DATA_HOME ?? '').trim();
const LOG = DATA ? join(DATA, 'opencode', 'log', 'opencode.log') : null;
const CLI_PID = Number(process.env.CLI_PID ?? 0);

if (!LOG || !CLI_PID || !WORKDIR) process.exit(0);

const alive = () => {
    try {
        process.kill(CLI_PID, 0);
        return true;
    } catch {
        return false;
    }
};

/** The run keeps logging under `run=<id> ` after the level field; the spaces are the boundary. */
const runTag = (id) => ` run=${id} `;

let runId = null;
let lastRunLineAt = 0;
let rateLimitText = null;
let offset = 0;
let carry = ''; // a trailing partial line from the last read, waiting for its newline
let killed = false;

function kill(reason) {
    killed = true;
    // The reason travels on stderr, into the driver's output tail and the failed attempt's
    // report — the one line this script ever prints.
    process.stderr.write(
        `[opencode-executor] the model provider returned "${reason}" and the run made no ` +
            `progress for ${Math.round(QUIET_MS / 1000)}s after it — stopping the hung CLI so the ` +
            'attempt fails on the rate limit instead of idling to its timeout. Retry when the quota resets.\n',
    );
    // SIGKILL, not SIGTERM: measured on the real zombie this watch exists for, opencode handles
    // SIGTERM and exits 0 — a graceful death the driver would read as a run that SUCCEEDED with
    // no work done. The exit code is the only failure channel to the driver, so the kill must be
    // one the CLI cannot turn polite. A zombie has no state worth a graceful shutdown: the
    // session database is WAL sqlite, written nothing for the whole quiet window.
    try {
        process.kill(CLI_PID, 'SIGKILL');
    } catch {
        /* gone already */
    }
    // Stay up briefly so the stderr write above drains before this process ends; the entry
    // point's own TERM reaps us sooner on the close path.
    setTimeout(() => process.exit(0), 1_000);
}

const timer = setInterval(() => {
    if (killed) return;
    if (!alive()) process.exit(0);
    // The quiet judgment comes FIRST, before any file read: a zombie's whole signature is that
    // the log has gone silent, and the read below early-returns on exactly that — so judging
    // after it would never judge at all.
    const now = Date.now();
    if (rateLimitText !== null && now - lastRunLineAt >= QUIET_MS) {
        kill(rateLimitText);
        return;
    }
    let data;
    try {
        // The watcher starts at the file's end: a previous attempt of the same job logged the
        // same directory, and its boot line must never bind us to a dead run. A shrunk file is a
        // truncated or rotated one — start over from the top.
        const fd = openSync(LOG, 'r');
        try {
            const size = fstatSync(fd).size;
            if (size < offset) {
                offset = 0;
                carry = '';
            }
            if (size === offset) return;
            const buf = Buffer.alloc(size - offset);
            readSync(fd, buf, 0, buf.length, offset);
            offset = size;
            data = carry + buf.toString('utf8');
            if (data.endsWith('\n')) {
                carry = '';
            } else {
                // The write landed mid-line between polls; judge only what is complete and
                // carry the tail into the next read, so a 429 split across two polls is
                // still seen whole.
                carry = data.slice(data.lastIndexOf('\n') + 1);
                data = data.slice(0, data.lastIndexOf('\n') + 1);
            }
        } finally {
            closeSync(fd);
        }
    } catch {
        return; // not there yet, or momentarily unreadable — the next tick retries
    }
    for (const line of data.split('\n')) {
        if (runId === null) {
            if (!line.includes('creating instance')) continue;
            const dir = `directory=${WORKDIR}`;
            if (!line.includes(dir) && !line.includes(`directory="${WORKDIR}"`)) continue;
            const match = /\brun=([0-9A-Za-z_-]+)/.exec(line);
            if (!match) continue;
            runId = match[1];
            lastRunLineAt = now;
            continue;
        }
        if (!line.includes(runTag(runId))) continue;
        lastRunLineAt = now;
        if (line.includes('stream error')) {
            const message = /error\.error="([^"]*)"/.exec(line)?.[1] ?? '';
            if (/rate limit/i.test(line) || /\b429\b/.test(message)) rateLimitText = message || 'HTTP 429';
        }
    }
}, POLL_MS);

// The interval above is what keeps this process alive; every exit is an explicit one — inert
// setup, a CLI that died on its own, or the kill path's final SIGKILL check.
