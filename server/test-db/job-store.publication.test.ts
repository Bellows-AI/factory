import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { useTestDb } from './harness.js';

/**
 * A create whose refusal would be a broken setup, never a case under test: narrows the store's
 * honest union (`{ id } | 'purging'`, issue #92) so the call sites read as they did before.
 */
const mustCreate = (p: Promise<{ id: string } | 'purging'>): Promise<{ id: string }> =>
    p.then((ref) => {
        if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
        return ref;
    });

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
let prs: ReturnType<typeof createPrLifecycleStore>;

const ORG = 'test-org';
const OTHER_ORG = 'other-org';
const WORKER = 'worker-1';
const SESSION = '33333333-3333-4333-8333-333333333333';
/** A lease long enough that nothing in this suite outlives it by accident. */
const LEASE_SECONDS = 300;

const db = useTestDb({ orgs: [ORG, OTHER_ORG], max: 4 });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    store = createJobStore({ sql, orgId: ORG });
});

/**
 * Takes a job the whole way to a finished run with a session — the state a follow-up needs its
 * parent in (the follow-up CTE refuses a sessionless parent), and the state a published thread is
 * in when a client wants to walk from the task to its PR.
 */
const finishWithSession = async (command: string): Promise<string> => {
    const { id } = await mustCreate(store.create(command, null, { repo: null, executor: null }));
    const claim = await store.claim(WORKER, LEASE_SECONDS);
    if (claim === null) throw new Error('claim refused');
    await store.session(id, claim.leaseToken, SESSION);
    await store.complete(id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
    return id;
};

const mustFollowUp = (root: string, command: string): Promise<{ id: string }> =>
    store.createFollowUp(root, command, null).then((ref) => {
        if (typeof ref === 'string') throw new Error(`createFollowUp refused: ${ref}`);
        return ref;
    });

describe.skipIf(!enabled)('publication and wait on the job reads (#324)', () => {
    it('serves the thread’s recorded publication on get() and thread(), every member alike', async () => {
        const root = await finishWithSession('open the pull request');
        const followUp = await mustFollowUp(root, 'adjust the pr');
        await prs.recordPublication({
            root,
            repo: 'acme/widgets',
            prNumber: 7,
            prUrl: 'https://github.com/acme/widgets/pull/7',
            headBranch: `factory/${root}`,
            baseBranch: 'main',
        });

        const expected = {
            repo: 'acme/widgets',
            prNumber: 7,
            prUrl: 'https://github.com/acme/widgets/pull/7',
            headBranch: `factory/${root}`,
            baseBranch: 'main',
        };
        expect((await store.get(root))?.publication).toEqual(expected);
        // The follow-up resolves the join through root_job_id — the publication belongs to the
        // THREAD, so any member answers it.
        expect((await store.get(followUp.id))?.publication).toEqual(expected);
        for (const member of (await store.thread(followUp.id)) ?? []) {
            expect(member.publication).toEqual(expected);
        }
    });

    it('answers publication: null for a thread that never published', async () => {
        const root = await finishWithSession('nothing to publish');

        expect((await store.get(root))?.publication).toBeNull();
        for (const member of (await store.thread(root)) ?? []) {
            expect(member.publication).toBeNull();
        }
    });

    it('leaves publication and the wait triple off the per-run lists', async () => {
        const root = await finishWithSession('publish and wait');
        await prs.recordPublication({
            root,
            repo: 'acme/widgets',
            prNumber: 7,
            prUrl: 'https://github.com/acme/widgets/pull/7',
            headBranch: `factory/${root}`,
            baseBranch: 'main',
        });
        await prs.enterWait({ root, reason: 'review', repo: 'acme/widgets', prNumber: 7 });

        // The lists are the one surface that answers null for both — the documented rule the
        // wait fields already followed before this field existed (docs/jobs.md).
        for (const row of await store.list({ limit: 10 })) {
            expect(row.publication).toBeNull();
            expect(row.waitReason).toBeNull();
            expect(row.waitingSince).toBeNull();
            expect(row.waitTerminalReason).toBeNull();
        }
    });

    it('carries the thread’s wait on get() like thread() does', async () => {
        const root = await finishWithSession('wait on review');

        // Before any wait: all three null — unmeasured, never zero.
        expect(await store.get(root)).toMatchObject({
            waitReason: null,
            waitingSince: null,
            waitTerminalReason: null,
        });

        await prs.enterWait({ root, reason: 'review', repo: 'acme/widgets', prNumber: 7 });
        const waiting = await store.get(root);
        expect(waiting).toMatchObject({ waitReason: 'review', waitTerminalReason: null });
        expect(waiting?.waitingSince).not.toBeNull();
        // Parity: the thread read answers the same triple it always has.
        expect(await store.thread(root)).toEqual([
            expect.objectContaining({ waitReason: 'review', waitTerminalReason: null }),
        ]);

        await prs.finishWait(root, 'review', 'exhausted');
        expect(await store.get(root)).toMatchObject({
            waitReason: 'review',
            waitTerminalReason: 'exhausted',
        });
    });

    it('does not leak another org’s publication for the same root id', async () => {
        const root = await finishWithSession('cross-org publication');
        const otherOrgPrs = createPrLifecycleStore({ sql, orgId: OTHER_ORG });
        // job_pr has no FK on root_job_id — only on org_id — so the same root uuid can carry a
        // row under another org. This org's read must not answer it.
        await otherOrgPrs.recordPublication({
            root,
            repo: 'evil/other',
            prNumber: 9,
            prUrl: 'https://github.com/evil/other/pull/9',
            headBranch: 'factory/other',
            baseBranch: 'main',
        });

        expect((await store.get(root))?.publication).toBeNull();
        for (const member of (await store.thread(root)) ?? []) {
            expect(member.publication).toBeNull();
        }
    });
});
