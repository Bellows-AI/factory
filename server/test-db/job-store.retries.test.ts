import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
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
/** A second store on the same pool, bound to a different org. Only the org guard uses it. */
let otherOrgStore: JobStore;

const ORG = 'test-org';
const OTHER_ORG = 'other-org';
/** A well-formed uuid, only ever used where the job or the lease is expected not to exist. */
const ABSENT = '00000000-0000-4000-8000-000000000000';
const SESSION = '33333333-3333-4333-8333-333333333333';
/** A second session, for proving the head is the member a retry re-runs. */
const CHAIN = '55555555-5555-4555-8555-555555555555';
/** A lease long enough that nothing in this suite outlives it by accident. */
const LEASE_SECONDS = 300;

const db = useTestDb({ orgs: [ORG] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    otherOrgStore = createJobStore({ sql, orgId: OTHER_ORG });
});

/**
 * Queues an unattributed job — the state every job written before accounts existed is in.
 * Attribution cases pass a real account explicitly.
 */
const queue = async (command: string, createdBy: string | null = null, target = { repo: null, executor: null }) => {
    const ref = await store.create(command, createdBy, target);
    if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
    return ref;
};

/**
 * Takes a job the whole way to a finished run that never reported a session — the driver died
 * before reporting, or a refused start took its minted session back. The verdict is `failed`, as those deaths are.
 */
const finishSessionless = async (
    command: string,
    createdBy: string | null = null,
    target: { repo: string | null; executor: string | null } = { repo: null, executor: null }
): Promise<string> => {
    const { id } = await mustCreate(store.create(command, createdBy, target));
    const claim = await store.claim('w1', LEASE_SECONDS);
    await store.complete(id, claim!.leaseToken, { status: 'failed', exitCode: null, output: 'died before reporting' });
    return id;
};

/**
 * Takes a job to a finished run that DID report a session — the state follow-up accepts, which
 * retry must also accept without resuming anything.
 */
const finishWithSession = async (
    command: string,
    target: { repo: string | null; executor: string | null } = { repo: null, executor: null }
): Promise<string> => {
    const { id } = await mustCreate(store.create(command, null, target));
    const claim = await store.claim('w1', LEASE_SECONDS);
    await store.session(id, claim!.leaseToken, SESSION);
    await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
    return id;
};

/** Chains a retry that MUST be created; the refusal branches get their own dedicated cases. */
const mustRetry = (id: string, userId: string | null): Promise<{ id: string }> =>
    store.createRetry(id, userId).then((ref) => {
        if (typeof ref === 'string') throw new Error(`createRetry refused: ${ref}`);
        return ref;
    });

/** Chains a follow-up that MUST be created, for the thread-shaped setups above. */
const mustFollowUp = (root: string, command: string, userId: string | null): Promise<{ id: string }> =>
    store.createFollowUp(root, command, userId).then((ref) => {
        if (typeof ref === 'string') throw new Error(`createFollowUp refused: ${ref}`);
        return ref;
    });

describe.skipIf(!enabled)('retries', () => {
    // The whole point of retry (issue #326): a finished run whose session was never reported is
    // recoverable in place. The new run is a
    // member of the SAME thread (same root, so the same worktree) and carries no session of its
    // own: it starts fresh.
    it('re-queues a sessionless finished run in the same thread, without a session', async () => {
        const id = await finishSessionless('retry me', null, { repo: 'acme/web', executor: 'main' });

        const retry = await mustRetry(id, null);

        expect(await store.get(retry.id)).toMatchObject({
            command: 'retry me',
            status: 'queued',
            followUpTo: null,
            sessionId: null,
            rootJobId: id,
            repo: 'acme/web',
            executor: 'main',
        });
        // A thread member, not a stray task: the whole-thread read includes it.
        const thread = await store.thread(id);
        expect(thread?.map((member) => member.id)).toContain(retry.id);
    });

    // The acceptance contract: the claim arrives as an ordinary fresh run — no session restored,
    // no command delivered into a transcript — while the worktree root keeps the thread together.
    it('delivers a retry claim with no session and no follow-up delivery', async () => {
        const id = await finishSessionless('retry me');

        const retry = await mustRetry(id, null);
        const claim = await store.claim('w1', LEASE_SECONDS);

        expect(claim).toMatchObject({
            id: retry.id,
            command: 'retry me',
            rootJobId: id,
            rootCommand: 'retry me',
            resumeSessionId: null,
            followUp: false,
            attempts: 1,
        });
    });

    /*
     * The issue's words: retry re-runs the THREAD HEAD's command — the newest member, the
     * chainHead rule — whatever member's id was asked. A thread whose last turn was a follow-up
     * retries the follow-up's command, not the root's.
     */
    it("re-runs the thread head's command, not the named member's", async () => {
        const root = await finishWithSession('root command');
        const head = await mustFollowUp(root, 'head command', null);
        const claim = await store.claim('w1', LEASE_SECONDS);
        expect(claim?.id).toBe(head.id);
        // The head's run dies sessionless — a refused start reports then takes its session back.
        await store.session(head.id, claim!.leaseToken, CHAIN);
        await store.session(head.id, claim!.leaseToken, null);
        await store.complete(head.id, claim!.leaseToken, { status: 'failed', exitCode: null, output: 'died' });

        const retry = await mustRetry(root, null);

        expect(await store.get(retry.id)).toMatchObject({ command: 'head command', rootJobId: root });
    });

    // Retry never refuses for having a session, and never resumes one: it is the fresh-attempt
    // action, whatever the finished run reported. (Follow-up is the resume action.)
    it('retries a finished run that has a session, without resuming it', async () => {
        const id = await finishWithSession('drive me');

        const retry = await mustRetry(id, null);
        const claim = await store.claim('w1', LEASE_SECONDS);

        expect(claim).toMatchObject({ id: retry.id, resumeSessionId: null, followUp: false });
    });

    // A moving run is not over: its own attempt still owns the turn. Two rows, one claim: the
    // FIFO claim takes the OLDER row, so after the claim `first` is running and `second` is
    // still queued — both refusal shapes in one test.
    it('refuses a retry on a task that is still moving', async () => {
        const { id: first } = await queue('echo hi');
        const { id: second } = await queue('echo hi too');
        await store.claim('w1', LEASE_SECONDS);

        expect(await store.createRetry(first, null)).toBe('not_finished');
        expect(await store.createRetry(second, null)).toBe('not_finished');
    });

    // Eligibility is the THREAD HEAD's, not the named row's: the retry re-runs the head's
    // command, so a head that is still queued or running owns the turn whoever was asked.
    it('refuses a retry while the thread head is still queued', async () => {
        const root = await finishWithSession('drive me');
        await mustFollowUp(root, 'queued adjustment', null);

        expect(await store.createRetry(root, null)).toBe('not_finished');
    });

    it('refuses a retry while the thread head is still running', async () => {
        const root = await finishWithSession('drive me');
        const followUp = await mustFollowUp(root, 'running adjustment', null);
        const claim = await store.claim('w1', LEASE_SECONDS);
        expect(claim?.id).toBe(followUp.id);

        expect(await store.createRetry(root, null)).toBe('not_finished');
    });

    // The done is the THREAD's: one member carrying done_at closes the whole conversation to
    // retries, even when the asked member itself was never marked.
    it('refuses a retry on a thread whose done landed on another member', async () => {
        const root = await finishWithSession('drive me');
        const followUp = await mustFollowUp(root, 'again', null);
        const claim = await store.claim('w1', LEASE_SECONDS);
        expect(claim?.id).toBe(followUp.id);
        // The follow-up's run dies sessionless — retry's own acceptance shape.
        await store.session(followUp.id, claim!.leaseToken, null);
        await store.complete(followUp.id, claim!.leaseToken, { status: 'failed', exitCode: null, output: 'died' });

        await store.markDone(root, null);

        expect(await store.createRetry(followUp.id, null)).toBe('task_done');
    });

    // A moving head means the thread is not over: not_finished (retry later) outranks the
    // older member's task_done, which a reopen can still clear.
    it('prefers not_finished over task_done when the head is moving', async () => {
        const root = await finishWithSession('drive me');
        await mustFollowUp(root, 'still queued', null);
        await store.markDone(root, null);

        expect(await store.createRetry(root, null)).toBe('not_finished');
    });

    it('refuses a retry on a task the user has marked done', async () => {
        const id = await finishSessionless('echo hi');
        await store.markDone(id, null);

        expect(await store.createRetry(id, null)).toBe('task_done');
    });

    // Author-scoped like follow-up: a retry runs in the author's checkout tree (the thread's
    // worktree lives there), so a member's command may only ever retry their own task.
    it('refuses a retry by anyone but the account that queued the task', async () => {
        const account = async (githubUserId: number, login: string): Promise<string> => {
            const [row] = await sql<{ id: string }[]>`
                insert into app_user (github_user_id, github_login) values (${githubUserId}, ${login})
                on conflict (github_user_id) do update set github_login = excluded.github_login
                returning id
            `;
            return row!.id;
        };
        const AUTHOR_A_GITHUB_ID = 6101;
        const AUTHOR_B_GITHUB_ID = 6102;
        const authorA = await account(AUTHOR_A_GITHUB_ID, 'retry-author-a');
        const authorB = await account(AUTHOR_B_GITHUB_ID, 'retry-author-b');
        const id = await finishSessionless('drive me', authorA);

        expect(await store.createRetry(id, authorB)).toBe('forbidden');
        // A caller with no account cannot claim a task that has one.
        expect(await store.createRetry(id, null)).toBe('forbidden');
        expect(await store.createRetry(id, authorA)).toMatchObject({ id: expect.any(String) });
    });

    it('separates a missing task from a refused retry', async () => {
        const id = await finishSessionless('echo hi');

        expect(await store.createRetry(ABSENT, null)).toBe('missing');
        expect(await otherOrgStore.createRetry(id, null)).toBe('missing');
    });

    // The head's frozen workflow_name (033) is one of the copied labels: a retried workflow
    // thread's turn carries the name the member chose at create. Stamped straight onto the row
    // here — the copy is the behavior under test, not the workflow machinery that normally
    // writes it.
    it("carries the thread head's workflow name onto the retry row", async () => {
        const id = await finishSessionless('retry the flow');
        await sql`update job set workflow_name = 'my-flow' where id = ${id}`;

        const retry = await mustRetry(id, null);

        expect(await store.get(retry.id)).toMatchObject({ workflowName: 'my-flow' });
    });

    // The per-thread advisory lock is the codebase's one serialization point (claim, remove,
    // reopen, done all take it): the retry's eligibility check and its insert must be atomic
    // with a racing done on any member, or a done could commit between the check and the
    // insert and leave a fresh attempt queued into a closed thread.
    it('blocks a retry while another transaction holds the thread lock', async () => {
        const root = await finishSessionless('retry me');

        let lockTaken: (() => void) | null = null;
        const locked = new Promise<void>((resolve) => {
            lockTaken = resolve;
        });
        let release: (() => void) | null = null;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const blocker = sql.begin(async (tx) => {
            await tx`select pg_advisory_xact_lock(hashtextextended(${root}::text, 0))`;
            lockTaken!();
            await held;
        });
        blocker.catch(() => {});
        await locked;

        // The timer is the assertion device, the same one the follow-ups lock tests use:
        // the retry must still be waiting when it fires.
        const retry = store.createRetry(root, null);
        const STILL_LOCKED_TIMEOUT_MS = 450;
        const outcome = await Promise.race([
            retry,
            new Promise<string>((resolve) => setTimeout(() => resolve('still_locked'), STILL_LOCKED_TIMEOUT_MS)),
        ]);
        expect(outcome).toBe('still_locked');

        release!();
        await blocker;
        expect(await retry).toMatchObject({ id: expect.any(String) });
    });
});
