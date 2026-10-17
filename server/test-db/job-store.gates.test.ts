import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { GateReport } from '../src/db/job-store-types.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { createWorkflowStore } from '../src/db/workflow-store.js';
import type { WorkflowDefinition } from '../src/db/workflow-schema.js';
import { useTestDb } from './harness.js';
import { account, lapseDeferral, randomGithubId, testOrg } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
const ORG = testOrg();

const db = useTestDb({ max: 4 });

/** A lease long enough that nothing in this suite outlives it by accident. */
const LEASE_SECONDS = 300;

const REVISION = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

/** A saved workflow row for the job's snapshot to name. */
const new_workflow = async (definition: WorkflowDefinition, name: string): Promise<string> => {
    const created = await createWorkflowStore({ sql, orgId: ORG }).create({
        name,
        scope: { kind: 'org' },
        definition,
        createdBy: null,
    });
    return (created as { id: string }).id;
};

type PlanAnswer = {
    config: unknown;
    services?: unknown[];
    revision?: string | null;
    error: string | null;
};

/** A store whose plan reader answers from memory: the SQL is under test here, not the GitHub read. */
const plannedStore = (answer: PlanAnswer | (() => Promise<PlanAnswer>), asked: unknown[][] = []): JobStore =>
    createJobStore({
        sql,
        orgId: ORG,
        plan: {
            readFor: async (...args) => {
                asked.push(args);
                const resolved = typeof answer === 'function' ? await answer() : answer;
                return { services: [], revision: REVISION, ...resolved } as Awaited<
                    ReturnType<NonNullable<Parameters<typeof createJobStore>[0]['plan']>['readFor']>
                >;
            },
        },
    });

describe.runIf(enabled)('the execution plan on the job store', () => {
    it('carries the resolved gates, services, revision and repo label on a claim', async () => {
        const userId = await account(sql, randomGithubId(), 'gate-cat');
        const asked: unknown[][] = [];
        const services = [{ name: 'db', image: 'postgres:17', environment: [], ports: [5432] }];
        const planned = plannedStore(
            { config: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] }, services, error: null },
            asked
        );
        await planned.create('fix the bug', userId, { repo: 'acme/web', executor: null });

        const claim = await planned.claim('driver-1', LEASE_SECONDS);

        expect(claim?.repo).toBe('acme/web');
        expect(claim?.gates).toEqual({ image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] });
        expect(claim?.services).toEqual(services);
        expect(claim?.planRevision).toBe(REVISION);
        expect(claim?.planRefusal).toBeNull();
        // The reader is asked for the claimed repo at the thread's base branch — none outside a batch.
        expect(asked).toEqual([['acme/web', null]]);
    });

    it('carries a planRefusal value — not a throw — when the plan cannot launch, and withholds the plan', async () => {
        const userId = await account(sql, randomGithubId(), 'gate-dog');
        const REFUSAL =
            '.bellows.yaml: the execution plan cannot be scheduled: services "a" and "b" both declare port 5432';
        const broken = plannedStore({ config: null, error: REFUSAL });
        await broken.create('fix the bug', userId, { repo: 'acme/web', executor: null });

        const claim = await broken.claim('driver-1', LEASE_SECONDS);

        expect(claim?.gates).toBeUndefined();
        expect(claim?.services).toBeUndefined();
        expect(claim?.planRefusal).toBe(REFUSAL);
    });

    it('carries no plan for a repository that declares none', async () => {
        const userId = await account(sql, randomGithubId(), 'plain-cat');
        const plain = plannedStore({ config: null, error: null });
        await plain.create('echo hi', userId, { repo: 'acme/web', executor: null });

        const claim = await plain.claim('driver-1', LEASE_SECONDS);

        expect(claim?.gates).toBeUndefined();
        expect(claim?.services).toBeUndefined();
        expect(claim?.planRefusal).toBeNull();
        // Even "no plan" names the revision it was read at.
        expect(claim?.planRevision).toBe(REVISION);
    });

    it('carries no plan fields for a store built without a plan reader', async () => {
        const userId = await account(sql, randomGithubId(), 'bare-cat');
        await store.create('echo hi', userId, { repo: 'acme/web', executor: null });

        const claim = await store.claim('driver-1', LEASE_SECONDS);

        expect(claim?.gates).toBeUndefined();
        expect(claim?.services).toBeUndefined();
        expect(claim?.planRevision).toBeUndefined();
        expect(claim?.planRefusal).toBeNull();
    });

    // An outage of the plan source interrupts a claim; it never loses the task: the row stays
    // queued and the next claim resolves the plan.
    it('leaves the task queued when the plan reader fails, and claims it once the reader recovers', async () => {
        const userId = await account(sql, randomGithubId(), 'outage-cat');
        let failing = true;
        const reader = plannedStore(async () => {
            if (failing) throw new Error('GitHub is unreachable');
            return { config: null, error: null };
        });
        const created = (await reader.create('fix the bug', userId, { repo: 'acme/web', executor: null })) as {
            id: string;
        };

        await expect(reader.claim('driver-1', LEASE_SECONDS)).rejects.toThrow('GitHub is unreachable');
        expect(await reader.get(created.id)).toMatchObject({ status: 'queued', attempts: 0 });
        const [deferral] = await sql<{ deferred: boolean }[]>`
            select claim_deferred_until > now() as deferred from job where id = ${created.id}
        `;
        expect(deferral?.deferred).toBe(true);

        // Deferred, never failed (issue #822): once the reader is back and the deferral lapsed,
        // the next claim resolves the plan.
        failing = false;
        await lapseDeferral(sql, created.id);
        const claim = await reader.claim('driver-1', LEASE_SECONDS);
        expect(claim?.id).toBe(created.id);
        expect(claim?.planRefusal).toBeNull();
    });

    // A node that declared `gates: false` never uses the plan, so a broken `.bellows.yaml` must not
    // fail it — and a gated node carries the refusal.
    it.each([
        { gates: false, expectRefusal: false },
        { gates: true, expectRefusal: true },
    ])('answers an unresolvable plan per the node (gates: $gates)', async ({ gates, expectRefusal }) => {
        const userId = await account(sql, randomGithubId(), gates ? 'gate-owl' : 'gate-fox');
        const REFUSAL = '.bellows.yaml line 3: unknown key "setup" inside environment';
        const reader = plannedStore({ config: null, error: REFUSAL });
        const definition: WorkflowDefinition = {
            entry: 'collect',
            params: [],
            nodes: [{ name: 'collect', kind: 'agent', session: 'fresh', gates, prompt: 'collect' }],
            edges: [],
        };
        const created = await new_workflow(definition, `plan-gates-${gates}`);
        await reader.create('collect', userId, {
            repo: 'acme/web',
            executor: null,
            workflow: { id: created, name: `plan-gates-${gates}`, node: 'collect', snapshot: definition, params: {} },
        });

        const claim = await reader.claim('driver-1', LEASE_SECONDS);

        expect(claim?.planRefusal ?? null).toBe(expectRefusal ? REFUSAL : null);
    });

    it('replaces the gate state on every report, and answers the last one on read', async () => {
        const userId = await account(sql, randomGithubId(), 'gate-owl');
        await store.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        const claim = await store.claim('driver-1', LEASE_SECONDS);
        const running: GateReport[] = [{ name: 'test', status: 'running', exitCode: null, output: null }];
        const finished: GateReport[] = [{ name: 'test', status: 'failed', exitCode: 3, output: 'boom' }];

        expect(await store.gates(claim!.id, claim!.leaseToken, running)).toBe('ok');
        expect((await store.get(claim!.id))?.gates).toEqual(running);
        expect(await store.gates(claim!.id, claim!.leaseToken, finished)).toBe('ok');
        // REPLACE, never append: the second report is the whole truth, current/last only.
        expect((await store.get(claim!.id))?.gates).toEqual(finished);
        expect((await store.thread(claim!.id))?.[0]?.gates).toEqual(finished);
    });

    it('omits gates from the list projection, like output', async () => {
        const userId = await account(sql, randomGithubId(), 'gate-emu');
        await store.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        const claim = await store.claim('driver-1', LEASE_SECONDS);
        await store.gates(claim!.id, claim!.leaseToken, [
            { name: 'test', status: 'passed', exitCode: 0, output: 'all green' },
        ]);

        const listed = await store.list({ limit: 10 });
        expect(listed).toHaveLength(1);
        expect(listed[0]?.gates).toBeNull();
    });
});
