import { OBJECTIVE_MODE, WORKFLOW_MODE } from '@factory-ai/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { LOCAL_ORG_ID } from '../src/config.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { OrgRuntime } from '../src/orgs.js';
import { createStatsService } from '../src/stats-service.js';
import { validateWaitQuery } from '../src/routes/job-field-validation.js';
import type { BellowsConfig } from '../src/workspace/bellows.js';
import type { Claim, GateReport, Job, JobStatus, RuntimeVitals } from '../src/db/job-store-types.js';
import type {
    AnswerQuestionResult,
    ArtifactKind,
    AskedQuestion,
    AskQuestionResult,
    ExpireQuestionResult,
    JobQuestion,
    CancelWaitResult,
    EditCommandResult,
    FollowUpRefusal,
    JobStore,
    LeaseResult,
    PokeWaitResult,
    ReadReviewResult,
    ReclaimClaim,
    RemoveResult,
    ReopenResult,
    RequestReviewResult,
    RetryRefusal,
    ReviewRequest,
    ReviewView,
    StopResult,
    StoredArtifact,
} from '../src/db/job-store-types.js';
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
const RETRY_ID = '66666666-6666-4666-8666-666666666666';

interface StoreStub extends JobStore {
    created: {
        command: string;
        createdBy: string | null;
        repo: string | null;
        executor: string | null;
        executorScope: string | null;
    }[];
    /** The skills each create was handed (issue #545), parallel to `created`. */
    skillSelections: (readonly string[] | undefined)[];
    /** The workflow triple the create was handed, when one resolved — empty in objective mode. */
    workflowTargets: {
        id: string;
        name: string;
        node: string;
        snapshot: unknown;
        params?: unknown;
    }[];
    listed: { status?: JobStatus | 'terminal'; repo?: string | undefined; limit: number }[];
    completed: {
        id: string;
        output: string | null;
        contextTokens: number | null;
        contextCostUsd: number | null;
        agentTurns: number | null;
        summary: string | null;
        failureKind: string | null;
        treeChanged: boolean | null;
        evidence: unknown;
    }[];
    sessions: { id: string; sessionId: string | null }[];
    progressed: { id: string; output: string; runtime: RuntimeVitals | null }[];
    /** The artifact uploads the worker routes landed, with the exact content they were handed. */
    artifacts: { id: string; kind: ArtifactKind; attempt: number; content: string; truncated: boolean }[];
    /** The artifact reads the person routes made, with the kind and attempt they asked for. */
    artifactReads: { id: string; kind: ArtifactKind; attempt: number | null }[];
    suspended: string[];
    followUps: { parentId: string; command: string; createdBy: string | null }[];
    retries: { id: string; createdBy: string | null }[];
    edited: { id: string; command: string; caller: string | null }[];
    markedDone: { id: string; doneBy: string | null }[];
    gatesReported: { id: string; results: GateReport[] }[];
    gatesReread: { id: string }[];
    publishTokens: { id: string }[];
    stopped: { id: string; stoppedBy: string | null }[];
    removed: { id: string; removedBy: string | null }[];
    cancelledWaits: { id: string; cancelledBy: string | null }[];
    pokes: { id: string; pokedBy: string | null }[];
    reopened: string[];
    reclaimClaims: { worker: string; leaseSeconds: number }[];
    reclaimAcks: { id: string; worker: string }[];
    /** The lease lookups the orphan reaper's batched route made, with the ids it asked for. */
    leased: { ids: string[] }[];
    /** The long-poll holds the route requested, with the timeout it was given (issue #323). */
    waits: { id: string; timeoutMs: number }[];
    /** The question reports, expiries and answers the routes handed the store (050). */
    asked: { id: string; questionId: string; questions: AskedQuestion[] }[];
    expired: { id: string; questionId: string }[];
    answered: { id: string; questionId: string; answers: Record<string, string>; answeredBy: string | null }[];
    /** The named-reviewer requests and reads the routes handed the store (056, issue #549). */
    reviewRequests: { id: string; request: ReviewRequest }[];
    reviewReads: { id: string; key: string }[];
}

const QUESTION: JobQuestion = {
    id: 'toolu_01',
    attempt: 1,
    questions: [],
    status: 'pending',
    answerable: true,
    answers: null,
    answeredBy: null,
    askedAt: '2026-08-21T12:00:00.000Z',
    answeredAt: null,
};

const REVIEW: ReviewView = {
    id: '99999999-9999-4999-8999-999999999999',
    key: 'security-1',
    profile: 'security',
    status: 'queued',
    verdict: 'none',
    revision: 'abc:def',
    findings: null,
    failureKind: null,
    evidence: { state: 'incomplete' },
};

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
        retry?: RetryRefusal;
        /** What the store answers a queued-command edit with; ok echoes the new command back. */
        edit?: EditCommandResult;
        /** What the store answers a create with; 'purging' is the manual purge's refusal (#92). */
        create?: 'purging';
        done?: { status: JobStatus; doneAt: string } | 'missing' | 'conflict';
        reread?: { result: 'ok'; gates: BellowsConfig | null; gateError: string | null } | 'lost' | 'missing';
        publish?: { result: 'ok'; token: string | null } | 'lost' | 'missing';
        /** Where the board says the suspend landed, on the 'ok' path. */
        suspendStatus?: JobStatus;
        stop?: StopResult;
        remove?: RemoveResult;
        /** What `readArtifact` answers; null → 404. */
        storedArtifact?: StoredArtifact | null;
        cancelWait?: CancelWaitResult;
        pokeWait?: PokeWaitResult;
        reopen?: ReopenResult;
        reclaimClaim?: ReclaimClaim | null;
        ackReclaim?: 'ok' | 'lost' | 'missing';
        heartbeatCancelRequested?: boolean;
        answeredQuestions?: { questionId: string; answers: Record<string, string> }[];
        /** What the question store answers a report, an expiry and an answer with (050). */
        ask?: AskQuestionResult;
        expire?: ExpireQuestionResult;
        answer?: AnswerQuestionResult;
        reviewRequest?: RequestReviewResult;
        reviewRead?: ReadReviewResult;
        /** The lease rows the store answers a batched lookup with; absent means none. */
        leaseRows?: { id: string; status: JobStatus; leaseToken: string | null }[];
        /**
         * What `waitForSettle` answers (issue #323); null → 404. A function may delay to model
         * the store's hold — the route must await it, never answer first.
         */
        waitFor?: (id: string, timeoutMs: number) => Promise<{ settled: boolean } | null>;
    } = {}
): StoreStub {
    const boom = () => {
        if (options.fail) throw new Error('database is down');
    };
    const stub: StoreStub = {
        created: [],
        skillSelections: [],
        workflowTargets: [],
        listed: [],
        commands: [],
        completed: [],
        sessions: [],
        progressed: [],
        artifacts: [],
        artifactReads: [],
        suspended: [],
        gatesReread: [],
        publishTokens: [],
        followUps: [],
        retries: [],
        edited: [],
        markedDone: [],
        gatesReported: [],
        stopped: [],
        removed: [],
        cancelledWaits: [],
        pokes: [],
        reopened: [],
        reclaimClaims: [],
        reclaimAcks: [],
        leased: [],
        waits: [],
        asked: [],
        expired: [],
        answered: [],
        reviewRequests: [],
        reviewReads: [],
        async suspend(id) {
            boom();
            stub.suspended.push(id);
            const result = options.verdict ?? 'ok';
            return result === 'ok' ? { result: 'ok', status: options.suspendStatus ?? 'stopped' } : { result };
        },
        async create(command, createdBy, target) {
            boom();
            stub.created.push({
                command,
                createdBy: createdBy ?? null,
                repo: target?.repo ?? null,
                executor: target?.executor ?? null,
                executorScope: target?.executorScope ?? null,
            });
            stub.skillSelections.push(target?.skills);
            if (target?.workflow) stub.workflowTargets.push(target.workflow);
            stub.commands.push(command);
            return options.create ?? { id: ID };
        },
        async createFollowUp(parentId, command, createdBy) {
            boom();
            stub.followUps.push({ parentId, command, createdBy: createdBy ?? null });
            return options.followUp ?? { id: FOLLOW_UP_ID };
        },
        async createRetry(id, createdBy) {
            boom();
            stub.retries.push({ id, createdBy: createdBy ?? null });
            return options.retry ?? { id: RETRY_ID };
        },
        async editCommand(id, command, caller) {
            boom();
            stub.edited.push({ id, command, caller: caller ?? null });
            return options.edit ?? { result: 'ok', command };
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
                answeredQuestions: result === 'ok' ? (options.answeredQuestions ?? []) : [],
            };
        },
        async askQuestion(id, _token, ask) {
            boom();
            stub.asked.push({ id, ...ask });
            return options.ask ?? { result: 'created', question: QUESTION };
        },
        async expireQuestion(id, _token, questionId) {
            boom();
            stub.expired.push({ id, questionId });
            return options.expire ?? { result: 'expired' };
        },
        async requestReview(id, _token, request) {
            boom();
            stub.reviewRequests.push({ id, request });
            return options.reviewRequest ?? { result: 'created', review: REVIEW };
        },
        async readReview(id, _token, key) {
            boom();
            stub.reviewReads.push({ id, key });
            return options.reviewRead ?? { result: 'ok', review: REVIEW };
        },
        async answerQuestion(id, questionId, answers, answeredBy) {
            boom();
            stub.answered.push({ id, questionId, answers, answeredBy });
            return options.answer ?? { result: 'ok', question: QUESTION };
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
        async cancelWait(id, cancelledBy) {
            boom();
            stub.cancelledWaits.push({ id, cancelledBy: cancelledBy ?? null });
            return options.cancelWait ?? { result: 'ok' };
        },
        async pokeWait(id, pokedBy) {
            boom();
            stub.pokes.push({ id, pokedBy: pokedBy ?? null });
            return options.pokeWait ?? { result: 'ok', woken: true };
        },
        async reopen(id) {
            boom();
            stub.reopened.push(id);
            return options.reopen ?? { result: 'ok' };
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
        async leases(ids) {
            boom();
            stub.leased.push({ ids: [...ids] });
            return options.leaseRows ?? [];
        },
        async session(id, _token, sessionId) {
            boom();
            stub.sessions.push({ id, sessionId });
            return options.verdict ?? 'ok';
        },
        async progress(id: string, _token: string, output: string, runtime: RuntimeVitals | null) {
            boom();
            stub.progressed.push({ id, output, runtime });
            return options.verdict ?? 'ok';
        },
        async artifact(id, _token, upload) {
            boom();
            stub.artifacts.push({ id, ...upload });
            return options.verdict ?? 'ok';
        },
        async readArtifact(id, kind, attempt) {
            boom();
            stub.artifactReads.push({ id, kind, attempt });
            return options.storedArtifact ?? null;
        },
        async complete(
            id: string,
            _token: string,
            { output, contextTokens, contextCostUsd, agentTurns, summary, failureKind, treeChanged, evidence }
        ) {
            boom();
            stub.completed.push({
                id,
                output,
                contextTokens: contextTokens ?? null,
                contextCostUsd: contextCostUsd ?? null,
                agentTurns: agentTurns ?? null,
                summary: summary ?? null,
                failureKind: failureKind ?? null,
                treeChanged: treeChanged ?? null,
                evidence: evidence ?? null,
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
        async waitForSettle(id, timeoutMs) {
            boom();
            stub.waits.push({ id, timeoutMs });
            const answer = options.waitFor ?? (async () => ({ settled: true }) as const);
            return answer(id, timeoutMs);
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
        async listTasks() {
            boom();
            return {
                navigation: { counts: { running: 0, review: 0, past: 0 }, running: [], review: [] },
                page: { items: [], nextCursor: null },
            };
        },
    };
    return stub;
}

async function harnessWith(jobs?: StoreStub, workflows?: WorkflowStore, telemetry = stubTelemetryClient()) {
    const config = testConfig();
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, jobs, workflows, telemetry }),
    });
    app = instance;
    return instance;
}

const post = (instance: FastifyInstance, url: string, payload: unknown) =>
    instance.inject({ method: 'POST', url, payload: payload as object });

const patch = (instance: FastifyInstance, url: string, payload: unknown) =>
    instance.inject({ method: 'PATCH', url, payload: payload as object });

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

    it('refuses with PURGE_IN_PROGRESS when the author\u2019s checkout row is being deleted', async () => {
        // The manual purge (issue #92): the insert transaction takes the author's checkout row's
        // lock and refuses when it reads `purging` — a task cannot be queued into a checkout that
        // is coming off the disk.
        const store = stubStore({ create: 'purging' });
        const instance = await harnessWith(store);

        const response = await post(instance, '/api/jobs', {
            command: 'claude -p "fix the build"',
            repo: 'acme/web',
            executor: 'main',
        });

        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('PURGE_IN_PROGRESS');
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
            {
                command: 'claude -p "fix the build"',
                createdBy: null,
                repo: 'acme/web',
                executor: 'main',
                executorScope: 'user',
            },
        ]);
    });

    it('records no repository and no executor when the body has none', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const response = await post(instance, '/api/jobs', { command: 'echo hi' });

        expect(response.statusCode).toBe(201);
        expect(store.created).toEqual([
            { command: 'echo hi', createdBy: null, repo: null, executor: null, executorScope: 'user' },
        ]);
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
        expect(store.created).toEqual([
            { command: 'echo hi', createdBy: null, repo: null, executor: null, executorScope: 'user' },
        ]);
    });

    it('stamps the organization scope beside the executor label (issue 391)', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const response = await post(instance, '/api/jobs', {
            command: 'echo hi',
            executor: 'team-runner',
            executorScope: 'org',
        });

        expect(response.statusCode).toBe(201);
        expect(store.created).toEqual([
            {
                command: 'echo hi',
                createdBy: null,
                repo: null,
                executor: 'team-runner',
                executorScope: 'org',
            },
        ]);
    });

    it.each([
        ['a scope outside the pair', 'repo'],
        ['a non-string scope', 7],
    ])('refuses %s as executorScope', async (_label, executorScope) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, '/api/jobs', { command: 'echo hi', executor: 'x', executorScope });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_EXECUTOR_SCOPE');
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
            { id: 'wf-1', name: 'fix-issue', node: 'implement', snapshot: workflows.record.definition, params: {} },
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

    // Objective mode (issue #543): a body without a workflow field resolves nothing — the named
    // workflow store is not read, no workflow target reaches the store, and the command is raw.
    it('creates an objective-mode task with the raw command, reading no workflows, when the body names none', async () => {
        const jobs = stubStore();
        const workflows = stubWorkflows();
        const instance = await harnessWith(jobs, workflows);

        const response = await post(instance, '/api/jobs', { command: 'echo hi', repo: 'acme/web' });

        expect(response.statusCode).toBe(201);
        expect(workflows.calls.findByName).toEqual([]);
        expect(jobs.workflowTargets).toEqual([]);
        expect(jobs.commands).toEqual(['echo hi']);
    });

    it('ignores a legacy defaultWorkflow body field: still objective mode, no workflow target', async () => {
        const jobs = stubStore();
        const instance = await harnessWith(jobs, stubWorkflows());

        const response = await post(instance, '/api/jobs', {
            command: 'echo hi',
            defaultWorkflow: { reviewReconciliation: true, mergeConflictAutofix: true },
        });

        expect(response.statusCode).toBe(201);
        expect(jobs.workflowTargets).toEqual([]);
        expect(jobs.commands).toEqual(['echo hi']);
    });
});

describe('POST /api/jobs skill selection', () => {
    it('forwards the selected skills to the store', async () => {
        const jobs = stubStore();
        const instance = await harnessWith(jobs, stubWorkflows());

        const response = await post(instance, '/api/jobs', { command: 'echo hi', skills: ['github', 'jira'] });

        expect(response.statusCode).toBe(201);
        expect(jobs.skillSelections).toEqual([['github', 'jira']]);
    });

    it('forwards no skills when the body names none', async () => {
        const jobs = stubStore();
        const instance = await harnessWith(jobs, stubWorkflows());

        await post(instance, '/api/jobs', { command: 'echo hi' });
        await post(instance, '/api/jobs', { command: 'echo hi', skills: null });

        expect(jobs.skillSelections).toEqual([[], []]);
    });

    it('refuses an unknown skill with a named, actionable error and queues nothing', async () => {
        const jobs = stubStore();
        const instance = await harnessWith(jobs, stubWorkflows());

        const response = await post(instance, '/api/jobs', { command: 'echo hi', skills: ['github', 'ghost'] });

        expect(response.statusCode).toBe(404);
        expect(response.json().code).toBe('UNKNOWN_SKILL');
        expect(response.json().error).toContain('"ghost"');
        expect(response.json().error).toContain('installed: ');
        expect(jobs.created).toEqual([]);
    });

    it.each([
        ['a string', 'github'],
        ['a non-string entry', ['github', 7]],
        ['a malformed name', ['Not A Skill']],
        ['a repeated name', ['github', 'github']],
        ['too many names', Array.from({ length: 17 }, (_, i) => `skill-${i}`)],
    ])('refuses %s as BAD_SKILLS and queues nothing', async (_label, skills) => {
        const jobs = stubStore();
        const instance = await harnessWith(jobs, stubWorkflows());

        const response = await post(instance, '/api/jobs', { command: 'echo hi', skills });

        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_SKILLS');
        expect(jobs.created).toEqual([]);
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
            { id: 'wf-1', name: 'fix-issue', node: 'fetch', snapshot: parammedDefinition, params: { issue: '#127' } },
        ]);
    });

    it('stamps the RESOLVED record name — a client-supplied workflowName has no authority', async () => {
        const jobs = stubStore();
        const workflows = stubWorkflows({ definition: parammedDefinition });
        const instance = await harnessWith(jobs, workflows);

        const forged = await post(instance, '/api/jobs', {
            command: 'fix the login bug',
            workflow: 'fix-issue',
            workflowParams: { issue: '#127' },
            workflowName: 'forged',
        });
        expect(forged.statusCode).toBe(201);
        // The name came off the record the store resolved, never off the body.
        expect(jobs.workflowTargets[0]!.name).toBe('fix-issue');

        // A body naming no workflow ignores a client-supplied workflowName entirely: objective
        // mode, no workflow target at all.
        const ghost = await post(instance, '/api/jobs', { command: 'echo hi', workflowName: 'ghost' });
        expect(ghost.statusCode).toBe(201);
        expect(jobs.workflowTargets).toHaveLength(1);
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

describe('POST /api/jobs/leases — the orphan reaper’s batched lookup (issue #301)', () => {
    const JOB_B = '44444444-4444-4444-8444-444444444444';

    it('answers each known job’s status and current lease, and omits ids it does not know', async () => {
        const store = stubStore({
            leaseRows: [
                { id: ID, status: 'running', leaseToken: TOKEN },
                { id: JOB_B, status: 'dead', leaseToken: null },
            ],
        });
        const instance = await harnessWith(store);

        const UNKNOWN = '99999999-9999-4999-8999-999999999999';
        const response = await postAsWorker(instance, '/api/jobs/leases', { ids: [ID, JOB_B, UNKNOWN] });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            jobs: [
                { id: ID, status: 'running', leaseToken: TOKEN },
                { id: JOB_B, status: 'dead', leaseToken: null },
            ],
        });
        // The unknown id reached the store — its absence from the ANSWER is the board's verdict.
        expect(store.leased).toEqual([{ ids: [ID, JOB_B, UNKNOWN] }]);
    });

    // The shared secret authenticates the driver, not an org, so this route — like the claim —
    // is offered every org's board, and one answer per org is merged by id.
    it('consults every org board under a worker token and merges the answers', async () => {
        const a = stubStore({ leaseRows: [{ id: ID, status: 'failed', leaseToken: null }] });
        const b = stubStore({ leaseRows: [{ id: JOB_B, status: 'running', leaseToken: TOKEN }] });
        const instance = await harnessOfBoards([
            ['org-a', a],
            ['org-b', b],
        ]);

        const response = await postAsWorker(instance, '/api/jobs/leases', { ids: [ID, JOB_B] });

        expect(response.statusCode).toBe(200);
        expect(response.json().jobs).toEqual([
            { id: ID, status: 'failed', leaseToken: null },
            { id: JOB_B, status: 'running', leaseToken: TOKEN },
        ]);
    });

    it('requires the worker token under AUTH_MODE=github', async () => {
        const instance = await harnessOfBoards([['org-a', stubStore()]]);
        const response = await instance.inject({ method: 'POST', url: '/api/jobs/leases', payload: { ids: [ID] } });
        expect(response.statusCode).toBe(401);
        expect(response.json().code).toBe('UNAUTHENTICATED');
    });

    it.each([
        ['a body without ids', {}],
        ['a non-array ids', { ids: ID }],
        ['a non-uuid entry', { ids: [ID, 'nope'] }],
        ['an empty list', { ids: [] }],
    ])('refuses %s with BAD_ID', async (_label, payload) => {
        const instance = await harnessWith(stubStore());
        const response = await postAsWorker(instance, '/api/jobs/leases', payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_ID');
    });

    it('refuses more ids than one request may carry with BAD_ID', async () => {
        const LEASE_BATCH_MAX = 100;
        const ids = Array.from({ length: LEASE_BATCH_MAX + 1 }, (_, i) => {
            const head = String(i).padStart(8, '0');
            return `${head}-1111-4111-8111-111111111111`;
        });
        const instance = await harnessWith(stubStore());

        const response = await postAsWorker(instance, '/api/jobs/leases', { ids });

        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_ID');
    });

    // "Absent means unknown" is only safe if every board actually answered: one org board down
    // must 503 the whole lookup, so the driver reaps nothing rather than guessing.
    it('answers 503 when any board throws', async () => {
        const failing = stubStore();
        failing.leases = async () => {
            throw new Error('database is down');
        };
        const instance = await harnessOfBoards([
            ['org-a', failing],
            ['org-b', stubStore({ leaseRows: [{ id: ID, status: 'dead', leaseToken: null }] })],
        ]);

        const response = await postAsWorker(instance, '/api/jobs/leases', { ids: [ID] });

        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });

    // The registry DROPS an org whose runtime failed to build — which would turn that org's
    // every id into "unknown to the board", a reap verdict. A registry that cannot fully answer
    // is a 503, exactly like a board that throws.
    it('answers 503 when an organization has no runtime at all', async () => {
        const config = testConfig({ auth: githubAuth() });
        const repos = staticRepoSource([]);
        const telemetry = stubTelemetryClient();
        const jobs = stubStore();
        const instance = await buildApp({
            config,
            auth: memoryAuthStore(),
            orgs: {
                for: async (orgId) =>
                    orgId === 'org-alive'
                        ? {
                              orgId,
                              repos,
                              telemetry,
                              service: createStatsService({ config, repos, telemetry }),
                              jobs,
                          }
                        : null,
                list: async () => [
                    { id: 'org-alive', name: 'org-alive', installationId: null },
                    { id: 'org-dead', name: 'org-dead', installationId: null },
                ],
                warmAll: async () => {},
            },
        });
        app = instance;

        const response = await postAsWorker(instance, '/api/jobs/leases', { ids: [ID] });

        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });

    it('answers 503 when no board exists', async () => {
        const instance = await harnessOfBoards([]);
        const response = await postAsWorker(instance, '/api/jobs/leases', { ids: [ID] });
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('JOBS_UNAVAILABLE');
    });

    // None mode resolves the caller to the LOCAL org — one board, whatever foreign org rows a
    // shared database also holds. The every-org count check above must not apply there, or the
    // default dev workflow would 503 the reaper forever.
    it('answers the local org board under AUTH_MODE=none even when foreign org rows exist', async () => {
        const config = testConfig();
        const instance = await buildApp({
            config,
            orgs: {
                for: async (orgId) =>
                    orgId === LOCAL_ORG_ID
                        ? {
                              orgId,
                              repos: staticRepoSource([]),
                              telemetry: stubTelemetryClient(),
                              service: createStatsService({
                                  config,
                                  repos: staticRepoSource([]),
                                  telemetry: stubTelemetryClient(),
                              }),
                              jobs: stubStore({ leaseRows: [{ id: ID, status: 'dead', leaseToken: null }] }),
                          }
                        : null,
                list: async () => [
                    { id: LOCAL_ORG_ID, name: LOCAL_ORG_ID, installationId: null },
                    { id: 'org-foreign', name: 'org-foreign', installationId: null },
                ],
                warmAll: async () => {},
            },
        });
        app = instance;

        const response = await post(instance, '/api/jobs/leases', { ids: [ID] });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ jobs: [{ id: ID, status: 'dead', leaseToken: null }] });
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
        expect(store.sessions).toEqual([{ id: ID, sessionId: SESSION }]);
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

    // A refused start reported its minted session before the spawn and never ran it; an explicit
    // null takes it back off the row, so a follow-up is not offered a conversation that is not there.
    it('clears the session on an explicit null', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/session`, { leaseToken: TOKEN, sessionId: null });

        expect(response.statusCode).toBe(200);
        expect(store.sessions).toEqual([{ id: ID, sessionId: null }]);
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

    // A dead service's ending (issue #487) rides the fleet: the exit, the reason, the log tail
    // (bounded to its END), the hint — and a malformed one is refused like any other bad field.
    it('passes a dead service ending through, bounding the log tail to its last lines', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const ending = { exitCode: 1, reason: 'Error', logTail: 'boom', hint: 'set unhardened: true' };
        const runtime = (service: object) => ({
            ...VITALS,
            services: [{ name: 'db', image: 'mongo', state: 'failed', ...service }],
        });

        await post(instance, `/api/jobs/${ID}/output`, { leaseToken: TOKEN, output: 'x', runtime: runtime(ending) });
        await post(instance, `/api/jobs/${ID}/output`, {
            leaseToken: TOKEN,
            output: 'x',
            runtime: runtime({ exitCode: null, reason: null, logTail: `${'a'.repeat(10_000)}END` }),
        });

        expect(store.progressed[0]?.runtime?.services).toEqual([
            { name: 'db', image: 'mongo', state: 'failed', ...ending },
        ]);
        const bounded = store.progressed[1]?.runtime?.services?.[0];
        expect(bounded?.exitCode).toBeNull();
        expect(bounded?.reason).toBeNull();
        expect(bounded?.logTail).toHaveLength(4096);
        expect(bounded?.logTail?.endsWith('END')).toBe(true);

        for (const bad of [{ exitCode: 1.5 }, { exitCode: '1' }, { reason: 7 }, { logTail: 7 }, { hint: 7 }]) {
            const response = await post(instance, `/api/jobs/${ID}/output`, {
                leaseToken: TOKEN,
                output: 'x',
                runtime: runtime(bad),
            });
            expect(response.statusCode).toBe(400);
        }
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

// The run artifacts (issue #325): the driver's close-time upload of the full-run log and the
// agent transcript, and the person reads that serve them to an investigating client. The store
// side is a real-database suite; these pin the HTTP contract.
describe('POST /api/jobs/:id/artifact', () => {
    it('stores an upload and answers the triple it stored', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/artifact`, {
            leaseToken: TOKEN,
            kind: 'log',
            attempt: 2,
            content: 'line one\nline two\n',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: ID, kind: 'log', attempt: 2 });
        expect(store.artifacts).toEqual([
            { id: ID, kind: 'log', attempt: 2, content: 'line one\nline two\n', truncated: false },
        ]);
    });

    it('passes the truncated flag through when the driver set it', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);

        await post(instance, `/api/jobs/${ID}/artifact`, {
            leaseToken: TOKEN,
            kind: 'transcript',
            attempt: 1,
            content: '{"truncated":true}',
            truncated: true,
        });

        expect(store.artifacts[0]?.truncated).toBe(true);
    });

    it('rejects an upload from a worker whose lease was reclaimed', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'lost' }));
        const response = await post(instance, `/api/jobs/${ID}/artifact`, {
            leaseToken: TOKEN,
            kind: 'log',
            attempt: 1,
            content: 'late',
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('LEASE_LOST');
    });

    it('answers 404 for a job that does not exist', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'missing' }));
        const response = await post(instance, `/api/jobs/${ID}/artifact`, {
            leaseToken: TOKEN,
            kind: 'log',
            attempt: 1,
            content: 'x',
        });
        expect(response.statusCode).toBe(404);
    });

    it.each([
        ['a malformed lease token', { leaseToken: 'nope', kind: 'log', attempt: 1, content: 'x' }, 'BAD_TOKEN'],
        ['an unknown kind', { leaseToken: TOKEN, kind: 'core', attempt: 1, content: 'x' }, 'BAD_ARTIFACT'],
        ['a missing kind', { leaseToken: TOKEN, attempt: 1, content: 'x' }, 'BAD_ARTIFACT'],
        ['a zero attempt', { leaseToken: TOKEN, kind: 'log', attempt: 0, content: 'x' }, 'BAD_ATTEMPT'],
        ['a fractional attempt', { leaseToken: TOKEN, kind: 'log', attempt: 1.5, content: 'x' }, 'BAD_ATTEMPT'],
        ['a non-string attempt', { leaseToken: TOKEN, kind: 'log', attempt: '1', content: 'x' }, 'BAD_ATTEMPT'],
        ['a missing content', { leaseToken: TOKEN, kind: 'log', attempt: 1 }, 'BAD_ARTIFACT'],
        ['a non-string content', { leaseToken: TOKEN, kind: 'log', attempt: 1, content: 42 }, 'BAD_ARTIFACT'],
        [
            'a string truncated flag',
            { leaseToken: TOKEN, kind: 'log', attempt: 1, content: 'x', truncated: 'yes' },
            'BAD_ARTIFACT',
        ],
    ])('refuses %s', async (_label, payload, code) => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/artifact`, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe(code);
        expect(store.artifacts).toEqual([]);
    });

    // The driver sends an already-tail-kept artifact; this is the backstop, exactly as the
    // output tail has one. A cut forces `truncated` beside it, so a reader can trust the flag.
    it('truncates oversized content before it reaches the store, forcing the flag', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);

        // Marked head and tail so the kept half is identifiable: the cut drops the head, the
        // contract the read routes document ("the head bytes were dropped, not stored elsewhere").
        const content = `HEAD${'x'.repeat(600 * 1024)}TAIL`;
        const response = await post(instance, `/api/jobs/${ID}/artifact`, {
            leaseToken: TOKEN,
            kind: 'log',
            attempt: 1,
            content,
        });

        expect(response.statusCode).toBe(200);
        expect(store.artifacts[0]?.content).toBe(content.slice(-512 * 1024));
        expect(store.artifacts[0]?.truncated).toBe(true);
    });
});

describe('GET /api/jobs/:id/log and /transcript', () => {
    const artifact = (content: string): StoredArtifact => ({ attempt: 2, truncated: true, content });

    it.each([
        ['log', 'log'],
        ['transcript', 'transcript'],
    ] as const)('answers the paging envelope for %s', async (route, kind) => {
        const store = stubStore({ storedArtifact: artifact('hello world') });
        const instance = await harnessWith(store);

        const response = await instance.inject(`/api/jobs/${ID}/${route}`);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            jobId: ID,
            kind,
            attempt: 2,
            truncated: true,
            offset: 0,
            limit: 65_536,
            totalCharacters: 11,
            content: 'hello world',
        });
        expect(store.artifactReads).toEqual([{ id: ID, kind, attempt: null }]);
    });

    it('slices by offset and limit', async () => {
        const store = stubStore({ storedArtifact: artifact('abcdefghij') });
        const instance = await harnessWith(store);

        const response = await instance.inject(`/api/jobs/${ID}/log?offset=2&limit=4`);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ offset: 2, limit: 4, totalCharacters: 10, content: 'cdef' });
    });

    it('honors an explicit attempt, and answers an empty page past the end', async () => {
        const store = stubStore({ storedArtifact: artifact('abc') });
        const instance = await harnessWith(store);

        const byAttempt = await instance.inject(`/api/jobs/${ID}/log?attempt=1`);
        expect(byAttempt.statusCode).toBe(200);
        expect(store.artifactReads[0]).toEqual({ id: ID, kind: 'log', attempt: 1 });

        const pastEnd = await instance.inject(`/api/jobs/${ID}/log?offset=99`);
        expect(pastEnd.statusCode).toBe(200);
        expect(pastEnd.json()).toMatchObject({ content: '', totalCharacters: 3 });
    });

    it('answers 404 when nothing was uploaded for the kind', async () => {
        const instance = await harnessWith(stubStore({ storedArtifact: null }));
        const response = await instance.inject(`/api/jobs/${ID}/log`);
        expect(response.statusCode).toBe(404);
        expect(response.json().code).toBe('NOT_FOUND');
    });

    it('answers 404 for a job that does not exist', async () => {
        const instance = await harnessWith(stubStore({ storedArtifact: null }));
        const response = await instance.inject(`/api/jobs/${ID}/log`);
        expect(response.statusCode).toBe(404);
    });

    it.each([
        ['a zero attempt', '?attempt=0', 'BAD_ATTEMPT'],
        ['a negative attempt', '?attempt=-1', 'BAD_ATTEMPT'],
        ['a non-numeric attempt', '?attempt=one', 'BAD_ATTEMPT'],
        ['a negative offset', '?offset=-1', 'BAD_OFFSET'],
        ['a non-numeric offset', '?offset=soon', 'BAD_OFFSET'],
        ['a zero limit', '?limit=0', 'BAD_LIMIT'],
        ['an oversized limit', '?limit=99999999', 'BAD_LIMIT'],
    ])('refuses %s', async (_label, query, code) => {
        const instance = await harnessWith(stubStore({ storedArtifact: artifact('abc') }));
        const response = await instance.inject(`/api/jobs/${ID}/log${query}`);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe(code);
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

    describe('POST /api/jobs/:id/reopen', () => {
        it('reopens a done task', async () => {
            const store = stubStore({ reopen: { result: 'ok' } });
            const instance = await harnessWith(store);

            const response = await post(instance, `/api/jobs/${ID}/reopen`, {});

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ id: ID, reopened: true });
            expect(store.reopened).toEqual([ID]);
        });

        // The done stamp is the only thing reopen reverses: a task that was never closed has
        // nothing to reopen, and the refusal names that rather than pretending to succeed.
        it('refuses a task that is not done', async () => {
            const instance = await harnessWith(stubStore({ reopen: 'not_done' }));
            const response = await post(instance, `/api/jobs/${ID}/reopen`, {});
            expect(response.statusCode).toBe(409);
            expect(response.json().code).toBe('TASK_NOT_DONE');
        });

        // The worktree a follow-up resumes in is gone — reopen cannot give it back.
        it('refuses once the worktree reclaim has run', async () => {
            const instance = await harnessWith(stubStore({ reopen: 'reclaimed' }));
            const response = await post(instance, `/api/jobs/${ID}/reopen`, {});
            expect(response.statusCode).toBe(409);
            expect(response.json().code).toBe('WORKTREE_RECLAIMED');
        });

        // A driver is mid-removal: retry once the reclaim settles rather than reopening over a
        // tree that is about to come down.
        it('refuses while a reclaim is in flight', async () => {
            const instance = await harnessWith(stubStore({ reopen: 'reclaiming' }));
            const response = await post(instance, `/api/jobs/${ID}/reopen`, {});
            expect(response.statusCode).toBe(409);
            expect(response.json().code).toBe('RECLAIM_IN_PROGRESS');
        });

        it('answers 404 for a task that does not exist', async () => {
            const instance = await harnessWith(stubStore({ reopen: 'missing' }));
            expect((await post(instance, `/api/jobs/${ID}/reopen`, {})).statusCode).toBe(404);
        });

        it('answers 503 when the store is down, so the caller retries', async () => {
            const instance = await harnessWith(stubStore({ fail: true }));
            const response = await post(instance, `/api/jobs/${ID}/reopen`, {});
            expect(response.statusCode).toBe(503);
            expect(response.json().code).toBe('UNAVAILABLE');
        });

        it('refuses a malformed id', async () => {
            const instance = await harnessWith(stubStore());
            expect((await post(instance, '/api/jobs/nope/reopen', {})).statusCode).toBe(400);
        });
    });
});

describe('POST /api/jobs/:id/wait/cancel', () => {
    it('cancels the thread\u2019s open wait, recording the caller', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/wait/cancel`, {});

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: ID, cancelled: true });
        expect(store.cancelledWaits).toEqual([{ id: ID, cancelledBy: null }]);
    });

    it('answers 409 NO_OPEN_WAIT when the thread has no open wait', async () => {
        const instance = await harnessWith(stubStore({ cancelWait: 'no_wait' }));
        const response = await post(instance, `/api/jobs/${ID}/wait/cancel`, {});
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('NO_OPEN_WAIT');
    });

    it('answers 403 for a caller that is not the thread\u2019s author', async () => {
        const instance = await harnessWith(stubStore({ cancelWait: 'forbidden' }));
        const response = await post(instance, `/api/jobs/${ID}/wait/cancel`, {});
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('FORBIDDEN');
    });

    it('answers 404 for a task that does not exist', async () => {
        const instance = await harnessWith(stubStore({ cancelWait: 'missing' }));
        expect((await post(instance, `/api/jobs/${ID}/wait/cancel`, {})).statusCode).toBe(404);
    });

    it('answers 503 when the store is down, so the caller retries', async () => {
        const instance = await harnessWith(stubStore({ fail: true }));
        const response = await post(instance, `/api/jobs/${ID}/wait/cancel`, {});
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });

    it('refuses a malformed id', async () => {
        const instance = await harnessWith(stubStore());
        expect((await post(instance, '/api/jobs/nope/wait/cancel', {})).statusCode).toBe(400);
    });
});

describe('POST /api/jobs/:id/wait/poke', () => {
    it('reports a woken round', async () => {
        const store = stubStore({ pokeWait: { result: 'ok', woken: true } });
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/wait/poke`, {});

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: ID, woken: true });
        expect(store.pokes).toEqual([{ id: ID, pokedBy: null }]);
    });

    it('reports woken: false when nothing was parked to wake', async () => {
        const instance = await harnessWith(stubStore({ pokeWait: { result: 'ok', woken: false } }));
        const response = await post(instance, `/api/jobs/${ID}/wait/poke`, {});
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: ID, woken: false });
    });

    it('answers 409 NO_OPEN_WAIT when the thread has no open wait', async () => {
        const instance = await harnessWith(stubStore({ pokeWait: 'no_wait' }));
        const response = await post(instance, `/api/jobs/${ID}/wait/poke`, {});
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('NO_OPEN_WAIT');
    });

    it('answers 403 for a caller that is not the thread\u2019s author', async () => {
        const instance = await harnessWith(stubStore({ pokeWait: 'forbidden' }));
        const response = await post(instance, `/api/jobs/${ID}/wait/poke`, {});
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('FORBIDDEN');
    });

    it('answers 404 for a task that does not exist', async () => {
        const instance = await harnessWith(stubStore({ pokeWait: 'missing' }));
        expect((await post(instance, `/api/jobs/${ID}/wait/poke`, {})).statusCode).toBe(404);
    });

    it('answers 503 when the store is down, so the caller retries', async () => {
        const instance = await harnessWith(stubStore({ fail: true }));
        const response = await post(instance, `/api/jobs/${ID}/wait/poke`, {});
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });

    it('refuses a malformed id', async () => {
        const instance = await harnessWith(stubStore());
        expect((await post(instance, '/api/jobs/nope/wait/poke', {})).statusCode).toBe(400);
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

    const patchAs = (instance: FastifyInstance, url: string, cookie: string, payload: unknown = {}) =>
        instance.inject({ method: 'PATCH', url, payload: payload as object, headers: { cookie } });

    it('create records the signed-in caller as the author', async () => {
        const { instance, store, caller, cookie } = await signedInHarness();

        const response = await postAs(instance, '/api/jobs', cookie, { command: 'echo hi' });

        expect(response.statusCode).toBe(201);
        expect(store.created).toEqual([
            {
                command: 'echo hi',
                createdBy: caller.user.id,
                repo: null,
                executor: null,
                executorScope: 'user',
            },
        ]);
    });

    it('follow-up records the signed-in caller', async () => {
        const { instance, store, caller, cookie } = await signedInHarness();

        const response = await postAs(instance, `/api/jobs/${ID}/follow-up`, cookie, { command: 'again, tighter' });

        expect(response.statusCode).toBe(201);
        expect(store.followUps).toEqual([{ parentId: ID, command: 'again, tighter', createdBy: caller.user.id }]);
    });

    it('retry records the signed-in caller', async () => {
        const { instance, store, caller, cookie } = await signedInHarness();

        const response = await postAs(instance, `/api/jobs/${ID}/retry`, cookie);

        expect(response.statusCode).toBe(201);
        expect(store.retries).toEqual([{ id: ID, createdBy: caller.user.id }]);
    });

    it('edit records the signed-in caller', async () => {
        const { instance, store, caller, cookie } = await signedInHarness();

        const response = await patchAs(instance, `/api/jobs/${ID}`, cookie, { command: 'now, tighter' });

        expect(response.statusCode).toBe(200);
        expect(store.edited).toEqual([{ id: ID, command: 'now, tighter', caller: caller.user.id }]);
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

    it('wait-cancel records the signed-in caller', async () => {
        const { instance, store, caller, cookie } = await signedInHarness();

        const response = await postAs(instance, `/api/jobs/${ID}/wait/cancel`, cookie);

        expect(response.statusCode).toBe(200);
        expect(store.cancelledWaits).toEqual([{ id: ID, cancelledBy: caller.user.id }]);
    });

    it('wait-poke records the signed-in caller', async () => {
        const { instance, store, caller, cookie } = await signedInHarness();

        const response = await postAs(instance, `/api/jobs/${ID}/wait/poke`, cookie);

        expect(response.statusCode).toBe(200);
        expect(store.pokes).toEqual([{ id: ID, pokedBy: caller.user.id }]);
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
        ['a checkout that is being deleted', 'purging', 'PURGE_IN_PROGRESS'],
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

describe('POST /api/jobs/:id/retry', () => {
    // Retry takes NOTHING from the body: the command is the thread head's, copied at insert, and
    // everything else about the run comes from the thread. A stale body is ignored, never read.
    it('queues a retry taking nothing from the body', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const response = await post(instance, `/api/jobs/${ID}/retry`, { command: 'ignored', executor: 'ignored' });

        expect(response.statusCode).toBe(201);
        expect(response.json()).toEqual({ id: RETRY_ID, status: 'queued' });
        expect(store.retries).toEqual([{ id: ID, createdBy: null }]);
    });

    // A retry is a person's action on a finished run: there is no lease token to present and
    // none would mean anything.
    it('takes no lease token', async () => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/retry`, {});
        expect(response.statusCode).toBe(201);
    });

    it('answers 404 for a task that does not exist', async () => {
        const instance = await harnessWith(stubStore({ retry: 'missing' }));
        const response = await post(instance, `/api/jobs/${ID}/retry`, {});
        expect(response.statusCode).toBe(404);
    });

    // Author-scoped like follow-up: the retry runs in the author's checkout tree.
    it('answers 403 for a task queued by another account', async () => {
        const instance = await harnessWith(stubStore({ retry: 'forbidden' }));
        const response = await post(instance, `/api/jobs/${ID}/retry`, {});
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('FORBIDDEN');
    });

    it.each([
        ['a task that is still moving', 'not_finished', 'NOT_FINISHED'],
        ['a task the user has marked done', 'task_done', 'TASK_DONE'],
        ['a checkout that is being deleted', 'purging', 'PURGE_IN_PROGRESS'],
    ])('answers 409 for %s', async (_label, verdict, code) => {
        const instance = await harnessWith(stubStore({ retry: verdict as RetryRefusal }));
        const response = await post(instance, `/api/jobs/${ID}/retry`, {});
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe(code);
    });

    it('answers 503 when the store is down, so the caller retries', async () => {
        const instance = await harnessWith(stubStore({ fail: true }));
        const response = await post(instance, `/api/jobs/${ID}/retry`, {});
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });

    it('refuses a malformed id before touching the store', async () => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, '/api/jobs/nope/retry', {});
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_ID');
    });
});

describe('PATCH /api/jobs/:id', () => {
    // The queued task's command is editable in place (issue #329): same id, same thread, no
    // stop-and-recreate. The store decides every refusal atomically with the write.
    it('edits a queued task\u2019s command', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const response = await patch(instance, `/api/jobs/${ID}`, { command: 'now run the fast tests' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: ID, status: 'queued', command: 'now run the fast tests' });
        expect(store.edited).toEqual([{ id: ID, command: 'now run the fast tests', caller: null }]);
    });

    it.each([
        ['a missing command', {}],
        ['an empty command', { command: '' }],
        ['whitespace only', { command: '   ' }],
        ['a non-string command', { command: 42 }],
        ['an oversized command', { command: 'x'.repeat(16_385) }],
    ])('refuses %s', async (_label, payload) => {
        const instance = await harnessWith(stubStore());
        const response = await patch(instance, `/api/jobs/${ID}`, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_COMMAND');
    });

    it('answers 404 for a task that does not exist', async () => {
        const instance = await harnessWith(stubStore({ edit: 'missing' }));
        expect((await patch(instance, `/api/jobs/${ID}`, { command: 'again' })).statusCode).toBe(404);
    });

    // Once claimed the command is the run's input — a moving task is not editable, and the
    // refusal names the status the store answered with.
    it('answers 409 NOT_QUEUED once claimed, naming its status', async () => {
        const instance = await harnessWith(stubStore({ edit: { result: 'not_queued', status: 'running' } }));
        const response = await patch(instance, `/api/jobs/${ID}`, { command: 'again' });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('NOT_QUEUED');
        expect(response.json().status).toBe('running');
    });

    // Author-scoped like the follow-up: the command would run in the author's checkout tree.
    it('answers 403 for a task queued by another account', async () => {
        const instance = await harnessWith(stubStore({ edit: 'forbidden' }));
        const response = await patch(instance, `/api/jobs/${ID}`, { command: 'again' });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('FORBIDDEN');
    });

    // A workflow row's command is the interpolated entry prompt — the raw chat line was never
    // stored, so there is nothing to edit from. Refused, not re-interpolated.
    it('answers 409 for a workflow row whose command a prompt built', async () => {
        const instance = await harnessWith(stubStore({ edit: 'workflow' }));
        const response = await patch(instance, `/api/jobs/${ID}`, { command: 'again' });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('WORKFLOW_COMMAND_FROZEN');
    });

    it('answers 503 when the store is down, so the caller retries', async () => {
        const instance = await harnessWith(stubStore({ fail: true }));
        const response = await patch(instance, `/api/jobs/${ID}`, { command: 'again' });
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });

    it('refuses a malformed id before touching the store', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const response = await patch(instance, '/api/jobs/nope', { command: 'again' });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_ID');
        expect(store.edited).toEqual([]);
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
            {
                id: ID,
                output: 'hello',
                contextTokens: null,
                contextCostUsd: null,
                agentTurns: null,
                summary: null,
                failureKind: null,
                treeChanged: null,
                evidence: null,
            },
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

    // The structured failure kind (issue #339): a known kind lands beside the verdict, an unknown
    // one is refused before the store can be told, and absent stores null.
    it('records the failure kind beside the verdict', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, {
            ...done,
            status: 'failed',
            failureKind: 'timeout',
        });
        expect(response.statusCode).toBe(200);
        expect(store.completed[0]).toMatchObject({ failureKind: 'timeout' });
    });

    // A dead `.bellows.yaml` service (issue #423): its own kind, so the workflow's gate-failed
    // edge never reads it as a gate the agent could fix.
    it('records the services failure kind', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, {
            ...done,
            status: 'failed',
            failureKind: 'services',
        });
        expect(response.statusCode).toBe(200);
        expect(store.completed[0]).toMatchObject({ failureKind: 'services' });
    });

    it('stores null when the report carries no failure kind', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, done);
        expect(response.statusCode).toBe(200);
        expect(store.completed[0]).toMatchObject({ failureKind: null });
    });

    it('records a blocked failure kind beside the verdict', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, {
            ...done,
            status: 'failed',
            failureKind: 'blocked',
        });
        expect(response.statusCode).toBe(200);
        expect(store.completed[0]).toMatchObject({ failureKind: 'blocked' });
    });

    // The driver's post-gate tree read: handed to the store's transition, null when absent.
    it.each([
        [true, true],
        [false, false],
        [null, null],
        [undefined, null],
    ])('hands the store treeChanged %s as %s', async (treeChanged, stored) => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, { ...done, treeChanged });
        expect(response.statusCode).toBe(200);
        expect(store.completed[0]).toMatchObject({ treeChanged: stored });
    });

    it.each([
        ['a string', 'yes'],
        ['a number', 0],
    ])('refuses treeChanged as %s with BAD_TREE_CHANGED', async (_label, treeChanged) => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, { ...done, treeChanged });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_TREE_CHANGED');
        expect(store.completed).toEqual([]);
    });

    it('hands the store the verdict’s evidence record, rebuilt field by field', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const evidence = { treeBefore: 'h:1', treeAfter: null, gates: 'passed' };
        const response = await post(instance, `/api/jobs/${ID}/complete`, {
            ...done,
            evidence: { ...evidence, extra: 'dropped' },
        });
        expect(response.statusCode).toBe(200);
        expect(store.completed[0]).toMatchObject({ evidence });
        expect(store.completed[0]?.evidence).not.toHaveProperty('extra');
    });

    it.each([
        ['a string', 'h:1'],
        ['an unknown gate outcome', { treeBefore: null, treeAfter: null, gates: 'maybe' }],
        ['an empty fingerprint', { treeBefore: '', treeAfter: null, gates: 'none' }],
        ['an oversized fingerprint', { treeBefore: 'x'.repeat(257), treeAfter: null, gates: 'none' }],
        ['a missing fingerprint', { treeAfter: null, gates: 'none' }],
    ])('refuses evidence as %s with BAD_EVIDENCE', async (_label, evidence) => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, { ...done, evidence });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_EVIDENCE');
        expect(store.completed).toEqual([]);
    });

    it('accepts the policy failure kind on a failed verdict', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'ok' }));
        const response = await post(instance, `/api/jobs/${ID}/complete`, {
            ...done,
            status: 'failed',
            failureKind: 'policy',
        });
        expect(response.statusCode).toBe(200);
    });

    it.each([
        ['an unknown failure kind', 'nope'],
        ['a non-string failure kind', 3],
    ])('refuses %s with BAD_FAILURE_KIND', async (_label, failureKind) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/complete`, { ...done, failureKind });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_FAILURE_KIND');
    });

    it.each(['blocked', 'gate', 'services'])('refuses status succeeded with failureKind %s', async (failureKind) => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, {
            ...done,
            status: 'succeeded',
            failureKind,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_FAILURE_KIND');
        expect(store.completed).toEqual([]);
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
        exitCode: 0,
        output: 'hello',
        failureKind: null,
        summary: null,
        repo: 'acme/web',
        executor: 'main',
        followUpTo: null,
        rootJobId: ID,
        workflowName: 'fix-issue',
        mode: WORKFLOW_MODE,
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

    it("serves the row's stored mode on the detail read and the thread read", async () => {
        const objective = { ...job, workflowName: null, mode: OBJECTIVE_MODE };
        const instance = await harnessWith(stubStore({ job: objective, thread: [objective] }));
        const one = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}` });
        expect(one.json().mode).toBe(OBJECTIVE_MODE);
        const thread = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}/thread` });
        expect(thread.json().jobs[0].mode).toBe(OBJECTIVE_MODE);
        const named = await harnessWith(stubStore({ job }));
        const detail = await named.inject({ method: 'GET', url: `/api/jobs/${ID}` });
        expect(detail.json().mode).toBe(WORKFLOW_MODE);
    });

    it('exposes the frozen workflow name on the detail, thread and list payloads — and null without one', async () => {
        const instance = await harnessWith(stubStore({ job, thread: [job] }));

        const one = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}` });
        expect(one.json().workflowName).toBe('fix-issue');
        const thread = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}/thread` });
        expect(thread.json().jobs[0].workflowName).toBe('fix-issue');
        const list = await instance.inject({ method: 'GET', url: '/api/jobs' });
        expect(list.json().jobs[0].workflowName).toBe('fix-issue');

        const workflowLess = { ...job, workflowName: null };
        const plain = await harnessWith(stubStore({ job: workflowLess }));
        expect((await plain.inject({ method: 'GET', url: `/api/jobs/${ID}` })).json().workflowName).toBeNull();
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

describe('GET /api/jobs/:id?waitFor=terminal — the settle long-poll (issue #323)', () => {
    // A moving run: the shape the long-poll is asked to watch.
    const job: Job = {
        id: ID,
        command: 'echo hi',
        status: 'running',
        attempts: 1,
        maxAttempts: 3,
        claimedBy: 'w1',
        createdBy: null,
        author: null,
        stoppedBy: null,
        doneBy: null,
        sessionId: null,
        exitCode: null,
        output: null,
        failureKind: null,
        summary: null,
        gates: null,
        runtime: null,
        repo: null,
        executor: null,
        followUpTo: null,
        rootJobId: ID,
        workflowName: null,
        mode: OBJECTIVE_MODE,
        workflowNode: null,
        waitReason: null,
        waitingSince: null,
        waitTerminalReason: null,
        doneAt: null,
        cancelRequestedAt: null,
        workspacePath: null,
        createdAt: '2026-08-21T12:00:00.000Z',
        startedAt: '2026-08-21T12:00:01.000Z',
        finishedAt: null,
        wallClockMs: null,
        taskWallClockMs: null,
    };

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    it('refuses a waitFor value other than terminal', async () => {
        const store = stubStore({ job });
        const instance = await harnessWith(store);
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}?waitFor=finished` });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_WAIT_FOR');
        expect(store.waits).toEqual([]);
    });

    it.each([
        ['a non-numeric timeout', 'timeout=soon'],
        ['a zero timeout', 'timeout=0'],
        ['a negative timeout', 'timeout=-1'],
        ['a fractional timeout', 'timeout=1.5'],
        ['an empty timeout', 'timeout='],
        ['a space-prefixed timeout', 'timeout=%205'],
        ['a repeated timeout', 'timeout=1&timeout=2'],
    ])('refuses %s', async (_label, query) => {
        const store = stubStore({ job });
        const instance = await harnessWith(store);
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}?waitFor=terminal&${query}` });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_TIMEOUT');
        expect(store.waits).toEqual([]);
    });

    it('refuses a timeout without waitFor', async () => {
        const store = stubStore({ job });
        const instance = await harnessWith(store);
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}?timeout=5` });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_TIMEOUT');
        expect(store.waits).toEqual([]);
    });

    it('defaults the timeout and clamps it to the server-side cap', () => {
        expect(validateWaitQuery({})).toEqual({ ok: true, value: null });
        expect(validateWaitQuery({ waitFor: 'terminal' })).toEqual({ ok: true, value: { timeoutMs: 30_000 } });
        expect(validateWaitQuery({ waitFor: 'terminal', timeout: '5' })).toEqual({
            ok: true,
            value: { timeoutMs: 5_000 },
        });
        // Over the cap is clamped, not refused — the client asked for "as long as you allow";
        // a digit string past Number.MAX_SAFE_INTEGER clamps the same way rather than NaN-ing.
        expect(validateWaitQuery({ waitFor: 'terminal', timeout: '120' })).toEqual({
            ok: true,
            value: { timeoutMs: 60_000 },
        });
        expect(validateWaitQuery({ waitFor: 'terminal', timeout: '99999999999999999999' })).toEqual({
            ok: true,
            value: { timeoutMs: 60_000 },
        });
    });

    it('answers the job when the thread is already settled', async () => {
        const store = stubStore({ job });
        const instance = await harnessWith(store);
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}?waitFor=terminal` });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(job);
        expect(store.waits).toEqual([{ id: ID, timeoutMs: 30_000 }]);
    });

    it('holds until the store settles', async () => {
        // A deferred, not a wall-clock sleep: a timer may fire a millisecond early by Date.now().
        let settle = (): void => undefined;
        const store = stubStore({
            job,
            waitFor: () =>
                new Promise((resolve) => {
                    settle = () => resolve({ settled: true });
                }),
        });
        const instance = await harnessWith(store);
        let answered = false;
        const pending = instance
            .inject({ method: 'GET', url: `/api/jobs/${ID}?waitFor=terminal&timeout=5` })
            .finally(() => {
                answered = true;
            });
        await vi.waitFor(() => expect(store.waits).toEqual([{ id: ID, timeoutMs: 5_000 }]));
        await sleep(50);
        expect(answered).toBe(false);
        settle();
        const response = await pending;
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(job);
    });

    it('answers the current job when the timeout elapses unsettled', async () => {
        const store = stubStore({
            job,
            waitFor: async (_id, timeoutMs) => {
                await sleep(timeoutMs);
                return { settled: false };
            },
        });
        const instance = await harnessWith(store);
        const started = Date.now();
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}?waitFor=terminal&timeout=1` });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(job);
        expect(Date.now() - started).toBeGreaterThanOrEqual(950);
        expect(store.waits).toEqual([{ id: ID, timeoutMs: 1_000 }]);
    });

    it('answers 404 for an unknown job without holding', async () => {
        const store = stubStore({ job: null });
        const instance = await harnessWith(store);
        const started = Date.now();
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}?waitFor=terminal&timeout=30` });
        expect(response.statusCode).toBe(404);
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    // The hold's null is its own answer — the wait ran and the org holds no such job — mapped to
    // the same 404 an unknown id on the plain read gets, after the hold, not instead of it.
    it('maps a null from the wait itself to 404, after holding', async () => {
        const store = stubStore({ job, waitFor: async () => null });
        const instance = await harnessWith(store);
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}?waitFor=terminal` });
        expect(response.statusCode).toBe(404);
        expect(store.waits).toEqual([{ id: ID, timeoutMs: 30_000 }]);
    });

    it('answers 503 when the wait itself fails, so the caller retries', async () => {
        const store = stubStore({ fail: true, job });
        const instance = await harnessWith(store);
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}?waitFor=terminal&timeout=5` });
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });

    it('without wait parameters the read is unchanged', async () => {
        const store = stubStore({ job });
        const instance = await harnessWith(store);
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}` });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(job);
        expect(store.waits).toEqual([]);
    });
});

describe('GET /api/jobs/:id/activity — the run-activity read (issue #339)', () => {
    // A started, session-bearing run — the shape the chart can draw is in. The fields the route
    // reads are the started/finished stamps and the session id; the rest rides along for type.
    const runJob: Job = {
        id: ID,
        command: 'echo hi',
        status: 'failed',
        attempts: 1,
        maxAttempts: 3,
        claimedBy: 'w1',
        createdBy: null,
        author: null,
        stoppedBy: null,
        doneBy: null,
        sessionId: '33333333-3333-4333-8333-333333333333',
        exitCode: null,
        output: 'killed after 7200000ms',
        summary: null,
        failureKind: 'timeout',
        repo: 'acme/web',
        executor: 'main',
        followUpTo: null,
        rootJobId: ID,
        workflowNode: null,
        workflowName: null,
        mode: OBJECTIVE_MODE,
        gates: null,
        runtime: null,
        doneAt: null,
        cancelRequestedAt: null,
        workspacePath: null,
        createdAt: '2026-09-22T20:46:16.000Z',
        startedAt: '2026-09-22T20:46:16.000Z',
        finishedAt: '2026-09-22T22:46:16.000Z',
        wallClockMs: null,
        taskWallClockMs: null,
    };

    it('answers the telemetry buckets over the run window', async () => {
        const telemetry = stubTelemetryClient({
            runActivity: () => [{ start: '2026-09-22T21:00:00.000Z', tokens: 2_500_000, edits: 3 }],
        });
        const instance = await harnessWith(stubStore({ job: runJob }), undefined, telemetry);

        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}/activity` });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            jobId: ID,
            sessionId: runJob.sessionId,
            from: runJob.startedAt,
            to: runJob.finishedAt,
            bucketMs: 900_000,
            buckets: [{ start: '2026-09-22T21:00:00.000Z', tokens: 2_500_000, edits: 3 }],
        });
    });

    it('answers empty for a job that never started or never named a session', async () => {
        const telemetry = stubTelemetryClient();
        const instance = await harnessWith(stubStore({ job: { ...runJob, sessionId: null } }), undefined, telemetry);
        const noSession = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}/activity` });
        expect(noSession.statusCode).toBe(200);
        expect(noSession.json()).toEqual({
            jobId: ID,
            sessionId: null,
            from: null,
            to: null,
            bucketMs: null,
            buckets: [],
        });
        expect(telemetry.activityCalls).toEqual([]);

        const neverStarted = await harnessWith(
            stubStore({ job: { ...runJob, startedAt: null } }),
            undefined,
            stubTelemetryClient()
        ).then((app) => app.inject({ method: 'GET', url: `/api/jobs/${ID}/activity` }));
        expect(neverStarted.json().buckets).toEqual([]);
    });

    it('answers 404 for an unknown job and BAD_ID for a malformed one', async () => {
        const missing = await harnessWith(stubStore({ job: null }));
        expect((await missing.inject({ method: 'GET', url: `/api/jobs/${ID}/activity` })).statusCode).toBe(404);

        const instance = await harnessWith(stubStore());
        const response = await instance.inject({ method: 'GET', url: '/api/jobs/nope/activity' });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_ID');
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

const ASK = {
    leaseToken: TOKEN,
    questionId: 'toolu_01AbC-9_z',
    questions: [
        {
            question: 'Which database?',
            header: 'Database',
            multiSelect: false,
            options: [{ label: 'Postgres', description: 'The default' }, { label: 'SQLite' }],
        },
    ],
};
const QUESTION_URL = `/api/jobs/${ID}/question`;
const EXPIRE_URL = `/api/jobs/${ID}/question-expire`;
const ANSWER_URL = `/api/jobs/${ID}/questions/${ASK.questionId}/answer`;

describe('heartbeat answeredQuestions (050)', () => {
    it('is always present, empty when nothing is answered', async () => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/heartbeat`, { leaseToken: TOKEN });
        expect(response.json().answeredQuestions).toEqual([]);
    });

    it('carries the answered questions the store lists', async () => {
        const answered = [{ questionId: 'toolu_01', answers: { 'Which database?': 'Postgres' } }];
        const instance = await harnessWith(stubStore({ answeredQuestions: answered }));
        const response = await post(instance, `/api/jobs/${ID}/heartbeat`, { leaseToken: TOKEN });
        expect(response.json().answeredQuestions).toEqual(answered);
    });
});

describe('POST /api/jobs/:id/question', () => {
    it('stores a new question with 201 and an existing one with 200', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const created = await post(instance, QUESTION_URL, ASK);
        expect(created.statusCode).toBe(201);
        expect(created.json().id).toBe(QUESTION.id);

        const again = await harnessWith(stubStore({ ask: { result: 'existing', question: QUESTION } }));
        const existing = await post(again, QUESTION_URL, ASK);
        expect(existing.statusCode).toBe(200);
    });

    it('drops unknown keys before the store sees them', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const noisy = {
            ...ASK,
            extra: 1,
            questions: [{ ...ASK.questions[0], extra: 'x', options: [{ label: 'A', extra: 1 }, { label: 'B' }] }],
        };
        await post(instance, QUESTION_URL, noisy);
        expect(store.asked[0]!.questions[0]).toEqual({
            question: 'Which database?',
            header: 'Database',
            multiSelect: false,
            options: [{ label: 'A' }, { label: 'B' }],
        });
    });

    const q = (patch: Record<string, unknown>) => ({ ...ASK.questions[0], ...patch });
    it.each([
        ['an empty questionId', { questionId: '' }],
        ['a questionId with a bad character', { questionId: 'a b' }],
        ['a questionId over 128 characters', { questionId: 'a'.repeat(129) }],
        ['no questions', { questions: [] }],
        ['five questions', { questions: [1, 2, 3, 4, 5].map((n) => q({ question: `Q${n}` })) }],
        ['a blank question', { questions: [q({ question: '  ' })] }],
        ['a question over 1000 characters', { questions: [q({ question: 'x'.repeat(1001) })] }],
        ['a blank header', { questions: [q({ header: '' })] }],
        ['a header over 100 characters', { questions: [q({ header: 'h'.repeat(101) })] }],
        ['a non-boolean multiSelect', { questions: [q({ multiSelect: 'no' })] }],
        ['one option', { questions: [q({ options: [{ label: 'A' }] })] }],
        ['five options', { questions: [q({ options: [1, 2, 3, 4, 5].map((n) => ({ label: `L${n}` })) })] }],
        ['a blank label', { questions: [q({ options: [{ label: '' }, { label: 'B' }] })] }],
        ['a label over 200 characters', { questions: [q({ options: [{ label: 'l'.repeat(201) }, { label: 'B' }] })] }],
        [
            'a description over 1000 characters',
            { questions: [q({ options: [{ label: 'A', description: 'd'.repeat(1001) }, { label: 'B' }] })] },
        ],
        ['repeated question texts', { questions: [q({}), q({})] }],
    ])('refuses %s with 400 INVALID_QUESTION', async (_label, patch) => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const response = await post(instance, QUESTION_URL, { ...ASK, ...patch });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('INVALID_QUESTION');
        expect(store.asked).toEqual([]);
    });

    it('refuses a body over 64 KiB', async () => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, QUESTION_URL, {
            ...ASK,
            questions: [q({ question: 'x'.repeat(70_000) })],
        });
        expect(response.statusCode).toBe(413);
    });

    it('refuses a bad lease token', async () => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, QUESTION_URL, { ...ASK, leaseToken: 'nope' });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_TOKEN');
    });

    it.each([
        ['lost', 409, 'LEASE_LOST'],
        ['missing', 404, 'NOT_FOUND'],
        ['limit', 429, 'QUESTION_LIMIT'],
    ] as const)('maps the store verdict %s to %i', async (result, status, code) => {
        const instance = await harnessWith(stubStore({ ask: { result } }));
        const response = await post(instance, QUESTION_URL, ASK);
        expect(response.statusCode).toBe(status);
        expect(response.json().code).toBe(code);
    });
});

describe('POST /api/jobs/:id/question-expire', () => {
    const body = { leaseToken: TOKEN, questionId: ASK.questionId };

    it('answers expired', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const response = await post(instance, EXPIRE_URL, body);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ state: 'expired' });
        expect(store.expired).toEqual([{ id: ID, questionId: ASK.questionId }]);
    });

    it('answers the stored answers when the question was answered first', async () => {
        const answers = { 'Which database?': 'Postgres' };
        const instance = await harnessWith(stubStore({ expire: { result: 'answered', answers } }));
        const response = await post(instance, EXPIRE_URL, body);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ state: 'answered', answers });
    });

    it.each([
        ['lost', 409, 'LEASE_LOST'],
        ['missing', 404, 'NOT_FOUND'],
        ['unknown', 404, 'NOT_FOUND'],
    ] as const)('maps the store verdict %s to %i', async (result, status, code) => {
        const instance = await harnessWith(stubStore({ expire: { result } }));
        const response = await post(instance, EXPIRE_URL, body);
        expect(response.statusCode).toBe(status);
        expect(response.json().code).toBe(code);
    });

    it('refuses a bad lease token and a bad questionId', async () => {
        const instance = await harnessWith(stubStore());
        expect((await post(instance, EXPIRE_URL, { ...body, leaseToken: 'nope' })).json().code).toBe('BAD_TOKEN');
        const response = await post(instance, EXPIRE_URL, { ...body, questionId: 'a b' });
        expect(response.json().code).toBe('INVALID_QUESTION');
    });
});

const REVIEW_REQUEST = {
    leaseToken: TOKEN,
    key: 'security-1',
    profile: 'security',
    revision: 'abc:def',
    ref: `refs/factory/review/${ID}/security-1`,
};
const REVIEW_URL = `/api/jobs/${ID}/review`;
const REVIEW_READ_URL = `/api/jobs/${ID}/review-read`;

describe('POST /api/jobs/:id/review (issue #549)', () => {
    it('creates a review with 201, answers the stored one with 200, and passes only the named fields', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const created = await post(instance, REVIEW_URL, { ...REVIEW_REQUEST, extra: 'dropped' });
        expect(created.statusCode).toBe(201);
        expect(created.json().key).toBe('security-1');
        const { leaseToken: _lease, ...request } = REVIEW_REQUEST;
        expect(store.reviewRequests).toEqual([{ id: ID, request }]);

        const again = await harnessWith(stubStore({ reviewRequest: { result: 'existing', review: REVIEW } }));
        expect((await post(again, REVIEW_URL, REVIEW_REQUEST)).statusCode).toBe(200);
    });

    it.each([
        ['an empty key', { key: '' }],
        ['a key with a bad character', { key: 'a b' }],
        ['a key over 64 characters', { key: 'k'.repeat(65) }],
        ['an upper-case profile', { profile: 'Security' }],
        ['a missing profile', { profile: undefined }],
        ['an empty revision', { revision: '' }],
        ['a revision over 256 characters', { revision: 'r'.repeat(257) }],
        ['an empty ref', { ref: '' }],
    ])('refuses %s with 400 INVALID_REVIEW', async (_label, patch) => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const response = await post(instance, REVIEW_URL, { ...REVIEW_REQUEST, ...patch });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('INVALID_REVIEW');
        expect(store.reviewRequests).toEqual([]);
    });

    it('refuses a bad lease token before the store is asked', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const response = await post(instance, REVIEW_URL, { ...REVIEW_REQUEST, leaseToken: 'nope' });
        expect(response.statusCode).toBe(400);
        expect(store.reviewRequests).toEqual([]);
    });

    it.each([
        ['missing', 404, 'NOT_FOUND'],
        ['lost', 409, 'LEASE_LOST'],
        ['unsupported', 409, 'REVIEW_UNSUPPORTED'],
        ['unknown_profile', 409, 'UNKNOWN_REVIEWER'],
        ['invalid_ref', 400, 'INVALID_REVIEW'],
    ] as const)('maps the store verdict %s to %i %s', async (result, status, code) => {
        const instance = await harnessWith(stubStore({ reviewRequest: { result } }));
        const response = await post(instance, REVIEW_URL, REVIEW_REQUEST);
        expect(response.statusCode).toBe(status);
        expect(response.json().code).toBe(code);
    });
});

describe('POST /api/jobs/:id/review-read (issue #549)', () => {
    it('answers the review with the thread’s review evidence', async () => {
        const store = stubStore({
            reviewRead: { result: 'ok', review: { ...REVIEW, evidence: { state: 'missing' } } },
        });
        const instance = await harnessWith(store);
        const response = await post(instance, REVIEW_READ_URL, { leaseToken: TOKEN, key: 'security-1' });
        expect(response.statusCode).toBe(200);
        expect(response.json().evidence).toEqual({ state: 'missing' });
        expect(store.reviewReads).toEqual([{ id: ID, key: 'security-1' }]);
    });

    it.each([
        ['unknown', 404, 'REVIEW_NOT_FOUND'],
        ['missing', 404, 'NOT_FOUND'],
        ['lost', 409, 'LEASE_LOST'],
    ] as const)('maps the store verdict %s to %i %s', async (result, status, code) => {
        const instance = await harnessWith(stubStore({ reviewRead: { result } }));
        const response = await post(instance, REVIEW_READ_URL, { leaseToken: TOKEN, key: 'security-1' });
        expect(response.statusCode).toBe(status);
        expect(response.json().code).toBe(code);
    });

    it('refuses a bad key', async () => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, REVIEW_READ_URL, { leaseToken: TOKEN, key: 'a b' });
        expect(response.statusCode).toBe(400);
    });
});

describe('POST /api/jobs/:id/questions/:questionId/answer', () => {
    const answers = { 'Which database?': '  Postgres  ' };

    it('lands the answer trimmed and answers the question', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const response = await post(instance, ANSWER_URL, { answers });
        expect(response.statusCode).toBe(200);
        expect(response.json().id).toBe(QUESTION.id);
        expect(store.answered).toEqual([
            { id: ID, questionId: ASK.questionId, answers: { 'Which database?': 'Postgres' }, answeredBy: null },
        ]);
    });

    it.each([
        ['no answers', {}],
        ['an array', { answers: ['Postgres'] }],
        ['a non-string value', { answers: { 'Which database?': 3 } }],
        ['a blank value', { answers: { 'Which database?': '   ' } }],
        ['a value over 2000 characters', { answers: { 'Which database?': 'a'.repeat(2001) } }],
    ])('refuses %s with 400 INVALID_ANSWER', async (_label, payload) => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const response = await post(instance, ANSWER_URL, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('INVALID_ANSWER');
        expect(store.answered).toEqual([]);
    });

    it('refuses a key set the store rejects with 400 INVALID_ANSWER', async () => {
        const instance = await harnessWith(stubStore({ answer: { result: 'invalid', message: 'wrong keys' } }));
        const response = await post(instance, ANSWER_URL, { answers });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ code: 'INVALID_ANSWER', error: 'wrong keys' });
    });

    it('answers 409 QUESTION_ANSWERED carrying the stored answer and answerer', async () => {
        const answeredBy = { id: 'u1', login: 'ada', name: null, avatarUrl: null };
        const stored = {
            ...QUESTION,
            status: 'answered' as const,
            answers: { 'Which database?': 'SQLite' },
            answeredBy,
        };
        const instance = await harnessWith(
            stubStore({ answer: { result: 'refused', reason: 'answered', question: stored } })
        );
        const response = await post(instance, ANSWER_URL, { answers });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
            code: 'QUESTION_ANSWERED',
            answers: { 'Which database?': 'SQLite' },
            answeredBy,
        });
    });

    it.each([
        ['expired', 'QUESTION_EXPIRED'],
        ['closed', 'QUESTION_CLOSED'],
    ] as const)('answers 409 for a %s question', async (reason, code) => {
        const instance = await harnessWith(stubStore({ answer: { result: 'refused', reason } }));
        const response = await post(instance, ANSWER_URL, { answers });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe(code);
    });

    it('answers 404 for an unknown question and for a malformed id', async () => {
        const instance = await harnessWith(stubStore({ answer: { result: 'unknown' } }));
        expect((await post(instance, ANSWER_URL, { answers })).statusCode).toBe(404);
        expect((await post(instance, `/api/jobs/${ID}/questions/a%20b/answer`, { answers })).statusCode).toBe(404);
    });
});
