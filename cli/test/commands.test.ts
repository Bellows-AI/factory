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

function harness(env: NodeJS.ProcessEnv, respond: (index: number) => Response, now?: () => number) {
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
        ...(now ? { now } : {}),
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => err.push(text),
    };
    return { out, err, calls, io };
}

/**
 * A clock that reads the given milliseconds in order — the settle loop's deadline, spelled out
 * stamp by stamp rather than inferred from how often it looks. Running out throws rather than
 * repeating the last stamp: a loop that grew a clock read would otherwise slide silently into a
 * different schedule and still pass.
 */
function clockOf(...stamps: readonly number[]): () => number {
    let read = 0;
    return () => {
        const stamp = stamps[read++];
        if (stamp === undefined) throw new Error(`the clock was read ${read} times, ${stamps.length} stamps given`);
        return stamp;
    };
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

describe('factory job wait', () => {
    it('re-issues the settle long-poll until the row is terminal, then prints it and exits 0', async () => {
        // The board answers a timeout with the current row and no marker, so the status field is
        // the loop condition. Re-issuing is the wait; there is no sleep between the polls.
        const { out, calls, io } = harness(
            ENV,
            (index) => json(index === 0 ? job({ status: 'running' }) : job({ status: 'succeeded' })),
            // Each poll comes back at its full 60s hold — a board timeout, so the wait re-issues.
            clockOf(0, 0, 60_000, 60_000)
        );

        const code = await run(['job', 'wait', 'job-1', '--timeout', '120'], io);

        expect(code).toBe(0);
        expect(out.join('')).toContain('succeeded');
        expect(calls).toHaveLength(2);
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1?waitFor=terminal&timeout=60');
        expect(calls[1]!.url).toBe('http://board/api/jobs/job-1?waitFor=terminal&timeout=60');
    });

    it('holds only for what is left of the deadline, then exits 3 naming the last status', async () => {
        // 70s gone of a 120s wait leaves 50, so the poll asks for 50 rather than the cap, and
        // comes back at that full hold — a timeout — with the deadline then spent.
        const { err, calls, io } = harness(
            ENV,
            () => json(job({ status: 'running' })),
            clockOf(0, 70_000, 120_000, 120_000)
        );

        const code = await run(['job', 'wait', 'job-1', '--timeout', '120'], io);

        expect(code).toBe(3);
        expect(err.join('')).toContain('running');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1?waitFor=terminal&timeout=50');
    });

    it('stops re-issuing when the board settles early on a non-terminal row', async () => {
        // The board's settle is terminal OR an open workflow wait, and the second answers at
        // once with a queued/running row. Re-issuing on that would be a request storm for the
        // whole budget, so a hold that ended far short of its 60s ends the wait instead.
        const { err, calls, io } = harness(
            ENV,
            () => json(job({ status: 'queued', waitReason: 'pr_review' })),
            clockOf(0, 0, 300)
        );

        const code = await run(['job', 'wait', 'job-1', '--timeout', '120'], io);

        expect(code).toBe(3);
        expect(err.join('')).toContain('workflow wait');
        expect(calls).toHaveLength(1);
    });

    it('still catches the early settle on the one-second hold a spent budget asks for', async () => {
        // The early-settle rule is a fraction of the hold, not a fixed slack: a slack wide enough
        // for a 60s hold is dead at 1s, which is exactly where the last of a budget gets spent.
        const { err, calls, io } = harness(ENV, () => json(job({ status: 'running' })), clockOf(0, 0, 100));

        const code = await run(['job', 'wait', 'job-1', '--timeout', '1'], io);

        expect(code).toBe(3);
        expect(err.join('')).toContain('settled early');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1?waitFor=terminal&timeout=1');
    });

    it('prints the settled row as JSON with --json', async () => {
        const settled = job({ status: 'failed' });
        // Two reads: the deadline, then the one poll's start. It settles, so nothing reads again.
        const { out, io } = harness(ENV, () => json(settled), clockOf(0, 0));

        const code = await run(['job', 'wait', 'job-1', '--json'], io);

        expect(code).toBe(0);
        expect(JSON.parse(out.join(''))).toEqual(settled);
    });

    it('refuses a --timeout that is not a positive integer before any request', async () => {
        const { err, calls, io } = harness(ENV, () => json(job()));

        const code = await run(['job', 'wait', 'job-1', '--timeout', 'soon'], io);

        expect(code).toBe(2);
        expect(err.join('')).toContain('--timeout');
        expect(calls).toHaveLength(0);
    });
});

describe('factory job follow-up', () => {
    it('posts the joined command to the follow-up route and prints the new queued id', async () => {
        const { out, calls, io } = harness(ENV, () => json({ id: 'job-2', status: 'queued' }, 201));

        const code = await run(['job', 'follow-up', 'job-1', '--', 'now', 'add', 'a', 'test'], io);

        expect(code).toBe(0);
        expect(out.join('')).toContain('job-2');
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/follow-up');
        expect(calls[0]!.body).toEqual({ command: 'now add a test' });
    });

    it('is a usage error with an id but no command, making no request', async () => {
        const { err, calls, io } = harness(ENV, () => json({}));

        const code = await run(['job', 'follow-up', 'job-1'], io);

        expect(code).toBe(2);
        expect(err.join('')).toContain('usage:');
        expect(calls).toHaveLength(0);
    });

    it('surfaces the board refusal when the parent turn is not finished', async () => {
        const { err, io } = harness(ENV, () => json({ error: 'Task is still running', code: 'NOT_FINISHED' }, 409));

        const code = await run(['job', 'follow-up', 'job-1', 'again'], io);

        expect(code).toBe(1);
        expect(err.join('')).toContain('Task is still running');
        expect(err.join('')).toContain('NOT_FINISHED');
    });
});

describe('factory job stop', () => {
    it('reports the settled stop', async () => {
        const { out, calls, io } = harness(ENV, () => json({ id: 'job-1', status: 'stopped' }));

        const code = await run(['job', 'stop', 'job-1'], io);

        expect(code).toBe(0);
        expect(out.join('')).toContain('stopped');
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/stop');
        expect(calls[0]!.method).toBe('POST');
    });

    it('says the stop was only requested when the worker still holds the run', async () => {
        // 202: the request rides to the worker and the settle lands moments later, so "stopped"
        // would be a lie here.
        const { out, io } = harness(ENV, () =>
            json({ id: 'job-1', status: 'running', cancelRequestedAt: '2026-09-29T13:01:00.000Z' }, 202)
        );

        const code = await run(['job', 'stop', 'job-1'], io);

        expect(code).toBe(0);
        expect(out.join('')).toContain('stop requested');
        expect(out.join('')).toContain('2026-09-29T13:01:00.000Z');
    });
});

describe('factory job done', () => {
    it('marks the task done and prints the stamp', async () => {
        const { out, calls, io } = harness(ENV, () =>
            json({ id: 'job-1', status: 'succeeded', doneAt: '2026-09-29T13:02:00.000Z' })
        );

        const code = await run(['job', 'done', 'job-1'], io);

        expect(code).toBe(0);
        expect(out.join('')).toContain('done');
        expect(out.join('')).toContain('2026-09-29T13:02:00.000Z');
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/done');
        expect(calls[0]!.method).toBe('POST');
    });
});

describe('factory job remove', () => {
    it('deletes the thread once --yes is given', async () => {
        const { out, calls, io } = harness(ENV, () => json({ id: 'job-1', removed: true }));

        const code = await run(['job', 'remove', 'job-1', '--yes'], io);

        expect(code).toBe(0);
        expect(out.join('')).toContain('removed');
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/remove');
        expect(calls[0]!.method).toBe('POST');
    });

    it('refuses without --yes, making no request', async () => {
        // Remove deletes the whole thread and cannot be undone, so the irreversible step is the
        // one the command line has to say out loud.
        const { err, calls, io } = harness(ENV, () => json({ id: 'job-1', removed: true }));

        const code = await run(['job', 'remove', 'job-1'], io);

        expect(code).toBe(2);
        expect(err.join('')).toContain('--yes');
        expect(calls).toHaveLength(0);
    });

    it('surfaces the board refusal when the task is still running', async () => {
        const { err, io } = harness(ENV, () =>
            json({ error: 'The task is still running — stop it first', code: 'TASK_RUNNING' }, 409)
        );

        const code = await run(['job', 'remove', 'job-1', '--yes'], io);

        expect(code).toBe(1);
        expect(err.join('')).toContain('stop it first');
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

        const code = await run(['job', 'frobnicate'], io);

        expect(code).toBe(2);
        expect(err.join('')).toContain('usage:');
        expect(calls).toHaveLength(0);
    });
});
