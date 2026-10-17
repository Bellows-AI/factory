import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';
import { account, expireLease, mustCreate, randomGithubId, testOrg } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
/** A second store on the same pool, bound to a different org. Only the org guard uses it. */
let otherOrgStore: JobStore;

const ORG = testOrg();
const OTHER_ORG = testOrg();
/** A well-formed uuid, only ever used where the job or the lease is expected not to exist. */
const ABSENT = randomUUID();
const SESSION = randomUUID();
/** A second session, for proving the head is the member a retry re-runs. */
const CHAIN = randomUUID();
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
    target: { repo: string | null; executor: string | null } = { repo: null, executor: null },
    createdBy: string | null = null
): Promise<string> => {
    const { id } = await mustCreate(store.create(command, createdBy, target));
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

    // Recovery keeps the session on the row it recovers (issue #822); the explicit fresh retry is
    // still a new row with none, however the head's run was recovered on the way.
    it('starts a retry fresh after a recovered attempt', async () => {
        const { id } = await mustCreate(store.create('drive me', null, { repo: null, executor: null }));
        const lost = await store.claim('w1', LEASE_SECONDS);
        await store.session(id, lost!.leaseToken, SESSION);
        await expireLease(sql, id);
        const recovered = await store.claim('w2', LEASE_SECONDS);
        expect(recovered).toMatchObject({ id, resumeSessionId: SESSION });
        await store.complete(id, recovered!.leaseToken, { status: 'failed', exitCode: 1, output: 'no' });

        const retry = await mustRetry(id, null);
        const claim = await store.claim('w1', LEASE_SECONDS);

        expect(claim).toMatchObject({ id: retry.id, resumeSessionId: null, followUp: false });
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
});

/*
 * Follow-up and retry answer one thread-eligibility contract (#698), so each rule runs for both.
 * Every op finishes its task its own way — follow-up from a run that reported a session, retry from
 * one that never did (its own acceptance shape) — except where a rule needs a thread of two.
 * The per-thread advisory lock both take is pinned with the other lock waits, in
 * job-store.follow-ups.test.ts.
 */
describe.skipIf(!enabled).each([
    {
        op: 'follow-up',
        call: (target: JobStore, id: string, by: string | null, command = 'again') =>
            target.createFollowUp(id, command, by),
        finish: (command: string, createdBy: string | null = null) => finishWithSession(command, undefined, createdBy),
    },
    {
        op: 'retry',
        call: (target: JobStore, id: string, by: string | null) => target.createRetry(id, by),
        finish: (command: string, createdBy: string | null = null) => finishSessionless(command, createdBy),
    },
])('a $op refuses the thread alike', ({ call, finish }) => {
    const run = (id: string, by: string | null, command?: string) => call(store, id, by, command);
    const threadSize = async (root: string) => {
        const [row] = await sql<{ n: number }[]>`
            select count(*)::int as n from job where org_id = ${ORG} and root_job_id = ${root}
        `;
        return row!.n;
    };
    /** A root and a finished follow-up head: a thread of two, both terminal, neither done. */
    const finishedThread = async () => {
        const root = await finishWithSession('drive me');
        const head = await mustFollowUp(root, 'adjust', null);
        const claim = await store.claim('w1', LEASE_SECONDS);
        expect(claim?.id).toBe(head.id);
        await store.complete(head.id, claim!.leaseToken, { status: 'failed', exitCode: null, output: 'died' });
        return { root, head: head.id };
    };

    // A moving run is not over: its own attempt still owns the turn. Two rows, one claim: the
    // FIFO claim takes the OLDER row, so after the claim `first` is running and `second` is
    // still queued — both refusal shapes in one test.
    it('refuses a task that is still moving', async () => {
        const { id: first } = await queue('echo hi');
        const { id: second } = await queue('echo hi too');
        await store.claim('w1', LEASE_SECONDS);

        expect(await run(first, null)).toBe('not_finished');
        expect(await run(second, null)).toBe('not_finished');
    });

    // Eligibility is the THREAD's, not the named row's: a finished member whose thread still
    // holds a queued or running member refuses, so a keyless repeat never queues a second turn.
    it('refuses a finished member while a newer one is still queued', async () => {
        const root = await finishWithSession('drive me');
        await mustFollowUp(root, 'first adjustment', null);

        expect(await run(root, null, 'first adjustment')).toBe('not_finished');
        expect(await threadSize(root)).toBe(2);
    });

    it('refuses a finished member while the thread head is still running', async () => {
        const root = await finishWithSession('drive me');
        const followUp = await mustFollowUp(root, 'running adjustment', null);
        const claim = await store.claim('w1', LEASE_SECONDS);
        expect(claim?.id).toBe(followUp.id);

        expect(await run(root, null)).toBe('not_finished');
    });

    // The rule is "any member unfinished", not "the head unfinished".
    it('refuses a finished head while an older member is unfinished', async () => {
        const { root, head } = await finishedThread();
        // Crafted: no write path reaches it, since every insert into a thread needs a terminal head.
        await sql`update job set status = 'running' where id = ${root}`;

        expect(await run(head, null)).toBe('not_finished');
        expect(await threadSize(root)).toBe(2);
    });

    // A moving thread means it is not over: not_finished (try later) outranks the older
    // member's task_done, which a reopen can still clear.
    it('answers not_finished before task_done for a done thread that is still moving', async () => {
        const root = await finishWithSession('drive me');
        await mustFollowUp(root, 'still queued', null);
        await store.markDone(root, null);

        expect(await run(root, null)).toBe('not_finished');
    });

    it('refuses a task the user has marked done', async () => {
        const id = await finish('echo hi');
        await store.markDone(id, null);

        expect(await run(id, null)).toBe('task_done');
    });

    // The done is the THREAD's: one member carrying done_at closes the whole conversation, even
    // when the asked member itself was never marked — and a reopen, which clears every member,
    // opens it again.
    it('refuses a member of a thread whose done landed on another member, until a reopen', async () => {
        const { root, head } = await finishedThread();
        await store.markDone(root, null);

        expect(await run(head, null)).toBe('task_done');
        expect(await threadSize(root)).toBe(2);

        expect(await store.reopen(root)).toEqual({ result: 'ok' });
        expect(await run(head, null)).toMatchObject({ id: expect.any(String) });
        expect(await threadSize(root)).toBe(3);
    });

    // Author-scoped: the thread's worktree and session live in the author's checkout tree, so a
    // member's command may only ever continue or re-run their own task.
    it('refuses anyone but the account that queued the task', async () => {
        const authorA = await account(sql, randomGithubId(), 'author-a');
        const authorB = await account(sql, randomGithubId(), 'author-b');
        const id = await finish('drive me', authorA);

        expect(await run(id, authorB)).toBe('forbidden');
        // A caller with no account — the route tests' no-auth-store shape — cannot claim a task
        // that has one. The author's own still lands.
        expect(await run(id, null)).toBe('forbidden');
        expect(await run(id, authorA)).toMatchObject({ id: expect.any(String) });
    });

    it('separates a missing task from a refusal', async () => {
        const id = await finish('echo hi');

        expect(await run(ABSENT, null)).toBe('missing');
        expect(await call(otherOrgStore, id, null)).toBe('missing');
    });
});
