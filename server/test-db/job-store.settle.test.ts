import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { useTestDb } from './harness.js';

/**
 * The long-poll settle read (issue #323): `waitForSettle` holds until the named job's THREAD
 * settles — the chain head (newest member) reaches a terminal status, or an open PR wait
 * (036) stands on the thread (`terminal` / `parked`) — answering `timeout` at the deadline,
 * each with the thread's root and head identity, or null for an id the org does not know. The predicate is deliberately the same one `listTasksOf` buckets
 * by, so a long-poll client and the sidenav can never disagree about "still moving".
 */

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
let prs: ReturnType<typeof createPrLifecycleStore>;

const ORG = 'test-org';
const WORKER = 'worker-1';
const REPO = 'acme/widgets';
/** A well-formed uuid, only ever used where the job is expected not to exist. */
const ABSENT = '00000000-0000-4000-8000-000000000000';
const SESSION = '33333333-3333-4333-8333-333333333333';
const LEASE_SECONDS = 300;

const db = useTestDb({ orgs: [ORG] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    store = createJobStore({ sql, orgId: ORG, prs });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Queues a plain job, refusing the purge refusal — never a case under test here. */
const queue = async (command: string): Promise<{ id: string }> => {
    const ref = await store.create(command, null, { repo: null, executor: null });
    if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
    return ref;
};

/** Chains a follow-up that MUST be created; a refusal is broken setup, thrown not hidden. */
const mustFollowUp = (root: string, command: string): Promise<{ id: string }> =>
    store.createFollowUp(root, command, null).then((ref) => {
        if (typeof ref === 'string') throw new Error(`createFollowUp refused: ${ref}`);
        return ref;
    });

/** Takes a job the whole way to a finished run with a session — the state a follow-up needs. */
const finishWithSession = async (command: string): Promise<string> => {
    const { id } = await queue(command);
    const claim = await store.claim(WORKER, LEASE_SECONDS);
    await store.session(id, claim!.leaseToken, SESSION);
    await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
    return id;
};

describe.skipIf(!enabled)('waitForSettle — the long-poll settle read (issue #323)', () => {
    it('a moving thread does not settle; the verdict settles it', async () => {
        const { id } = await queue('work');
        expect(await store.waitForSettle(id, 50)).toEqual({
            result: 'timeout',
            rootJobId: id,
            headJobId: id,
            headStatus: 'queued',
            waitReason: null,
        });

        const claim = await store.claim(WORKER, LEASE_SECONDS);
        await store.session(id, claim!.leaseToken, SESSION);
        await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        expect(await store.waitForSettle(id, 5_000)).toEqual({
            result: 'terminal',
            rootJobId: id,
            headJobId: id,
            headStatus: 'succeeded',
            waitReason: null,
        });
    });

    it('waiting on the root settles when the chain head settles', async () => {
        const root = await finishWithSession('drive me');
        const followUp = await mustFollowUp(root, 'again');
        // The head is the queued follow-up: the thread is not settled, the root's own verdict
        // notwithstanding — a settled member does not settle the conversation after it.
        expect(await store.waitForSettle(root, 50)).toMatchObject({ result: 'timeout', headJobId: followUp.id });

        const claim = await store.claim(WORKER, LEASE_SECONDS);
        expect(claim!.id).toBe(followUp.id);
        await store.complete(followUp.id, claim!.leaseToken, { status: 'failed', exitCode: 1, output: 'no' });
        expect(await store.waitForSettle(root, 5_000)).toMatchObject({
            result: 'terminal',
            rootJobId: root,
            headJobId: followUp.id,
            headStatus: 'failed',
        });
    });

    it('an open PR wait parks a thread whose head is still moving, and names the wait', async () => {
        const root = await finishWithSession('drive me');
        const followUp = await mustFollowUp(root, 'again');
        expect(await store.waitForSettle(root, 50)).toMatchObject({ result: 'timeout' });

        await prs.enterWait({ root, reason: 'review', repo: REPO, prNumber: 1 });
        expect(await store.waitForSettle(root, 5_000)).toMatchObject({
            result: 'parked',
            rootJobId: root,
            headJobId: followUp.id,
            waitReason: 'review',
        });
    });

    it('a closed PR wait leaves the moving thread unsettled', async () => {
        const root = await finishWithSession('drive me');
        await mustFollowUp(root, 'again');
        await prs.enterWait({ root, reason: 'review', repo: REPO, prNumber: 1 });
        // A wait goes terminal the way every real caller lands it — with the reason it ended
        // ('pr closed', 'task stopped'); a stamped completion without one is the ambiguous
        // state no production path writes.
        await prs.finishWait(root, 'review', 'pr closed');
        expect(await store.waitForSettle(root, 50)).toMatchObject({ result: 'timeout', waitReason: null });
    });

    it('an unknown id answers null without waiting', async () => {
        const started = Date.now();
        expect(await store.waitForSettle(ABSENT, 60_000)).toBeNull();
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('answers a foreign org\u2019s id as unknown', async () => {
        const { id } = await queue('work');
        const foreign = createJobStore({ sql, orgId: 'other-org' });
        expect(await foreign.waitForSettle(id, 5_000)).toBeNull();
    });

    it('times out unsettled, having held for the whole timeout', async () => {
        const { id } = await queue('work');
        const started = Date.now();
        expect(await store.waitForSettle(id, 250)).toMatchObject({ result: 'timeout' });
        expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    });

    it('settles while waiting, without outliving the verdict by long', async () => {
        const { id } = await queue('work');
        const pending = store.waitForSettle(id, 10_000);
        await sleep(150);
        const claim = await store.claim(WORKER, LEASE_SECONDS);
        await store.session(id, claim!.leaseToken, SESSION);
        await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        expect(await pending).toMatchObject({ result: 'terminal' });
    });

    it('never re-answers an id that vanishes mid-wait as settled', async () => {
        // Guarded by nothing in particular — the loop re-checks the org each round, so a row
        // deleted mid-hold (removeThread) answers null, never a stale settled.
        const { id } = await queue('work');
        const pending = store.waitForSettle(id, 10_000);
        await sleep(150);
        await sql`delete from job where id = ${id}`;
        expect(await pending).toBeNull();
    });
});
