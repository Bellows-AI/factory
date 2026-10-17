import { spawn } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/*
 * The runner end of AskUserQuestion (issue #226): docker/claude-executor/claude-bridge.cjs run
 * against a fake `claude` on PATH and the task supervisor's mailbox played by the test — the bridge
 * holds no control credential and never speaks HTTP, it writes a question file and reads an answer
 * file. The fake CLI records its
 * argv and stdin, emits scripted stream-json, waits for one control_response per control_request
 * it emitted, then ends the turn with a `result` line and exits when its stdin closes. FAKE_LATER
 * scripts one more turn the CLI starts on its own after that `result` — the one a background
 * subagent's completion queues — which only runs while stdin is still open.
 */
const BRIDGE = join(ROOT, 'docker/claude-executor/claude-bridge.cjs');
const EXECUTABLE_MODE = 0o755;
const POLL_MS = '20';
const RUN_TIMEOUT_MS = 20_000;
const USAGE_EXIT = 64;
const SIGNAL_EXIT_BASE = 128;
const SIGKILL_NUMBER = 9;
const SIGTERM_NUMBER = 15;
const QUESTION = 'Which colour is the SECRETQ?';
const QUESTIONS = [{ question: QUESTION, options: [{ label: 'Red' }, { label: 'Blue' }] }];
const TOOL_USE_ID = 'toolu_ask_1';
const SESSION_ID = '0b6f2f9e-6c1d-4a51-9a07-3d5b7c2e8f41';

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const dir = process.env.FAKE_DIR;
fs.writeFileSync(dir + '/argv.json', JSON.stringify(process.argv.slice(2)));
const lines = JSON.parse(process.env.FAKE_LINES || '[]');
const later = JSON.parse(process.env.FAKE_LATER || '[]');
const requests = (batch) => batch.filter((line) => line.type === 'control_request').length;
let expected = requests(lines);
let responses = 0;
let emitted = false;
let laterEmitted = false;
const say = (line) => process.stdout.write(JSON.stringify(line) + '\\n');
const finish = () => {
    say({ type: 'result', subtype: 'success' });
    if (!later.length || laterEmitted) return;
    laterEmitted = true;
    setTimeout(() => {
        expected += requests(later);
        for (const item of later) say(item);
        if (!requests(later)) finish();
    }, 50);
};
process.on('SIGTERM', () => {
    fs.writeFileSync(dir + '/termed', '1');
    process.exit(0);
});
const reader = require('node:readline').createInterface({ input: process.stdin });
reader.on('line', (line) => {
    fs.appendFileSync(dir + '/stdin.jsonl', line + '\\n');
    const message = JSON.parse(line);
    if (message.type === 'user' && !emitted) {
        emitted = true;
        fs.writeFileSync(dir + '/started', '1');
        if (process.env.FAKE_HANG) return;
        for (const item of lines) say(item);
        if (!expected) finish();
    }
    if (message.type === 'control_response' && message.response.request_id !== 'factory-init') {
        responses += 1;
        if (responses >= expected) finish();
    }
});
reader.on('close', () => {
    fs.writeFileSync(dir + '/stdin-closed', '1');
    if (process.env.FAKE_SIGNAL) process.kill(process.pid, process.env.FAKE_SIGNAL);
    process.exit(Number(process.env.FAKE_EXIT || 0));
});
`;

/**
 * The supervisor's side of the mailbox, played by the test: the two directories the bridge is
 * handed, what it wrote into `out`, and a way to answer into `in` the way the supervisor does
 * (atomically, as a file named for the question).
 */
interface Mailbox {
    inDir: string;
    outDir: string;
    /** The question file the bridge wrote, once it did. */
    asked: () => Record<string, unknown> | null;
    answer: (body: unknown) => void;
    /** Writes the answer file torn in half, the way a reader that is not atomic would find it. */
    answerTorn: () => void;
    /** Runs `act` once the question file appears. */
    whenAsked: (act: (box: Mailbox) => void) => void;
}

const mailboxes: Mailbox[] = [];
const timers: NodeJS.Timeout[] = [];
afterEach(() => {
    for (const timer of timers.splice(0)) clearInterval(timer);
});

function mailbox(): Mailbox {
    const root = mkdtempSync(join(tmpdir(), 'claude-bridge-mailbox-'));
    dirs.push(root);
    const inDir = join(root, 'in');
    const outDir = join(root, 'out');
    mkdirSync(join(inDir, 'answers'), { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const questionFile = join(outDir, 'questions', `${TOOL_USE_ID}.json`);
    const answerFile = join(inDir, 'answers', `${TOOL_USE_ID}.json`);
    const box: Mailbox = {
        inDir,
        outDir,
        asked: () => readJson(questionFile),
        answer: (body) => {
            writeFileSync(`${answerFile}.tmp`, JSON.stringify(body));
            renameSync(`${answerFile}.tmp`, answerFile);
        },
        answerTorn: () => writeFileSync(answerFile, '{"state":"answe'),
        whenAsked(act) {
            const timer = setInterval(() => {
                if (!existsSync(questionFile)) return;
                clearInterval(timer);
                act(box);
            }, 10);
            timers.push(timer);
        },
    };
    mailboxes.push(box);
    return box;
}

const askRequest = (toolName = 'AskUserQuestion') => ({
    type: 'control_request',
    request_id: 'req-1',
    request: {
        subtype: 'can_use_tool',
        tool_name: toolName,
        input: { questions: QUESTIONS },
        tool_use_id: TOOL_USE_ID,
        requires_user_interaction: true,
    },
});

interface Run {
    code: number | null;
    stdout: string;
    stderr: string;
    dir: string;
    argv: string[];
    stdin: Record<string, any>[];
    /** The CLI's reply to the one request this run scripted. */
    decision: Record<string, any>;
}

const dirs: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
const servers: Server[] = [];
afterEach(async () => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), 'claude-bridge-'));
    dirs.push(dir);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
    chmodSync(join(bin, 'claude'), EXECUTABLE_MODE);
    return { dir, bin };
}

const whenFile = (path: string): Promise<void> =>
    new Promise((resolve, reject) => {
        const deadline = Date.now() + RUN_TIMEOUT_MS;
        const poll = () => {
            if (existsSync(path)) return resolve();
            if (Date.now() > deadline) return reject(new Error(`${path} never appeared`));
            setTimeout(poll, 20);
        };
        poll();
    });

function launch(args: string[], env: Record<string, string>, dir: string, bin: string) {
    const child = spawn(process.execPath, [BRIDGE, ...args], {
        env: {
            ...process.env,
            FACTORY_CTL_IN: '',
            FACTORY_CTL_OUT: '',
            FACTORY_STOP_MARKER: '',
            PATH: `${bin}:${process.env.PATH}`,
            FAKE_DIR: dir,
            FACTORY_CTL_TICK_MS: POLL_MS,
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once('exit', (code, signal) => resolve({ code, signal }))
    );
    return { child, exited, output: () => ({ stdout, stderr }) };
}

const readJson = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

async function run(opts: {
    args?: string[];
    env?: Record<string, string>;
    lines?: unknown[];
    mailbox?: Mailbox;
}): Promise<Run> {
    const { dir, bin } = sandbox();
    const env: Record<string, string> = { FAKE_LINES: JSON.stringify(opts.lines ?? []), ...opts.env };
    if (opts.mailbox) {
        env.FACTORY_CTL_IN = opts.mailbox.inDir;
        env.FACTORY_CTL_OUT = opts.mailbox.outDir;
    }
    const { exited, output } = launch(opts.args ?? ['--model', 'm', '-p', 'do the thing'], env, dir, bin);
    const { code } = await exited;
    const stdin = existsSync(join(dir, 'stdin.jsonl'))
        ? readFileSync(join(dir, 'stdin.jsonl'), 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line))
        : [];
    const reply = stdin.find(
        (message) => message.type === 'control_response' && message.response.request_id !== 'factory-init'
    );
    return {
        code,
        ...output(),
        dir,
        argv: readJson(join(dir, 'argv.json')) ?? [],
        stdin,
        decision: reply?.response?.response,
    };
}

const answeredBlue = { state: 'answered', answers: { [QUESTION]: 'Blue' } };
const interrupted = (message: string) => ({ behavior: 'deny', message, interrupt: true });

describe('claude-bridge argv', () => {
    it('refuses a command line that does not end in "-p <prompt>"', async () => {
        const result = await run({ args: ['--model', 'm', 'do the thing'] });

        expect(result.code).toBe(USAGE_EXIT);
        expect(result.stderr).toBe('claude-bridge: expected "-p <prompt>" as the last two arguments\n');
        expect(result.argv).toEqual([]);
    });

    it('moves the prompt to stdin and launches the CLI in stream-json permission-prompt mode', async () => {
        const result = await run({ args: ['--model', 'm', '--dangerously-skip-permissions', '-p', 'do the thing'] });

        expect(result.argv).toEqual([
            '-p',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--verbose',
            '--permission-prompt-tool',
            'stdio',
            '--model',
            'm',
            '--dangerously-skip-permissions',
        ]);
        expect(result.code).toBe(0);
    });

    // A driver lost between reporting the session it minted and the CLI's first transcript write
    // leaves the board an id with nothing behind it (issue #822): the recovery's `--resume` would
    // be refused, so the bridge starts that same id instead.
    it('starts a resumed session that left no transcript with --session-id under the same id', async () => {
        const config = mkdtempSync(join(tmpdir(), 'claude-config-'));
        dirs.push(config);
        const result = await run({
            args: ['--resume', SESSION_ID, '--model', 'm', '-p', 'do the thing'],
            env: { CLAUDE_CONFIG_DIR: config },
        });

        expect(result.argv).toContain('--session-id');
        expect(result.argv).not.toContain('--resume');
        expect(result.argv[result.argv.indexOf('--session-id') + 1]).toBe(SESSION_ID);
        expect(result.stderr).toContain(`session ${SESSION_ID} left no transcript`);
    });

    it('resumes a session whose transcript is on disk', async () => {
        const config = mkdtempSync(join(tmpdir(), 'claude-config-'));
        dirs.push(config);
        mkdirSync(join(config, 'projects', '-work-tree'), { recursive: true });
        writeFileSync(join(config, 'projects', '-work-tree', `${SESSION_ID}.jsonl`), '{}\n');
        const result = await run({
            args: ['--resume', SESSION_ID, '--model', 'm', '-p', 'do the thing'],
            env: { CLAUDE_CONFIG_DIR: config },
        });

        expect(result.argv).toContain('--resume');
        expect(result.argv[result.argv.indexOf('--resume') + 1]).toBe(SESSION_ID);
        expect(result.argv).not.toContain('--session-id');
    });

    // A project directory the run cannot enter is not an absent transcript: only ENOENT starts
    // the id fresh. Root reads through any mode bits, so the case means nothing there.
    it.skipIf(process.getuid?.() === 0)('resumes when a project directory cannot be entered', async () => {
        const config = mkdtempSync(join(tmpdir(), 'claude-config-'));
        dirs.push(config);
        const project = join(config, 'projects', '-work-tree');
        mkdirSync(project, { recursive: true });
        writeFileSync(join(project, `${SESSION_ID}.jsonl`), '{}\n');
        chmodSync(project, 0o000);
        try {
            const result = await run({
                args: ['--resume', SESSION_ID, '--model', 'm', '-p', 'do the thing'],
                env: { CLAUDE_CONFIG_DIR: config },
            });

            expect(result.argv[result.argv.indexOf('--resume') + 1]).toBe(SESSION_ID);
            expect(result.argv).not.toContain('--session-id');
        } finally {
            chmodSync(project, 0o755);
        }
    });
});

describe('claude-bridge stream', () => {
    it('writes the initialize request, then the prompt, and closes stdin on the result line', async () => {
        const result = await run({ lines: [{ type: 'system', subtype: 'init' }] });

        expect(result.stdin).toEqual([
            { type: 'control_request', request_id: 'factory-init', request: { subtype: 'initialize', hooks: null } },
            {
                type: 'user',
                message: { role: 'user', content: 'do the thing' },
                parent_tool_use_id: null,
                session_id: '',
            },
        ]);
        expect(existsSync(join(result.dir, 'stdin-closed'))).toBe(true);
    });

    it('passes every CLI stdout line through unchanged', async () => {
        const lines = [
            { type: 'system', subtype: 'init' },
            { type: 'assistant', message: { content: [] } },
        ];

        const result = await run({ lines });

        expect(result.stdout).toBe(
            `${[...lines, { type: 'result', subtype: 'success' }].map((l) => JSON.stringify(l)).join('\n')}\n`
        );
    });

    // Job 2bfc0e63 (2026-10-11): the agent ended its turn while its reviewer subagent ran, the
    // bridge closed stdin on that `result`, and every permission request of the turn the
    // subagent's completion started failed "Stream closed" — AskUserQuestion included.
    it('keeps stdin open across a result while a background subagent runs, so the turn it starts is answered', async () => {
        const subagents = (tasks: unknown[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks });
        const result = await run({
            lines: [subagents([{ task_id: 'a1', task_type: 'local_agent', description: 'review' }])],
            env: { FAKE_LATER: JSON.stringify([subagents([]), { ...askRequest('Write'), request_id: 'req-2' }]) },
        });

        expect(result.stdin.at(-1)).toMatchObject({
            type: 'control_response',
            response: { subtype: 'success', request_id: 'req-2', response: { behavior: 'deny' } },
        });
        expect(result.stdout.match(/"type":"result"/g)).toHaveLength(2);
        expect(result.code).toBe(0);
    });

    // The CLI kills a background shell at end of input rather than waiting for it, so a shell
    // left running — a dev server — must not hold the run open.
    it('closes stdin on a result while only a background shell runs', async () => {
        const result = await run({
            lines: [
                {
                    type: 'system',
                    subtype: 'background_tasks_changed',
                    tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' }],
                },
            ],
            env: { FAKE_LATER: JSON.stringify([{ ...askRequest('Write'), request_id: 'req-2' }]) },
        });

        expect(existsSync(join(result.dir, 'stdin-closed'))).toBe(true);
        expect(result.stdout.match(/"type":"result"/g)).toHaveLength(1);
        expect(result.code).toBe(0);
    });

    it('answers a control request it does not support with an error', async () => {
        const result = await run({
            lines: [{ type: 'control_request', request_id: 'req-9', request: { subtype: 'set_model' } }],
        });

        expect(result.stdin.at(-1)).toEqual({
            type: 'control_response',
            response: { subtype: 'error', request_id: 'req-9', error: 'unsupported' },
        });
    });
});

describe('claude-bridge can_use_tool', () => {
    it('hands the question to the supervisor as a file, and turns its answer into allow with the answers merged in', async () => {
        const box = mailbox();
        box.whenAsked((b) => b.answer(answeredBlue));

        const result = await run({ lines: [askRequest()], mailbox: box });

        expect(box.asked()).toEqual({ questionId: TOOL_USE_ID, questions: QUESTIONS });
        expect(result.stdin.at(-1)).toMatchObject({
            type: 'control_response',
            response: { subtype: 'success', request_id: 'req-1' },
        });
        expect(result.decision).toEqual({
            behavior: 'allow',
            updatedInput: { questions: QUESTIONS, answers: { [QUESTION]: 'Blue' } },
        });
        expect(result.code).toBe(0);
    });

    it.each([
        ['cancelled', { state: 'cancelled' }],
        ['gone', { state: 'gone' }],
    ])('turns a %s answer into deny and interrupt', async (_name, answer) => {
        const box = mailbox();
        box.whenAsked((b) => b.answer(answer));

        const result = await run({ lines: [askRequest()], mailbox: box });

        expect(result.decision).toEqual(interrupted('The task was stopped.'));
    });

    it('keeps waiting while the answer is absent or torn, and takes it whole when it lands', async () => {
        const box = mailbox();
        box.whenAsked((b) => {
            b.answerTorn();
            setTimeout(() => b.answer(answeredBlue), 120);
        });

        const result = await run({ lines: [askRequest()], mailbox: box });

        expect(result.decision.behavior).toBe('allow');
    });

    it('stops on the stop marker, which it checks every poll', async () => {
        const { dir } = sandbox();
        const marker = join(dir, 'factory-stop');
        const box = mailbox();
        box.whenAsked(() => setTimeout(() => writeFileSync(marker, 'stop\n'), 60));

        const result = await run({ lines: [askRequest()], mailbox: box, env: { FACTORY_STOP_MARKER: marker } });

        expect(result.decision).toEqual(interrupted('The task was stopped.'));
    });

    it.each(['refused', 'invalid'])('denies without interrupt when the supervisor answers %s', async (state) => {
        const box = mailbox();
        box.whenAsked((b) => b.answer({ state }));

        const result = await run({ lines: [askRequest()], mailbox: box });

        expect(result.decision).toEqual({
            behavior: 'deny',
            message:
                'This run cannot ask more questions. Continue with your best judgment and state the assumption you made.',
            interrupt: false,
        });
    });

    const NOT_APPROVED = "Not pre-approved by the runner's allowlist, and nobody can approve it in this run.";

    // A real run (`/fix 582`) read the old "denied by the permission settings" on
    // `(npm install | tail -3)` as "npm is forbidden" and gave up, though `Bash(npm *)` was allowed:
    // the subshell, not npm, kept the command from matching. The Bash denial names that way out.
    it.each([
        ['denies every other tool the way a headless run always did', 'WebFetch', NOT_APPROVED],
        [
            'tells a denied Bash command that a compound command may pass split into plain parts',
            'Bash',
            `${NOT_APPROVED} ` +
                'A compound command (a `( … )` subshell, a heredoc, a `;` or `&&` chain) is approved only when ' +
                'every part matches the allowlist: run each part once on its own, unwrapped, before treating ' +
                'it as refused.',
        ],
    ])('%s', async (_label, tool, message) => {
        const box = mailbox();

        const result = await run({ lines: [askRequest(tool)], mailbox: box });

        expect(result.decision).toEqual({ behavior: 'deny', message, interrupt: false });
        expect(box.asked()).toBeNull();
    });

    it.each([
        ['FACTORY_CTL_IN', { FACTORY_CTL_IN: '', FACTORY_CTL_OUT: '/tmp' }],
        ['FACTORY_CTL_OUT', { FACTORY_CTL_IN: '/tmp', FACTORY_CTL_OUT: '' }],
    ])('denies a question without interrupt when %s is unset', async (_name, env) => {
        const result = await run({ lines: [askRequest()], env });

        expect(result.decision).toEqual({
            behavior: 'deny',
            message:
                'Nobody can answer questions in this run. Continue with your best judgment and state the assumption you made.',
            interrupt: false,
        });
    });

    // The agent holds no control credential, so it has nothing to speak to the driver with: even a
    // run handed a live endpoint and a token by an old environment never calls it.
    it('never calls a control endpoint, whatever its environment names', async () => {
        const seen: string[] = [];
        const server = createServer((request, response) => {
            seen.push(`${request.method} ${request.url}`);
            response.end('{}');
        });
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const box = mailbox();
        box.whenAsked((b) => b.answer(answeredBlue));

        const result = await run({
            lines: [askRequest()],
            mailbox: box,
            env: { BELLOWS_CONTROL_URL: url, BELLOWS_CONTROL_TOKEN: 'lane-token' },
        });

        expect(result.decision.behavior).toBe('allow');
        expect(seen).toEqual([]);
    });

    it('never writes the question text to stderr', async () => {
        const box = mailbox();
        box.whenAsked((b) => b.answer(answeredBlue));

        const result = await run({ lines: [askRequest()], mailbox: box });

        expect(result.stderr).not.toContain('SECRETQ');
    });
});

describe('claude-bridge exit and signals', () => {
    it('exits with the CLI’s own status', async () => {
        const result = await run({ env: { FAKE_EXIT: '7' } });

        expect(result.code).toBe(7);
    });

    // Issue #798: the bridge's stdout is the progress sidecar's FIFO. A reader that died is lost
    // live progress, never a failed run: the CLI runs on and its own status is the verdict.
    it('keeps the CLI running and exits with its status when the progress reader is gone', async () => {
        const { dir, bin } = sandbox();
        const lines = [{ type: 'system', subtype: 'init' }, askRequest('Write')];
        const { child, exited, output } = launch(
            ['-p', 'p'],
            { FAKE_LINES: JSON.stringify(lines), FAKE_EXIT: '7' },
            dir,
            bin
        );
        child.stdout.destroy();

        const { code } = await exited;

        expect(code).toBe(7);
        expect(existsSync(join(dir, 'stdin-closed'))).toBe(true);
        const replies = readFileSync(join(dir, 'stdin.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
            .filter((message) => message.type === 'control_response' && message.response.request_id === 'req-1');
        expect(replies.map((message) => message.response.response.behavior)).toEqual(['deny']);
        const { stderr } = output();
        expect(stderr).not.toContain('EPIPE');
        expect(stderr.split('the progress reader is gone').length - 1).toBe(1);
    });

    it('exits 128 plus the signal number when the CLI died to a signal', async () => {
        const result = await run({ env: { FAKE_SIGNAL: 'SIGKILL' } });

        expect(result.code).toBe(SIGNAL_EXIT_BASE + SIGKILL_NUMBER);
    });

    it('forwards TERM to the CLI and leaves only after it has', async () => {
        const { dir, bin } = sandbox();
        const { child, exited } = launch(['-p', 'p'], { FAKE_HANG: '1' }, dir, bin);
        await whenFile(join(dir, 'started'));

        child.kill('SIGTERM');
        const { code } = await exited;

        expect(existsSync(join(dir, 'termed'))).toBe(true);
        expect(code).toBe(0);
    });

    // Issue #506: the entrypoint forwards a TERM the moment the CLI is up, which can be before the
    // bridge has run a line past its spawn. The preload sends that TERM inside the spawn call, so
    // it lands deterministically where a listener installed after the spawn would not yet exist —
    // and Node's default action would kill the bridge, leaving the CLI unsignalled.
    it('forwards a TERM that lands while it is still spawning the CLI', async () => {
        const { dir, bin } = sandbox();
        // NODE_OPTIONS reaches the fake CLI too; it never spawns, so the preload is inert there.
        const preload = join(dir, 'term-at-spawn.cjs');
        writeFileSync(
            preload,
            `const cp = require('node:child_process');
const spawn = cp.spawn;
cp.spawn = (...args) => {
    cp.spawn = spawn;
    const child = spawn(...args);
    process.kill(process.pid, 'SIGTERM');
    return child;
};
`
        );
        const { exited } = launch(['-p', 'p'], { FAKE_HANG: '1', NODE_OPTIONS: `--require ${preload}` }, dir, bin);
        const { code, signal } = await exited;

        // The bridge itself survived the TERM, and left only once the CLI had: either the CLI
        // handled the forward (exit 0, marker written) or it died to it before its own handler
        // was up (128 + TERM, re-raised). An unforwarded TERM is neither — the bridge dies to it.
        expect(signal).toBeNull();
        expect([
            { code: 0, termed: true },
            { code: SIGNAL_EXIT_BASE + SIGTERM_NUMBER, termed: false },
        ]).toContainEqual({ code, termed: existsSync(join(dir, 'termed')) });
    });
});
