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
    mode: 'objective',
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

/** The board's answer to a settle long-poll: the explicit result, the thread identity, the run row. */
const waitBody = (
    result: 'terminal' | 'parked' | 'timeout',
    jobOverrides: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {}
) => ({
    result,
    rootJobId: 'job-1',
    headJobId: 'job-1',
    headStatus: result === 'terminal' ? 'succeeded' : 'running',
    waitReason: null,
    job: job({ status: result === 'terminal' ? 'succeeded' : 'running', ...jobOverrides }),
    ...overrides,
});

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

    it('rides the executor scope the flag names into the body (issue 391)', async () => {
        const { calls, io } = harness(ENV, () => json({ id: 'job-1', status: 'queued' }, 201));

        const code = await run(
            ['job', 'create', '--executor', 'team-runner', '--executor-scope', 'org', '--', 'npm test'],
            io
        );

        expect(code).toBe(0);
        expect(calls[0]!.body).toEqual({
            command: 'npm test',
            executor: 'team-runner',
            executorScope: 'org',
        });
    });

    it('sends each repeated --skill as the skills list (issue #545), and no key when none is given', async () => {
        const { calls, io } = harness(ENV, () => json({ id: 'job-1', status: 'queued' }, 201));

        expect(await run(['job', 'create', '--skill', 'github', '--skill', 'jira', '--', 'npm test'], io)).toBe(0);
        expect(await run(['job', 'create', '--', 'npm test'], io)).toBe(0);

        expect(calls[0]!.body).toEqual({ command: 'npm test', skills: ['github', 'jira'] });
        expect(calls[1]!.body).toEqual({ command: 'npm test' });
    });

    it('sends no scope when the flag is absent — the board defaults to personal', async () => {
        const { calls, io } = harness(ENV, () => json({ id: 'job-1', status: 'queued' }, 201));

        const code = await run(['job', 'create', '--executor', 'main', '--', 'npm test'], io);

        expect(code).toBe(0);
        expect(calls[0]!.body).toEqual({ command: 'npm test', executor: 'main' });
    });

    it('refuses a scope outside user|org as a usage error, before any request', async () => {
        const { err, calls, io } = harness(ENV, () => json({}));

        const code = await run(
            ['job', 'create', '--executor', 'main', '--executor-scope', 'repo', '--', 'npm test'],
            io
        );

        expect(code).toBe(2);
        expect(err.join('')).toContain('--executor-scope');
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

    it('prints the envelope around the jobs with --json', async () => {
        const jobs = [job()];
        const { out, err, io } = harness(ENV, () => json({ jobs }));

        const code = await run(['job', 'list', '--json'], io);

        expect(code).toBe(0);
        expect(err).toEqual([]);
        expect(JSON.parse(out.join(''))).toEqual({
            ok: true,
            command: 'job list',
            outcome: 'ok',
            exitCode: 0,
            data: { jobs },
            error: null,
        });
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

    it('separates the executor scope label from its value in the detail block', async () => {
        const detail = job({ executorScope: 'org' });
        const thread = { jobs: [detail] };
        const { out, io } = harness(ENV, (index) => (index === 0 ? json(detail) : json(thread)));

        const code = await run(['job', 'investigate', 'job-1'], io);

        expect(code).toBe(0);
        expect(out.join('')).toMatch(/scope:\s+org/);
    });

    it('prints the task mode in the detail block', async () => {
        const detail = job({ mode: 'objective' });
        const thread = { jobs: [detail] };
        const { out, io } = harness(ENV, (index) => (index === 0 ? json(detail) : json(thread)));

        const code = await run(['job', 'investigate', 'job-1'], io);

        expect(code).toBe(0);
        expect(out.join('')).toMatch(/mode:\s+objective/);
    });

    it('prints { job, thread } with --json', async () => {
        const detail = job();
        const threadJobs = [detail];
        const { out, io } = harness(ENV, (index) => (index === 0 ? json(detail) : json({ jobs: threadJobs })));

        const code = await run(['job', 'investigate', 'job-1', '--json'], io);

        expect(code).toBe(0);
        expect(JSON.parse(out.join('')).data).toEqual({ job: detail, thread: threadJobs });
    });
});

describe('factory job wait', () => {
    it("re-issues on the board's timeout result until a terminal one, then prints the row and exits 0", async () => {
        // Only the board's `timeout` result is re-issued; there is no sleep between the polls.
        const { out, calls, io } = harness(
            ENV,
            (index) => json(index === 0 ? waitBody('timeout') : waitBody('terminal')),
            // The deadline, then one read per loop turn.
            clockOf(0, 0, 60_000)
        );

        const code = await run(['job', 'wait', 'job-1', '--timeout', '120'], io);

        expect(code).toBe(0);
        expect(out.join('')).toContain('succeeded');
        expect(calls).toHaveLength(2);
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1?waitFor=terminal&timeout=60');
        expect(calls[1]!.url).toBe('http://board/api/jobs/job-1?waitFor=terminal&timeout=60');
    });

    it('holds only for what is left of the budget, then exits 3 naming the last status', async () => {
        // 70s gone of a 120s wait leaves 50, so the poll asks for 50 rather than the cap; the
        // board answers a timeout and the budget is then spent.
        const { err, calls, io } = harness(ENV, () => json(waitBody('timeout')), clockOf(0, 70_000, 120_000));

        const code = await run(['job', 'wait', 'job-1', '--timeout', '120'], io);

        expect(code).toBe(3);
        expect(err.join('')).toContain('running');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1?waitFor=terminal&timeout=50');
    });

    it("ends on the board's parked result however fast it came back, naming the wait", async () => {
        // No clock reads past the poll's own: the result says parked, so nothing about timing is
        // consulted — a parked thread ends the wait at once and exits 6.
        const { err, calls, io } = harness(
            ENV,
            () => json(waitBody('parked', {}, { headStatus: 'queued', waitReason: 'pr_review' })),
            clockOf(0, 0)
        );

        const code = await run(['job', 'wait', 'job-1', '--timeout', '120'], io);

        expect(code).toBe(6);
        expect(err.join('')).toContain('pr_review');
        expect(calls).toHaveLength(1);
    });

    it('does not treat a quick timeout result as parked', async () => {
        // The old rule read a hold that ended early as parked. The board's result is the only
        // signal now: a `timeout` that came back instantly is simply re-issued.
        const { calls, io } = harness(
            ENV,
            (index) => json(index === 0 ? waitBody('timeout') : waitBody('terminal')),
            clockOf(0, 0, 1)
        );

        const code = await run(['job', 'wait', 'job-1', '--timeout', '120'], io);

        expect(code).toBe(0);
        expect(calls).toHaveLength(2);
    });

    it('prints the wait envelope with the task, run and head identities with --json', async () => {
        const settled = job({ status: 'failed' });
        const { out, err, io } = harness(
            ENV,
            () => json(waitBody('terminal', { status: 'failed' }, { headStatus: 'failed', headJobId: 'job-9' })),
            clockOf(0, 0)
        );

        const code = await run(['job', 'wait', 'job-1', '--json'], io);

        expect(code).toBe(4);
        expect(err).toEqual([]);
        expect(JSON.parse(out.join(''))).toEqual({
            ok: false,
            command: 'job wait',
            outcome: 'failed',
            exitCode: 4,
            data: {
                result: 'terminal',
                taskId: 'job-1',
                runId: 'job-1',
                headRunId: 'job-9',
                headStatus: 'failed',
                waitReason: null,
                budgetSeconds: 300,
                job: settled,
            },
            error: null,
        });
    });

    // Every way a wait can end, against the one exit code and outcome each owns.
    it.each([
        { label: 'succeeded', body: waitBody('terminal'), exitCode: 0, outcome: 'succeeded', stream: 'stdout' },
        {
            label: 'failed',
            body: waitBody('terminal', {}, { headStatus: 'failed' }),
            exitCode: 4,
            outcome: 'failed',
            stream: 'stdout',
        },
        {
            label: 'dead',
            body: waitBody('terminal', {}, { headStatus: 'dead' }),
            exitCode: 4,
            outcome: 'failed',
            stream: 'stdout',
        },
        {
            label: 'stopped',
            body: waitBody('terminal', {}, { headStatus: 'stopped' }),
            exitCode: 5,
            outcome: 'cancelled',
            stream: 'stdout',
        },
        {
            label: 'parked',
            body: waitBody('parked', {}, { waitReason: 'pr_review' }),
            exitCode: 6,
            outcome: 'needs_attention',
            stream: 'stderr',
        },
        {
            label: 'a non-head run on a failed head',
            body: waitBody('terminal', {}, { headStatus: 'failed', headJobId: 'job-9' }),
            exitCode: 4,
            outcome: 'failed',
            stream: 'stdout',
        },
    ])('ends $label with exit $exitCode and outcome $outcome', async ({ body, exitCode, outcome, stream }) => {
        const human = harness(ENV, () => json(body), clockOf(0, 0));
        expect(await run(['job', 'wait', 'job-1'], human.io)).toBe(exitCode);
        expect((stream === 'stdout' ? human.out : human.err).join('')).not.toBe('');

        const machine = harness(ENV, () => json(body), clockOf(0, 0));
        expect(await run(['job', 'wait', 'job-1', '--json'], machine.io)).toBe(exitCode);
        expect(JSON.parse(machine.out.join('')).outcome).toBe(outcome);
        expect(machine.err).toEqual([]);
    });

    it('ends exit 3 with outcome timeout when the budget is spent', async () => {
        const { out, io } = harness(ENV, () => json(waitBody('timeout')), clockOf(0, 0, 1_000));

        const code = await run(['job', 'wait', 'job-1', '--timeout', '1', '--json'], io);

        expect(code).toBe(3);
        expect(JSON.parse(out.join('')).outcome).toBe('timeout');
    });

    it('refuses an answer with no wait result as a malformed response, not a guess', async () => {
        // A board that answers the bare row (the old shape) is refused, never inferred from.
        const { err, io } = harness(ENV, () => json(job({ status: 'succeeded' })), clockOf(0, 0));

        const code = await run(['job', 'wait', 'job-1'], io);

        expect(code).toBe(1);
        expect(err.join('')).toContain('MALFORMED_RESPONSE');
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

        expect(code).toBe(7);
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

describe('--json on every outcome', () => {
    const refusal = () => json({ error: 'No such job', code: 'NOT_FOUND' }, 404);
    const unreachable = () => {
        throw new Error('fetch failed');
    };

    // Each row: a command line, what the board does, then the one outcome and exit code it must
    // end in. The same line runs with --json and must leave stderr empty and stdout one document.
    const nonJson = () => new Response('<html>', { status: 200 });
    const FAILURES = [
        {
            label: 'a board refusal on a read',
            argv: ['job', 'investigate', 'nope'],
            respond: refusal,
            outcome: 'refused',
            exitCode: 1,
        },
        {
            label: 'a board refusal on an action',
            argv: ['job', 'stop', 'nope'],
            respond: refusal,
            outcome: 'refused',
            exitCode: 1,
        },
        {
            label: 'a board refusal on a wait',
            argv: ['job', 'wait', 'nope'],
            respond: refusal,
            outcome: 'refused',
            exitCode: 1,
        },
        {
            label: 'a network failure',
            argv: ['job', 'list'],
            respond: unreachable,
            outcome: 'unreachable',
            exitCode: 7,
        },
        { label: 'a non-JSON 2xx body', argv: ['job', 'list'], respond: nonJson, outcome: 'refused', exitCode: 1 },
        { label: 'a missing config', argv: ['job', 'list'], respond: refusal, outcome: 'usage', exitCode: 2, env: {} },
        {
            label: 'a bad flag value',
            argv: ['job', 'list', '--limit', 'many'],
            respond: refusal,
            outcome: 'usage',
            exitCode: 2,
        },
        { label: 'an unknown flag', argv: ['job', 'list', '--frob'], respond: refusal, outcome: 'usage', exitCode: 2 },
        { label: 'a create with no command', argv: ['job', 'create'], respond: refusal, outcome: 'usage', exitCode: 2 },
        {
            label: 'a remove without --yes',
            argv: ['job', 'remove', 'job-1'],
            respond: refusal,
            outcome: 'usage',
            exitCode: 2,
        },
        {
            label: 'a bad wait timeout',
            argv: ['job', 'wait', 'job-1', '--timeout', 'soon'],
            respond: refusal,
            outcome: 'usage',
            exitCode: 2,
        },
        {
            label: 'an unknown subcommand',
            argv: ['job', 'frobnicate'],
            respond: refusal,
            outcome: 'usage',
            exitCode: 2,
        },
        { label: 'an unknown topic', argv: ['nope'], respond: refusal, outcome: 'usage', exitCode: 2 },
        { label: 'no arguments at all', argv: [], respond: refusal, outcome: 'usage', exitCode: 2 },
    ];

    it.each(FAILURES)('$label ends as one parseable document', async ({ argv, respond, outcome, exitCode, env }) => {
        const { out, err, calls, io } = harness(env ?? ENV, respond);

        const code = await run([...argv, '--json'], io);

        expect(code).toBe(exitCode);
        expect(err).toEqual([]);
        expect(out).toHaveLength(1);
        const envelope = JSON.parse(out[0]!);
        expect(envelope).toMatchObject({ ok: false, outcome, exitCode });
        expect(envelope.error.message).not.toBe('');
        if (outcome === 'usage') expect(calls).toHaveLength(0);
    });

    it("carries the board's code and status on a refusal", async () => {
        const { out, io } = harness(ENV, refusal);

        await run(['job', 'investigate', 'nope', '--json'], io);

        expect(JSON.parse(out.join('')).error).toEqual({ message: 'No such job', code: 'NOT_FOUND', status: 404 });
    });

    it("honors --json even when it comes before the id and after a create command's `--`", async () => {
        const { out, io } = harness(ENV, () => json({ id: 'job-1', status: 'queued' }, 201));

        // After `--` the flag belongs to the task's own command, not to the CLI.
        const code = await run(['job', 'create', '--', 'npm', 'test', '--json'], io);

        expect(code).toBe(0);
        expect(out.join('')).toBe('queued job-1\n');
    });

    it.each([
        ['create', ['job', 'create', '--json', '--', 'npm test'], { id: 'job-1', status: 'queued' }],
        ['follow-up', ['job', 'follow-up', 'job-1', 'again', '--json'], { id: 'job-2', status: 'queued' }],
        ['stop', ['job', 'stop', 'job-1', '--json'], { id: 'job-1', status: 'stopped' }],
        ['done', ['job', 'done', 'job-1', '--json'], { id: 'job-1', status: 'succeeded', doneAt: null }],
        ['remove', ['job', 'remove', 'job-1', '--yes', '--json'], { id: 'job-1', removed: true }],
    ])('prints the %s payload inside the envelope', async (name, argv, payload) => {
        const { out, err, io } = harness(ENV, () => json(payload));

        const code = await run(argv, io);

        expect(code).toBe(0);
        expect(err).toEqual([]);
        expect(JSON.parse(out.join(''))).toEqual({
            ok: true,
            command: `job ${name}`,
            outcome: 'ok',
            exitCode: 0,
            data: payload,
            error: null,
        });
    });

    it('ends interrupted, not unreachable or cancelled, when the local signal aborts the request', async () => {
        const controller = new AbortController();
        const fetch = (async () => {
            controller.abort();
            throw new DOMException('This operation was aborted', 'AbortError');
        }) as unknown as typeof globalThis.fetch;
        const out: string[] = [];
        const err: string[] = [];
        const io = {
            env: ENV,
            fetch,
            signal: controller.signal,
            stdout: (text: string) => out.push(text),
            stderr: (text: string) => err.push(text),
        };

        const code = await run(['job', 'wait', 'job-1', '--json'], io);

        expect(code).toBe(130);
        expect(err).toEqual([]);
        expect(JSON.parse(out.join(''))).toMatchObject({ ok: false, outcome: 'interrupted', exitCode: 130 });
    });
});
