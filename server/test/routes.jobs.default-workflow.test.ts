import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type {
    DefaultWorkflowSettings,
    DefaultWorkflowSettingsStore,
} from '../src/db/default-workflow-settings-store.js';
import { compileDefaultWorkflow, DEFAULT_ENTRY_NODE, DEFAULT_WORKFLOW_NAME } from '../src/db/default-workflow.js';
import type { JobStore } from '../src/db/job-store-types.js';
import type { WorkflowRecord, WorkflowStore } from '../src/db/workflow-store.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryUserExecutorStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
} from './helpers.js';

/**
 * The HTTP contract of the launch-time default-workflow resolution (issue #209): the three
 * `defaultWorkflow`/`workflow` combinations `POST /api/jobs` must honor, and every refusal's
 * no-row guarantee. `default-workflow.test.ts` covers the assembler itself in isolation;
 * `job-store.workflow.default.test.ts` covers the frozen row against a real database.
 */

const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVICE_UNAVAILABLE = 503;

const BOTH_ENABLED: DefaultWorkflowSettings = {
    reviewReconciliation: true,
    mergeConflictAutofix: true,
    updatedAt: null,
};

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

interface TargetRecord {
    id: string | null;
    name: string;
    node: string;
    snapshot: unknown;
    params: unknown;
    defaultOptions?: { reviewReconciliation: boolean; mergeConflictAutofix: boolean; gateFixRounds: number };
}

/** Records exactly what `store.create` was handed — the HTTP contract's own concern, not the SQL. */
function stubJobs(options: { fail?: boolean } = {}): JobStore & { created: TargetRecord[]; commands: string[] } {
    const created: TargetRecord[] = [];
    const commands: string[] = [];
    return {
        async create(command, _createdBy, target) {
            if (options.fail) throw new Error('database is down');
            commands.push(command);
            if (target?.workflow) created.push(target.workflow as TargetRecord);
            return { id: '11111111-1111-4111-8111-111111111111' };
        },
        created,
        commands,
    } as unknown as JobStore & { created: TargetRecord[]; commands: string[] };
}

/** A named-workflow store double that must never be read on the default (unnamed) path. */
function stubWorkflows(): WorkflowStore & { findByNameCalls: string[] } {
    const findByNameCalls: string[] = [];
    const record: WorkflowRecord = {
        id: 'wf-1',
        name: 'fix-issue',
        scope: 'org',
        userId: null,
        repo: null,
        params: [],
        createdAt: '2026-09-22T00:00:00.000Z',
        updatedAt: '2026-09-22T00:00:00.000Z',
        definition: {
            entry: 'a',
            params: [],
            nodes: [{ name: 'a', kind: 'agent', session: 'resume', prompt: 'x' }],
            edges: [],
        },
    };
    return {
        findByNameCalls,
        async findByName(name: string) {
            findByNameCalls.push(name);
            return record;
        },
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
        async seedBase() {},
    } as unknown as WorkflowStore & { findByNameCalls: string[] };
}

function stubSettings(saved?: { reviewReconciliation: boolean; mergeConflictAutofix: boolean }): {
    store: DefaultWorkflowSettingsStore;
    getCalls: string[];
} {
    const getCalls: string[] = [];
    return {
        getCalls,
        store: {
            async get(userId) {
                getCalls.push(userId);
                return saved ? { ...saved, updatedAt: '2026-09-22T00:00:00.000Z' } : BOTH_ENABLED;
            },
            async put() {
                throw new Error('not exercised');
            },
        },
    };
}

/**
 * `signedIn: false` (the default) builds the app with NO auth at all — no hook, no session —
 * `callerOf(request)` then answers null and `createdBy` is null, exactly the open/route-test mode
 * every other unnamed-task test in this file exercises. `signedIn: true` builds with github auth
 * instead, so a real caller id is what the settings-store tests key their `get(userId)` calls by.
 */
async function boot(opts: {
    jobs: JobStore;
    workflows?: WorkflowStore;
    workflowDefaults?: DefaultWorkflowSettingsStore;
    signedIn?: boolean;
    userExecutors?: ReturnType<typeof memoryUserExecutorStore>;
}) {
    const registryParts = {
        jobs: opts.jobs,
        workflows: opts.workflows,
        workflowDefaults: opts.workflowDefaults,
        userExecutors: opts.userExecutors,
        telemetry: stubTelemetryClient(),
    };
    if (!opts.signedIn) {
        const config = testConfig();
        const instance = await buildApp({ config, orgs: staticRegistry({ config, ...registryParts }) });
        app = instance;
        return { instance, cookie: undefined };
    }
    const auth = memoryAuthStore();
    const alice = auth.seedMember('test-org', 'alice');
    const config = testConfig({ auth: githubAuth() });
    const instance = await buildApp({ config, orgs: staticRegistry({ config, ...registryParts }), auth });
    app = instance;
    return { instance, cookie: await signedIn(auth, alice) };
}

const post = (instance: FastifyInstance, payload: unknown, cookie?: string) =>
    instance.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: payload as object,
        headers: cookie ? { cookie } : {},
    });

describe('POST /api/jobs — the default workflow launch contract (issue #209)', () => {
    it('unnamed, no caller: both steps on, the settings store is never read', async () => {
        const jobs = stubJobs();
        const workflows = stubWorkflows();
        const { getCalls } = stubSettings();
        const { instance } = await boot({ jobs, workflows, signedIn: false });

        const response = await post(instance, { command: 'echo hi' });

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(workflows.findByNameCalls).toEqual([]);
        expect(getCalls).toEqual([]);
        expect(jobs.created).toEqual([
            {
                id: null,
                name: DEFAULT_WORKFLOW_NAME,
                node: DEFAULT_ENTRY_NODE,
                snapshot: compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: true }, 3),
                params: {},
                defaultOptions: { reviewReconciliation: true, mergeConflictAutofix: true, gateFixRounds: 3 },
            },
        ]);
        expect(jobs.commands).toEqual(['echo hi']);
    });

    it('an arbitrary prompt and a skill invocation both queue verbatim as the default entry', async () => {
        for (const command of ['Please refactor the widget loader.', '/fix 209']) {
            const jobs = stubJobs();
            const { instance } = await boot({ jobs, signedIn: false });
            const response = await post(instance, { command });
            expect(response.statusCode).toBe(HTTP_CREATED);
            expect(jobs.commands).toEqual([command]);
        }
    });

    it('signed in, saved settings {false, true}: one get(userId) call, matching pair and snapshot', async () => {
        const jobs = stubJobs();
        const { store: workflowDefaults, getCalls } = stubSettings({
            reviewReconciliation: false,
            mergeConflictAutofix: true,
        });
        const { instance, cookie } = await boot({ jobs, workflowDefaults, signedIn: true });

        const response = await post(instance, { command: 'echo hi' }, cookie);

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(getCalls).toHaveLength(1);
        expect(jobs.created[0]!.defaultOptions).toEqual({
            reviewReconciliation: false,
            mergeConflictAutofix: true,
            gateFixRounds: 3,
        });
        expect(jobs.created[0]!.snapshot).toEqual(
            compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: true }, 3)
        );
    });

    it('a missing settings row answers BOTH_ENABLED — both steps on', async () => {
        const jobs = stubJobs();
        const { store: workflowDefaults } = stubSettings(undefined);
        const { instance, cookie } = await boot({ jobs, workflowDefaults, signedIn: true });

        const response = await post(instance, { command: 'echo hi' }, cookie);

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(jobs.created[0]!.defaultOptions).toEqual({
            reviewReconciliation: true,
            mergeConflictAutofix: true,
            gateFixRounds: 3,
        });
    });

    it.each([
        [
            { reviewReconciliation: false, mergeConflictAutofix: false },
            { reviewReconciliation: true, mergeConflictAutofix: true },
        ],
        [
            { reviewReconciliation: true, mergeConflictAutofix: true },
            { reviewReconciliation: false, mergeConflictAutofix: false },
        ],
    ])('a per-task override %o inverts the saved setting %o, and the store is not read', async (override, saved) => {
        const jobs = stubJobs();
        const { store: workflowDefaults, getCalls } = stubSettings(saved);
        const { instance, cookie } = await boot({ jobs, workflowDefaults, signedIn: true });

        const response = await post(instance, { command: 'echo hi', defaultWorkflow: override }, cookie);

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(getCalls).toEqual([]);
        expect(jobs.created[0]!.defaultOptions).toEqual({ ...override, gateFixRounds: 3 });
    });

    it("workflow: null alongside a valid override uses the default path (the composer's own shape)", async () => {
        const jobs = stubJobs();
        const { instance, cookie } = await boot({ jobs, signedIn: true });

        const response = await post(
            instance,
            {
                command: 'echo hi',
                workflow: null,
                defaultWorkflow: { reviewReconciliation: false, mergeConflictAutofix: true },
            },
            cookie
        );

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(jobs.created[0]!.defaultOptions).toEqual({
            reviewReconciliation: false,
            mergeConflictAutofix: true,
            gateFixRounds: 3,
        });
    });

    it('an explicit workflow plus a valid override refuses BAD_DEFAULT_WORKFLOW, never resolving the name', async () => {
        const jobs = stubJobs();
        const workflows = stubWorkflows();
        const { instance, cookie } = await boot({ jobs, workflows, signedIn: true });

        const response = await post(
            instance,
            {
                command: 'fix it',
                workflow: 'fix-issue',
                defaultWorkflow: { reviewReconciliation: true, mergeConflictAutofix: true },
            },
            cookie
        );

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_DEFAULT_WORKFLOW');
        expect(workflows.findByNameCalls).toEqual([]);
        expect(jobs.created).toEqual([]);
    });

    it('an explicit workflow plus a MALFORMED override still refuses BAD_DEFAULT_WORKFLOW before resolving the name', async () => {
        const jobs = stubJobs();
        const workflows = stubWorkflows();
        const { instance, cookie } = await boot({ jobs, workflows, signedIn: true });

        const response = await post(
            instance,
            { command: 'fix it', workflow: 'fix-issue', defaultWorkflow: { reviewReconciliation: true } },
            cookie
        );

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_DEFAULT_WORKFLOW');
        expect(workflows.findByNameCalls).toEqual([]);
        expect(jobs.created).toEqual([]);
    });

    it.each([
        ['an empty object', {}],
        ['one key only', { reviewReconciliation: true }],
        ['an extra unknown key', { reviewReconciliation: true, mergeConflictAutofix: true, extra: 1 }],
        ['a non-boolean value', { reviewReconciliation: 'yes', mergeConflictAutofix: true }],
        ['a null field', { reviewReconciliation: null, mergeConflictAutofix: true }],
        ['an array', []],
        ['a string', 'both'],
        ['a boolean', true],
        ['a number', 42],
    ])(
        'refuses a malformed defaultWorkflow (%s) with 400 BAD_DEFAULT_WORKFLOW, and queues nothing',
        async (_label, bad) => {
            const jobs = stubJobs();
            const { instance, cookie } = await boot({ jobs, signedIn: true });

            const response = await post(instance, { command: 'echo hi', defaultWorkflow: bad }, cookie);

            expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
            expect(response.json().code).toBe('BAD_DEFAULT_WORKFLOW');
            expect(jobs.created).toEqual([]);
        }
    );

    it('refuses workflowParams sent on the default path with 400 BAD_WORKFLOW_PARAMS, and queues nothing', async () => {
        const jobs = stubJobs();
        const { instance, cookie } = await boot({ jobs, signedIn: true });

        const response = await post(instance, { command: 'echo hi', workflowParams: { issue: '#1' } }, cookie);

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_WORKFLOW_PARAMS');
        expect(jobs.created).toEqual([]);
    });

    it('answers 503 when the settings store throws, and queues nothing', async () => {
        const jobs = stubJobs();
        const workflowDefaults: DefaultWorkflowSettingsStore = {
            async get() {
                throw new Error('database is down');
            },
            async put() {
                throw new Error('not exercised');
            },
        };
        const { instance, cookie } = await boot({ jobs, workflowDefaults, signedIn: true });

        const response = await post(instance, { command: 'echo hi' }, cookie);

        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(jobs.created).toEqual([]);
    });

    it('an explicit workflow alone carries no defaultOptions, and the settings store is never read', async () => {
        const jobs = stubJobs();
        const workflows = stubWorkflows();
        const { store: workflowDefaults, getCalls } = stubSettings();
        const { instance, cookie } = await boot({ jobs, workflows, workflowDefaults, signedIn: true });

        const response = await post(instance, { command: 'fix it', workflow: 'fix-issue' }, cookie);

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(getCalls).toEqual([]);
        expect(jobs.created[0]).not.toHaveProperty('defaultOptions');
    });

    it.each([
        [{ reviewReconciliation: false, mergeConflictAutofix: false }],
        [{ reviewReconciliation: true, mergeConflictAutofix: false }],
        [{ reviewReconciliation: false, mergeConflictAutofix: true }],
        [{ reviewReconciliation: true, mergeConflictAutofix: true }],
    ])('preflight request, stored selected pair and expanded snapshot agree for %o', async (pair) => {
        const jobs = stubJobs();
        const { instance, cookie } = await boot({ jobs, signedIn: true });

        const response = await post(instance, { command: 'echo hi', defaultWorkflow: pair }, cookie);

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(jobs.created[0]!.defaultOptions).toEqual({ ...pair, gateFixRounds: 3 });
        expect(jobs.created[0]!.snapshot).toEqual(compileDefaultWorkflow(pair, 3));
    });
});

describe('POST /api/jobs — the gate-repair round limit (issue #49)', () => {
    /** Seeds an executor store with one row under the signed-in caller, returning it and the app. */
    async function bootWithExecutor(row: { gateFixRounds?: number; name?: string } | null) {
        const jobs = stubJobs();
        const executors = memoryUserExecutorStore();
        const auth = memoryAuthStore();
        const alice = auth.seedMember('test-org', 'alice');
        if (row) {
            await executors.replace(alice.user.id, [
                {
                    name: row.name ?? 'main',
                    type: 'claude-code',
                    config: {},
                    ...(row.gateFixRounds !== undefined ? { gateFixRounds: row.gateFixRounds } : {}),
                },
            ]);
        }
        const config = testConfig({ auth: githubAuth() });
        const instance = await buildApp({
            config,
            orgs: staticRegistry({ config, jobs, userExecutors: executors, telemetry: stubTelemetryClient() }),
            auth,
        });
        app = instance;
        return { instance, cookie: await signedIn(auth, alice), executors, aliceId: alice.user.id, jobs };
    }

    it('the selected executor row freezes its round limit into the snapshot and defaultOptions', async () => {
        const { instance, cookie, jobs } = await bootWithExecutor({ gateFixRounds: 5 });

        const response = await post(instance, { command: 'echo hi', executor: 'main' }, cookie);

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(jobs.created[0]!.defaultOptions).toEqual({
            reviewReconciliation: true,
            mergeConflictAutofix: true,
            gateFixRounds: 5,
        });
        expect(jobs.created[0]!.snapshot).toEqual(
            compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: true }, 5)
        );
    });

    it('reads the row the body names, not the first row', async () => {
        const { instance, cookie, executors, aliceId, jobs } = await bootWithExecutor({ gateFixRounds: 5 });
        await executors.replace(aliceId, [
            { name: 'other', type: 'claude-code', config: {}, gateFixRounds: 1 },
            { name: 'main', type: 'claude-code', config: {}, gateFixRounds: 5 },
        ]);

        const response = await post(instance, { command: 'echo hi', executor: 'other' }, cookie);

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(jobs.created[0]!.defaultOptions).toEqual({
            reviewReconciliation: true,
            mergeConflictAutofix: true,
            gateFixRounds: 1,
        });
        expect(jobs.created[0]!.snapshot).toEqual(
            compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: true }, 1)
        );
    });

    it('rounds zero disables repair: the snapshot has no gate-fix node and the option says zero', async () => {
        const { instance, cookie, jobs } = await bootWithExecutor({ gateFixRounds: 0 });

        const response = await post(instance, { command: 'echo hi', executor: 'main' }, cookie);

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(jobs.created[0]!.defaultOptions).toEqual({
            reviewReconciliation: true,
            mergeConflictAutofix: true,
            gateFixRounds: 0,
        });
        expect(jobs.created[0]!.snapshot).toEqual(
            compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: true }, 0)
        );
    });

    it('an unknown executor label falls back to the default of three', async () => {
        const { instance, cookie, jobs } = await bootWithExecutor({ gateFixRounds: 5 });

        const response = await post(instance, { command: 'echo hi', executor: 'missing' }, cookie);

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(jobs.created[0]!.defaultOptions).toEqual({
            reviewReconciliation: true,
            mergeConflictAutofix: true,
            gateFixRounds: 3,
        });
    });

    it('no executor label falls back to the default of three', async () => {
        const { instance, cookie, jobs } = await bootWithExecutor({ gateFixRounds: 5 });

        const response = await post(instance, { command: 'echo hi' }, cookie);

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(jobs.created[0]!.defaultOptions).toEqual({
            reviewReconciliation: true,
            mergeConflictAutofix: true,
            gateFixRounds: 3,
        });
    });

    it('no executor store at all falls back to the default of three', async () => {
        const jobs = stubJobs();
        const auth = memoryAuthStore();
        const alice = auth.seedMember('test-org', 'alice');
        const config = testConfig({ auth: githubAuth() });
        const instance = await buildApp({
            config,
            orgs: staticRegistry({ config, jobs, telemetry: stubTelemetryClient() }),
            auth,
        });
        app = instance;

        const response = await post(instance, { command: 'echo hi', executor: 'main' }, await signedIn(auth, alice));

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(jobs.created[0]!.defaultOptions).toEqual({
            reviewReconciliation: true,
            mergeConflictAutofix: true,
            gateFixRounds: 3,
        });
    });

    it('no caller (open mode) falls back to the default of three', async () => {
        const jobs = stubJobs();
        const executors = memoryUserExecutorStore();
        const { instance } = await boot({ jobs, signedIn: false, userExecutors: executors });
        await executors.replace('nobody', [{ name: 'main', type: 'claude-code', config: {}, gateFixRounds: 9 }]);

        const response = await post(instance, { command: 'echo hi', executor: 'main' });

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(jobs.created[0]!.defaultOptions).toEqual({
            reviewReconciliation: true,
            mergeConflictAutofix: true,
            gateFixRounds: 3,
        });
    });
});
