import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * The runner's half of the cooperative Stop (issue #442): the stop poller turns the driver's
 * control answer into a marker file, and the agent-side mechanism — Claude Code's PostToolUse hook,
 * OpenCode's plugin — reads only that marker. The real binaries are the `test:jobs` lane's
 * business (scripts/test-jobs.sh); what is pinned here is every file the images ship.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const path = (rel: string): string => join(ROOT, rel);
const read = (rel: string): string => readFileSync(path(rel), 'utf8');

const CLAUDE_POLLER = 'docker/claude-executor/stop-poller.cjs';
const OPENCODE_POLLER = 'docker/opencode-executor/stop-poller.cjs';
const CLAUDE_HOOK = 'docker/claude-executor/stop-hook.cjs';
const OPENCODE_PLUGIN = 'docker/opencode-executor/stop-plugin/index.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const server of servers.splice(0)) server.close();
});
const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'run-control-'));
    dirs.push(dir);
    return dir;
};

/** A control endpoint stub: answers `answers` in order, then the last one forever. */
async function controlStub(answers: { status: number; body: unknown }[]) {
    const seen: { url: string | undefined; authorization: string | undefined }[] = [];
    const server = createServer((request, reply) => {
        seen.push({ url: request.url, authorization: request.headers.authorization });
        const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
        reply.statusCode = answer.status;
        reply.setHeader('content-type', 'application/json');
        reply.end(JSON.stringify(answer.body));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { seen, url: `http://127.0.0.1:${port}` };
}

/** Runs the poller to its exit; resolves with the exit code. */
const runPoller = (script: string, env: Record<string, string>): Promise<number | null> =>
    new Promise((resolve) => {
        const child = spawn('node', [path(script)], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'ignore' });
        child.on('close', (code) => resolve(code));
    });

describe('the stop poller', () => {
    it.each([CLAUDE_POLLER, OPENCODE_POLLER])(
        '%s writes the marker once a Stop is raised, with its token',
        async (script) => {
            const marker = join(scratch(), 'stop');
            const control = await controlStub([
                { status: 200, body: { stop: false } },
                { status: 200, body: { stop: true } },
            ]);

            const code = await runPoller(script, {
                BELLOWS_CONTROL_URL: control.url,
                BELLOWS_CONTROL_TOKEN: 'tok-1',
                BELLOWS_CONTROL_POLL_MS: '20',
                FACTORY_STOP_MARKER: marker,
            });

            expect(code).toBe(0);
            expect(existsSync(marker)).toBe(true);
            expect(control.seen).toHaveLength(2);
            expect(control.seen.every((call) => call.url === '/control' && call.authorization === 'Bearer tok-1')).toBe(
                true
            );
        }
    );

    it('leaves no marker and exits when the endpoint no longer knows the token', async () => {
        const marker = join(scratch(), 'stop');
        const control = await controlStub([{ status: 401, body: { error: 'unknown token' } }]);

        const code = await runPoller(CLAUDE_POLLER, {
            BELLOWS_CONTROL_URL: control.url,
            BELLOWS_CONTROL_TOKEN: 'tok-gone',
            BELLOWS_CONTROL_POLL_MS: '20',
            FACTORY_STOP_MARKER: marker,
        });

        expect(code).toBe(0);
        expect(existsSync(marker)).toBe(false);
    });

    it('keeps polling through an unreachable driver and does nothing without a control channel', async () => {
        const marker = join(scratch(), 'stop');
        // No env at all: nothing to poll, exits at once.
        expect(await runPoller(CLAUDE_POLLER, { FACTORY_STOP_MARKER: marker })).toBe(0);

        // An unreachable endpoint is not a Stop: it keeps polling until killed, writing nothing.
        const child = spawn('node', [path(CLAUDE_POLLER)], {
            env: {
                PATH: process.env.PATH ?? '',
                BELLOWS_CONTROL_URL: 'http://127.0.0.1:1',
                BELLOWS_CONTROL_TOKEN: 'tok',
                BELLOWS_CONTROL_POLL_MS: '20',
                FACTORY_STOP_MARKER: marker,
            },
            stdio: 'ignore',
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(child.exitCode).toBeNull();
        child.kill();
        expect(existsSync(marker)).toBe(false);
    });

    it('is the same file in both images', () => {
        expect(read(OPENCODE_POLLER)).toBe(read(CLAUDE_POLLER));
    });
});

describe("Claude Code's PostToolUse stop hook", () => {
    const runHook = (marker: string): string =>
        execFileSync('node', [path(CLAUDE_HOOK)], {
            env: { PATH: process.env.PATH ?? '', FACTORY_STOP_MARKER: marker },
        }).toString();

    it('says nothing without the marker and ends the run with it', () => {
        const marker = join(scratch(), 'stop');
        expect(runHook(marker)).toBe('');

        writeFileSync(marker, 'stop\n');
        expect(JSON.parse(runHook(marker))).toMatchObject({ continue: false });
    });

    it('is registered as the only PostToolUse hook, beside the git guard', () => {
        const settings = JSON.parse(read('docker/claude-executor/claude-home/settings.json')) as {
            hooks: Record<string, { hooks: { command: string }[] }[]>;
        };
        expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse']);
        expect(settings.hooks.PostToolUse.flatMap((entry) => entry.hooks.map((hook) => hook.command))).toEqual([
            'node /usr/local/bin/stop-hook.cjs',
        ]);
    });
});

describe("OpenCode's stop plugin", () => {
    type Hooks = {
        event: (input: { event: unknown }) => Promise<void>;
        'tool.execute.after': (input: { sessionID?: string }) => Promise<void>;
    };
    const load = async (): Promise<(input: { client: unknown }) => Promise<Hooks>> =>
        (await import(pathToFileURL(path(OPENCODE_PLUGIN)).href)).FactoryStopPlugin;

    const withMarker = async (present: boolean) => {
        const marker = join(scratch(), 'stop');
        if (present) writeFileSync(marker, 'stop\n');
        process.env.FACTORY_STOP_MARKER = marker;
        const aborted: unknown[] = [];
        const client = { session: { abort: async (args: unknown) => void aborted.push(args) } };
        return { hooks: await (await load())({ client }), aborted };
    };
    afterEach(() => {
        delete process.env.FACTORY_STOP_MARKER;
    });

    it('aborts the session once at a step boundary when the marker exists', async () => {
        const { hooks, aborted } = await withMarker(true);

        await hooks.event({
            event: { type: 'message.part.updated', properties: { part: { type: 'step-finish', sessionID: 'ses_1' } } },
        });
        await hooks['tool.execute.after']({ sessionID: 'ses_1' });

        expect(aborted).toEqual([{ path: { id: 'ses_1' } }]);
    });

    it('aborts after a tool call too, and leaves a marker-less run alone', async () => {
        const stopped = await withMarker(true);
        await stopped.hooks['tool.execute.after']({ sessionID: 'ses_2' });
        expect(stopped.aborted).toEqual([{ path: { id: 'ses_2' } }]);

        const running = await withMarker(false);
        await running.hooks['tool.execute.after']({ sessionID: 'ses_3' });
        await running.hooks.event({
            event: { type: 'message.part.updated', properties: { part: { type: 'step-finish', sessionID: 'ses_3' } } },
        });
        expect(running.aborted).toEqual([]);
    });

    it('ignores events that are not a finished step', async () => {
        const { hooks, aborted } = await withMarker(true);
        await hooks.event({
            event: { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'ses_4' } } },
        });
        await hooks.event({ event: { type: 'session.idle', properties: {} } });
        expect(aborted).toEqual([]);
    });
});

describe('the images ship the cooperative Stop', () => {
    it('copies the claude pieces to /usr/local/bin and starts the poller beside the reporter', () => {
        const dockerfile = read('docker/claude-executor/Dockerfile');
        expect(dockerfile).toMatch(/COPY[^\n]*stop-poller\.cjs \/usr\/local\/bin\/stop-poller\.cjs/);
        expect(dockerfile).toMatch(/COPY[^\n]*stop-hook\.cjs \/usr\/local\/bin\/stop-hook\.cjs/);
        const entrypoint = read('docker/claude-executor/entrypoint.sh');
        expect(entrypoint).toContain('node /usr/local/bin/stop-poller.cjs >/dev/null 2>&1 &');
        expect(entrypoint).toContain('$STOP_POLLER_PID');
    });

    it('bakes the opencode plugin root-owned and registers it beside the others', () => {
        const dockerfile = read('docker/opencode-executor/Dockerfile');
        expect(dockerfile).toMatch(/COPY[^\n]*stop-poller\.cjs \/usr\/local\/bin\/stop-poller\.cjs/);
        expect(dockerfile).toMatch(/COPY stop-plugin\/ \/usr\/local\/lib\/node_modules\/factory-stop-plugin\//);
        const config = JSON.parse(read('docker/opencode-executor/opencode-home/opencode.json')) as { plugin: string[] };
        expect(config.plugin).toContain('/usr/local/lib/node_modules/factory-stop-plugin');
        const entrypoint = read('docker/opencode-executor/entrypoint.sh');
        expect(entrypoint).toContain('node /usr/local/bin/stop-poller.cjs >/dev/null 2>&1 &');
        expect(entrypoint).toContain('$STOP_POLLER_PID');
    });
});
