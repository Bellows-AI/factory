import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * The runner end of AskUserQuestion (issue #226): docker/claude-executor/claude-bridge.cjs run
 * against a fake `claude` on PATH and a fake control server on loopback. The fake CLI records its
 * argv and stdin, emits scripted stream-json, waits for one control_response per control_request
 * it emitted, then ends the turn with a `result` line and exits when its stdin closes.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BRIDGE = join(ROOT, 'docker/claude-executor/claude-bridge.cjs');
const EXECUTABLE_MODE = 0o755;
const POLL_MS = '20';
const RUN_TIMEOUT_MS = 20_000;
const USAGE_EXIT = 64;
const SIGNAL_EXIT_BASE = 128;
const SIGKILL_NUMBER = 9;
const QUESTION = 'Which colour is the SECRETQ?';
const QUESTIONS = [{ question: QUESTION, options: [{ label: 'Red' }, { label: 'Blue' }] }];
const TOOL_USE_ID = 'toolu_ask_1';

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const dir = process.env.FAKE_DIR;
fs.writeFileSync(dir + '/argv.json', JSON.stringify(process.argv.slice(2)));
const lines = JSON.parse(process.env.FAKE_LINES || '[]');
const expected = lines.filter((line) => line.type === 'control_request').length;
let responses = 0;
let emitted = false;
const say = (line) => process.stdout.write(JSON.stringify(line) + '\\n');
const finish = () => say({ type: 'result', subtype: 'success' });
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

interface Reply {
    status: number;
    body?: unknown;
    drop?: boolean;
}
interface Control {
    url: string;
    posts: { authorization: string | undefined; body: Record<string, unknown> }[];
    gets: number;
    close: () => Promise<void>;
}

/** A control server: POST /question answers `post`; GET /question/<id> walks `gets`, repeating the last. */
async function startControl(opts: { post?: Reply; gets?: Reply[]; onGet?: (count: number) => void }): Promise<Control> {
    const control = { posts: [], gets: 0 } as unknown as Control;
    control.posts = [];
    const server: Server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            const reply = (r: Reply) => {
                if (r.drop) return request.socket.destroy();
                response.statusCode = r.status;
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify(r.body ?? {}));
            };
            if (request.method === 'POST' && request.url === '/question') {
                control.posts.push({
                    authorization: request.headers.authorization,
                    body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                });
                return reply(opts.post ?? { status: 200, body: {} });
            }
            if (request.method === 'GET' && request.url === `/question/${TOOL_USE_ID}`) {
                control.gets += 1;
                opts.onGet?.(control.gets);
                const sequence = opts.gets ?? [{ status: 200, body: { state: 'pending' } }];
                return reply(sequence[Math.min(control.gets, sequence.length) - 1]);
            }
            reply({ status: 404 });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    control.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    control.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    return control;
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
const controls: Control[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const control of controls.splice(0)) await control.close();
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
            BELLOWS_CONTROL_URL: '',
            BELLOWS_CONTROL_TOKEN: '',
            FACTORY_STOP_MARKER: '',
            PATH: `${bin}:${process.env.PATH}`,
            FAKE_DIR: dir,
            BELLOWS_CONTROL_POLL_MS: POLL_MS,
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<{ code: number | null }>((resolve) => child.once('exit', (code) => resolve({ code })));
    return { child, exited, output: () => ({ stdout, stderr }) };
}

const readJson = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

async function run(opts: {
    args?: string[];
    env?: Record<string, string>;
    lines?: unknown[];
    control?: Control;
}): Promise<Run> {
    const { dir, bin } = sandbox();
    const env: Record<string, string> = { FAKE_LINES: JSON.stringify(opts.lines ?? []), ...opts.env };
    if (opts.control) {
        env.BELLOWS_CONTROL_URL = opts.control.url;
        env.BELLOWS_CONTROL_TOKEN = 'lane-token';
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
    it('turns an answered question into allow with the answers merged into the input', async () => {
        const control = await startControl({
            gets: [
                { status: 200, body: { state: 'pending' } },
                { status: 200, body: answeredBlue },
            ],
        });
        controls.push(control);

        const result = await run({ lines: [askRequest()], control });

        expect(result.stdin.at(-1)).toMatchObject({
            type: 'control_response',
            response: { subtype: 'success', request_id: 'req-1' },
        });
        expect(result.decision).toEqual({
            behavior: 'allow',
            updatedInput: { questions: QUESTIONS, answers: { [QUESTION]: 'Blue' } },
        });
        expect(control.posts).toEqual([
            { authorization: 'Bearer lane-token', body: { questionId: TOOL_USE_ID, questions: QUESTIONS } },
        ]);
        expect(control.gets).toBe(2);
        expect(result.code).toBe(0);
    });

    it.each([
        [
            'expired',
            { status: 200, body: { state: 'expired' } },
            'The question expired after 1 hour without an answer. Stop now.',
        ],
        ['cancelled', { status: 200, body: { state: 'cancelled' } }, 'The task was stopped.'],
        ['a 401', { status: 401 }, 'The task was stopped.'],
    ])('turns %s into deny and interrupt', async (_name, reply, message) => {
        const control = await startControl({ gets: [reply] });
        controls.push(control);

        const result = await run({ lines: [askRequest()], control });

        expect(result.decision).toEqual(interrupted(message));
    });

    it('stops on the stop marker, which it checks every poll', async () => {
        const { dir } = sandbox();
        const marker = join(dir, 'factory-stop');
        const control = await startControl({ onGet: (count) => count === 2 && writeFileSync(marker, 'stop\n') });
        controls.push(control);

        const result = await run({ lines: [askRequest()], control, env: { FACTORY_STOP_MARKER: marker } });

        expect(result.decision).toEqual(interrupted('The task was stopped.'));
        expect(control.gets).toBe(2);
    });

    it('denies without interrupt when the board refuses the question (400 or 429)', async () => {
        for (const status of [400, 429]) {
            const control = await startControl({ post: { status } });
            controls.push(control);

            const result = await run({ lines: [askRequest()], control });

            expect(result.decision).toEqual({
                behavior: 'deny',
                message:
                    'This run cannot ask more questions. Continue with your best judgment and state the assumption you made.',
                interrupt: false,
            });
            expect(control.gets).toBe(0);
        }
    });

    it('denies every other tool the way a headless run always did', async () => {
        const control = await startControl({});
        controls.push(control);

        const result = await run({ lines: [askRequest('Bash')], control });

        expect(result.decision).toEqual({
            behavior: 'deny',
            message: "Permission denied by the runner's permission settings.",
            interrupt: false,
        });
        expect(control.posts).toEqual([]);
    });

    it.each([
        ['BELLOWS_CONTROL_URL', { BELLOWS_CONTROL_URL: '', BELLOWS_CONTROL_TOKEN: 't' }],
        ['BELLOWS_CONTROL_TOKEN', { BELLOWS_CONTROL_URL: 'http://127.0.0.1:1', BELLOWS_CONTROL_TOKEN: '' }],
    ])('denies a question without interrupt when %s is unset', async (_name, env) => {
        const result = await run({ lines: [askRequest()], env });

        expect(result.decision).toEqual({
            behavior: 'deny',
            message:
                'Nobody can answer questions in this run. Continue with your best judgment and state the assumption you made.',
            interrupt: false,
        });
    });

    it('keeps polling through a network error and a 5xx', async () => {
        const control = await startControl({
            gets: [{ status: 200, drop: true }, { status: 503 }, { status: 200, body: answeredBlue }],
        });
        controls.push(control);

        const result = await run({ lines: [askRequest()], control });

        expect(result.decision.behavior).toBe('allow');
        expect(control.gets).toBe(3);
    });

    it('never writes the question text to stderr', async () => {
        const control = await startControl({ gets: [{ status: 200, body: answeredBlue }] });
        controls.push(control);

        const result = await run({ lines: [askRequest()], control });

        expect(result.stderr).not.toContain('SECRETQ');
    });
});

describe('claude-bridge exit and signals', () => {
    it('exits with the CLI’s own status', async () => {
        const result = await run({ env: { FAKE_EXIT: '7' } });

        expect(result.code).toBe(7);
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
});
