import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim, JobStore } from '../src/db/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { createWorkflowStore } from '../src/db/workflow-store.js';
import type { WorkflowDefinition } from '../src/db/workflow-schema.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
let workflows: ReturnType<typeof createWorkflowStore>;
let prs: ReturnType<typeof createPrLifecycleStore>;

const ORG = 'test-org';
const WORKER = 'worker-1';

const db = useTestDb({ orgs: [ORG], max: 8 });

/**
 * `job-store-claim.ts`'s `resolveClaimHelperPlans` — issue #122's first real producer of
 * `WorkflowNode.helperPlans` — against a real database: the claim-time PR-identity injection this
 * pure-unit coverage (`workflow-block-merge-conflict-autofix.test.ts`) cannot reach, since that
 * suite never touches `job`/`job_pr` rows or a claim transaction. Not the block's own expand()
 * shape (covered there) — this is the generic resolver every future helperId-declaring block will
 * share.
 */
const withHelper: WorkflowDefinition = {
    entry: 'repair',
    params: [],
    nodes: [
        {
            name: 'repair',
            kind: 'agent',
            session: 'resume',
            gates: false,
            prompt: 'repair',
            helperPlans: [{ helperId: 'merge-conflict-probe', phase: 'pre', githubWriting: true }],
        },
        { name: 'verify', kind: 'agent', session: 'resume', publish: true, prompt: 'verify' },
    ],
    edges: [{ from: 'repair', to: 'verify', when: { marker: 'MERGE-REBASED' } }],
};

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    store = createJobStore({ sql, orgId: ORG, prs });
    workflows = createWorkflowStore({ sql, orgId: ORG });
});

async function queueWorkflowJob(definition: WorkflowDefinition, name: string): Promise<string> {
    const created = await workflows.create({ name, scope: { kind: 'org' }, definition, createdBy: null });
    const job = await store.create('reconcile the pull request', null, {
        repo: null,
        executor: null,
        workflow: {
            id: (created as { id: string }).id,
            name,
            node: definition.entry,
            snapshot: definition,
            params: {},
        },
    });
    return job.id;
}

describe.skipIf(!enabled)('claim-time helper plans (issue #122)', () => {
    it('injects the thread’s recorded PR publication into a declared pre-helper’s input', async () => {
        const root = await queueWorkflowJob(withHelper, 'reconcile-with-pub');
        await prs.recordPublication({
            root,
            repo: 'acme/widgets',
            prNumber: 7,
            prUrl: 'https://github.com/acme/widgets/pull/7',
            headBranch: `factory/${root}`,
            baseBranch: 'main',
        });

        const claim = (await store.claim(WORKER, 60)) as Claim;
        expect(claim).not.toBeNull();
        expect(claim.helperPlans).toEqual([
            {
                helperId: 'merge-conflict-probe',
                phase: 'pre',
                githubWriting: true,
                input: {
                    publication: {
                        repo: 'acme/widgets',
                        prNumber: 7,
                        prUrl: 'https://github.com/acme/widgets/pull/7',
                        headBranch: `factory/${root}`,
                        baseBranch: 'main',
                    },
                },
            },
        ]);
    });

    it('injects a null publication when the thread never published', async () => {
        await queueWorkflowJob(withHelper, 'reconcile-without-pub');

        const claim = (await store.claim(WORKER, 60)) as Claim;
        expect(claim).not.toBeNull();
        expect(claim.helperPlans).toEqual([
            {
                helperId: 'merge-conflict-probe',
                phase: 'pre',
                githubWriting: true,
                input: { publication: null },
            },
        ]);
    });

    it('carries no helperPlans key at all for a node that declares none — unchanged claim shape', async () => {
        const plain: WorkflowDefinition = {
            entry: 'work',
            params: [],
            nodes: [{ name: 'work', kind: 'agent', session: 'resume', publish: true, prompt: 'work' }],
            edges: [],
        };
        await queueWorkflowJob(plain, 'plain-node');

        const claim = (await store.claim(WORKER, 60)) as Claim;
        expect(claim).not.toBeNull();
        expect(claim).not.toHaveProperty('helperPlans');
    });
});
