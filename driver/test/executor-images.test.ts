import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The executor images carry the branch reporter — the in-container twin of
 * plugins/agent-telemetry — and nothing else in the offline suite reads these files, so the
 * assertions here are what pins the wire contract and the entrypoint wiring. The build contexts
 * are the image directories, so a file that goes missing fails here instead of silently
 * un-attributing every executor run.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const CLAUDE_REPORTER = 'docker/claude-executor/branch-reporter.cjs';
const OPENCODE_REPORTER = 'docker/opencode-executor/branch-reporter.cjs';

describe('the executor branch reporter', () => {
    // Deliberate copies, like the collector's per-branch blocks: one file per image, byte-equal
    // after the agent constant, so a fix to one lands in the other by construction. The agent
    // values are exactly the ones agentOf() derives from the OTLP metric names — a mismatch here
    // would report branch spans no session summary would ever join to.
    it('ships in both images, identical except the agent it reports as', () => {
        const claude = read(CLAUDE_REPORTER);
        const opencode = read(OPENCODE_REPORTER);
        const stripAgent = (s: string) => s.replace(/const AGENT = '[^']+';/, "const AGENT = 'X';");
        expect(stripAgent(opencode)).toBe(stripAgent(claude));
        expect(claude).toContain("const AGENT = 'claude-code';");
        expect(opencode).toContain("const AGENT = 'opencode';");
    });

    // claude-home/ cannot hold it: the Remote Control auth volume mounts over CLAUDE_CONFIG_DIR
    // and would shadow the script on exactly the runs that most want to be attributed.
    it('is copied to /usr/local/bin by both Dockerfiles, never into a config home', () => {
        for (const dir of ['docker/claude-executor', 'docker/opencode-executor']) {
            const dockerfile = read(`${dir}/Dockerfile`);
            expect(dockerfile).toMatch(
                new RegExp(`COPY[^\\n]*branch-reporter\\.cjs /usr/local/bin/branch-reporter\\.cjs`),
            );
            expect(dockerfile).not.toMatch(/home\/COPY[^\n]*branch-reporter/);
            expect(dockerfile).not.toMatch(/branch-reporter[^\n]*-home\//);
        }
    });

    // The entrypoint shape: launched beside the CLI (never as its child, so a CLI crash cannot
    // take it down mid-run), stdio discarded (the run's output stream is the CLI's), a close-time
    // `--once` sample, and the CLI's exit status preserved through the `exec` it replaced. The
    // shell is PID 1, so it also owns the runtime's TERM/INT: both children are tracked by PID,
    // the signal is forwarded to both, and the CLI is waited out past the trap-interrupted
    // `wait` returns so its status — a signal-death 143 included — is what the script exits with.
    it.each([
        ['docker/claude-executor/entrypoint.sh', 'claude'],
        ['docker/opencode-executor/entrypoint.sh', 'opencode'],
    ])('%s launches the reporter beside the CLI, forwards signals, and samples once at close', (entrypoint, cli) => {
        const entry = read(entrypoint);
        // --disable-warning: node:sqlite still emits an ExperimentalWarning on stderr, and the
        // reporter's contract is that IT never speaks — node's own warning must not either.
        expect(entry).toMatch(
            /node --disable-warning=ExperimentalWarning \/usr\/local\/bin\/branch-reporter\.cjs >\/dev\/null 2>&1 &\n/,
        );
        // Both children tracked: the reporter and the CLI each hand their PID back to the shell.
        expect(entry).toMatch(/^REPORTER_PID=\$!$/m);
        expect(entry).toMatch(new RegExp(`^${cli} "\\$@" &$`, 'm'));
        expect(entry).toMatch(/^CLI_PID=\$!$/m);
        // The CLI runs as a background child now, so the close-time sample can run after it;
        // a leftover `exec` would turn the script into the PID-1 replacement and skip it.
        expect(entry).not.toMatch(new RegExp(`^exec ${cli} `, 'm'));
        // TERM/INT reaching PID 1 is forwarded to BOTH children — without that, a `docker stop`
        // leaves the CLI running until the runtime's forced kill.
        expect(entry).toMatch(/^trap \w+ TERM INT$/m);
        expect(entry).toMatch(/kill -TERM "\$CLI_PID" "\$REPORTER_PID"/);
        // `wait` returns 128+signal when the trap interrupts it, indistinguishable from a child
        // that died to that signal — so the CLI is waited on in a loop until it is really gone
        // (the kill -0 probe), and the reporter is terminated and reaped before the close-time
        // sample so nothing outlives the run.
        expect(entry).toMatch(/while :; do\n    wait "\$CLI_PID"\n    STATUS=\$\?\n    kill -0 "\$CLI_PID" 2>\/dev\/null \|\| break\ndone/);
        expect(entry).toMatch(/kill -TERM "\$REPORTER_PID" 2>\/dev\/null \|\| true/);
        expect(entry).toMatch(/wait "\$REPORTER_PID" 2>\/dev\/null \|\| true/);
        expect(entry).toMatch(/branch-reporter\.cjs --once/);
        expect(entry).toMatch(/exit "\$STATUS"/);
    });

    // opencode mints its own session ids and tells nobody before the run starts — discovery
    // polls the session database live. The query must be the shipped readout's exact query:
    // the readout is what decided "newest root session in the run's own directory" means the
    // run's own conversation (subagents create children, and the per-member database would
    // otherwise cross-report two concurrent fresh runs), and the two readers must never
    // disagree about which row that is.
    it('discovers the opencode session with the shipped readout’s exact query', () => {
        const query = 'select id from session where parent_id is null and directory = ? order by time_created desc limit 1';
        expect(read(OPENCODE_REPORTER)).toContain(query);
        expect(read('driver/src/scripts/opencode-readout.cjs')).toContain(query);
    });
});

/*
 * The entrypoints are plain POSIX sh, so the signal contract can be run, not just pinned by
 * regex: a stub CLI on PATH proves the TERM was FORWARDED (a marker only the stub writes),
 * that the CLI's exit status — chosen and signal-death alike — is what the shell re-raises,
 * and that the shell reaps the reporter and exits instead of sitting in wait on a child the
 * runtime already gave up on. The reporter itself cannot run here (/usr/local/bin is the
 * image's), but every one of its invocations is stdio-discarded and failure-tolerated, which
 * is exactly what lets the rest be assertable offline.
 */
const STUB = `#!/bin/sh
# Stand-in CLI. Installs its own TERM trap FIRST (an early forward must still leave the
# marker), records that it started only after a settle — the entrypoint needs a fork plus
# two builtins to get its trap up, and the test must never signal before that — then blocks
# in the wait builtin, which a trap interrupts at once, where a foreground sleep would
# defer it. Without a signal it exits with STUB_STATUS after STUB_SLEEP seconds.
trap 'echo "$$" > "$STUB_DIR/signaled"; exit 143' TERM
sleep "\${STUB_SETTLE:-0}"
echo started > "$STUB_DIR/started"
sleep "\${STUB_SLEEP:-0}" &
wait "$!"
exit "\${STUB_STATUS:-0}"
`;

// Signaling before the entrypoint's trap exists would kill the shell with the default action
// and make the test measure nothing; half a second covers the fork-and-two-builtins window
// with a margin that survives a loaded CI box.
const STUB_SETTLE_S = '0.5';
const EXIT_TIMEOUT_MS = 10_000;
const STARTED_TIMEOUT_MS = 5_000;

interface Sandbox {
    bin: string;
    work: string;
    env: NodeJS.ProcessEnv;
    cleanup: () => void;
}

// A PATH-shimmed directory with a stub for each image's CLI name, plus the env the
// entrypoints expect: WORKDIR must exist (they exit 2 otherwise), HOME and CLAUDE_CONFIG_DIR
// point at the sandbox, and the container-only blocks — /opt/claude-home seeding, the OTEL
// rewrites, TRUST_WORKDIR — are all skipped because their guards are absent locally.
const makeSandbox = (): Sandbox => {
    const root = mkdtempSync(join(tmpdir(), 'executor-entrypoint-'));
    const bin = join(root, 'bin');
    const work = join(root, 'work');
    mkdirSync(bin);
    mkdirSync(work);
    for (const cli of ['claude', 'opencode']) {
        writeFileSync(join(bin, cli), STUB);
        chmodSync(join(bin, cli), 0o755);
    }
    return {
        bin,
        work,
        env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            WORKDIR: work,
            HOME: root,
            CLAUDE_CONFIG_DIR: root,
            STUB_DIR: bin,
            STUB_SETTLE: STUB_SETTLE_S,
        },
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
};

const runEntrypoint = (entrypoint: string, sandbox: Sandbox, stubEnv: Record<string, string>) =>
    spawn('/bin/sh', [join(ROOT, entrypoint), '-p', 'test run'], {
        env: { ...sandbox.env, ...stubEnv },
        stdio: 'ignore',
    });

const whenExited = (child: ReturnType<typeof spawn>, ms: number): Promise<number | null> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`entrypoint did not exit within ${ms}ms — a child was never reaped`));
        }, ms);
        child.once('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });

const whenFileExists = (path: string, ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
        const deadline = Date.now() + ms;
        const poll = () => {
            if (existsSync(path)) return resolve();
            if (Date.now() > deadline) return reject(new Error(`${path} never appeared`));
            setTimeout(poll, 25);
        };
        poll();
    });

describe('the entrypoint as PID 1, run locally under /bin/sh', () => {
    it.each([
        ['docker/claude-executor/entrypoint.sh', 'claude'],
        ['docker/opencode-executor/entrypoint.sh', 'opencode'],
    ])('%s re-raises the CLI’s own chosen exit status', async (entrypoint) => {
        const sandbox = makeSandbox();
        try {
            const child = runEntrypoint(entrypoint, sandbox, { STUB_STATUS: '7' });
            expect(await whenExited(child, EXIT_TIMEOUT_MS)).toBe(7);
        } finally {
            sandbox.cleanup();
        }
    });

    it.each([
        ['docker/claude-executor/entrypoint.sh', 'claude'],
        ['docker/opencode-executor/entrypoint.sh', 'opencode'],
    ])('%s forwards TERM to the CLI and still exits, reporter reaped', async (entrypoint) => {
        const sandbox = makeSandbox();
        try {
            // Thirty seconds of stub sleep: the only way the shell can be done within the
            // bound below is by forwarding the TERM it was sent.
            const child = runEntrypoint(entrypoint, sandbox, { STUB_SLEEP: '30' });
            await whenFileExists(join(sandbox.bin, 'started'), STARTED_TIMEOUT_MS);
            child.kill('SIGTERM');
            // 143 is the CLI's own signal death (128+TERM), re-raised by the shell — and
            // reaching an exit at all proves the reporter was reaped: the shell would
            // otherwise still sit in wait on it when the timeout SIGKILLs the lot.
            expect(await whenExited(child, EXIT_TIMEOUT_MS)).toBe(143);
            // The substance: the marker is written by the STUB's own trap, so it exists only
            // if the signal truly reached the CLI rather than the shell merely dying.
            expect(readFileSync(join(sandbox.bin, 'signaled'), 'utf8')).toMatch(/^\d+$/m);
        } finally {
            sandbox.cleanup();
        }
    });
});
