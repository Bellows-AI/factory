import { execFileSync, spawn } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
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
const CLAUDE_PROGRESS = 'docker/claude-executor/claude-progress.cjs';

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

    // claude-home/ cannot hold it: the transcript redirect moves CLAUDE_CONFIG_DIR onto the
    // workspaces volume, so a script baked into a config home is not a stable path.
    it('is copied to /usr/local/bin by both Dockerfiles, never into a config home', () => {
        for (const dir of ['docker/claude-executor', 'docker/opencode-executor']) {
            const dockerfile = read(`${dir}/Dockerfile`);
            expect(dockerfile).toMatch(/COPY[^\n]*branch-reporter\.cjs \/usr\/local\/bin\/branch-reporter\.cjs/);
            expect(dockerfile).not.toMatch(/home\/COPY[^\n]*branch-reporter/);
            expect(dockerfile).not.toMatch(/branch-reporter[^\n]*-home\//);
        }
    });

    it('ships the Claude progress formatter beside the entrypoint, outside the mutable config home', () => {
        const dockerfile = read('docker/claude-executor/Dockerfile');
        expect(dockerfile).toMatch(/COPY[^\n]*claude-progress\.cjs \/usr\/local\/bin\/claude-progress\.cjs/);
        expect(dockerfile).toMatch(/chmod 0755[^\n]*claude-progress\.cjs/);
        expect(dockerfile).not.toMatch(/claude-progress[^\n]*claude-home\//);
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
            /node --disable-warning=ExperimentalWarning \/usr\/local\/bin\/branch-reporter\.cjs >\/dev\/null 2>&1 &\n/
        );
        // Both children tracked: the reporter and the CLI each hand their PID back to the shell.
        expect(entry).toMatch(/^REPORTER_PID=\$!$/m);
        if (cli === 'claude') {
            expect(entry).toMatch(/^claude --output-format stream-json --verbose "\$@" > "\$PROGRESS_FIFO" &$/m);
            expect(entry).toMatch(/node "\$\(dirname "\$0"\)\/claude-progress\.cjs" < "\$PROGRESS_FIFO" &/);
            expect(entry).toMatch(/^PROGRESS_PID=\$!$/m);
        } else {
            expect(entry).toMatch(new RegExp(`^${cli} "\\$@" &$`, 'm'));
        }
        expect(entry).toMatch(/^CLI_PID=\$!$/m);
        // The CLI runs as a background child now, so the close-time sample can run after it;
        // a leftover `exec` would turn the script into the PID-1 replacement and skip it.
        expect(entry).not.toMatch(new RegExp(`^exec ${cli} `, 'm'));
        // TERM/INT reaching PID 1 is forwarded to every child — CLI, reporter and, in the
        // opencode image (the only one that ships it, #68), the rate-limit watch — without
        // that, a `docker stop` leaves the CLI running until the runtime's forced kill.
        expect(entry).toMatch(/^trap \w+ TERM INT$/m);
        // `wait` returns 128+signal when the trap interrupts it, indistinguishable from a child
        // that died to that signal — so the CLI is waited on in a loop until it is really gone
        // (the kill -0 probe), and the reporter is terminated and reaped before the close-time
        // sample so nothing outlives the run.
        expect(entry).toMatch(
            /while :; do\n {4}wait "\$CLI_PID"\n {4}STATUS=\$\?\n {4}kill -0 "\$CLI_PID" 2>\/dev\/null \|\| break\ndone/
        );
        // The forwarding kill takes its pids UNQUOTED, unlike every other expansion in these
        // files. The trap is installed before any child exists (asserted below), so each pid is
        // empty until its child starts, and an empty "$VAR" would hand kill an empty argument
        // instead of nothing at all.
        if (cli === 'opencode') {
            expect(entry).toMatch(/kill -TERM \$CLI_PID \$REPORTER_PID \$WATCHER_PID/);
            expect(entry).toMatch(/kill -TERM "\$REPORTER_PID" "\$WATCHER_PID" 2>\/dev\/null \|\| true/);
            expect(entry).toMatch(/wait "\$REPORTER_PID" "\$WATCHER_PID" 2>\/dev\/null \|\| true/);
        } else {
            expect(entry).toMatch(/kill -TERM \$CLI_PID \$REPORTER_PID \$PROGRESS_PID/);
            expect(entry).toMatch(/kill -TERM "\$REPORTER_PID" 2>\/dev\/null \|\| true/);
            expect(entry).toMatch(/wait "\$REPORTER_PID" 2>\/dev\/null \|\| true/);
            expect(entry).toMatch(/wait "\$PROGRESS_PID" 2>\/dev\/null \|\| true/);
        }
        expect(entry).toMatch(/branch-reporter\.cjs --once/);
        expect(entry).toMatch(/exit "\$STATUS"/);

        // The trap is installed BEFORE the first child is forked, and that ordering is the
        // assertion — not a detail of it. With the trap after the last `&`, PID 1 carries the
        // default TERM action across the gap between them, so a `docker stop` landing there kills
        // this shell and orphans the CLI until the runtime's forced kill: precisely what the trap
        // exists to prevent. The gap is also unobservable from outside, which is why the offline
        // signal test below could only guess at its width with a sleep, and why it failed about
        // one full-suite run in three until the ordering changed.
        const trapAt = entry.search(/^trap \w+ TERM INT$/m);
        const firstChildAt = entry.search(/^node --disable-warning=ExperimentalWarning .*&$/m);
        expect(trapAt, 'no trap line').toBeGreaterThan(-1);
        expect(firstChildAt, 'no backgrounded first child').toBeGreaterThan(-1);
        expect(trapAt, 'the TERM trap must be installed before the first child is forked').toBeLessThan(firstChildAt);
    });

    it('turns Claude protocol events into safe live progress', () => {
        const { linesFor } = requireCjs(join(ROOT, CLAUDE_PROGRESS)) as { linesFor(event: unknown): string[] };
        expect(linesFor({ type: 'system', subtype: 'init' })).toEqual(['Claude session started.']);
        expect(
            linesFor({
                type: 'assistant',
                message: {
                    content: [
                        { type: 'tool_use', name: 'Bash', input: { command: 'export TOKEN=secret; npm test' } },
                        { type: 'text', text: 'I am running the test suite.' },
                    ],
                },
            })
        ).toEqual(['Running Bash.', 'I am running the test suite.']);
        expect(linesFor({ type: 'stream_event', event: { type: 'content_block_delta' } })).toEqual([]);
        expect(linesFor(null)).toEqual([]);
    });

    // opencode mints its own session ids and tells nobody before the run starts — discovery
    // polls the session database live. The query must be the shipped readout's exact query:
    // the readout is what decided "newest root session in the run's own directory" means the
    // run's own conversation (subagents create children, and the per-member database would
    // otherwise cross-report two concurrent fresh runs), and the two readers must never
    // disagree about which row that is.
    it('discovers the opencode session with the shipped readout’s exact query', () => {
        const query =
            'select id from session where parent_id is null and directory = ? order by time_created desc limit 1';
        expect(read(OPENCODE_REPORTER)).toContain(query);
        expect(read('driver/src/scripts/opencode-readout.cjs')).toContain(query);
    });
});

/*
 * The transcript store redirect (issue #55): when the driver hands the headless run a
 * FACTORY_TRANSCRIPT_DIR, the entrypoint moves CLAUDE_CONFIG_DIR onto the workspaces volume
 * BEFORE the seed block — the settings.json-keyed seed then runs against the thread dir, so the
 * baked git guard and every baked setting ride along (the spec's "baked runner configuration
 * survives the redirect"). Pinned against drift like every baked script: the block's exact shape,
 * and its position before the seed.
 */
describe('the claude-executor transcript redirect', () => {
    const ENTRYPOINT = 'docker/claude-executor/entrypoint.sh';

    it('redirects CLAUDE_CONFIG_DIR only when the driver hands it a transcript dir', () => {
        const entry = read(ENTRYPOINT);
        expect(entry).toMatch(/if \[ -n "\$\{FACTORY_TRANSCRIPT_DIR:-\}" \]; then/);
        expect(entry).toMatch(/\n {4}mkdir -p "\$FACTORY_TRANSCRIPT_DIR"\n/);
        expect(entry).toMatch(/\n {4}export CLAUDE_CONFIG_DIR="\$FACTORY_TRANSCRIPT_DIR"\n/);
    });

    it('carries no Remote Control trust patch', () => {
        expect(read(ENTRYPOINT)).not.toContain('TRUST_WORKDIR');
    });

    it('redirects before the seed, so the thread dir is seeded from the baked home', () => {
        const entry = read(ENTRYPOINT);
        const redirect = entry.indexOf('export CLAUDE_CONFIG_DIR="$FACTORY_TRANSCRIPT_DIR"');
        const seed = entry.indexOf('/opt/claude-home');
        expect(redirect).toBeGreaterThan(-1);
        expect(seed).toBeGreaterThan(redirect);
    });

    it('is absent from the opencode entrypoint, which the driver never sends the name to', () => {
        expect(read('docker/opencode-executor/entrypoint.sh')).not.toContain('FACTORY_TRANSCRIPT_DIR');
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
# marker), records that it started, then blocks in the wait builtin, which a trap interrupts
# at once, where a foreground sleep would defer it. Without a signal it exits with STUB_STATUS
# after STUB_SLEEP seconds.
trap 'echo "$$" > "$STUB_DIR/signaled"; exit 143' TERM
sleep "\${STUB_SETTLE:-0}"
echo started > "$STUB_DIR/started"
sleep "\${STUB_SLEEP:-0}" &
wait "$!"
exit "\${STUB_STATUS:-0}"
`;

/**
 * No settle. The entrypoints install their TERM trap BEFORE forking the first child, so this
 * stub can only be running at all if the trap is already up: the `started` marker IS the
 * readiness signal, and the test can send its TERM the instant it appears.
 *
 * This used to be half a second of sleep, chosen to cover the window between the CLI's `&` and
 * a `trap` line that came after it. A duration guess is not a synchronisation primitive — under
 * the load of a full suite run the window outgrew the guess and the case failed roughly one run
 * in three, because the signal arrived while PID 1 still had the default TERM action. Moving the
 * trap ahead of the fork closed the window in the entrypoints themselves, which is where the
 * race actually lived; keep this at 0 so the test would notice if it reopened.
 */
const STUB_SETTLE_S = '0';
const EXIT_TIMEOUT_MS = 10_000;
const STARTED_TIMEOUT_MS = 5_000;
/** The stub CLI's own chosen exit status, for the "re-raises it" assertion. */
const STUB_EXIT_CODE = 7;
/** A signal death's exit status: 128 + the signal number (SIGTERM is 15). */
const TERM_DEATH_EXIT_CODE = 143;

interface Sandbox {
    bin: string;
    work: string;
    env: NodeJS.ProcessEnv;
    cleanup: () => void;
}

// A PATH-shimmed directory with a stub for each image's CLI name, plus the env the
// entrypoints expect: WORKDIR must exist (they exit 2 otherwise), HOME and CLAUDE_CONFIG_DIR
// point at the sandbox, and the container-only blocks — /opt/claude-home seeding, the OTEL
// rewrites — are all skipped because their guards are absent locally.
const EXECUTABLE_MODE = 0o755;

const makeSandbox = (): Sandbox => {
    const root = mkdtempSync(join(tmpdir(), 'executor-entrypoint-'));
    const bin = join(root, 'bin');
    const work = join(root, 'work');
    mkdirSync(bin);
    mkdirSync(work);
    for (const cli of ['claude', 'opencode']) {
        writeFileSync(join(bin, cli), STUB);
        chmodSync(join(bin, cli), EXECUTABLE_MODE);
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

const FILE_POLL_INTERVAL_MS = 25;

const whenFileExists = (path: string, ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
        const deadline = Date.now() + ms;
        const poll = () => {
            if (existsSync(path)) return resolve();
            if (Date.now() > deadline) return reject(new Error(`${path} never appeared`));
            setTimeout(poll, FILE_POLL_INTERVAL_MS);
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
            const child = runEntrypoint(entrypoint, sandbox, { STUB_STATUS: String(STUB_EXIT_CODE) });
            expect(await whenExited(child, EXIT_TIMEOUT_MS)).toBe(STUB_EXIT_CODE);
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
            expect(await whenExited(child, EXIT_TIMEOUT_MS)).toBe(TERM_DEATH_EXIT_CODE);
            // The substance: the marker is written by the STUB's own trap, so it exists only
            // if the signal truly reached the CLI rather than the shell merely dying.
            expect(readFileSync(join(sandbox.bin, 'signaled'), 'utf8')).toMatch(/^\d+$/m);
        } finally {
            sandbox.cleanup();
        }
    });
});

/*
 * The git guard (issue #73): the claude-executor's PreToolUse hook that denies the Bash
 * commands which would move HEAD or rewrite refs in the task worktree. The tree standing on
 * `factory/<root>` is the driver's invariant — the restore-mode sync refuses a wrong checkout
 * only after the damage, and the damage strands the thread (job 43379d3a, 2026-09-13). The
 * hook is a guardrail, not a security boundary; the sync refusal stays the last line of
 * defense. The canonical case table lives in the script itself and both suites pin it: this
 * one runs decide() offline, the image suite (docker/claude-executor/test.sh) runs --selftest
 * against the baked copy.
 */
const GIT_GUARD = 'docker/claude-executor/git-guard.cjs';
const requireCjs = createRequire(import.meta.url);

interface GuardDecision {
    deny: boolean;
    reason?: string;
}
interface GuardModule {
    decide: (command: string) => GuardDecision;
    CASES: Array<['deny' | 'allow', string]>;
}
const loadGuard = (): GuardModule => requireCjs(join(ROOT, GIT_GUARD)) as GuardModule;

describe('the claude-executor git guard', () => {
    // The behavior table, executed (not just re-read): every deny case must deny, every allow
    // case must stay silent. A deny carries a reason — it is the only instruction the agent
    // sees at the moment of the block. The rows are narrowed to the command so the test title
    // names the case it runs — a regression must be diagnosable from the failure list alone.
    it.each(
        loadGuard()
            .CASES.filter(([want]) => want === 'deny')
            .map(([, command]) => [command])
    )('denies %s', (command) => {
        const verdict = loadGuard().decide(command);
        expect(verdict.deny).toBe(true);
        expect(typeof verdict.reason).toBe('string');
    });

    it.each(
        loadGuard()
            .CASES.filter(([want]) => want === 'allow')
            .map(([, command]) => [command])
    )('allows %s', (command) => {
        expect(loadGuard().decide(command).deny).toBe(false);
    });

    // The wire contract with Claude Code: JSON on stdin, the deny decision as JSON on stdout,
    // exit 0 either way — exit 2 would block every Bash call, and silence means "no decision".
    // Malformed input must fail open: a hook that crashes a run is worse than one that misses.
    it('speaks the PreToolUse hook protocol', async () => {
        const runHook = (payload: string): Promise<{ code: number | null; stdout: string }> =>
            new Promise((resolve, reject) => {
                const child = spawn('node', [join(ROOT, GIT_GUARD)], { stdio: ['pipe', 'pipe', 'pipe'] });
                let stdout = '';
                child.stdout.on('data', (chunk) => {
                    stdout += chunk;
                });
                child.once('error', reject);
                child.once('exit', (code) => resolve({ code, stdout }));
                child.stdin.end(payload);
            });

        const deny = await runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git switch main' } }));
        expect(deny.code).toBe(0);
        const parsed = JSON.parse(deny.stdout);
        expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
        expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(typeof parsed.hookSpecificOutput.permissionDecisionReason).toBe('string');

        const allow = await runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }));
        expect(allow.code).toBe(0);
        expect(allow.stdout).toBe('');

        const junk = await runHook('not json at all');
        expect(junk.code).toBe(0);
        expect(junk.stdout).toBe('');
    });

    // /usr/local/bin, like the branch reporter: the transcript redirect moves CLAUDE_CONFIG_DIR
    // off the baked config home — and the settings.json hook command names this exact absolute
    // path.
    it('is baked at /usr/local/bin by the Dockerfile, never into a config home', () => {
        const dockerfile = read('docker/claude-executor/Dockerfile');
        expect(dockerfile).toMatch(/COPY[^\n]*git-guard\.cjs \/usr\/local\/bin\/git-guard\.cjs/);
        expect(dockerfile).toMatch(/chmod 0755[^\n]*git-guard\.cjs/);
        expect(dockerfile).not.toMatch(/git-guard[^\n]*-home\//);
    });

    it('is wired as a PreToolUse Bash hook in the baked settings.json', () => {
        const settings = JSON.parse(read('docker/claude-executor/claude-home/settings.json'));
        const group = (settings.hooks?.PreToolUse ?? []).find((g: { matcher?: string }) => g.matcher === 'Bash');
        expect(group).toBeDefined();
        const [gitHook, ghHook] = group.hooks;
        for (const hook of [gitHook, ghHook]) {
            expect(hook.type).toBe('command');
            expect(hook.command).toBe('node /usr/local/bin/git-guard.cjs');
            expect(hook.timeout).toBe(10);
        }
        // The `if` filters keep the node boot off every Bash call the guard does not read;
        // Claude Code checks them per subcommand and runs the hook anyway when it cannot
        // tell — compounds and substitutions still reach the guard. The gh arm is issue #82:
        // the guard denies `gh pr create` / `gh pr checkout`, so gh calls must reach it too.
        expect(gitHook.if).toBe('Bash(git *)');
        expect(ghHook.if).toBe('Bash(gh *)');
    });
});

/*
 * One set of skills for both executors: docker/skills/ is baked into each image's own skills
 * directory through the named `skills` build context, so a task sees the same skills whichever
 * executor its profile picks. The repo's dev skills follow the same rule from the other side —
 * .claude/skills/ is the one directory both Claude Code and OpenCode discover.
 */
describe('the shared executor skills', () => {
    const SKILLS = 'docker/skills';
    const IMAGES = [
        { dockerfile: 'docker/claude-executor/Dockerfile', target: '/home/node/.claude/skills/' },
        { dockerfile: 'docker/opencode-executor/Dockerfile', target: '/home/node/.config/opencode/skills/' },
    ];

    it('bakes docker/skills into both images', () => {
        for (const { dockerfile, target } of IMAGES) {
            expect(read(dockerfile)).toContain(`COPY --from=skills --chown=node:node . ${target}`);
        }
    });

    it('lands in claude-executor before the /opt/claude-home seed is snapshotted', () => {
        const dockerfile = read('docker/claude-executor/Dockerfile');
        const copy = dockerfile.indexOf('COPY --from=skills');
        expect(copy).toBeGreaterThan(-1);
        expect(copy).toBeLessThan(dockerfile.indexOf('cp -a /home/node/.claude/. /opt/claude-home/'));
    });

    it('is the only home: neither per-image config directory carries skills of its own', () => {
        expect(existsSync(join(ROOT, 'docker/claude-executor/claude-home/skills'))).toBe(false);
        expect(existsSync(join(ROOT, 'docker/opencode-executor/opencode-home/skills'))).toBe(false);
    });

    it('names every skill after its directory, as opencode requires', () => {
        const names = readdirSync(join(ROOT, SKILLS));
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
            expect(read(`${SKILLS}/${name}/SKILL.md`)).toMatch(new RegExp(`^---\nname: ${name}\n`));
        }
    });

    // Without the flag `COPY --from=skills` resolves `skills` as an image to pull, and the
    // build fails far from the missing argument.
    it('every executor image build passes the skills context', () => {
        const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
            .split('\0')
            .filter((file) => file && existsSync(join(ROOT, file)) && read(file).includes('docker build'));
        let builds = 0;
        for (const file of files) {
            // Unwrap comment and prose line breaks so a command split across lines reads whole.
            const text = read(file).replace(/\\?\n\s*#?\s*/g, ' ');
            const invocations =
                text.match(
                    /docker build\b(?:(?!docker build)[^`])*?(?:docker\/(?:claude|opencode)-executor|"\$HERE"|\s\.\s>)/g
                ) ?? [];
            // `-f` names a Dockerfile elsewhere — the dashboard and driver images, not a runner.
            for (const line of invocations.filter((build) => !/\s-f\s/.test(build))) {
                builds++;
                expect(line, `${file}: ${line}`).toContain('--build-context skills=');
            }
        }
        expect(builds).toBeGreaterThan(0);
    });

    it('keeps the repo dev skills in .claude/skills, the directory both tools read', () => {
        expect(existsSync(join(ROOT, '.opencode/skills'))).toBe(false);
        expect(readdirSync(join(ROOT, '.claude/skills'))).toEqual(
            expect.arrayContaining(['fix', 'openspec-propose', 'openspec-apply-change'])
        );
    });
});

/*
 * The PR boundary (issue #82): executors do not open pull requests — that is the driver
 * publish's, with the title/description written by the summarizer script. The enforcement is
 * the two guards above; these pins keep the INSTRUCTIONS from teaching the old behavior, the
 * way the baked github skill once did ("open the PR without waiting to be asked").
 */
describe('the executor PR boundary', () => {
    const GITHUB_SKILL = 'docker/skills/github/SKILL.md';

    it('no baked skill instructs opening a pull request', () => {
        const skills = [
            GITHUB_SKILL,
            'docker/skills/backend-fix/SKILL.md',
            'docker/opencode-executor/opencode-home/AGENTS.md',
        ];
        for (const skill of skills) {
            const text = read(skill);
            // The deny is policy the skills may NAME ("Never run `gh pr create`"); what must
            // not survive is the instruction — a runnable command line, or the old call to
            // action.
            expect(text).not.toMatch(/^\s*gh pr create\b/m);
            expect(text).not.toMatch(/open the PR/i);
        }
    });

    it('the github skill names the board as the PR author instead', () => {
        const text = read(GITHUB_SKILL);
        expect(text).toContain('opens (or reuses) the pull request');
        expect(text).toContain('Never run');
        // And the one command it listed that moves HEAD onto a PR is gone with the section —
        // named only as denied policy, never as a line to run.
        expect(text).not.toMatch(/^\s*gh pr checkout\b/m);
    });

    it('the opencode fence denies gh pr create and gh pr checkout', () => {
        const policy = JSON.parse(read('docker/opencode-executor/opencode-home/opencode.json'));
        const bash: Record<string, string> = policy.permission.bash;
        for (const rule of ['gh pr create', 'gh pr create *', 'gh pr checkout', 'gh pr checkout *']) {
            expect(bash[rule]).toBe('deny');
        }
    });
});

describe('the opencode-executor git guard policy', () => {
    // opencode takes no hooks for this: the deny lives in the baked permission.bash table,
    // evaluated with the LAST MATCHING RULE WINNING — so key order is load-bearing. The
    // catch-all `*` comes first, the deny globs next, and the exact-match allows last (a
    // trailing-glob allow could full-string-match a compound like `git checkout -- f && git
    // switch main` and bless a deny-command; an exact allow cannot). Nothing may resolve to
    // `ask` — headless, an unanswered ask auto-rejects.
    const PATH = 'docker/opencode-executor/opencode-home/opencode.json';

    it('pins the exact bash rule table, in order', () => {
        const policy = JSON.parse(read(PATH));
        expect(Object.keys(policy.permission.bash)).toEqual([
            '*',
            'git switch',
            'git switch *',
            'git checkout',
            'git checkout *',
            'git worktree',
            'git worktree *',
            'git branch -d*',
            'git branch -D*',
            'git branch -m*',
            'git branch -M*',
            'git branch -c*',
            'git branch -C*',
            'git branch -f*',
            'git branch --delete*',
            'git branch --force*',
            'git branch --move*',
            'git branch --copy*',
            'git reset --hard',
            'git reset --hard *',
            'git rebase',
            'git rebase *',
            'git merge',
            'git merge *',
            'gh pr create',
            'gh pr create *',
            'gh pr checkout',
            'gh pr checkout *',
            'git worktree list',
            'git rebase --abort',
            'git rebase --quit',
            'git rebase --continue',
            'git merge --abort',
            'git merge --quit',
            'git merge --continue',
            'git merge origin/main',
            'git merge --no-edit origin/main',
            'git merge origin/main --no-edit',
        ]);
    });

    it('allows or denies every rule — never ask — and ranks allows after denies', () => {
        const policy = JSON.parse(read(PATH));
        const bash: Record<string, string> = policy.permission.bash;
        const values = Object.values(bash);
        expect(values.every((v) => v === 'allow' || v === 'deny')).toBe(true);
        const lastDeny = Object.keys(bash).reduce((acc, key, i) => (bash[key] === 'deny' ? i : acc), -1);
        const firstAllow = Object.keys(bash).findIndex((key, i) => i > 0 && bash[key] === 'allow');
        expect(firstAllow).toBeGreaterThan(lastDeny);
    });

    // The entrypoint patches only permission.external_directory; this pins that the guard
    // table sits beside the fence keys it must not disturb.
    it('leaves the rest of the permission block untouched', () => {
        const policy = JSON.parse(read(PATH));
        expect(policy.permission['*']).toBe('allow');
        expect(policy.permission.read).toEqual({ '*': 'allow' });
        expect(policy.permission.webfetch).toBe('deny');
        expect(policy.permission.external_directory['*']).toBe('deny');
        expect(policy.permission.bash['*']).toBe('allow');
    });

    // The baked allows name origin/main only; the entrypoint adds the same exact allows for a
    // repo whose origin/HEAD names another default, appended so they still rank last.
    const MERGE_ALLOWS = (ref: string) => [
        `git merge ${ref}`,
        `git merge --no-edit ${ref}`,
        `git merge ${ref} --no-edit`,
    ];

    const runWithDefault = async (defaultBranch: string | null) => {
        const sandbox = makeSandbox();
        try {
            const git = (...args: string[]) => execFileSync('git', args, { cwd: sandbox.work, stdio: 'ignore' });
            git('init', '-q');
            if (defaultBranch) {
                git('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${defaultBranch}`);
            }
            const config = join(sandbox.env.HOME!, '.config', 'opencode');
            mkdirSync(config, { recursive: true });
            writeFileSync(join(config, 'opencode.json'), read(PATH));
            const env = { ...sandbox.env, GIT_CONFIG_GLOBAL: join(sandbox.env.HOME!, '.gitconfig') };
            const child = spawn('/bin/sh', [join(ROOT, 'docker/opencode-executor/entrypoint.sh'), 'run'], {
                env,
                stdio: 'ignore',
            });
            expect(await whenExited(child, EXIT_TIMEOUT_MS)).toBe(0);
            return JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8')).permission.bash as Record<
                string,
                string
            >;
        } finally {
            sandbox.cleanup();
        }
    };

    it('allows merging the origin/HEAD default when it is not main, ranked last', async () => {
        const bash = await runWithDefault('develop');
        const keys = Object.keys(bash);
        expect(keys.slice(-3)).toEqual(MERGE_ALLOWS('origin/develop'));
        for (const rule of MERGE_ALLOWS('origin/develop')) expect(bash[rule]).toBe('allow');
        expect(bash['git merge *']).toBe('deny');
    });

    it.each([
        ['main', 'main'],
        ['no origin/HEAD', null],
    ])('adds nothing when the default is %s', async (_label, defaultBranch) => {
        const bash = await runWithDefault(defaultBranch);
        expect(bash).toEqual(JSON.parse(read(PATH)).permission.bash);
    });
});

/*
 * The infrastructure-access guide: a real run burned time probing `127.0.0.1:5432` for a database
 * that was reachable at the hostname the injected DATABASE_URL named — a localhost refusal here is
 * the wrong address, not an outage. These pins keep the instruction in both guides: look up the
 * injected env first, treat declared `.bellows.yaml` services as DNS names.
 */
describe('the executor infrastructure-access guide', () => {
    const GUIDES = ['docker/claude-executor/claude-home/CLAUDE.md', 'docker/opencode-executor/opencode-home/AGENTS.md'];

    it.each(GUIDES)('%s tells the agent to use injected env and declared services', (guide) => {
        const text = read(guide);
        expect(text).toContain('## Infrastructure access');
        expect(text).toContain('injected env variables');
        expect(text).toContain('`services:`');
        expect(text).toContain('127.0.0.1');
        expect(text).toContain('DNS');
    });
});
