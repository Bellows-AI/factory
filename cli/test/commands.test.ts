import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

interface Call {
    url: string;
    method: string;
    body: unknown;
}

const job = (overrides: Record<string, unknown> = {}) => ({
    id: 'job-1',
    command: 'fix the login bug',
    status: 'running',
    attempts: 1,
    maxAttempts: 3,
    claimedBy: 'driver-1',
    createdBy: 'user-1',
    author: { id: 'user-1', login: 'octocat', name: null, avatarUrl: null },
    stoppedBy: null,
    doneBy: null,
    sessionId: 'session-1',
    exitCode: null,
    output: 'line one\nline two',
    summary: 'started looking at auth',
    failureKind: null,
    gates: [{ name: 'lint', status: 'passed', exitCode: 0, output: null }],
    runtime: null,
    repo: 'owner/name',
    executor: 'my-claude',
    followUpTo: null,
    rootJobId: 'job-1',
    workflowNode: null,
    workflowName: null,
    doneAt: null,
    cancelRequestedAt: null,
    workspacePath: null,
    createdAt: '2026-09-29T13:00:00.000Z',
    startedAt: '2026-09-29T13:00:05.000Z',
    finishedAt: null,
    wallClockMs: null,
    taskWallClockMs: null,
    waitReason: null,
    waitingSince: null,
    waitTerminalReason: null,
    ...overrides,
});

function harness(env: NodeJS.ProcessEnv, respond: (index: number) => Response) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: Call[] = [];
    const fetch = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
        const index = calls.length;
        calls.push({
            url: String(url),
            method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        return respond(index);
    }) as unknown as typeof globalThis.fetch;
    const io = {
        env,
        fetch,
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => err.push(text),
    };
    return { out, err, calls, io };
}

const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

const ENV = { FACTORY_URL: 'http://board', FACTORY_TOKEN: 'fat_abc' };

describe('factory job create', () => {
    it('posts the joined command, prints the queued id, and exits 0', async () => {
        const { out, calls, io } = harness(ENV, () => json({ id: 'job-1', status: 'queued' }, 201));

        const code = await run(['job', 'create', '--repo', 'owner/name', '--', 'npm', 'test', '--watch'], io);

        expect(code).toBe(0);
        expect(out.join('')).toContain('queued');
        expect(out.join('')).toContain('job-1');
        expect(calls[0]!.url).toBe('http://board/api/jobs');
        expect(calls[0]!.body).toEqual({ command: 'npm test --watch', repo: 'owner/name' });
    });

    it('is a usage error with no command, making no request', async () => {
        const { err, calls, io } = harness(ENV, () => json({}));

        const code = await run(['job', 'create'], io);

        expect(code).toBe(2);
        expect(err.join('')).toContain('usage:');
        expect(calls).toHaveLength(0);
    });
});

describe('factory job list', () => {
    it('prints one line per job', async () => {
        const { out, io } = harness(ENV, () =>
            json({ jobs: [job(), job({ id: 'job-2', status: 'queued', command: 'second task' })] })
        );

        const code = await run(['job', 'list'], io);

        expect(code).toBe(0);
        const printed = out.join('');
        expect(printed).toContain('job-1');
        expect(printed).toContain('running');
        expect(printed).toContain('fix the login bug');
        expect(printed).toContain('job-2');
    });

    it('prints the raw jobs array with --json', async () => {
        const jobs = [job()];
        const { out, io } = harness(ENV, () => json({ jobs }));

        const code = await run(['job', 'list', '--json'], io);

        expect(code).toBe(0);
        expect(JSON.parse(out.join(''))).toEqual(jobs);
    });

    it('refuses a non-numeric --limit before any request', async () => {
        const { err, calls, io } = harness(ENV, () => json({ jobs: [] }));

        const code = await run(['job', 'list', '--limit', 'many'], io);

        expect(code).toBe(2);
        expect(err.join('')).toContain('--limit');
        expect(calls).toHaveLength(0);
    });
});

describe('factory job investigate', () => {
    it('prints the job header, gates, output tail, and every thread member', async () => {
        const detail = job();
        const thread = {
            jobs: [detail, job({ id: 'job-0', status: 'succeeded', command: 'earlier turn', sessionId: 'session-0' })],
        };
        const { out, calls, io } = harness(ENV, (index) => (index === 0 ? json(detail) : json(thread)));

        const code = await run(['job', 'investigate', 'job-1'], io);

        expect(code).toBe(0);
        const printed = out.join('');
        expect(printed).toContain('running');
        expect(printed).toContain('session-1');
        expect(printed).toContain('lint passed');
        expect(printed).toContain('line one');
        expect(printed).toContain('earlier turn');
        expect(printed).toContain('session-0');
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1');
        expect(calls[1]!.url).toBe('http://board/api/jobs/job-1/thread');
    });

    it('prints { job, thread } with --json', async () => {
        const detail = job();
        const threadJobs = [detail];
        const { out, io } = harness(ENV, (index) => (index === 0 ? json(detail) : json({ jobs: threadJobs })));

        const code = await run(['job', 'investigate', 'job-1', '--json'], io);

        expect(code).toBe(0);
        expect(JSON.parse(out.join(''))).toEqual({ job: detail, thread: threadJobs });
    });
});

describe('command failures', () => {
    it('lands a board 404 on stderr with the board message and exits 1', async () => {
        const { err, io } = harness(ENV, () => json({ error: 'No such job', code: 'NOT_FOUND' }, 404));

        const code = await run(['job', 'investigate', 'nope'], io);

        expect(code).toBe(1);
        expect(err.join('')).toContain('No such job');
    });

    it('lands a network failure on stderr and exits 1', async () => {
        const fetch = (async () => {
            throw new Error('fetch failed');
        }) as unknown as typeof globalThis.fetch;
        const out: string[] = [];
        const err: string[] = [];
        const io = {
            env: ENV,
            fetch,
            stdout: (text: string) => out.push(text),
            stderr: (text: string) => err.push(text),
        };

        const code = await run(['job', 'list'], io);

        expect(code).toBe(1);
        expect(err.join('')).toContain('cannot reach http://board');
    });

    it('names the missing FACTORY_URL, exits 2, and makes no request', async () => {
        const { err, calls, io } = harness({}, () => json({ jobs: [] }));

        const code = await run(['job', 'list'], io);

        expect(code).toBe(2);
        expect(err.join('')).toContain('FACTORY_URL');
        expect(calls).toHaveLength(0);
    });

    it('prints usage and exits 2 for an unknown subcommand', async () => {
        const { err, calls, io } = harness(ENV, () => json({ jobs: [] }));

        const code = await run(['job', 'follow-up'], io);

        expect(code).toBe(2);
        expect(err.join('')).toContain('usage:');
        expect(calls).toHaveLength(0);
    });
});
