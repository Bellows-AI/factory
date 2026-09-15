import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { createJobStore, type Claim, type JobStore } from '../src/db/job-store.js';
import { createWorkflowStore } from '../src/db/workflow-store.js';
import type { WorkflowDefinition } from '../src/db/workflow-schema.js';

const url = process.env.DATABASE_URL;

/**
 * This suite TRUNCATES job and workflow before every test. Requiring a `_test` database name is
 * the guard, because the failure is silent: the tests pass and the board's audit trail — the rows
 * every workflow decision derives from — is simply gone.
 */
function assertTestDatabase(raw: string): void {
    const name = new URL(raw).pathname.replace(/^\//, '');
    if (!/_test$/.test(name)) {
        throw new Error(`Refusing to run: this suite truncates its tables, and "${name}" is not a test database.`);
    }
}

const enabled = Boolean(url);
if (url) assertTestDatabase(url);

let sql: Sql;
let store: JobStore;
let workflows: ReturnType<typeof createWorkflowStore>;

const ORG = 'test-org';
const WORKER = 'worker-1';

const BLOCKERS = 'VERDICT: BLOCKERS';
const CLEAN = 'VERDICT: CLEAN';

/** A four-node graph with one review/fix loop, one publish node, and the base session policies. */
const walk: WorkflowDefinition = {
    entry: 'implement',
    nodes: [
        { name: 'implement', kind: 'agent', session: 'resume', prompt: 'implement' },
        { name: 'review', kind: 'agent', session: 'fresh', prompt: 'review the work' },
        { name: 'fix', kind: 'agent', session: 'resume', prompt: 'fix: {{review.output}}' },
        { name: 'publish', kind: 'agent', session: 'resume', publish: true, prompt: 'preflight' },
    ],
    edges: [
        { from: 'implement', to: 'review', when: 'succeeded' },
        { from: 'review', to: 'fix', when: { marker: BLOCKERS } },
        { from: 'review', to: 'publish', when: { marker: CLEAN } },
        { from: 'fix', to: 'review', when: 'succeeded', max: 3 },
    ],
};

/** The loop bounded at ONE, so a single existing fix row (even a dead one) exhausts it. */
const walkBound1: WorkflowDefinition = {
    ...walk,
    edges: walk.edges.map((edge) => (edge.to === 'fix' ? { ...edge, max: 1 } : edge)),
};

const INTERP_CAP: WorkflowDefinition = {
    entry: 'a',
    nodes: [
        ...['a', 'b', 'c', 'd', 'e'].map((name) => ({
            name,
            kind: 'agent' as const,
            session: 'resume' as const,
            prompt: `run ${name}`,
        })),
        {
            name: 'f',
            kind: 'agent',
            session: 'resume',
            prompt: '{{a.output}} {{b.output}} {{c.output}} {{d.output}} {{e.output}}',
        },
    ],
    edges: [
        { from: 'a', to: 'b', when: 'succeeded' },
        { from: 'b', to: 'c', when: 'succeeded' },
        { from: 'c', to: 'd', when: 'succeeded' },
        { from: 'd', to: 'e', when: 'succeeded' },
        { from: 'e', to: 'f', when: 'succeeded' },
    ],
};

beforeAll(async () => {
    if (!enabled) return;
    sql = postgres(url as string, { max: 8 });
    await migrate(sql, { orgId: ORG, attempts: 3 });
    store = createJobStore({ sql, orgId: ORG });
    workflows = createWorkflowStore({ sql, orgId: ORG });
});

afterAll(async () => {
    if (enabled) await sql.end({ timeout: 5 });
});

beforeEach(async () => {
    if (!enabled) return;
    await sql`truncate job, task_reclaim, workflow`;
});

/** Seeds the named definition, queues a task on it, and returns the root id. */
async function queueWorkflowJob(definition: WorkflowDefinition, name = 'walk'): Promise<string> {
    const created = await workflows.create({ name, scope: { kind: 'org' }, definition, createdBy: null });
    expect(created).toHaveProperty('id');
    const job = await store.create('fix the thing', null, {
        repo: null,
        executor: null,
        workflow: { id: (created as { id: string }).id, node: definition.entry, snapshot: definition },
    });
    return job.id;
}

/** Claims the board's oldest claimable row and reports it, the way a driver would. */
async function runNext(status: 'succeeded' | 'failed', output: string | null): Promise<Claim> {
    const claim = await store.claim(WORKER, 60);
    expect(claim).not.toBeNull();
    const held = claim as Claim;
    await store.complete(held.id, held.leaseToken, {
        status,
        exitCode: status === 'succeeded' ? 0 : 1,
        output,
    });
    return held;
}

const thread = async (rootId: string) => (await store.thread(rootId))!;
const nodesOf = (rootId: string) => thread(rootId).then((rows) => rows.map((row) => row.workflowNode));

describe.skipIf(!enabled)('workflow execution', () => {
    it('lands the workflow triple on the root row at create, and nothing on a workflow-less one', async () => {
        const id = await queueWorkflowJob(walk);
        const [row] = await sql<{ workflow_id: string | null; workflow_node: string | null; snapshot: unknown }[]>`
            select workflow_id, workflow_node, workflow_snapshot as snapshot from job where id = ${id}
        `;
        expect(row!.workflow_node).toBe('implement');
        expect(row!.workflow_id).not.toBeNull();
        expect(row!.snapshot).toEqual(walk);

        const plain = await store.create('plain', null, { repo: null, executor: null });
        const [bare] = await sql<{ workflow_id: string | null; workflow_node: string | null; snapshot: unknown }[]>`
            select workflow_id, workflow_node, workflow_snapshot as snapshot from job where id = ${plain.id}
        `;
        expect(bare!.workflow_id).toBeNull();
        expect(bare!.workflow_node).toBeNull();
        expect(bare!.snapshot).toBeNull();
    });

    it('inserts the next row in the verdict transaction: review follows implement', async () => {
        const root = await queueWorkflowJob(walk);
        const claim = (await store.claim(WORKER, 60))!;
        expect(await nodesOf(root)).toEqual(['implement']);

        await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        // The same transaction landed the verdict and the successor: both visible the moment
        // complete returns, and no read ever saw one without the other.
        expect(await nodesOf(root)).toEqual(['implement', 'review']);
        expect((await thread(root)).map((row) => row.status)).toEqual(['succeeded', 'queued']);
    });

    it('walks review → fix on the BLOCKERS marker, then review → publish on CLEAN', async () => {
        const root = await queueWorkflowJob(walk);
        await runNext('succeeded', 'implemented'); // implement
        await runNext('succeeded', `findings\n${BLOCKERS}`); // review round one
        expect(await nodesOf(root)).toEqual(['implement', 'review', 'fix']);

        await runNext('succeeded', 'fixed'); // fix
        await runNext('succeeded', `fine\n${CLEAN}`); // review round two
        expect(await nodesOf(root)).toEqual(['implement', 'review', 'fix', 'review', 'publish']);
    });

    it('rests when no rule matches — marker absence never silently continues', async () => {
        const root = await queueWorkflowJob(walk);
        await runNext('succeeded', 'implemented');
        await runNext('succeeded', 'review said nothing machine-readable');
        expect(await nodesOf(root)).toEqual(['implement', 'review']);
    });

    it('never inserts the fourth review round — the bound rests the loop', async () => {
        const root = await queueWorkflowJob(walk);
        await runNext('succeeded', 'implemented'); // implement → review 1
        for (const round of [1, 2]) {
            await runNext('succeeded', `blockers ${round}\n${BLOCKERS}`); // review N → fix N
            await runNext('succeeded', `fixed ${round}`); // fix N → review N+1
        }
        await runNext('succeeded', `blockers 3\n${BLOCKERS}`); // review 3 → fix 3
        // fix 3 completes: the fix→review edge (max 3) matches a FOURTH time — three review rows
        // exist — so no fourth review row is inserted and the thread rests with its verdicts.
        await runNext('succeeded', 'fixed 3');
        expect(await nodesOf(root)).toEqual([
            'implement',
            'review',
            'fix',
            'review',
            'fix',
            'review',
            'fix',
        ]);
        const rows = await thread(root);
        expect(rows[rows.length - 1]!.status).toBe('succeeded');
    });

    it('carries the primary session across a fresh-eyes branch', async () => {
        const root = await queueWorkflowJob(walk);
        const first = (await store.claim(WORKER, 60))!;
        await store.session(first.id, first.leaseToken, 'sess-implement', null);
        await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });

        // The review row is `fresh`: no session on the claim; its run mints its own.
        const review = (await store.claim(WORKER, 60))!;
        expect(review.resumeSessionId).toBeNull();
        await store.session(review.id, review.leaseToken, 'sess-review-side-branch', null);
        await store.complete(review.id, review.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: `blockers\n${BLOCKERS}`,
        });

        // The fix row is `resume`: it carries the IMPLEMENT session, not the review's branch.
        const fix = (await thread(root)).find((row) => row.workflowNode === 'fix');
        expect(fix?.sessionId).toBe('sess-implement');
    });

    it('copies the primary session — not the last row\'s — onto a user follow-up', async () => {
        const root = await queueWorkflowJob(walk);
        const first = (await store.claim(WORKER, 60))!;
        await store.session(first.id, first.leaseToken, 'sess-primary', null);
        await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });

        // The review mints a side-branch session, then says nothing machine-readable: the thread
        // RESTS at the review, whose row is the thread's newest — and carries the branch session.
        const review = (await store.claim(WORKER, 60))!;
        await store.session(review.id, review.leaseToken, 'sess-fresh-branch', null);
        await store.complete(review.id, review.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'no marker',
        });

        const followUp = await store.createFollowUp(review.id, 'adjust', null);
        expect(followUp).toHaveProperty('id');
        const child = await store.get((followUp as { id: string }).id);
        expect(child?.sessionId).toBe('sess-primary');
        expect(child?.workflowNode).toBeNull();
    });

    it('publish flag: true only on the publish node, false on every other, absent without a workflow', async () => {
        await queueWorkflowJob(walk);
        const implementClaim = (await store.claim(WORKER, 60))!;
        expect(implementClaim.publish).toBe(false);
        await store.complete(implementClaim.id, implementClaim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const reviewClaim = (await store.claim(WORKER, 60))!;
        expect(reviewClaim.publish).toBe(false);
        await store.complete(reviewClaim.id, reviewClaim.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: `fine\n${CLEAN}`,
        });
        const publishClaim = (await store.claim(WORKER, 60))!;
        expect(publishClaim.publish).toBe(true);

        // A workflow-less task carries NO flag at all: byte-identical to the pre-027 claim.
        await store.create('plain', null, { repo: null, executor: null });
        const plainClaim = (await store.claim(WORKER, 60))!;
        expect('publish' in plainClaim).toBe(false);
    });

    it('rests the insert when the interpolated command exceeds the cap, with no successor', async () => {
        const capped: WorkflowDefinition = {
            ...INTERP_CAP,
            nodes: INTERP_CAP.nodes.map((node) => (node.name === 'f' ? { ...node, publish: true } : node)),
        };
        const root = await queueWorkflowJob(capped, 'cap');
        const tail = 'x'.repeat(4096);
        for (let i = 0; i < 5; i++) {
            await runNext('succeeded', tail); // a..e; the fifth completion's edge into f overflows
        }
        expect(await nodesOf(root)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('a dead review row still counts as a round against the bound', async () => {
        // The loop bounded at ONE review round: a single review row — dead included — exhausts it.
        const boundedOnce: WorkflowDefinition = {
            ...walk,
            edges: walk.edges.map((edge) => (edge.to === 'review' ? { ...edge, max: 1 } : edge)),
        };
        const root = await queueWorkflowJob(boundedOnce, 'bound-once');
        const first = (await store.claim(WORKER, 60))!;
        await store.session(first.id, first.leaseToken, 'sess-implement', null);
        await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });

        // Review 1 runs, reports its session, then burns its attempts and dies.
        const review1 = (await store.claim(WORKER, 60))!;
        await store.session(review1.id, review1.leaseToken, 'sess-review', null);
        await sql`update job set status = 'dead', finished_at = now(), lease_token = null where id = ${review1.id}`;

        // The human follows up the dead review row; the completion re-fires the halted node's
        // (review's) edges: BLOCKERS matches review→fix and a fix row is inserted.
        const followUp = await store.createFollowUp(review1.id, 'run it by hand', null);
        expect(followUp).toHaveProperty('id');
        const child = (await store.claim(WORKER, 60))!;
        expect(child.id).toBe((followUp as { id: string }).id);
        await store.complete(child.id, child.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: `blockers\n${BLOCKERS}`,
        });
        // The off-graph follow-up sits between the dead review and the fix it triggered.
        expect(await nodesOf(root)).toEqual(['implement', 'review', null, 'fix']);

        // The fix completes: the fix→review edge matches, but the DEAD review row already counts
        // as review round one against a bound of one — no second review row is inserted. Were
        // dead rows excluded from the count, the loop would walk right past its limit.
        await runNext('succeeded', 'fixed');
        expect(await nodesOf(root)).toEqual(['implement', 'review', null, 'fix']);
    });

    it('a user follow-up re-fires the halted node\'s edges so the graph continues', async () => {
        const root = await queueWorkflowJob(walk);
        const first = (await store.claim(WORKER, 60))!;
        await store.session(first.id, first.leaseToken, 'sess-implement', null);
        await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        // The review says nothing machine-readable: the thread rests AT the review.
        const review = (await store.claim(WORKER, 60))!;
        await store.session(review.id, review.leaseToken, 'sess-review', null);
        await store.complete(review.id, review.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'no marker, the human steps in',
        });
        expect(await nodesOf(root)).toEqual(['implement', 'review']);

        // The human's follow-up completes; the halted node's (review's) outgoing edges are
        // evaluated from THIS completion, and the BLOCKERS marker continues the graph.
        const followUp = await store.createFollowUp(review.id, 'i also checked, still blockers', null);
        const child = (await store.claim(WORKER, 60))!;
        expect(child.id).toBe((followUp as { id: string }).id);
        await store.complete(child.id, child.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: `confirmed blockers\n${BLOCKERS}`,
        });
        // The off-graph follow-up sits between the halted review and the fix it triggered.
        expect(await nodesOf(root)).toEqual(['implement', 'review', null, 'fix']);
    });

    it('stop fires no edge: a queued row settles stopped, a running one on the suspend', async () => {
        const root = await queueWorkflowJob(walk);
        await runNext('succeeded', 'implemented'); // implement → review queued

        // A QUEUED row never started: /stop settles it here, no successor ever inserted.
        const review = (await thread(root)).find((row) => row.workflowNode === 'review')!;
        const stopped = await store.stop(review.id, null);
        expect(stopped).toMatchObject({ result: 'stopped' });
        expect(await nodesOf(root)).toEqual(['implement', 'review']);
        expect((await thread(root))[1]!.status).toBe('stopped');
    });

    it('a running stop is a request the settle lands: still no edge, thread rests', async () => {
        const root = await queueWorkflowJob(walk);
        await runNext('succeeded', 'implemented');
        const review = (await store.claim(WORKER, 60))!;
        const asked = await store.stop(review.id, null);
        expect(asked).toMatchObject({ result: 'requested' });
        const parked = await store.suspend(review.id, review.leaseToken);
        expect(parked).toMatchObject({ result: 'ok', status: 'stopped' });
        expect(await nodesOf(root)).toEqual(['implement', 'review']);
    });

    it('a workflow-less complete inserts nothing, threadDone answering exactly as before', async () => {
        const job = await store.create('plain', null, { repo: null, executor: null });
        const claim = (await store.claim(WORKER, 60))!;
        const verdict = await store.complete(claim.id, claim.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'done',
        });
        // No member carries the user's done_at, so the thread is not DONE — the pre-027 answer.
        expect(verdict).toMatchObject({ result: 'ok', threadDone: false });
        expect(await thread(job.id)).toHaveLength(1);
    });
});
