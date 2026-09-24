import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { useTestDb } from './harness.js';

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
/** A second session, for proving a follow-up chains the NEWEST session and not the root's. */
const CHAIN = '55555555-5555-4555-8555-555555555555';
/** Shaped like a real one: opaque, prefixed, and not a uuid. */
/** A lease long enough that nothing in this suite outlives it by accident. */
const LEASE_SECONDS = 300;

/**
 * The env-forwarding cases write env_var rows, whose org is foreign-keyed — hence the seeded org.
 * `max: 8` is higher than the app pool's 4: the claim exclusivity test needs real parallelism,
 * and a pool of two would serialise it into a test that passes for the wrong reason.
 */
const db = useTestDb({ max: 8, orgs: [ORG] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    otherOrgStore = createJobStore({ sql, orgId: OTHER_ORG });
});

/**
 * Queues an unattributed job — the state every job written before accounts existed is in.
 *
 * `created_by` is a required parameter rather than an optional one, so that the route has to name
 * the authenticated caller rather than defaulting quietly; these cases are about leases, not
 * attribution, so they pass null explicitly. The attribution cases below pass a real account.
 */
const queue = (command: string) => store.create(command, null, { repo: null, executor: null });

/**
 * Chains a follow-up that MUST be created. The refusal branches get their own dedicated cases
 * below; everywhere else a refusal is a failure of the setup, so it throws instead of hiding in
 * the union the store honestly returns.
 */
const mustFollowUp = (root: string, command: string, userId: string | null): Promise<{ id: string }> =>
    store.createFollowUp(root, command, userId).then((ref) => {
        if (typeof ref === 'string') throw new Error(`createFollowUp refused: ${ref}`);
        return ref;
    });

/** Reads the stamped moment off a markDone answer, refusing the refusal strings. */
const doneAt = (result: Awaited<ReturnType<JobStore['markDone']>>): string => {
    if (typeof result === 'string') throw new Error(`markDone refused: ${result}`);
    return result.doneAt;
};

/** Ages a lease into the past. Deterministic where sleeping for a one-second lease is not. */
const expireLease = (id: string) => sql`update job set lease_expires_at = now() - interval '1 second' where id = ${id}`;

const row = (id: string) =>
    sql<{ status: string; attempts: number; claimed_by: string | null; started_at: Date | null }[]>`
        select status, attempts, claimed_by, started_at from job where id = ${id}
    `;
describe.skipIf(!enabled)('follow-ups and done', () => {
    /**
     * Takes a job the whole way to a finished run, reporting a session on the way — the state a
     * task is in when its executor has stopped talking and a human is looking at the output. The
     * follow-up mechanic and the done button both start from exactly here.
     */
    const finishWithSession = async (
        command: string,
        target: { repo: string | null; executor: string | null } = { repo: null, executor: null }
    ): Promise<string> => {
        const { id } = await store.create(command, null, target);
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.session(id, claim!.leaseToken, SESSION);
        await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        return id;
    };

    // The follow-up must arrive at the worker as a continuation of the conversation so far: the
    // parent's session is what makes "ask for an adjustment" mean anything to the agent.
    it('creates a follow-up that continues the parent session and links to it', async () => {
        const parent = await finishWithSession('drive me');

        const followUp = await mustFollowUp(parent, 'now adjust the tone', null);

        expect(await store.get(followUp.id)).toMatchObject({
            command: 'now adjust the tone',
            status: 'queued',
            followUpTo: parent,
            sessionId: SESSION,
            doneAt: null,
        });
    });

    // A stopped parent is a finished turn, not a dead end: the stop kept the session, so the
    // conversation continues from exactly where the user ended it.
    it('creates a follow-up on a task the user stopped', async () => {
        const { id } = await store.create('drive me', null, { repo: null, executor: null });
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.session(id, claim!.leaseToken, SESSION);
        await store.stop(id, null);
        expect(await store.suspend(id, claim!.leaseToken)).toEqual({ result: 'ok', status: 'stopped' });
        expect((await store.get(id))?.status).toBe('stopped');

        const followUp = await mustFollowUp(id, 'pick up where I left you', null);

        expect(await store.get(followUp.id)).toMatchObject({ followUpTo: id, sessionId: SESSION });
    });

    // The thread keeps its tab AND its runner: the follow-up renders in the parent's repository
    // view and is bound to the executor that ran the task — the board copies it at insert, and
    // no body can retarget it (a conversation switching executors mid-thread is exactly the
    // cross-CLI resume nothing can do).
    it('inherits the parent repo and the parent executor', async () => {
        const parent = await finishWithSession('drive me', { repo: 'acme/web', executor: 'main' });

        const followUp = await mustFollowUp(parent, 'again, tighter', null);

        expect(await store.get(followUp.id)).toMatchObject({ repo: 'acme/web', executor: 'main' });
    });

    /*
     * The per-task worktree (issue #35) is keyed by the thread's ROOT job id, so every attempt
     * and every follow-up of one task lands in the same tree. The claim is where the board
     * tells the driver which thread it is handing out.
     */
    it('claims with the job itself as the thread root when it is not a follow-up', async () => {
        const { id } = await queue('echo hi');

        const claim = await store.claim('w1', LEASE_SECONDS);

        expect(claim?.rootJobId).toBe(id);
    });

    it('claims a follow-up — and a follow-up of a follow-up — with the thread root as the root', async () => {
        const root = await finishWithSession('drive me', { repo: 'acme/web', executor: null });
        const child = await mustFollowUp(root, 'adjust the tone', null);

        // Finish the child so the grandchild can attach to it.
        const childClaim = await store.claim('w1', LEASE_SECONDS);
        expect(childClaim?.id).toBe(child.id);
        await store.complete(child.id, childClaim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const grand = await mustFollowUp(child.id, 'again, tighter', null);

        // The child is finished too, so the grandchild is the only claimable row.
        const grandClaim = await store.claim('w2', LEASE_SECONDS);
        expect(grandClaim?.id).toBe(grand.id);
        // NOT the child's id and NOT the grandchild's own: the thread's root.
        expect(grandClaim?.rootJobId).toBe(root);
    });

    /*
     * The publisher closes the issue the TASK names, and the task is named by its first command:
     * a follow-up that publishes ("both OK") must still close the root's `/fix 122`.
     */
    it("claims with the thread root's command, the job's own when it is the root", async () => {
        const root = await finishWithSession('/fix 122', { repo: 'acme/web', executor: null });
        const child = await mustFollowUp(root, 'both OK', null);

        const claim = await store.claim('w1', LEASE_SECONDS);

        expect(claim?.id).toBe(child.id);
        expect(claim?.command).toBe('both OK');
        expect(claim?.rootCommand).toBe('/fix 122');

        const { id } = await queue('echo hi');
        await store.complete(child.id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const own = await store.claim('w2', LEASE_SECONDS);
        expect(own?.id).toBe(id);
        expect(own?.rootCommand).toBe('echo hi');
    });

    // A moving job belongs to its worker and its run is not over; a follow-up on one would race it.
    it('refuses a follow-up on a job that is still moving', async () => {
        const { id } = await queue('echo hi');
        await store.claim('w1', LEASE_SECONDS);

        expect(await store.createFollowUp(id, 'again', null)).toBe('not_finished');
    });

    it('refuses a follow-up on a task the user has marked done', async () => {
        const parent = await finishWithSession('echo hi');
        await store.markDone(parent, null);

        expect(await store.createFollowUp(parent, 'again', null)).toBe('task_done');
    });

    // The done button and a follow-up can overlap on the same finished task, and both statements
    // touch the parent row. Unless the follow-up's insert takes that row's lock, both succeed —
    // a done parent left with queued follow-up work instead of a `task_done` answer. Holding the
    // lock the way a racing markDone would must hold the insert up too; whoever commits first
    // wins, and the loser decides against the row's newest committed version.
    it('blocks a follow-up while another request holds the parent row', async () => {
        const parent = await finishWithSession('drive me');

        let lockTaken: (() => void) | null = null;
        const locked = new Promise<void>((resolve) => {
            lockTaken = resolve;
        });
        let release: (() => void) | null = null;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const blocker = sql.begin(async (tx) => {
            await tx`select id from job where id = ${parent} for update`;
            lockTaken!();
            await held;
        });
        blocker.catch(() => {});
        await locked;

        // The timer is the assertion device: the follow-up must still be waiting when it fires,
        // not deciding against a snapshot taken before the lock was even taken.
        const followUp = store.createFollowUp(parent, 'again', null);
        const STILL_LOCKED_TIMEOUT_MS = 450;
        const outcome = await Promise.race([
            followUp,
            new Promise<string>((resolve) => setTimeout(() => resolve('still_locked'), STILL_LOCKED_TIMEOUT_MS)),
        ]);
        expect(outcome).toBe('still_locked');

        release!();
        await blocker;
        // The held-up insert lands once the lock frees, and a done after it still works — the
        // sequential follow-up-then-done outcome the lock makes the only possible ordering.
        expect(await followUp).toMatchObject({ id: expect.any(String) });
        expect(await store.markDone(parent, null)).toMatchObject({ status: 'succeeded' });
    });

    // Without a session on the parent there is nothing to continue — an opencode run, for one, or a
    // claude-code run that died before its driver could report. Running the follow-up fresh would
    // look like a continuation while starting from nothing.
    it('refuses a follow-up on a run the board never saw a session for', async () => {
        const { id } = await queue('echo hi');
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: null });

        expect(await store.createFollowUp(id, 'again', null)).toBe('no_session');
    });

    // The child inherits the parent's session, and a session resumes only in the checkout tree it
    // ran in — the author's. A member's command may only ever run in their own tree, so a
    // follow-up by anyone else would either run their command in the author's tree or resume the
    // conversation in their own; both are refused, and only the author may follow their task up.
    it('refuses a follow-up by anyone but the account that queued the task', async () => {
        const account = async (githubUserId: number, login: string): Promise<string> => {
            const [row] = await sql<{ id: string }[]>`
                insert into app_user (github_user_id, github_login) values (${githubUserId}, ${login})
                on conflict (github_user_id) do update set github_login = excluded.github_login
                returning id
            `;
            return row!.id;
        };
        const AUTHOR_A_GITHUB_ID = 6001;
        const AUTHOR_B_GITHUB_ID = 6002;
        const authorA = await account(AUTHOR_A_GITHUB_ID, 'author-a');
        const authorB = await account(AUTHOR_B_GITHUB_ID, 'author-b');
        const { id: parent } = await store.create('drive me', authorA, { repo: null, executor: null });
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.session(parent, claim!.leaseToken, SESSION);
        await store.complete(parent, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });

        expect(await store.createFollowUp(parent, 'again', authorB)).toBe('forbidden');
        // A caller with no account — the route tests' no-auth-store shape — cannot claim a task
        // that has one. The author's own follow-up still lands.
        expect(await store.createFollowUp(parent, 'again', null)).toBe('forbidden');
        expect(await store.createFollowUp(parent, 'again', authorA)).toMatchObject({ id: expect.any(String) });
    });

    it('separates a missing parent from a refused follow-up', async () => {
        const id = await finishWithSession('echo hi');

        expect(await store.createFollowUp(ABSENT, 'again', null)).toBe('missing');
        expect(await otherOrgStore.createFollowUp(id, 'again', null)).toBe('missing');
    });

    /**
     * The chain IS the conversation: the thread read returns the root and every adjustment,
     * oldest first, whichever member's id was asked — the UI keeps one task per conversation, so
     * a member deep in the thread must resolve to the same view.
     */
    it('reads the whole follow-up chain from any member of it', async () => {
        const parent = await finishWithSession('drive me');
        const first = await mustFollowUp(parent, 'first adjustment', null);
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.session(first.id, claim!.leaseToken, SESSION);
        await store.complete(first.id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: null });
        const second = await mustFollowUp(first.id, 'second adjustment', null);

        for (const member of [parent, first.id, second.id]) {
            const chain = await store.thread(member);
            expect(chain?.map((task) => task.command)).toEqual(['drive me', 'first adjustment', 'second adjustment']);
        }

        // And the org guard holds: another org's store reads nothing of this conversation.
        expect(await otherOrgStore.thread(parent)).toBeNull();
        expect(await store.thread(ABSENT)).toBeNull();
    });

    /**
     * The thread's PR-review wait (036) is a property of the ROOT, and every member of the
     * conversation must read the same one — the task view renders whichever member it is looking
     * at. Open first, then terminal, exactly as the read model's own contract states.
     */
    it("carries the thread's PR-review wait on every member — open, then terminal, then none", async () => {
        const parent = await finishWithSession('drive me');
        const first = await mustFollowUp(parent, 'first adjustment', null);
        const prLifecycle = createPrLifecycleStore({ sql, orgId: ORG });

        for (const member of [parent, first.id]) {
            const chain = await store.thread(member);
            for (const job of chain!) {
                expect(job.waitReason).toBeNull();
                expect(job.waitingSince).toBeNull();
                expect(job.waitTerminalReason).toBeNull();
            }
        }

        await prLifecycle.enterWait({ root: parent, reason: 'review', repo: 'acme/widgets', prNumber: 7 });
        for (const member of [parent, first.id]) {
            const chain = await store.thread(member);
            for (const job of chain!) {
                expect(job.waitReason).toBe('review');
                expect(job.waitingSince).not.toBeNull();
                expect(job.waitTerminalReason).toBeNull();
            }
        }

        await prLifecycle.finishWait(parent, 'review', 'exhausted');
        for (const member of [parent, first.id]) {
            const chain = await store.thread(member);
            for (const job of chain!) {
                expect(job.waitReason).toBe('review');
                expect(job.waitTerminalReason).toBe('exhausted');
            }
        }
    });

    // The whole point: the worker gets the parent session back AND the new command to deliver
    // into it — restore and continue, not just restore.
    it('hands a follow-up claim the parent session and the command to deliver', async () => {
        const parent = await finishWithSession('drive me');
        const { id } = await mustFollowUp(parent, 'again', null);

        const claim = await store.claim('w1', LEASE_SECONDS);

        expect(claim).toMatchObject({ id, resumeSessionId: SESSION, followUp: true });
    });

    // A STOPPED parent's follow-up claim carries the same pair (issue #152): the stop kept the
    // session, and the follow-up is the restart-with-a-new-prompt — the claim resumes exactly
    // the conversation the user ended.
    it('hands a follow-up claim of a stopped task the parent session and the command to deliver', async () => {
        const { id: parent } = await store.create('drive me', null, { repo: null, executor: null });
        const parked = await store.claim('w1', LEASE_SECONDS);
        await store.session(parent, parked!.leaseToken, SESSION);
        await store.stop(parent, null);
        expect(await store.suspend(parent, parked!.leaseToken)).toEqual({ result: 'ok', status: 'stopped' });

        const { id } = await mustFollowUp(parent, 'again', null);

        expect(await store.claim('w2', LEASE_SECONDS)).toMatchObject({ id, resumeSessionId: SESSION, followUp: true });
    });

    // A crashed follow-up attempt re-claims with the session kept and the command re-delivered:
    // the conversation survives the crash, and the adjustment still reaches the agent.
    it('re-delivers the command when a follow-up attempt is reclaimed', async () => {
        const parent = await finishWithSession('drive me');
        const { id } = await mustFollowUp(parent, 'again', null);
        await store.claim('w1', LEASE_SECONDS);
        await expireLease(id);

        const second = await store.claim('w2', LEASE_SECONDS);

        expect(second).toMatchObject({ id, attempts: 2, resumeSessionId: SESSION, followUp: true });
    });

    // The task is done when the user says so — a verdict no run can make and nobody can take back
    // by saying it twice.
    // The repeat half of "rinse and repeat": a follow-up is itself a finished task with a session
    // once its run ends, so the conversation chains — and it chains through the follow-up's OWN
    // session (whatever its run reported), never by reaching back to the root's.
    it('follows up on a follow-up, chaining the newest session', async () => {
        const parent = await finishWithSession('drive me');
        const first = await mustFollowUp(parent, 'first adjustment', null);
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.session(first.id, claim!.leaseToken, CHAIN);
        await store.complete(first.id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: null });

        const second = await mustFollowUp(first.id, 'second adjustment', null);

        expect(await store.get(second.id)).toMatchObject({
            followUpTo: first.id,
            sessionId: CHAIN,
            status: 'queued',
        });
        // The served root: the grandchild wears the ROOT's id, not its immediate parent's, so any
        // member resolves to the whole conversation without a walk (022).
        expect((await store.get(second.id))?.rootJobId).toBe(parent);
        expect((await store.get(first.id))?.rootJobId).toBe(parent);
        expect((await store.get(parent))?.rootJobId).toBe(parent);
    });

    it('marks a finished task done and answers the same moment twice', async () => {
        const parent = await finishWithSession('echo hi');

        // Same moment twice: the second call finds the task already done and answers the stored
        // timestamp again, so the timestamps here are read off the same shape both times.
        const first = doneAt(await store.markDone(parent, null));
        const second = doneAt(await store.markDone(parent, null));

        expect(second).toBe(first);
        expect((await store.get(parent))?.doneAt).toBe(first);
    });

    it('refuses to mark a moving task done, and to mark an absent one', async () => {
        const { id: queued } = await queue('echo hi');

        expect(await store.markDone(queued, null)).toBe('conflict');
        expect(await store.markDone(ABSENT, null)).toBe('missing');
    });

    /**
     * Done is what frees the tree (issue #47, revised): a thread that failed or finished keeps
     * its worktree until the user closes it. The done queues the reclaim itself when the thread
     * is already terminal; a thread still moving waits for its last completing verdict, which
     * finds the done in place (the case pinned in the done-ness describe below).
     */
    describe('done queues the worktree reclaim', () => {
        const reclaimRows = (rootJobId: string) =>
            sql<{ root_job_id: string; repo: string | null; workspace_path: string | null }[]>`
                select root_job_id, repo, workspace_path from task_reclaim
                where org_id = ${ORG} and root_job_id = ${rootJobId}
            `;

        it('queues a reclaim for an already-terminal thread, addressed by the root', async () => {
            const root = await finishWithSession('drive me', { repo: 'acme/web', executor: null });
            const followUp = await mustFollowUp(root, 'first adjustment', null);
            const claim = await store.claim('w1', LEASE_SECONDS);
            expect(claim?.id).toBe(followUp.id);
            await store.complete(followUp.id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: null });

            await store.markDone(followUp.id, null);

            const rows = await reclaimRows(root);
            expect(rows).toHaveLength(1);
            // The root row carries the labels the driver removes the tree by — the same fields
            // removeThread queues. No author here, so no workspace path.
            expect(rows[0]).toMatchObject({ repo: 'acme/web', workspace_path: null });
        });

        it('keeps the tree for a failed thread nobody closed', async () => {
            const { id } = await queue('drive me');
            const claim = await store.claim('w1', LEASE_SECONDS);
            await store.complete(id, claim!.leaseToken, { status: 'failed', exitCode: 1, output: 'boom' });

            expect(await reclaimRows(id)).toHaveLength(0);
        });

        // A stopped member is terminal for exactly the same machinery: done closes the thread and
        // frees the tree, with no special case for the user's own verdict.
        it('queues a reclaim for a thread whose member the user stopped', async () => {
            const root = await finishWithSession('drive me', { repo: 'acme/web', executor: null });
            const followUp = await mustFollowUp(root, 'first adjustment', null);
            const claim = await store.claim('w1', LEASE_SECONDS);
            expect(claim?.id).toBe(followUp.id);
            await store.session(followUp.id, claim!.leaseToken, SESSION);
            await store.stop(followUp.id, null);
            expect(await store.suspend(followUp.id, claim!.leaseToken)).toEqual({ result: 'ok', status: 'stopped' });

            await store.markDone(followUp.id, null);

            const rows = await reclaimRows(root);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ repo: 'acme/web' });
        });

        it('keeps the tree when a follow-up is still queued, and the verdict reclaims it later', async () => {
            const root = await finishWithSession('drive me');
            await mustFollowUp(root, 'first adjustment', null);

            await store.markDone(root, null);

            // Not all terminal — the done queues nothing. The follow-up's completing attempt
            // finds the done and the terminality together (the done-ness describe pins that
            // answer), and the driver's verdict-time reclaim takes the tree there.
            expect(await reclaimRows(root)).toHaveLength(0);
        });

        it('does not queue a second reclaim when the thread is marked done again', async () => {
            const root = await finishWithSession('echo hi');

            await store.markDone(root, null);
            await store.markDone(root, null);

            expect(await reclaimRows(root)).toHaveLength(1);
        });
    });

    /**
     * The verdict's answer to the driver's worktree reclaim (issue #47, revised): whether the
     * thread is DONE — every member terminal AND the user's done on one of them — computed in
     * the same transaction as the verdict itself. A thread that merely finished keeps its tree;
     * this is the credential fix too — the driver used to read the answer off
     * `GET /api/jobs/:id/thread`, a route a worker token has no business on (docs/auth.md).
     */
    describe('the verdict carries the thread done-ness', () => {
        it('answers false for a terminal thread nobody closed', async () => {
            const { id } = await queue('echo hi');
            const claim = await store.claim('w1', LEASE_SECONDS);

            const result = await store.complete(id, claim!.leaseToken, {
                status: 'succeeded',
                exitCode: 0,
                output: null,
            });

            expect(result).toEqual({ result: 'ok', threadDone: false });
        });

        it('answers false while a follow-up is still queued, even with no done', async () => {
            const root = await finishWithSession('drive me');
            // Two adjustments on one parent: the shape the thread walk already contemplates.
            // A linear chain cannot hold a queued member at a verdict moment — the follow-up
            // only exists once the parent is finished.
            const first = await mustFollowUp(root, 'first adjustment', null);
            const second = await mustFollowUp(root, 'second adjustment', null);

            const firstClaim = await store.claim('w1', LEASE_SECONDS);
            expect(firstClaim?.id).toBe(first.id);
            const whileQueued = await store.complete(first.id, firstClaim!.leaseToken, {
                status: 'succeeded',
                exitCode: 0,
                output: null,
            });
            expect(whileQueued).toEqual({ result: 'ok', threadDone: false });

            const secondClaim = await store.claim('w2', LEASE_SECONDS);
            expect(secondClaim?.id).toBe(second.id);
            const afterBoth = await store.complete(second.id, secondClaim!.leaseToken, {
                status: 'succeeded',
                exitCode: 0,
                output: null,
            });
            // All terminal now, but nobody has closed the thread — the tree stays.
            expect(afterBoth).toEqual({ result: 'ok', threadDone: false });
        });

        it('answers true for a verdict that completes a thread the user already closed', async () => {
            // The done landed while a follow-up still moved — done on the root, thread not
            // terminal yet, so the queue insert at done skipped it and the completing attempt
            // is the one that finds done AND terminal together.
            const root = await finishWithSession('drive me');
            const followUp = await mustFollowUp(root, 'first adjustment', null);
            expect(await store.markDone(root, null)).toMatchObject({ status: 'succeeded' });

            const followUpClaim = await store.claim('w1', LEASE_SECONDS);
            expect(followUpClaim?.id).toBe(followUp.id);
            const result = await store.complete(followUp.id, followUpClaim!.leaseToken, {
                status: 'succeeded',
                exitCode: 0,
                output: null,
            });

            expect(result).toEqual({ result: 'ok', threadDone: true });
        });

        it('counts a dead member as terminal', async () => {
            const { id } = await queue('drive me');
            await sql`update job set max_attempts = 1 where id = ${id}`;
            const claim = await store.claim('w1', LEASE_SECONDS);
            // Reported before the job dies, or the follow-up would have nothing to continue.
            await store.session(id, claim!.leaseToken, SESSION);
            await expireLease(id);
            expect(await store.claim('w2', LEASE_SECONDS)).toBeNull();
            expect((await row(id))[0]?.status).toBe('dead');

            const followUp = await mustFollowUp(id, 'again', null);
            const followUpClaim = await store.claim('w3', LEASE_SECONDS);
            expect(followUpClaim?.id).toBe(followUp.id);
            const result = await store.complete(followUp.id, followUpClaim!.leaseToken, {
                status: 'succeeded',
                exitCode: 0,
                output: null,
            });

            // `dead` is the board giving up, not work continuing — but nobody closed the thread,
            // so the tree still waits for a done.
            expect(result).toEqual({ result: 'ok', threadDone: false });
        });

        it('refuses a completion carrying a lease token that is not the holder', async () => {
            const { id } = await queue('echo hi');
            await store.claim('w1', LEASE_SECONDS);

            const result = await store.complete(id, ABSENT, {
                status: 'succeeded',
                exitCode: 0,
                output: null,
            });

            expect(result).toEqual({ result: 'lost' });
        });
    });
});
