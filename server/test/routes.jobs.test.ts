import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { OrgRuntime } from '../src/orgs.js';
import { createStatsService } from '../src/stats-service.js';
import type { BellowsConfig } from '../src/workspace/bellows.js';
import type {
    Claim,
    FollowUpRefusal,
    GateReport,
    Job,
    JobStatus,
    JobStore,
    LeaseResult,
    ReclaimClaim,
    RemoveResult,
    RuntimeVitals,
    StopResult,
} from '../src/db/job-store.js';
import type { WorkflowRecord, WorkflowStore } from '../src/db/workflow-store.js';
import {
    githubAuth,
    memoryAuthStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
    TEST_JOB_BOARD_TOKEN,
} from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = '22222222-2222-4222-8222-222222222222';
const FOLLOW_UP_ID = '44444444-4444-4444-8444-444444444444';

interface StoreStub extends JobStore {
    created: { command: string; createdBy: string | null; repo: string | null; executor: string | null }[];
    /** The workflow triple the create was handed, when one resolved — null when none did. */
    workflowTargets: { id: string; node: string; snapshot: unknown }[];
    listed: { status?: JobStatus | 'terminal'; repo?: string | undefined; limit: number }[];
    completed: {
        id: string;
        output: string | null;
        contextTokens: number | null;
        contextCostUsd: number | null;
        agentTurns: number | null;
        summary: string | null;
    }[];
    sessions: { id: string; sessionId: string; remoteSessionId: string | null }[];
    progressed: { id: string; output: string; runtime: RuntimeVitals | null }[];
    suspended: string[];
    followUps: { parentId: string; command: string; createdBy: string | null }[];
    markedDone: { id: string; doneBy: string | null }[];
    gatesReported: { id: string; results: GateReport[] }[];
    gatesReread: { id: string }[];
    publishTokens: { id: string }[];
    stopped: { id: string; stoppedBy: string | null }[];
    removed: { id: string; removedBy: string | null }[];
    reclaimClaims: { worker: string; leaseSeconds: number }[];
    reclaimAcks: { id: string; worker: string }[];
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
        /** The terminality answer the store computes at the verdict moment, on the 'ok' path. */
        threadDone?: boolean;
        job?: Job | null;
        thread?: Job[] | null;
        followUp?: FollowUpRefusal;
        done?: { status: JobStatus; doneAt: string } | 'missing' | 'conflict';
        reread?: { result: 'ok'; gates: BellowsConfig | null; gateError: string | null } | 'lost' | 'missing';
        publish?: { result: 'ok'; token: string | null } | 'lost' | 'missing';
        /** Where the board says the suspend landed, on the 'ok' path. */
        suspendStatus?: JobStatus;
        stop?: StopResult;
        remove?: RemoveResult;
        reclaimClaim?: ReclaimClaim | null;
        ackReclaim?: 'ok' | 'lost' | 'missing';
        heartbeatCancelRequested?: boolean;
    } = {}
): StoreStub {
    const boom = () => {
        if (options.fail) throw new Error('database is down');
    };
    const stub: StoreStub = {
        created: [],
        workflowTargets: [],
        listed: [],
        commands: [],
        completed: [],
        sessions: [],
        progressed: [],
        suspended: [],
        gatesReread: [],
        publishTokens: [],
        followUps: [],
        markedDone: [],
        gatesReported: [],
        stopped: [],
        removed: [],
        reclaimClaims: [],
        reclaimAcks: [],
        async suspend(id) {
            boom();
            stub.suspended.push(id);
            const result = options.verdict ?? 'ok';
            return result === 'ok' ? { result: 'ok', status: options.suspendStatus ?? 'standby' } : { result };
        },
        async create(command, createdBy, target) {
            boom();
            stub.created.push({
                command,
                createdBy: createdBy ?? null,
                repo: target?.repo ?? null,
                executor: target?.executor ?? null,
            });
            if (target?.workflow) stub.workflowTargets.push(target.workflow);
            stub.commands.push(command);
            return { id: ID };
        },
        async createFollowUp(parentId, command, createdBy) {
            boom();
            stub.followUps.push({ parentId, command, createdBy: createdBy ?? null });
            return options.followUp ?? { id: FOLLOW_UP_ID };
        },
        async markDone(id, doneBy) {
            boom();
            stub.markedDone.push({ id, doneBy: doneBy ?? null });
            return options.done ?? { status: 'succeeded', doneAt: '2026-08-21T12:10:00.000Z' };
        },
        async claim() {
            boom();
            return options.claim ?? null;
        },
        async heartbeat() {
            boom();
            const result = options.verdict ?? 'ok';
            return {
                result,
                leaseExpiresAt: result === 'ok' ? '2026-08-21T12:05:00.000Z' : null,
                cancelRequested: result === 'ok' ? (options.heartbeatCancelRequested ?? false) : false,
            };
        },
        async stop(id, stoppedBy) {
            boom();
            stub.stopped.push({ id, stoppedBy: stoppedBy ?? null });
            return options.stop ?? { result: 'stopped' };
        },
        async removeThread(id, removedBy) {
            boom();
            stub.removed.push({ id, removedBy: removedBy ?? null });
            return options.remove ?? { result: 'ok', rootJobId: ID, repo: null, workspacePath: null };
        },
        async claimReclaim(worker, leaseSeconds) {
            boom();
            stub.reclaimClaims.push({ worker, leaseSeconds });
            return options.reclaimClaim ?? null;
        },
        async ackReclaim(id, worker) {
            boom();
            stub.reclaimAcks.push({ id, worker });
            return options.ackReclaim ?? 'ok';
        },
        async session(id, _token, sessionId, remoteSessionId) {
            boom();
            stub.sessions.push({ id, sessionId, remoteSessionId });
            return options.verdict ?? 'ok';
        },
        async progress(id: string, _token: string, output: string, runtime: RuntimeVitals | null) {
            boom();
            stub.progressed.push({ id, output, runtime });
            return options.verdict ?? 'ok';
        },
        async complete(id: string, _token: string, { output, contextTokens, contextCostUsd, agentTurns, summary }) {
            boom();
            stub.completed.push({
                id,
                output,
                contextTokens: contextTokens ?? null,
                contextCostUsd: contextCostUsd ?? null,
                agentTurns: agentTurns ?? null,
                summary: summary ?? null,
            });
            const verdict = options.verdict ?? 'ok';
            return verdict === 'ok' ? { result: 'ok', threadDone: options.threadDone ?? false } : { result: verdict };
        },
        async gates(id, _token, results) {
            boom();
            stub.gatesReported.push({ id, results });
            return options.verdict ?? 'ok';
        },
        async rereadGates(id, _token) {
            boom();
            stub.gatesReread.push({ id });
            const answer = options.reread ?? { result: 'ok' as const, gates: null, gateError: null };
            return typeof answer === 'string' ? { result: answer } : answer;
        },
        async publishToken(id, _token) {
            boom();
            stub.publishTokens.push({ id });
            const answer = options.publish ?? { result: 'ok' as const, token: 'ghs_publish' };
            return typeof answer === 'string' ? { result: answer } : answer;
        },
        async get() {
            boom();
            return options.job ?? null;
        },
        async thread() {
            boom();
            return options.thread ?? null;
        },
        async list(filter) {
            boom();
            stub.listed.push(filter);
            return options.job ? [options.job] : [];
        },
    };
    return stub;
}

async function harnessWith(jobs?: StoreStub, workflows?: WorkflowStore) {
    const config = testConfig();
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, jobs, workflows, telemetry: stubTelemetryClient() }),
    });
    app = instance;
    return instance;
}

const post = (instance: FastifyInstance, url: string, payload: unknown) =>
    instance.inject({ method: 'POST', url, payload: payload as object });

/**
 * A github-mode harness whose registry lists one organization PER board stub — the shape a worker
 * claim actually sees: the shared secret authenticates the driver, not an org, so the poll is
 * offered every org's queue in the registry's order.
 */
async function harnessOfBoards(boards: readonly (readonly [string, StoreStub])[]) {
    const config = testConfig({ auth: githubAuth() });
    const runtimes = new Map<string, OrgRuntime>(
        boards.map(([orgId, jobs]): [string, OrgRuntime] => {
            const repos = staticRepoSource([]);
            const telemetry = stubTelemetryClient();
            return [
                orgId,
                { orgId, repos, telemetry, service: createStatsService({ config, repos, telemetry }), jobs },
            ];
        })
    );
    const instance = await buildApp({
        config,
        auth: memoryAuthStore(),
        orgs: {
            for: async (orgId) => runtimes.get(orgId) ?? null,
            list: async () => boards.map(([orgId]) => ({ id: orgId, name: orgId, installationId: null })),
            warmAll: async () => {},
        },
    });
    app = instance;
    return instance;
}

/** The worker's credential: the shared board secret, so the poll names no org and reaches every board. */
const postAsWorker = (instance: FastifyInstance, url: string, payload: unknown) =>
    instance.inject({
        method: 'POST',
        url,
        payload: payload as object,
        headers: { authorization: `Bearer ${TEST_JOB_BOARD_TOKEN}` },
    });

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

/**
 * The in-memory workflow-store double: what the resolution tests need is which methods the route
 * called with which arguments, and one resolvable record. The store's real rules live in
 * server/test-db/workflow-store.test.ts.
 */
function stubWorkflows(options: { found?: WorkflowRecord | null; definition?: WorkflowDefinition } = {}) {
    const definition: WorkflowDefinition = options.definition ?? {
        entry: 'implement',
        params: [],
        nodes: [{ name: 'implement', kind: 'agent', session: 'resume', prompt: 'work', publish: true }],
        edges: [],
    };
    const record: WorkflowRecord = {
        id: 'wf-1',
        name: 'fix-issue',
        scope: 'org',
        userId: null,
        repo: null,
        params: definition.params,
        createdAt: '2026-09-15T00:00:00.000Z',
        updatedAt: '2026-09-15T00:00:00.000Z',
        definition,
    };
    const calls = { findByName: [] as string[] };
    return {
        calls,
        record: options.found === undefined ? record : options.found,
        async create() {
            return { id: 'wf-x' };
        },
        async listVisible() {
            return [];
        },
        async get() {
            return null;
        },
        async remove() {
            return true;
        },
        async findByName(name: string) {
            calls.findByName.push(name);
            return options.found === undefined ? record : options.found;
        },
        async seedBase() {},
    } as unknown as WorkflowStore & typeof calls;
}

describe('POST /api/jobs workflow resolution', () => {
    it('freezes the resolved definition onto the create when the body names a workflow', async () => {
        const jobs = stubStore();
        const workflows = stubWorkflows();
        const instance = await harnessWith(jobs, workflows);

        const response = await post(instance, '/api/jobs', { command: 'fix it', workflow: 'fix-issue' });

        expect(response.statusCode).toBe(201);
        expect(workflows.calls.findByName).toEqual(['fix-issue']);
        expect(jobs.workflowTargets).toEqual([
            { id: 'wf-1', node: 'implement', snapshot: workflows.record.definition, params: {} },
        ]);
        // The root command IS the interpolated entry prompt — a workflow task launches its entry
        // node, not the raw chat line.
        expect(jobs.commands).toEqual(['work']);
    });

    it('refuses an unknown workflow name with a named error and queues nothing', async () => {
        const jobs = stubStore();
        const workflows = stubWorkflows({ found: null });
        const instance = await harnessWith(jobs, workflows);

        const response = await post(instance, '/api/jobs', { command: 'fix it', workflow: 'ghost' });

        expect(response.statusCode).toBe(404);
        expect(response.json().code).toBe('UNKNOWN_WORKFLOW');
        expect(jobs.created).toEqual([]);
    });

    // The no-workflow identity: a body without a workflow field names no process, so the member's
    // words ARE the command and the workflow store is not read at all — no resolution, no default
    // to fall back to. The row and claim carry no workflow triple; the claim's own shape is
    // pinned by the db suite, which asserts `publish` is ABSENT on a workflow-less claim.
    it('runs the raw prompt, reading no workflows, when the body names none', async () => {
        const jobs = stubStore();
        const workflows = stubWorkflows();
        const instance = await harnessWith(jobs, workflows);

        const response = await post(instance, '/api/jobs', { command: 'echo hi', repo: 'acme/web' });

        expect(response.statusCode).toBe(201);
        expect(workflows.calls.findByName).toEqual([]);
        expect(jobs.workflowTargets).toEqual([]);
        expect(jobs.commands).toEqual(['echo hi']);
    });
});

describe('POST /api/jobs workflow parameters', () => {
    const parammedDefinition: WorkflowDefinition = {
        entry: 'fetch',
        params: [{ name: 'issue', pattern: '#\\d+' }],
        nodes: [
            {
                name: 'fetch',
                kind: 'agent',
                session: 'resume',
                prompt: 'fetch {{param.issue}}\n\nasked: {{command}}',
            },
            { name: 'work', kind: 'agent', session: 'resume', prompt: 'work', publish: true },
        ],
        edges: [{ from: 'fetch', to: 'work', when: 'succeeded' }],
    };

    const boot = async () => {
        const jobs = stubStore();
        const workflows = stubWorkflows({ definition: parammedDefinition });
        const instance = await harnessWith(jobs, workflows);
        return { jobs, instance };
    };

    it('refuses a missing required param with BAD_WORKFLOW_PARAMS and queues nothing', async () => {
        const { jobs, instance } = await boot();
        // Exactly the issue's repro: "fix the bug" with fix-issue selected used to launch.
        const response = await post(instance, '/api/jobs', { command: 'fix the login bug', workflow: 'fix-issue' });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_WORKFLOW_PARAMS');
        expect(jobs.created).toEqual([]);
    });

    it('refuses a malformed param value with BAD_WORKFLOW_PARAMS', async () => {
        const { jobs, instance } = await boot();
        const response = await post(instance, '/api/jobs', {
            command: 'fix the login bug',
            workflow: 'fix-issue',
            workflowParams: { issue: '42' },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_WORKFLOW_PARAMS');
        expect(jobs.created).toEqual([]);
    });

    it('refuses workflowParams sent with no workflow resolved at all', async () => {
        const jobs = stubStore();
        const workflows = stubWorkflows({ found: null });
        const instance = await harnessWith(jobs, workflows);
        const response = await post(instance, '/api/jobs', { command: 'echo hi', workflowParams: { issue: '#42' } });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_WORKFLOW_PARAMS');
        expect(jobs.created).toEqual([]);
    });

    it('builds the root command from the entry prompt, carrying the param and the member command', async () => {
        const { jobs, instance } = await boot();
        const response = await post(instance, '/api/jobs', {
            command: 'fix the login bug',
            workflow: 'fix-issue',
            workflowParams: { issue: '#127' },
        });
        expect(response.statusCode).toBe(201);
        expect(jobs.commands).toEqual(['fetch #127\n\nasked: fix the login bug']);
        expect(jobs.workflowTargets).toEqual([
            { id: 'wf-1', node: 'fetch', snapshot: parammedDefinition, params: { issue: '#127' } },
        ]);
    });

    it('refuses an interpolated root command over the cap with BAD_COMMAND', async () => {
        const jobs = stubStore();
        const workflows = stubWorkflows({
            definition: {
                entry: 'a',
                params: [],
                nodes: [{ name: 'a', kind: 'agent', session: 'resume', prompt: '{{command}}!', publish: true }],
                edges: [],
            },
        });
        const instance = await harnessWith(jobs, workflows);
        // The raw command is under the cap; the filled entry prompt is not.
        const response = await post(instance, '/api/jobs', {
            command: 'x'.repeat(16_384),
            workflow: 'fix-issue',
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_COMMAND');
        expect(jobs.created).toEqual([]);
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
        followUp: false,
    };

    it('hands out the job with its lease token', async () => {
        const instance = await harnessWith(stubStore({ claim }));
        const response = await post(instance, '/api/jobs/claim', { worker: 'w1', leaseSeconds: 300 });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(claim);
    });

    // The claim's env is the board's business, resolved in the store, and the route must not
    // reshape it — the driver forwards exactly what it is handed.
    it('passes a resolved environment through verbatim', async () => {
        const withEnv: Claim = { ...claim, env: { CORE: 'value', SECRET: 'value' } };
        const instance = await harnessWith(stubStore({ claim: withEnv }));
        const response = await post(instance, '/api/jobs/claim', { worker: 'w1', leaseSeconds: 300 });
        expect(response.statusCode).toBe(200);
        expect(response.json().env).toEqual({ CORE: 'value', SECRET: 'value' });
    });

    // Same rule for the gate declaration: read in the store, relayed untouched. The driver
    // decides what a null `gates` or a `gateError` means; the route is a pipe.
    it('passes the repo label and the gate declaration through verbatim', async () => {
        const withGates: Claim = {
            ...claim,
            repo: 'Bellows-AI/factory',
            gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
        };
        const instance = await harnessWith(stubStore({ claim: withGates }));
        const response = await post(instance, '/api/jobs/claim', { worker: 'w1', leaseSeconds: 300 });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(withGates);

        const withError: Claim = { ...claim, repo: 'Bellows-AI/factory', gateError: '.bellows.yaml line 2: nope' };
        const instance2 = await harnessWith(stubStore({ claim: withError }));
        const response2 = await post(instance2, '/api/jobs/claim', { worker: 'w1', leaseSeconds: 300 });
        expect(response2.json()).toEqual(withError);
    });

    // The idle poll is the common case: it must be recognisable without parsing a body.
    it('answers 204 when nothing is waiting', async () => {
        const instance = await harnessWith(stubStore({ claim: null }));
        const response = await post(instance, '/api/jobs/claim', { worker: 'w1' });
        expect(response.statusCode).toBe(204);
        expect(response.body).toBe('');
    });

    // One org's claim preparation can fail alone (an installation-token mint): the poll must
    // still reach the other orgs' boards instead of dying in a 503 before them.
    it('keeps polling later boards when one board fails', async () => {
        const failing = stubStore();
        failing.claim = async () => {
            throw new Error('mint failed');
        };
        const healthy = stubStore({ claim });
        const instance = await harnessOfBoards([
            ['org-a', failing],
            ['org-b', healthy],
        ]);
        const response = await postAsWorker(instance, '/api/jobs/claim', { worker: 'w1', leaseSeconds: 300 });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(claim);
    });

    // Every board down is still a broken board, not an idle one: the guard's 503 is what tells
    // the driver the poll failed, and it survives the per-board tolerance above.
    it('answers 503 when every board fails', async () => {
        const down = (reason: string): StoreStub => {
            const store = stubStore();
            store.claim = async () => {
                throw new Error(reason);
            };
            return store;
        };
        const instance = await harnessOfBoards([
            ['org-a', down('a is down')],
            ['org-b', down('b is down')],
        ]);
        const response = await postAsWorker(instance, '/api/jobs/claim', { worker: 'w1', leaseSeconds: 300 });
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });

    // The registry lists organizations in a stable order, so a fixed first board would let one
    // busy org fill every driver slot while later orgs starve: the scan rotates one position
    // per poll.
    it('rotates the starting board across polls', async () => {
        const fromA: Claim = { ...claim, command: 'from-a' };
        const fromB: Claim = { ...claim, command: 'from-b' };
        const instance = await harnessOfBoards([
            ['org-a', stubStore({ claim: fromA })],
            ['org-b', stubStore({ claim: fromB })],
        ]);
        const first = await postAsWorker(instance, '/api/jobs/claim', { worker: 'w1', leaseSeconds: 300 });
        const second = await postAsWorker(instance, '/api/jobs/claim', { worker: 'w1', leaseSeconds: 300 });
        expect(first.json().command).toBe('from-a');
        expect(second.json().command).toBe('from-b');
    });

    // The driver polls the reclaim queue between job polls, so the two scans must not share one
    // rotation counter: each interleaved reclaim poll would advance the job scan's phase, and
    // with two orgs every job claim would start at the same org and starve the other.
    it('rotates job claims independently of the interleaved reclaim polls', async () => {
        const fromA: Claim = { ...claim, command: 'from-a' };
        const fromB: Claim = { ...claim, command: 'from-b' };
        const instance = await harnessOfBoards([
            ['org-a', stubStore({ claim: fromA })],
            ['org-b', stubStore({ claim: fromB })],
        ]);
        await postAsWorker(instance, '/api/reclaims/claim', { worker: 'w1', leaseSeconds: 300 });
        const first = await postAsWorker(instance, '/api/jobs/claim', { worker: 'w1', leaseSeconds: 300 });
        await postAsWorker(instance, '/api/reclaims/claim', { worker: 'w1', leaseSeconds: 300 });
        const second = await postAsWorker(instance, '/api/jobs/claim', { worker: 'w1', leaseSeconds: 300 });
        expect(first.json().command).toBe('from-a');
        expect(second.json().command).toBe('from-b');
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
        expect(response.json().cancelRequested).toBe(false);
    });

    // The stop channel: the user's /stop stamped the row, and this beat delivers the request. The
    // worker kills its runner and parks with suspend, which clears the stamp.
    it('answers cancelRequested once a stop has been asked', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'ok', heartbeatCancelRequested: true }));
        const response = await post(instance, `/api/jobs/${ID}/heartbeat`, { leaseToken: TOKEN });
        expect(response.statusCode).toBe(200);
        expect(response.json().cancelRequested).toBe(true);
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

    /**
     * Not pinned to a uuid: claude-code's ids are, but opencode mints its own (`ses_…`), and the
     * board records the session the run used rather than second-guessing a foreign CLI's format.
     * What matters for the record is that it is a bounded opaque token, not free-form text.
     */
    it('takes an executor token such as opencode’s as a session id', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const ses = 'ses_f86188c3dffeZGYO4yZq4atba9';

        const response = await post(instance, `/api/jobs/${ID}/session`, { leaseToken: TOKEN, sessionId: ses });

        expect(response.statusCode).toBe(200);
        expect(store.sessions[0]?.sessionId).toBe(ses);
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
        ['a non-string session id', { leaseToken: TOKEN, sessionId: 42 }, 'BAD_SESSION_ID'],
        ['a session id starting with a dot', { leaseToken: TOKEN, sessionId: '.hidden' }, 'BAD_SESSION_ID'],
        ['a session id with whitespace in it', { leaseToken: TOKEN, sessionId: 'ses x' }, 'BAD_SESSION_ID'],
        ['an oversized session id', { leaseToken: TOKEN, sessionId: 'x'.repeat(257) }, 'BAD_SESSION_ID'],
        ['a malformed lease token', { leaseToken: 'nope', sessionId: SESSION }, 'BAD_TOKEN'],
    ])('refuses %s', async (_label, payload, code) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/session`, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe(code);
    });
});

describe('POST /api/jobs/:id/output', () => {
    const VITALS = {
        cpuPercent: 93,
        memUsedMb: 544,
        memPercent: 7,
        activity: '→ Read x.ts',
        sampledAt: '2026-09-09T10:00:00.000Z',
    };

    it('streams a rolling tail of the running attempt', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/output`, { leaseToken: TOKEN, output: 'step 1\n' });

        expect(response.statusCode).toBe(200);
        expect(store.progressed).toEqual([{ id: ID, output: 'step 1\n', runtime: null }]);
    });

    // Same rule as every other worker write: a superseded worker must not relabel the run that
    // replaced it. Refused, never merged.
    it('rejects a tail from a worker whose lease was reclaimed', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'lost' }));
        const response = await post(instance, `/api/jobs/${ID}/output`, { leaseToken: TOKEN, output: 'late' });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('LEASE_LOST');
    });

    it('answers 404 for a job that does not exist', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'missing' }));
        const response = await post(instance, `/api/jobs/${ID}/output`, { leaseToken: TOKEN, output: 'late' });
        expect(response.statusCode).toBe(404);
    });

    it.each([
        ['a missing tail', { leaseToken: TOKEN }, 'BAD_OUTPUT'],
        ['a non-string tail', { leaseToken: TOKEN, output: 42 }, 'BAD_OUTPUT'],
        ['a malformed lease token', { leaseToken: 'nope', output: 'x' }, 'BAD_TOKEN'],
    ])('refuses %s', async (_label, payload, code) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/output`, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe(code);
    });

    // The driver sends a bounded tail; this is the backstop, exactly as complete has one.
    it('truncates the tail before it reaches the store', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);

        await post(instance, `/api/jobs/${ID}/output`, { leaseToken: TOKEN, output: 'x'.repeat(100_000) });

        expect(store.progressed[0]?.output).toHaveLength(64 * 1024);
    });

    /**
     * The attempt's vitals ride beside the tail: the "is it stuck or working" answer. A full object
     * is validated and passed through; its absence (or an explicit null) means "no sample this
     * round", which the store reads as leave-the-last-one-alone — never as a clearance. The
     * attempt's `.bellows.yaml` services (issue #60) ride the same object, and null numbers are
     * honest data beside them — a cluster with no metrics-server still reports its fleet.
     */
    it('passes the runtime vitals beside the tail, and nothing when there is no sample', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const runtime = {
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7,
            activity: '→ Read server/src/routes/env.ts',
            sampledAt: '2026-09-09T10:00:00.000Z',
        };

        await post(instance, `/api/jobs/${ID}/output`, { leaseToken: TOKEN, output: 'step', runtime });
        await post(instance, `/api/jobs/${ID}/output`, { leaseToken: TOKEN, output: 'step' });
        await post(instance, `/api/jobs/${ID}/output`, { leaseToken: TOKEN, output: 'step', runtime: null });

        expect(store.progressed[0]?.runtime).toEqual(runtime);
        expect(store.progressed[1]?.runtime).toBeNull();
        expect(store.progressed[2]?.runtime).toBeNull();

        const withFleet = {
            ...runtime,
            services: [
                { name: 'db', image: 'postgres:16', state: 'running' },
                { name: 'cache', image: 'redis:7', state: 'exited' },
            ],
        };
        await post(instance, `/api/jobs/${ID}/output`, { leaseToken: TOKEN, output: 'step', runtime: withFleet });
        expect(store.progressed[3]?.runtime).toEqual(withFleet);

        // Null numbers with a fleet: the vitals read failed, the fleet read did not.
        const fleetOnly = {
            ...runtime,
            cpuPercent: null,
            memUsedMb: null,
            memPercent: null,
            activity: null,
            services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
        };
        await post(instance, `/api/jobs/${ID}/output`, { leaseToken: TOKEN, output: 'step', runtime: fleetOnly });
        expect(store.progressed[4]?.runtime).toEqual(fleetOnly);

        // An empty list is "no fleet" — the key the driver never sends is the key not stored.
        await post(instance, `/api/jobs/${ID}/output`, {
            leaseToken: TOKEN,
            output: 'step',
            runtime: { ...runtime, services: [] },
        });
        expect('services' in (store.progressed[5]?.runtime ?? {})).toBe(false);
    });

    it.each([
        ['a non-object runtime', { leaseToken: TOKEN, output: 'x', runtime: 42 }],
        ['a negative cpu', { leaseToken: TOKEN, output: 'x', runtime: { ...VITALS, cpuPercent: -1 } }],
        ['an absurd cpu', { leaseToken: TOKEN, output: 'x', runtime: { ...VITALS, cpuPercent: 100_001 } }],
        ['a string memory', { leaseToken: TOKEN, output: 'x', runtime: { ...VITALS, memUsedMb: '544MiB' } }],
        ['a memPercent past 100', { leaseToken: TOKEN, output: 'x', runtime: { ...VITALS, memPercent: 101 } }],
        ['an empty activity line', { leaseToken: TOKEN, output: 'x', runtime: { ...VITALS, activity: '  ' } }],
        [
            'an unparseable sample time',
            { leaseToken: TOKEN, output: 'x', runtime: { ...VITALS, sampledAt: 'noonish' } },
        ],
        ['a runtime with no sample time', { leaseToken: TOKEN, output: 'x', runtime: { cpuPercent: 1, memUsedMb: 1 } }],
        [
            'a service list that is not a list',
            { leaseToken: TOKEN, output: 'x', runtime: { ...VITALS, services: 'db' } },
        ],
        [
            'more services than a workspace may declare',
            {
                leaseToken: TOKEN,
                output: 'x',
                runtime: {
                    ...VITALS,
                    services: Array.from({ length: 11 }, () => ({
                        name: 'db',
                        image: 'postgres:16',
                        state: 'running',
                    })),
                },
            },
        ],
        [
            'a service name that is not a DNS label',
            {
                leaseToken: TOKEN,
                output: 'x',
                runtime: { ...VITALS, services: [{ name: 'My DB', image: 'postgres:16', state: 'running' }] },
            },
        ],
        [
            'a service with no image',
            {
                leaseToken: TOKEN,
                output: 'x',
                runtime: { ...VITALS, services: [{ name: 'db', image: '', state: 'running' }] },
            },
        ],
        [
            'a service state that is not a lowercase word',
            {
                leaseToken: TOKEN,
                output: 'x',
                runtime: { ...VITALS, services: [{ name: 'db', image: 'postgres:16', state: 'Running!' }] },
            },
        ],
    ])('refuses %s with BAD_RUNTIME', async (_label, payload) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/output`, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_RUNTIME');
    });

    it('caps the activity line, which is one CLI line and not a log', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);

        await post(instance, `/api/jobs/${ID}/output`, {
            leaseToken: TOKEN,
            output: 'step',
            runtime: { ...VITALS, activity: 'a'.repeat(10_000) },
        });

        expect(store.progressed[0]?.runtime?.activity).toHaveLength(512);
    });
});

describe('POST /api/jobs/:id/gates', () => {
    const results: GateReport[] = [
        { name: 'test', status: 'passed', exitCode: 0, output: 'all green' },
        { name: 'lint', status: 'failed', exitCode: 1, output: '2 problems' },
    ];

    // REPLACE, not append — the progress precedent. "Current/last ran only" is the whole UI
    // contract, and the driver re-reports a gate's state as it moves.
    it('records the current gate state, replacing whatever was stored', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/gates`, { leaseToken: TOKEN, gates: results });

        expect(response.statusCode).toBe(200);
        expect(store.gatesReported).toEqual([{ id: ID, results }]);
    });

    it('truncates per-gate output before it reaches the store', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);

        const long = 'x'.repeat(100_000);
        await post(instance, `/api/jobs/${ID}/gates`, {
            leaseToken: TOKEN,
            gates: [{ name: 'test', status: 'failed', exitCode: 1, output: long }],
        });

        expect(store.gatesReported[0]?.results[0]?.output).toHaveLength(64 * 1024);
    });

    it.each([
        ['a malformed lease token', { leaseToken: 'nope', gates: results }, 'BAD_TOKEN'],
        ['a missing gate list', { leaseToken: TOKEN }, 'BAD_GATES'],
        ['a non-array gate list', { leaseToken: TOKEN, gates: 'test' }, 'BAD_GATES'],
        [
            'an unknown status',
            { leaseToken: TOKEN, gates: [{ name: 'test', status: 'queued', exitCode: null, output: '' }] },
            'BAD_GATES',
        ],
        [
            'a gate without a name',
            { leaseToken: TOKEN, gates: [{ status: 'passed', exitCode: 0, output: '' }] },
            'BAD_GATES',
        ],
        [
            'a non-integer exit code',
            { leaseToken: TOKEN, gates: [{ name: 'test', status: 'passed', exitCode: 1.5, output: '' }] },
            'BAD_GATES',
        ],
        [
            'a non-string output',
            { leaseToken: TOKEN, gates: [{ name: 'test', status: 'passed', exitCode: 0, output: 7 }] },
            'BAD_GATES',
        ],
    ])('refuses %s', async (_label, payload, code) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/gates`, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe(code);
    });

    // Same rule as every other worker write, same codes as /output: a superseded worker's
    // telemetry is refused, and the driver stops talking rather than acting on it.
    it('rejects a report from a worker whose lease was reclaimed', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'lost' }));
        const response = await post(instance, `/api/jobs/${ID}/gates`, { leaseToken: TOKEN, gates: results });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('LEASE_LOST');
    });

    it('answers 404 for a job that does not exist', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'missing' }));
        const response = await post(instance, `/api/jobs/${ID}/gates`, { leaseToken: TOKEN, gates: results });
        expect(response.statusCode).toBe(404);
    });
});

describe('POST /api/jobs/:id/suspend', () => {
    it("ends a running job's attempt, echoing where the board landed it", async () => {
        const store = stubStore({ verdict: 'ok', suspendStatus: 'stopped' });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/suspend`, { leaseToken: TOKEN });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: ID, status: 'stopped' });
        expect(store.suspended).toEqual([ID]);
    });

    it('lands the Remote Control idle park on standby', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'ok' }));
        const response = await post(instance, `/api/jobs/${ID}/suspend`, { leaseToken: TOKEN });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: ID, status: 'standby' });
    });

    it('refuses a park from a worker whose lease was reclaimed', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'lost' }));
        const response = await post(instance, `/api/jobs/${ID}/suspend`, { leaseToken: TOKEN });
        expect(response.statusCode).toBe(409);
    });

    it('refuses a malformed id', async () => {
        const instance = await harnessWith(stubStore());
        expect((await post(instance, '/api/jobs/nope/suspend', { leaseToken: TOKEN })).statusCode).toBe(400);
    });
});

describe('POST /api/jobs/:id/stop', () => {
    // A queued job never started, so stopping it IS settling it — the turn ends before it began,
    // and the session (there is none yet) is untouched.
    it('settles a queued task directly', async () => {
        const store = stubStore({ stop: { result: 'stopped' } });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/stop`, {});

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: ID, status: 'stopped' });
        expect(store.stopped).toEqual([{ id: ID, stoppedBy: null }]);
    });

    // A parked task settles the same way: stopping it is the verdict that ends its stay. The
    // second stop of the same task is the store's conflict to answer — it already ended.
    it('settles an already-parked task directly too', async () => {
        const store = stubStore({ stop: { result: 'stopped' } });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/stop`, {});

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: ID, status: 'stopped' });
        expect(store.stopped).toEqual([{ id: ID, stoppedBy: null }]);
    });

    // A running task keeps running until the worker parks it — the request RIDES the heartbeat —
    // and the 202 says so with the request's timestamp.
    it("asks a running task's worker to stop, answering 202 with the request", async () => {
        const instance = await harnessWith(
            stubStore({ stop: { result: 'requested', cancelRequestedAt: '2026-08-21T12:05:00.000Z' } })
        );
        const response = await post(instance, `/api/jobs/${ID}/stop`, {});
        expect(response.statusCode).toBe(202);
        expect(response.json()).toEqual({
            id: ID,
            status: 'running',
            cancelRequestedAt: '2026-08-21T12:05:00.000Z',
        });
    });

    it('refuses a finished task, naming its status', async () => {
        const instance = await harnessWith(stubStore({ stop: { result: 'conflict', status: 'succeeded' } }));
        const response = await post(instance, `/api/jobs/${ID}/stop`, {});
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('NOT_STOPPABLE');
        expect(response.json().status).toBe('succeeded');
    });

    it('answers 404 for a task that does not exist', async () => {
        const instance = await harnessWith(stubStore({ stop: 'missing' }));
        expect((await post(instance, `/api/jobs/${ID}/stop`, {})).statusCode).toBe(404);
    });

    it('answers 503 when the store is down, so the caller retries', async () => {
        const instance = await harnessWith(stubStore({ fail: true }));
        const response = await post(instance, `/api/jobs/${ID}/stop`, {});
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });

    it('refuses a malformed id', async () => {
        const instance = await harnessWith(stubStore());
        expect((await post(instance, '/api/jobs/nope/stop', {})).statusCode).toBe(400);
    });
});

describe('POST /api/jobs/:id/remove', () => {
    it('removes the thread', async () => {
        const store = stubStore({
            remove: { result: 'ok', rootJobId: ID, repo: 'acme/web', workspacePath: 'test-org/user-7' },
        });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/remove`, {});

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: ID, removed: true });
        expect(store.removed).toEqual([{ id: ID, removedBy: null }]);
    });

    // The thread's worktree is a live runner's checkout; removal must not tear it out from under
    // the container. The user stops the task first.
    it('refuses while any member is running', async () => {
        const instance = await harnessWith(stubStore({ remove: 'conflict' }));
        const response = await post(instance, `/api/jobs/${ID}/remove`, {});
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('TASK_RUNNING');
    });

    it('answers 404 for a task that does not exist', async () => {
        const instance = await harnessWith(stubStore({ remove: 'missing' }));
        expect((await post(instance, `/api/jobs/${ID}/remove`, {})).statusCode).toBe(404);
    });

    it('answers 503 when the store is down, so the caller retries', async () => {
        const instance = await harnessWith(stubStore({ fail: true }));
        const response = await post(instance, `/api/jobs/${ID}/remove`, {});
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });

    it('refuses a malformed id', async () => {
        const instance = await harnessWith(stubStore());
        expect((await post(instance, '/api/jobs/nope/remove', {})).statusCode).toBe(400);
    });
});

describe('lifecycle actor attribution', () => {
    // Stop, done and remove are a person's verdict (docs/auth.md), and the actor comes off the
    // session — never a body — on the create route's exact rule. Without an auth store the actor
    // is null, the state every AUTH_MODE=none deployment is in; the captures above pin that.

    const signedInHarness = async () => {
        const auth = memoryAuthStore();
        const config = testConfig({ auth: githubAuth() });
        const store = stubStore();
        const instance = await buildApp({
            config,
            orgs: staticRegistry({ config, jobs: store, telemetry: stubTelemetryClient() }),
            auth,
        });
        app = instance;
        const caller = auth.seedMember('test-org', 'octocat');
        const cookie = await signedIn(auth, caller);
        return { instance, store, caller, cookie };
    };

    const postAs = (instance: FastifyInstance, url: string, cookie: string, payload: unknown = {}) =>
        instance.inject({ method: 'POST', url, payload: payload as object, headers: { cookie } });

    it('create records the signed-in caller as the author', async () => {
        const { instance, store, caller, cookie } = await signedInHarness();

        const response = await postAs(instance, '/api/jobs', cookie, { command: 'echo hi' });

        expect(response.statusCode).toBe(201);
        expect(store.created).toEqual([{ command: 'echo hi', createdBy: caller.user.id, repo: null, executor: null }]);
    });

    it('follow-up records the signed-in caller', async () => {
        const { instance, store, caller, cookie } = await signedInHarness();

        const response = await postAs(instance, `/api/jobs/${ID}/follow-up`, cookie, { command: 'again, tighter' });

        expect(response.statusCode).toBe(201);
        expect(store.followUps).toEqual([{ parentId: ID, command: 'again, tighter', createdBy: caller.user.id }]);
    });

    it('stop records the signed-in caller', async () => {
        const { instance, store, caller, cookie } = await signedInHarness();

        const response = await postAs(instance, `/api/jobs/${ID}/stop`, cookie);

        expect(response.statusCode).toBe(200);
        expect(store.stopped).toEqual([{ id: ID, stoppedBy: caller.user.id }]);
    });

    it('done records the signed-in caller', async () => {
        const { instance, store, caller, cookie } = await signedInHarness();

        const response = await postAs(instance, `/api/jobs/${ID}/done`, cookie);

        expect(response.statusCode).toBe(200);
        expect(store.markedDone).toEqual([{ id: ID, doneBy: caller.user.id }]);
    });

    it('remove records the signed-in caller', async () => {
        const { instance, store, caller, cookie } = await signedInHarness();

        const response = await postAs(instance, `/api/jobs/${ID}/remove`, cookie);

        expect(response.statusCode).toBe(200);
        expect(store.removed).toEqual([{ id: ID, removedBy: caller.user.id }]);
    });
});

describe('POST /api/reclaims/claim', () => {
    const claim: ReclaimClaim = {
        id: '55555555-5555-4555-8555-555555555555',
        rootJobId: ID,
        repo: 'acme/web',
        workspacePath: 'test-org/user-7',
        leaseExpiresAt: '2026-08-21T12:05:00.000Z',
    };

    it('hands the driver a reclaim with its work order and lease', async () => {
        const instance = await harnessWith(stubStore({ reclaimClaim: claim }));
        const response = await post(instance, '/api/reclaims/claim', { worker: 'w1', leaseSeconds: 300 });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(claim);
    });

    // The idle poll is the common case: recognisable without parsing a body, like the job claim.
    it('answers 204 when the queue is empty', async () => {
        const instance = await harnessWith(stubStore({ reclaimClaim: null }));
        const response = await post(instance, '/api/reclaims/claim', { worker: 'w1' });
        expect(response.statusCode).toBe(204);
        expect(response.body).toBe('');
    });

    it('requires a worker id and a sane lease window', async () => {
        const instance = await harnessWith(stubStore());
        expect((await post(instance, '/api/reclaims/claim', {})).statusCode).toBe(400);
        expect((await post(instance, '/api/reclaims/claim', { worker: 'w1', leaseSeconds: 0 })).statusCode).toBe(400);
    });

    it('answers 503 when the store is down', async () => {
        const instance = await harnessWith(stubStore({ fail: true }));
        const response = await post(instance, '/api/reclaims/claim', { worker: 'w1' });
        expect(response.statusCode).toBe(503);
    });

    // The same scan the job claim walks (the registry's order is stable, so the pattern is shared):
    // one board's failure must not block the others, and the starting board must rotate.
    it('keeps polling later boards when one board fails', async () => {
        const failing = stubStore();
        failing.claimReclaim = async () => {
            throw new Error('mint failed');
        };
        const healthy = stubStore({ reclaimClaim: claim });
        const instance = await harnessOfBoards([
            ['org-a', failing],
            ['org-b', healthy],
        ]);
        const response = await postAsWorker(instance, '/api/reclaims/claim', { worker: 'w1', leaseSeconds: 300 });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(claim);
    });

    it('rotates the starting board across polls', async () => {
        const fromA: ReclaimClaim = { ...claim, repo: 'acme/a' };
        const fromB: ReclaimClaim = { ...claim, repo: 'acme/b' };
        const instance = await harnessOfBoards([
            ['org-a', stubStore({ reclaimClaim: fromA })],
            ['org-b', stubStore({ reclaimClaim: fromB })],
        ]);
        const first = await postAsWorker(instance, '/api/reclaims/claim', { worker: 'w1', leaseSeconds: 300 });
        const second = await postAsWorker(instance, '/api/reclaims/claim', { worker: 'w1', leaseSeconds: 300 });
        expect(first.json().repo).toBe('acme/a');
        expect(second.json().repo).toBe('acme/b');
    });
});

describe('POST /api/reclaims/:id/ack', () => {
    const RECLAIM_ID = '55555555-5555-4555-8555-555555555555';

    it("acks the reclaim in the driver's name", async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/reclaims/${RECLAIM_ID}/ack`, { worker: 'w1' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: RECLAIM_ID });
        expect(store.reclaimAcks).toEqual([{ id: RECLAIM_ID, worker: 'w1' }]);
    });

    // The lease guard: only the worker holding the claim may ack it. A foreign ack is refused, so
    // a slow worker's row survives and finishes on its next try.
    it('refuses a foreign worker', async () => {
        const instance = await harnessWith(stubStore({ ackReclaim: 'lost' }));
        const response = await post(instance, `/api/reclaims/${RECLAIM_ID}/ack`, { worker: 'w2' });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('LEASE_LOST');
    });

    it('answers 404 for a reclaim that never existed', async () => {
        const instance = await harnessWith(stubStore({ ackReclaim: 'missing' }));
        expect((await post(instance, `/api/reclaims/${RECLAIM_ID}/ack`, { worker: 'w1' })).statusCode).toBe(404);
    });

    it('refuses a malformed id or a missing worker', async () => {
        const instance = await harnessWith(stubStore());
        expect((await post(instance, '/api/reclaims/nope/ack', { worker: 'w1' })).statusCode).toBe(400);
        expect((await post(instance, `/api/reclaims/${RECLAIM_ID}/ack`, {})).statusCode).toBe(400);
    });

    it('answers 503 when the store is down', async () => {
        const instance = await harnessWith(stubStore({ fail: true }));
        const response = await post(instance, `/api/reclaims/${RECLAIM_ID}/ack`, { worker: 'w1' });
        expect(response.statusCode).toBe(503);
    });
});

describe('POST /api/jobs/:id/follow-up', () => {
    // The executor is NOT taken from the body, even if a stale client sends one: the adjustment
    // is bound to the executor that ran the task, copied from the parent at insert.
    it('queues a follow-up on a finished task, ignoring any executor in the body', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/follow-up`, {
            command: 'now adjust the tone',
            executor: 'some-other-executor',
        });

        expect(response.statusCode).toBe(201);
        expect(response.json()).toEqual({ id: FOLLOW_UP_ID, status: 'queued' });
        // `createdBy` comes from the caller, never the body — the same rule as create.
        expect(store.followUps).toEqual([{ parentId: ID, command: 'now adjust the tone', createdBy: null }]);
    });

    it.each([
        ['a missing command', {}],
        ['an empty command', { command: '' }],
        ['whitespace only', { command: '   ' }],
        ['a non-string command', { command: 42 }],
        ['an oversized command', { command: 'x'.repeat(16_385) }],
    ])('refuses %s', async (_label, payload) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/follow-up`, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_COMMAND');
    });

    it.each([
        ['an empty executor', ''],
        ['an executor with a path separator', 'a/b'],
        ['a non-string executor', 7],
    ])('ignores a stale %s in the body', async (_label, executor) => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/follow-up`, { command: 'again', executor });
        expect(response.statusCode).toBe(201);
        expect(store.followUps).toEqual([{ parentId: ID, command: 'again', createdBy: null }]);
    });

    // A follow-up is a person's action on a finished run: there is no lease token to present and
    // none would mean anything.
    it('takes no lease token', async () => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/follow-up`, { command: 'again' });
        expect(response.statusCode).toBe(201);
    });

    it('answers 404 for a parent that does not exist', async () => {
        const instance = await harnessWith(stubStore({ followUp: 'missing' }));
        const response = await post(instance, `/api/jobs/${ID}/follow-up`, { command: 'again' });
        expect(response.statusCode).toBe(404);
    });

    // Author-scoped, because the follow-up would resume the parent's session — and a session only
    // resumes coherently in the checkout tree it ran in.
    it('answers 403 for a task queued by another account', async () => {
        const instance = await harnessWith(stubStore({ followUp: 'forbidden' }));
        const response = await post(instance, `/api/jobs/${ID}/follow-up`, { command: 'again' });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('FORBIDDEN');
    });

    it.each([
        ['a parent that is still moving', 'not_finished', 'NOT_FINISHED'],
        ['a task the user has marked done', 'task_done', 'TASK_DONE'],
        ['a parent with no session to continue', 'no_session', 'NO_SESSION'],
    ])('answers 409 for %s', async (_label, verdict, code) => {
        const instance = await harnessWith(stubStore({ followUp: verdict as FollowUpRefusal }));
        const response = await post(instance, `/api/jobs/${ID}/follow-up`, { command: 'again' });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe(code);
    });

    it('answers 503 when the store is down, so the caller retries', async () => {
        const instance = await harnessWith(stubStore({ fail: true }));
        const response = await post(instance, `/api/jobs/${ID}/follow-up`, { command: 'again' });
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });

    it('refuses a malformed id before touching the store', async () => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, '/api/jobs/nope/follow-up', { command: 'again' });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_ID');
    });
});

describe('POST /api/jobs/:id/done', () => {
    it('marks a finished task done and is idempotent about it', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const first = await post(instance, `/api/jobs/${ID}/done`, {});
        const second = await post(instance, `/api/jobs/${ID}/done`, {});

        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual({ id: ID, status: 'succeeded', doneAt: '2026-08-21T12:10:00.000Z' });
        expect(second.statusCode).toBe(200);
        expect(store.markedDone).toEqual([
            { id: ID, doneBy: null },
            { id: ID, doneBy: null },
        ]);
    });

    it('answers 409 for a task that is still moving', async () => {
        const instance = await harnessWith(stubStore({ done: 'conflict' }));
        const response = await post(instance, `/api/jobs/${ID}/done`, {});
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('NOT_FINISHED');
    });

    it('answers 404 for a task that does not exist', async () => {
        const instance = await harnessWith(stubStore({ done: 'missing' }));
        const response = await post(instance, `/api/jobs/${ID}/done`, {});
        expect(response.statusCode).toBe(404);
    });

    it('answers 503 when the store is down, so the caller retries', async () => {
        const instance = await harnessWith(stubStore({ fail: true }));
        const response = await post(instance, `/api/jobs/${ID}/done`, {});
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });

    it('refuses a malformed id before touching the store', async () => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, '/api/jobs/nope/done', {});
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_ID');
    });
});

describe('POST /api/jobs/:id/complete', () => {
    const done = { leaseToken: TOKEN, status: 'succeeded', exitCode: 0, output: 'hello' };

    it('records the outcome', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, done);
        expect(response.statusCode).toBe(200);
        expect(store.completed).toEqual([
            { id: ID, output: 'hello', contextTokens: null, contextCostUsd: null, agentTurns: null, summary: null },
        ]);
    });

    // The close-time summary: what the run did, in the agent's own words — rides the verdict,
    // truncated at the route, and a non-string is refused before the store can be told.
    it('records the run summary beside the verdict, bounded', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, {
            ...done,
            summary: 'x'.repeat(600),
        });
        expect(response.statusCode).toBe(200);
        expect(store.completed[0]?.summary).toBe('x'.repeat(512));
    });

    it('refuses a non-string summary with BAD_SUMMARY', async () => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/complete`, { ...done, summary: 42 });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_SUMMARY');
    });

    it('stores null for an empty summary — null is unmeasured, never an empty string', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, { ...done, summary: '   ' });
        expect(response.statusCode).toBe(200);
        expect(store.completed[0]?.summary).toBeNull();
    });

    // The verdict-moment done-ness of the job's whole thread — every member terminal AND the
    // user's done — computed in the store's complete transaction and relayed verbatim: the
    // driver's worktree reclaim (issue #47) decides on this instead of reading the thread back.
    it('answers the 200 body with the thread done-ness, true and false', async () => {
        const finished = await harnessWith(stubStore({ verdict: 'ok', threadDone: true }));
        const yes = await post(finished, `/api/jobs/${ID}/complete`, done);
        expect(yes.statusCode).toBe(200);
        expect(yes.json()).toEqual({ id: ID, status: 'succeeded', threadDone: true });

        const ongoing = await harnessWith(stubStore({ verdict: 'ok', threadDone: false }));
        const no = await post(ongoing, `/api/jobs/${ID}/complete`, done);
        expect(no.statusCode).toBe(200);
        expect(no.json()).toEqual({ id: ID, status: 'succeeded', threadDone: false });
    });

    // The context the run reached, scraped from the session database — rides the verdict and is
    // stored beside the attempt's vitals.
    it('records the context stats beside the verdict', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, {
            ...done,
            contextTokens: 90433,
            contextCostUsd: 0.31,
        });
        expect(response.statusCode).toBe(200);
        expect(store.completed[0]).toMatchObject({ contextTokens: 90433, contextCostUsd: 0.31 });
    });

    // The close-time agent-turn count: a number lands, an absent one stores null — unmeasured,
    // never zero — and a malformed one is refused before the store can be told anything.
    it('records the agent-turn count when the driver measured one', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, { ...done, agentTurns: 11 });
        expect(response.statusCode).toBe(200);
        expect(store.completed[0]).toMatchObject({ agentTurns: 11 });
    });

    it('stores null when the report carries no agent-turn count', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, done);
        expect(response.statusCode).toBe(200);
        expect(store.completed[0]).toMatchObject({ agentTurns: null });
    });

    it.each([
        ['a negative count', { ...done, agentTurns: -1 }],
        ['a fractional count', { ...done, agentTurns: 2.5 }],
        ['a string count', { ...done, agentTurns: 'eleven' }],
        // int4 is the column's type: an over-range value would fail the verdict's transaction
        // and leave a finished run unsettled, so the route is the boundary.
        ['a count above the int4 maximum', { ...done, agentTurns: 2_147_483_648 }],
    ])('refuses %s with BAD_AGENT_TURNS', async (_label, payload) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/complete`, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_AGENT_TURNS');
    });

    it.each([
        ['a negative token count', { ...done, contextTokens: -1 }],
        ['an absurd token count', { ...done, contextTokens: 100_000_001 }],
        ['a string cost', { ...done, contextCostUsd: 'free' }],
        ['a negative cost', { ...done, contextCostUsd: -0.01 }],
    ])('refuses %s with BAD_CONTEXT', async (_label, payload) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/complete`, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_CONTEXT');
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
        createdBy: null,
        author: null,
        stoppedBy: null,
        doneBy: null,
        sessionId: '33333333-3333-4333-8333-333333333333',
        remoteSessionId: 'cse_015tb2nHhHNrBuL7ZDhn9Wx5',
        exitCode: 0,
        output: 'hello',
        summary: null,
        repo: 'acme/web',
        executor: 'main',
        followUpTo: null,
        rootJobId: ID,
        doneAt: null,
        cancelRequestedAt: null,
        workspacePath: null,
        createdAt: '2026-08-21T12:00:00.000Z',
        startedAt: '2026-08-21T12:00:01.000Z',
        finishedAt: '2026-08-21T12:00:09.000Z',
        wallClockMs: null,
        taskWallClockMs: null,
    };

    const author = {
        id: '3f1c1111-1111-4111-8111-111111111111',
        login: 'octocat',
        name: 'The Octocat',
        avatarUrl: null,
    };
    const stopper = { id: '3f1c2222-2222-4222-8222-222222222222', login: 'stopper', name: null, avatarUrl: null };

    it('carries the resolved author and lifecycle actors through verbatim', async () => {
        // The routes add nothing and drop nothing: authorship is the store's read-time join, and
        // the payload is exactly what it computed.
        const attributed = { ...job, createdBy: author.id, author, stoppedBy: stopper, doneBy: author };
        const instance = await harnessWith(stubStore({ job: attributed, thread: [attributed] }));

        const one = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}` });
        expect(one.json().author).toEqual(author);
        expect(one.json().stoppedBy).toEqual(stopper);
        expect(one.json().doneBy).toEqual(author);
        expect(one.json().createdBy).toBe(author.id);

        const thread = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}/thread` });
        expect(thread.json().jobs[0].author).toEqual(author);

        const list = await instance.inject({ method: 'GET', url: '/api/jobs' });
        expect(list.json().jobs[0].author).toEqual(author);
    });

    it('renders a pre-accounts row as author null, never a synthetic author', async () => {
        const instance = await harnessWith(stubStore({ job }));
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}` });
        expect(response.json().author).toBeNull();
        expect(response.json().createdBy).toBeNull();
    });

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

    // The whole follow-up chain, and ANY member's id resolves to it — the UI keeps one task per
    // conversation, so the URL may name the root or any adjustment.
    it('reads the whole thread from any member of it', async () => {
        const child = { ...job, id: FOLLOW_UP_ID, command: 'now adjust the tone', followUpTo: ID, rootJobId: ID };
        const instance = await harnessWith(stubStore({ thread: [job, child] }));

        for (const member of [ID, FOLLOW_UP_ID]) {
            const response = await instance.inject({ method: 'GET', url: `/api/jobs/${member}/thread` });
            expect(response.statusCode).toBe(200);
            expect(response.json().jobs).toHaveLength(2);
        }
    });

    it('answers 404 for a thread whose job does not exist', async () => {
        const instance = await harnessWith(stubStore({ thread: null }));
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}/thread` });
        expect(response.statusCode).toBe(404);
    });

    it('refuses a malformed id on the thread', async () => {
        const instance = await harnessWith(stubStore());
        const response = await instance.inject({ method: 'GET', url: '/api/jobs/nope/thread' });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_ID');
    });

    it('lists jobs', async () => {
        const instance = await harnessWith(stubStore({ job }));
        const response = await instance.inject({ method: 'GET', url: '/api/jobs?status=succeeded' });
        expect(response.statusCode).toBe(200);
        expect(response.json().jobs).toHaveLength(1);
    });

    it("passes the 'terminal' pseudo-status to the store — every settled verdict at once", async () => {
        const store = stubStore({ job });
        const instance = await harnessWith(store);
        const response = await instance.inject({ method: 'GET', url: '/api/jobs?status=terminal&limit=30' });
        expect(response.statusCode).toBe(200);
        expect(store.listed).toEqual([{ status: 'terminal', repo: undefined, limit: 30 }]);
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

// The board is registered for every caller; without a job store BEHIND the registry, the route
// answers unavailable rather than pretending the command was queued.
it('answers 503 when the org runtime has no job store', async () => {
    const instance = await harnessWith();
    const response = await post(instance, '/api/jobs', { command: 'echo hi' });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('JOBS_UNAVAILABLE');
});

describe('POST /api/jobs/:id/gates-reread', () => {
    it('re-reads the gates for the lease holder and answers what the tree holds now', async () => {
        const gates = { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] };
        const store = stubStore({ reread: { result: 'ok', gates, gateError: null } });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/gates-reread`, { leaseToken: TOKEN });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ gates, gateError: null });
        expect(store.gatesReread).toEqual([{ id: ID }]);
    });

    it('carries a broken gates file as gateError, not as an error status', async () => {
        const store = stubStore({
            reread: { result: 'ok', gates: null, gateError: '.bellows.yaml line 3: unknown key' },
        });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/gates-reread`, { leaseToken: TOKEN });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ gates: null, gateError: '.bellows.yaml line 3: unknown key' });
    });

    it.each([
        ['a lost lease', 'lost', 409, 'LEASE_LOST'],
        ['a missing job', 'missing', 404, 'NOT_FOUND'],
    ])('maps %s', async (_label, result, status, code) => {
        const store = stubStore({ reread: result as 'lost' | 'missing' });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/gates-reread`, { leaseToken: TOKEN });

        expect(response.statusCode).toBe(status);
        expect(response.json().code).toBe(code);
    });

    it('refuses a bad lease token', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/gates-reread`, { leaseToken: 'not-a-uuid' });

        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_TOKEN');
    });
});

describe('POST /api/jobs/:id/publish-token', () => {
    it('answers the publish credential to the lease holder', async () => {
        const store = stubStore({ publish: { result: 'ok', token: 'ghs_fresh' } });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/publish-token`, { leaseToken: TOKEN });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ GITHUB_TOKEN: 'ghs_fresh' });
        expect(store.publishTokens).toEqual([{ id: ID }]);
    });

    it('answers null as a credential — nothing fresher than the claim env — not as an error', async () => {
        const store = stubStore({ publish: { result: 'ok', token: null } });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/publish-token`, { leaseToken: TOKEN });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ GITHUB_TOKEN: null });
    });

    it.each([
        ['a lost lease', 'lost', 409, 'LEASE_LOST'],
        ['a missing job', 'missing', 404, 'NOT_FOUND'],
    ])('maps %s', async (_label, result, status, code) => {
        const store = stubStore({ publish: result as 'lost' | 'missing' });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/publish-token`, { leaseToken: TOKEN });

        expect(response.statusCode).toBe(status);
        expect(response.json().code).toBe(code);
    });

    it('refuses a bad lease token', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/publish-token`, { leaseToken: 'not-a-uuid' });

        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_TOKEN');
    });
});
