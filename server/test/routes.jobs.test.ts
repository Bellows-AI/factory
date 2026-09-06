import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Claim, Job, JobStatus, JobStore, LeaseResult } from '../src/db/job-store.js';
import { createStatsService } from '../src/stats-service.js';
import { stubClient, stubTelemetryClient, testConfig } from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = '22222222-2222-4222-8222-222222222222';

interface StoreStub extends JobStore {
    created: { command: string; createdBy: string | null; repo: string | null; executor: string | null }[];
    listed: { status?: JobStatus; repo?: string | undefined; limit: number }[];
    completed: { id: string; output: string | null }[];
    sessions: { id: string; sessionId: string; remoteSessionId: string | null }[];
    suspended: string[];
}

/**
 * Deliberately not a lease implementation. These tests are about the HTTP contract — which body is
 * refused, which code a store verdict maps to — and a second copy of the claim rules here would
 * only ever agree with itself. The real ones are exercised against a database in
 * test-db/job-store.test.ts.
 */
function stubStore(
    options: {
        fail?: boolean;
        claim?: Claim | null;
        verdict?: LeaseResult;
        job?: Job | null;
        resume?: 'ok' | 'missing' | 'conflict';
    } = {},
): StoreStub {
    const boom = () => {
        if (options.fail) throw new Error('database is down');
    };
    const stub: StoreStub = {
        created: [],
        listed: [],
        commands: [],
        completed: [],
        sessions: [],
        suspended: [],
        async suspend(id) {
            boom();
            stub.suspended.push(id);
            return options.verdict ?? 'ok';
        },
        async resume() {
            boom();
            return options.resume ?? 'ok';
        },
        async create(command, createdBy, target) {
            boom();
            stub.created.push({
                command,
                createdBy: createdBy ?? null,
                repo: target?.repo ?? null,
                executor: target?.executor ?? null,
            });
            stub.commands.push(command);
            return { id: ID };
        },
        async claim() {
            boom();
            return options.claim ?? null;
        },
        async heartbeat() {
            boom();
            const result = options.verdict ?? 'ok';
            return { result, leaseExpiresAt: result === 'ok' ? '2026-08-21T12:05:00.000Z' : null };
        },
        async session(id, _token, sessionId, remoteSessionId) {
            boom();
            stub.sessions.push({ id, sessionId, remoteSessionId });
            return options.verdict ?? 'ok';
        },
        async complete(id, _token, { output }) {
            boom();
            stub.completed.push({ id, output });
            return options.verdict ?? 'ok';
        },
        async get() {
            boom();
            return options.job ?? null;
        },
        async list(filter) {
            boom();
            stub.listed.push(filter);
            return options.job ? [options.job] : [];
        },
    };
    return stub;
}

async function harnessWith(jobs?: StoreStub) {
    const config = testConfig();
    const service = createStatsService({
        config,
        client: stubClient(),
        telemetry: stubTelemetryClient(),
        now: () => Date.parse('2026-08-21T12:00:00.000Z'),
    });
    const instance = await buildApp({ config, service, jobs });
    app = instance;
    return instance;
}

const post = (instance: FastifyInstance, url: string, payload: unknown) =>
    instance.inject({ method: 'POST', url, payload: payload as object });

describe('POST /api/jobs', () => {
    it('queues a command', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const response = await post(instance, '/api/jobs', { command: 'claude -p "fix the build"' });

        expect(response.statusCode).toBe(201);
        expect(response.json()).toEqual({ id: ID, status: 'queued' });
        expect(store.commands).toEqual(['claude -p "fix the build"']);
    });

    it.each([
        ['a missing command', {}],
        ['an empty command', { command: '' }],
        ['whitespace only', { command: '   ' }],
        ['a non-string command', { command: 42 }],
        ['an oversized command', { command: 'x'.repeat(16_385) }],
    ])('refuses %s', async (_label, payload) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, '/api/jobs', payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_COMMAND');
    });

    it('queues a command with a repository and an executor', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const response = await post(instance, '/api/jobs', {
            command: 'claude -p "fix the build"',
            repo: 'acme/web',
            executor: 'main',
        });

        expect(response.statusCode).toBe(201);
        expect(response.json()).toEqual({ id: ID, status: 'queued' });
        expect(store.created).toEqual([
            { command: 'claude -p "fix the build"', createdBy: null, repo: 'acme/web', executor: 'main' },
        ]);
    });

    it('records no repository and no executor when the body has none', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const response = await post(instance, '/api/jobs', { command: 'echo hi' });

        expect(response.statusCode).toBe(201);
        expect(store.created).toEqual([{ command: 'echo hi', createdBy: null, repo: null, executor: null }]);
    });

    // Absent and explicit null are the same "not given" — JSON null is what a client that clears
    // a dropdown sends.
    it('takes an explicit null as not given', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const response = await post(instance, '/api/jobs', {
            command: 'echo hi',
            repo: null,
            executor: null,
        });

        expect(response.statusCode).toBe(201);
        expect(store.created).toEqual([{ command: 'echo hi', createdBy: null, repo: null, executor: null }]);
    });

    it.each([
        ['a repo without an owner', 'web'],
        ['a repo with three segments', 'acme/web/extra'],
        ['a repo with an empty name', 'acme/'],
        ['a repo whose owner starts with "-"', '-weird/web'],
        ['a repo whose name is ".."', 'acme/..'],
        ['an oversized repo owner', `${'x'.repeat(101)}/web`],
        ['a non-string repo', 42],
    ])('refuses %s', async (_label, repo) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, '/api/jobs', { command: 'echo hi', repo });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_REPO');
    });

    it.each([
        ['an empty executor', ''],
        ['an executor with a path separator', 'a/b'],
        ['an executor starting with "."', '.hidden'],
        ['a non-string executor', 7],
    ])('refuses %s', async (_label, executor) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, '/api/jobs', { command: 'echo hi', executor });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_EXECUTOR');
    });

    it('answers 503 when the store is down, so the caller retries', async () => {
        const instance = await harnessWith(stubStore({ fail: true }));
        const response = await post(instance, '/api/jobs', { command: 'echo hi' });
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });
});

describe('POST /api/jobs/claim', () => {
    const claim: Claim = {
        id: ID,
        command: 'echo hi',
        attempts: 1,
        leaseToken: TOKEN,
        leaseExpiresAt: '2026-08-21T12:05:00.000Z',
        resumeSessionId: null,
    };

    it('hands out the job with its lease token', async () => {
        const instance = await harnessWith(stubStore({ claim }));
        const response = await post(instance, '/api/jobs/claim', { worker: 'w1', leaseSeconds: 300 });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(claim);
    });

    // The idle poll is the common case: it must be recognisable without parsing a body.
    it('answers 204 when nothing is waiting', async () => {
        const instance = await harnessWith(stubStore({ claim: null }));
        const response = await post(instance, '/api/jobs/claim', { worker: 'w1' });
        expect(response.statusCode).toBe(204);
        expect(response.body).toBe('');
    });

    it('requires a worker id, because a stuck job has to be traceable to a container', async () => {
        const instance = await harnessWith(stubStore({ claim }));
        const response = await post(instance, '/api/jobs/claim', { leaseSeconds: 300 });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_WORKER');
    });

    it.each([0, -1, 3601, 1.5, 'soon'])('refuses leaseSeconds %p', async (leaseSeconds) => {
        const instance = await harnessWith(stubStore({ claim }));
        const response = await post(instance, '/api/jobs/claim', { worker: 'w1', leaseSeconds });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_LEASE');
    });
});

describe('POST /api/jobs/:id/heartbeat', () => {
    it('extends the lease', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'ok' }));
        const response = await post(instance, `/api/jobs/${ID}/heartbeat`, { leaseToken: TOKEN });
        expect(response.statusCode).toBe(200);
        expect(response.json().leaseExpiresAt).toBe('2026-08-21T12:05:00.000Z');
    });

    // The only signal a superseded worker gets. The driver kills the container on this.
    it('answers 409 once the lease has moved on', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'lost' }));
        const response = await post(instance, `/api/jobs/${ID}/heartbeat`, { leaseToken: TOKEN });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('LEASE_LOST');
    });

    it('answers 404 for a job that does not exist', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'missing' }));
        const response = await post(instance, `/api/jobs/${ID}/heartbeat`, { leaseToken: TOKEN });
        expect(response.statusCode).toBe(404);
    });

    // Reaches the store as a uuid or not at all: postgres rejects a malformed one with a 500-shaped
    // error, and a bad path is a 400.
    it('refuses a malformed id before touching the store', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const response = await post(instance, '/api/jobs/not-a-uuid/heartbeat', { leaseToken: TOKEN });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_ID');
    });

    it('refuses a malformed lease token', async () => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/heartbeat`, { leaseToken: 'nope' });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_TOKEN');
    });
});

describe('POST /api/jobs/:id/session', () => {
    const SESSION = '33333333-3333-4333-8333-333333333333';

    it('records the session the attempt is running as', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/session`, {
            leaseToken: TOKEN,
            sessionId: SESSION,
        });

        expect(response.statusCode).toBe(200);
        expect(store.sessions).toEqual([{ id: ID, sessionId: SESSION, remoteSessionId: null }]);
    });

    // The second report of an attempt. The remote id is assigned by Anthropic's backend when the
    // bridge connects, so it can only ever arrive after the run has started.
    it('records the remote session id when the bridge has reported one', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/session`, {
            leaseToken: TOKEN,
            sessionId: SESSION,
            remoteSessionId: 'cse_015tb2nHhHNrBuL7ZDhn9Wx5',
        });

        expect(response.statusCode).toBe(200);
        expect(store.sessions[0]?.remoteSessionId).toBe('cse_015tb2nHhHNrBuL7ZDhn9Wx5');
    });

    // Deliberately not shape-checked: it is an opaque token minted elsewhere, and pinning `cse_`
    // here would break on the day it changes.
    it('takes any reasonable string as the remote id, but not junk', async () => {
        const instance = await harnessWith(stubStore());
        const send = (remoteSessionId: unknown) =>
            post(instance, `/api/jobs/${ID}/session`, { leaseToken: TOKEN, sessionId: SESSION, remoteSessionId });

        expect((await send('anything-at-all')).statusCode).toBe(200);
        expect((await send('   ')).statusCode).toBe(400);
        expect((await send(42)).statusCode).toBe(400);
        expect((await send('x'.repeat(257))).statusCode).toBe(400);
    });

    // Same rule as every other worker write: a superseded worker must not relabel the run that
    // replaced it.
    it('rejects a report from a worker whose lease was reclaimed', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'lost' }));
        const response = await post(instance, `/api/jobs/${ID}/session`, {
            leaseToken: TOKEN,
            sessionId: SESSION,
        });
        expect(response.statusCode).toBe(409);
    });

    it.each([
        ['a missing session id', { leaseToken: TOKEN }, 'BAD_SESSION_ID'],
        ['a session id that is not a uuid', { leaseToken: TOKEN, sessionId: 'nope' }, 'BAD_SESSION_ID'],
        ['a malformed lease token', { leaseToken: 'nope', sessionId: SESSION }, 'BAD_TOKEN'],
    ])('refuses %s', async (_label, payload, code) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/session`, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe(code);
    });
});

describe('parking and resuming', () => {
    it('parks a running job', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/suspend`, { leaseToken: TOKEN });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: ID, status: 'standby' });
        expect(store.suspended).toEqual([ID]);
    });

    it('refuses a park from a worker whose lease was reclaimed', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'lost' }));
        const response = await post(instance, `/api/jobs/${ID}/suspend`, { leaseToken: TOKEN });
        expect(response.statusCode).toBe(409);
    });

    it('puts a parked job back in the queue', async () => {
        const instance = await harnessWith(stubStore({ resume: 'ok' }));
        const response = await post(instance, `/api/jobs/${ID}/resume`, {});
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: ID, status: 'queued' });
    });

    // Resuming something that is running or finished is a caller mistake, and it has to read
    // differently from a job that is not there at all.
    it('separates a job that is not parked from one that does not exist', async () => {
        const conflict = await harnessWith(stubStore({ resume: 'conflict' }));
        const first = await post(conflict, `/api/jobs/${ID}/resume`, {});
        expect(first.statusCode).toBe(409);
        expect(first.json().code).toBe('NOT_STANDBY');

        await conflict.close();
        const absent = await harnessWith(stubStore({ resume: 'missing' }));
        expect((await post(absent, `/api/jobs/${ID}/resume`, {})).statusCode).toBe(404);
    });

    // No lease token on resume: nobody holds a parked job, which is what makes it resumable by a
    // person rather than only by the worker that parked it.
    it('takes no lease token to resume', async () => {
        const instance = await harnessWith(stubStore({ resume: 'ok' }));
        expect((await post(instance, `/api/jobs/${ID}/resume`, {})).statusCode).toBe(200);
    });

    it('refuses a malformed id on either', async () => {
        const instance = await harnessWith(stubStore());
        expect((await post(instance, '/api/jobs/nope/suspend', { leaseToken: TOKEN })).statusCode).toBe(400);
        expect((await post(instance, '/api/jobs/nope/resume', {})).statusCode).toBe(400);
    });
});

describe('POST /api/jobs/:id/complete', () => {
    const done = { leaseToken: TOKEN, status: 'succeeded', exitCode: 0, output: 'hello' };

    it('records the outcome', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, done);
        expect(response.statusCode).toBe(200);
        expect(store.completed).toEqual([{ id: ID, output: 'hello' }]);
    });

    it('rejects a report from a worker whose lease was reclaimed', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'lost' }));
        const response = await post(instance, `/api/jobs/${ID}/complete`, done);
        expect(response.statusCode).toBe(409);
    });

    it.each([
        ['an unknown status', { ...done, status: 'dead' }, 'BAD_STATUS'],
        ['a fractional exit code', { ...done, exitCode: 1.5 }, 'BAD_EXIT_CODE'],
        ['a non-string output', { ...done, output: { tail: 'x' } }, 'BAD_OUTPUT'],
    ])('refuses %s', async (_label, payload, code) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/complete`, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe(code);
    });

    // A body limit is not a length check: 128 KiB of output gets through it and would be stored.
    it('truncates output before it reaches the store', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);

        await post(instance, `/api/jobs/${ID}/complete`, { ...done, output: 'x'.repeat(100_000) });

        expect(store.completed[0]?.output).toHaveLength(64 * 1024);
    });
});

describe('GET /api/jobs', () => {
    const job: Job = {
        id: ID,
        command: 'echo hi',
        status: 'succeeded',
        attempts: 1,
        maxAttempts: 3,
        claimedBy: 'w1',
        sessionId: '33333333-3333-4333-8333-333333333333',
        remoteSessionId: 'cse_015tb2nHhHNrBuL7ZDhn9Wx5',
        exitCode: 0,
        output: 'hello',
        repo: 'acme/web',
        executor: 'main',
        createdAt: '2026-08-21T12:00:00.000Z',
        startedAt: '2026-08-21T12:00:01.000Z',
        finishedAt: '2026-08-21T12:00:09.000Z',
    };

    it('reads one job', async () => {
        const instance = await harnessWith(stubStore({ job }));
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}` });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(job);
    });

    it('answers 404 for an unknown job', async () => {
        const instance = await harnessWith(stubStore({ job: null }));
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}` });
        expect(response.statusCode).toBe(404);
    });

    it('lists jobs', async () => {
        const instance = await harnessWith(stubStore({ job }));
        const response = await instance.inject({ method: 'GET', url: '/api/jobs?status=succeeded' });
        expect(response.statusCode).toBe(200);
        expect(response.json().jobs).toHaveLength(1);
    });

    it('passes a repository filter to the store', async () => {
        const store = stubStore({ job });
        const instance = await harnessWith(store);
        const response = await instance.inject({ method: 'GET', url: '/api/jobs?repo=acme/web' });
        expect(response.statusCode).toBe(200);
        expect(store.listed).toEqual([{ status: undefined, repo: 'acme/web', limit: 50 }]);
    });

    it.each([
        ['a repo without an owner', '/api/jobs?repo=web'],
        ['a repeated repo filter', '/api/jobs?repo=acme/web&repo=acme/api'],
    ])('refuses %s', async (_label, url) => {
        const instance = await harnessWith(stubStore({ job }));
        const response = await instance.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_REPO');
    });

    it.each([
        ['an unknown status', '/api/jobs?status=pending', 'BAD_STATUS'],
        ['an over-cap limit', '/api/jobs?limit=1000', 'BAD_LIMIT'],
        ['a non-numeric limit', '/api/jobs?limit=lots', 'BAD_LIMIT'],
    ])('refuses %s', async (_label, url, code) => {
        const instance = await harnessWith(stubStore({ job }));
        const response = await instance.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe(code);
    });
});

// Guards the `if (jobs)` in app.ts: every existing route test builds an app without a job store,
// and registering the board unconditionally would give them all a live queue.
it('does not register the board when there is no job store', async () => {
    const instance = await harnessWith();
    const response = await post(instance, '/api/jobs', { command: 'echo hi' });
    expect(response.statusCode).toBe(404);
});
