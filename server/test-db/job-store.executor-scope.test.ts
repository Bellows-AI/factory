import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { useTestDb } from './harness.js';

/**
 * Issue 391's board half: a task selection names a scope and a profile, and the claim resolves
 * type + configuration from the STAMPED scope's row — a personal and an organization row sharing
 * a name stay distinguishable, an org row resolves for any author, and an unavailable selection
 * stays null (the driver fails it) rather than falling back to the other scope. The copies —
 * follow-up, retry — inherit the scope beside the executor label they already inherit.
 */

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;

const ORG = 'test-org';
const ALICE = '00000000-0000-4000-8000-00000000a11c';
const BOB = '00000000-0000-4000-8000-00000000b0b0';
const LEASE_SECONDS = 300;

const db = useTestDb({
    orgs: [ORG],
    users: [
        { id: ALICE, githubUserId: 90001, login: 'alice' },
        { id: BOB, githubUserId: 90002, login: 'bob' },
    ],
});

const mustCreate = (p: Promise<{ id: string } | 'purging'>): Promise<{ id: string }> =>
    p.then((ref) => {
        if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
        return ref;
    });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({
        sql,
        orgId: ORG,
        executorConfig: createUserExecutorStore({ sql, orgId: ORG }),
    });
});

describe.skipIf(!enabled)('claim resolution across executor scopes (issue 391)', () => {
    /** Alice's personal "main" and the organization's own "main": same name, two rows. */
    const seedSameName = async () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG });
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config: { model: 'personal-model' } }]);
        await executors.createOrg({
            name: 'main',
            type: 'claude-code',
            config: { model: 'shared-model' },
            createdBy: ALICE,
        });
    };

    it('resolves an org-scoped selection from the org row, for any author', async () => {
        await seedSameName();
        const { id } = await mustCreate(
            store.create('echo hi', BOB, { repo: null, executor: 'main', executorScope: 'org' })
        );

        const claim = await store.claim('w1', LEASE_SECONDS);

        expect(claim?.id).toBe(id);
        expect(claim?.executorType).toBe('claude-code');
        // The org row's configuration reaches the claim env under claude-code's merge name —
        // with the runner-managed keys already stripped, per the standing claim contract.
        const merged = claim?.env?.CLAUDE_CODE_CONFIG_CONTENT;
        expect(merged).toBeDefined();
        expect(JSON.parse(merged!)).toEqual({ model: 'shared-model' });
    });

    it('resolves the personal row when the selection stamps the personal scope', async () => {
        await seedSameName();
        await mustCreate(store.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user' }));

        const claim = await store.claim('w2', LEASE_SECONDS);

        expect(claim?.executorType).toBe('opencode');
        expect(JSON.parse(claim?.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({ model: 'personal-model' });
    });

    it('a scope with no matching row stays null — no cross-scope fallback', async () => {
        await seedSameName();
        // Bob has no personal "main": his personal-scope selection names nothing.
        const { id } = await mustCreate(
            store.create('echo hi', BOB, { repo: null, executor: 'main', executorScope: 'user' })
        );

        const claim = await store.claim('w3', LEASE_SECONDS);

        expect(claim?.id).toBe(id);
        expect(claim?.executorType).toBeNull();
        expect(claim?.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
        expect(claim?.env?.CLAUDE_CODE_CONFIG_CONTENT).toBeUndefined();
    });

    it('a row removed after queueing resolves null, and the task fails clearly rather than guessing', async () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG });
        await executors.createOrg({ name: 'gone', type: 'claude-code', config: {}, createdBy: ALICE });
        const { id } = await mustCreate(
            store.create('echo hi', ALICE, { repo: null, executor: 'gone', executorScope: 'org' })
        );
        const orgRow = (await executors.listOrg()).find((row) => row.name === 'gone')!;
        await executors.deleteOrg(orgRow.id);

        const claim = await store.claim('w4', LEASE_SECONDS);

        expect(claim?.id).toBe(id);
        expect(claim?.executorType).toBeNull();
    });
});

describe.skipIf(!enabled)('the scope rides the thread (issue 391)', () => {
    /** Takes a job the whole way to a finished run with a session, the follow-up's starting state. */
    const finishWithSession = async (target: { executor: string; executorScope: 'user' | 'org' }) => {
        const { id } = await mustCreate(store.create('drive me', ALICE, { repo: null, ...target }));
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.session(id, claim!.leaseToken, '33333333-3333-4333-8333-333333333333');
        await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        return id;
    };

    it('a follow-up inherits the stamped scope beside the executor label', async () => {
        const parent = await finishWithSession({ executor: 'main', executorScope: 'org' });

        const followUp = await store.createFollowUp(parent, 'adjust', ALICE);
        if (typeof followUp === 'string') throw new Error(`createFollowUp refused: ${followUp}`);

        expect(await store.get(followUp.id)).toMatchObject({
            executor: 'main',
            executorScope: 'org',
            followUpTo: parent,
        });
    });

    it('a retry inherits the stamped scope from the thread head', async () => {
        const head = await finishWithSession({ executor: 'team-runner', executorScope: 'org' });

        const retry = await store.createRetry(head, ALICE);
        if (typeof retry === 'string') throw new Error(`createRetry refused: ${retry}`);

        expect(await store.get(retry.id)).toMatchObject({
            executor: 'team-runner',
            executorScope: 'org',
            rootJobId: (await store.get(head))?.rootJobId,
        });
    });
});
