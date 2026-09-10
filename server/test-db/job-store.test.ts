import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { createJobStore, type JobStore } from '../src/db/job-store.js';
import { createEnvVarStore } from '../src/db/env-var-store.js';

const url = process.env.DATABASE_URL;

/**
 * This suite TRUNCATES the job table before every test. Requiring a `_test` database name is the
 * guard, because the failure is silent: the tests pass and the queue is simply gone.
 */
function assertTestDatabase(raw: string): void {
    const name = new URL(raw).pathname.replace(/^\//, '');
    if (!/_test$/.test(name)) {
        throw new Error(
            `Refusing to run: this suite truncates its tables, and "${name}" is not a test database.`,
        );
    }
}

const enabled = Boolean(url);
if (url) assertTestDatabase(url);

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
const REMOTE = 'cse_015tb2nHhHNrBuL7ZDhn9Wx5';

beforeAll(async () => {
    if (!enabled) return;
    // Higher than pr-store's `max: 2`: the claim exclusivity test needs real parallelism, and a
    // pool of two would serialise it into a test that passes for the wrong reason.
    sql = postgres(url as string, { max: 8 });
    await migrate(sql, { orgId: ORG, attempts: 3 });
    store = createJobStore({ sql, orgId: ORG });
    otherOrgStore = createJobStore({ sql, orgId: OTHER_ORG });
});

afterAll(async () => {
    if (enabled) await sql.end();
});

beforeEach(async () => {
    if (!enabled) return;
    await sql`truncate job`;
});

/**
 * Queues an unattributed job — the state every job written before accounts existed is in.
 *
 * `created_by` is a required parameter rather than an optional one, so that the route has to name
 * the authenticated caller rather than defaulting quietly; these cases are about leases, not
 * attribution, so they pass null explicitly. The attribution cases below pass a real account.
 */
const queue = (command: string) => store.create(command, null, { repo: null, executor: null });

/** Ages a lease into the past. Deterministic where sleeping for a one-second lease is not. */
const expireLease = (id: string) =>
    sql`update job set lease_expires_at = now() - interval '1 second' where id = ${id}`;

const row = (id: string) =>
    sql<{ status: string; attempts: number; claimed_by: string | null; started_at: Date | null }[]>`
        select status, attempts, claimed_by, started_at from job where id = ${id}
    `;

describe.skipIf(!enabled)('job store', () => {
    it('queues a job and reads it back', async () => {
        const { id } = await queue('echo hi');

        const job = await store.get(id);
        expect(job).toMatchObject({ command: 'echo hi', status: 'queued', attempts: 0, maxAttempts: 3 });
        expect(job?.startedAt).toBeNull();
    });

    it('hands a job to one claimer and holds it there while the lease is live', async () => {
        const { id } = await queue('echo hi');

        const first = await store.claim('w1', 300);
        expect(first).toMatchObject({ id, command: 'echo hi', attempts: 1, followUp: false });

        expect(await store.claim('w2', 300)).toBeNull();
        expect((await row(id))[0]).toMatchObject({ status: 'running', claimed_by: 'w1' });
    });

    it('takes the oldest job first', async () => {
        const { id: first } = await queue('first');
        const { id: second } = await queue('second');

        expect((await store.claim('w1', 300))?.id).toBe(first);
        expect((await store.claim('w2', 300))?.id).toBe(second);
    });

    it('reclaims an expired lease with a fresh token and a bumped attempt', async () => {
        const { id } = await queue('echo hi');
        const first = await store.claim('w1', 300);
        const firstStart = (await row(id))[0]?.started_at as Date;
        await expireLease(id);

        const second = await store.claim('w2', 300);

        expect(second).toMatchObject({ id, attempts: 2 });
        expect(second?.leaseToken).not.toBe(first?.leaseToken);
        // Reset per attempt, not kept from the first: otherwise every duration is measured from
        // the run that died.
        const secondStart = (await row(id))[0]?.started_at as Date;
        expect(secondStart.getTime()).toBeGreaterThan(firstStart.getTime());
    });

    // Without this a command that kills its worker is handed out again every time its lease
    // expires, forever, and one poison job permanently occupies a worker slot.
    it('gives up on a job that has burned its attempts', async () => {
        const { id } = await queue('kill -9 $$');
        await sql`update job set max_attempts = 1 where id = ${id}`;
        await store.claim('w1', 300);
        await expireLease(id);

        expect(await store.claim('w2', 300)).toBeNull();
        expect((await row(id))[0]?.status).toBe('dead');
    });

    it('extends a live lease on a heartbeat', async () => {
        const { id } = await queue('echo hi');
        const claim = await store.claim('w1', 60);

        const beat = await store.heartbeat(id, claim!.leaseToken, 600);

        expect(beat.result).toBe('ok');
        expect(Date.parse(beat.leaseExpiresAt as string)).toBeGreaterThan(Date.parse(claim!.leaseExpiresAt));
    });

    it('separates an unknown job from a lost lease', async () => {
        const { id } = await queue('echo hi');
        const stale = await store.claim('w1', 300);
        await expireLease(id);
        await store.claim('w2', 300);

        expect((await store.heartbeat(id, stale!.leaseToken, 300)).result).toBe('lost');
        expect((await store.heartbeat(ABSENT, stale!.leaseToken, 300)).result).toBe('missing');
    });

    // The whole point of the fencing token: the two runs did different work, so the loser's report
    // is refused rather than merged.
    it('refuses a completion from a worker whose lease was reclaimed', async () => {
        const { id } = await queue('echo hi');
        const stale = await store.claim('w1', 300);
        await expireLease(id);
        const winner = await store.claim('w2', 300);

        const refused = await store.complete(id, stale!.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'from the zombie',
        });
        const accepted = await store.complete(id, winner!.leaseToken, {
            status: 'failed',
            exitCode: 3,
            output: 'from the live one',
        });

        expect(refused).toBe('lost');
        expect(accepted).toBe('ok');
        expect(await store.get(id)).toMatchObject({
            status: 'failed',
            exitCode: 3,
            output: 'from the live one',
        });
    });

    it('reports a completion for a job that does not exist', async () => {
        const result = await store.complete(ABSENT, ABSENT, {
            status: 'succeeded',
            exitCode: 0,
            output: null,
        });
        expect(result).toBe('missing');
    });

    it('streams a rolling output tail while the run is going', async () => {
        const { id } = await queue('echo hi');
        const claim = await store.claim('w1', 300);

        expect(await store.progress(id, claim!.leaseToken, 'working')).toBe('ok');
        expect(await store.progress(id, claim!.leaseToken, 'working\nstill working')).toBe('ok');

        // Replace, never append: the driver owns the window, and an unbounded append would grow
        // the row for as long as a session runs.
        expect(await store.get(id)).toMatchObject({ output: 'working\nstill working' });

        // The final report wins — the tail was only ever a preview of it.
        await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        expect(await store.get(id)).toMatchObject({ output: 'done' });
    });

    /**
     * The vitals ride the tail's own route, replaced on every sample and left alone when a round
     * has none — a missed sample costs freshness, not the last good answer. Cleared on the next
     * claim: the sample describes the attempt that reported it, and a new container starts
     * unsampled.
     */
    it('keeps the last runtime vitals beside the tail, and clears them on a new attempt', async () => {
        const { id } = await queue('echo hi');
        const first = await store.claim('w1', 300);
        const vitals = {
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7,
            activity: '→ Read src/x.ts',
            sampledAt: '2026-09-09T10:00:00.000Z',
        };

        await store.progress(id, first!.leaseToken, 'working', vitals);
        // A round with no sample leaves the last good answer alone.
        await store.progress(id, first!.leaseToken, 'still working', null);
        expect(await store.get(id)).toMatchObject({ runtime: vitals });

        // The claim clears the column: the sample describes the attempt that took it, and a new
        // attempt starts with a new, unsampled container.
        await expireLease(id);
        const second = await store.claim('w2', 300);
        expect(await store.get(id)).toMatchObject({ runtime: null });

        // The last sample stays on a FINISHED row: "was it doing anything when it died" reads off
        // sampledAt.
        await store.progress(id, second!.leaseToken, 'again', vitals);
        await store.complete(id, second!.leaseToken, { status: 'failed', exitCode: 1, output: 'done', contextTokens: 90433, contextCostUsd: 0.31 });
        // The context stats MERGE into the sampled vitals — the row keeps its last sample and
        // gains the context the run reached beside it.
        expect(await store.get(id)).toMatchObject({
            runtime: { ...vitals, contextTokens: 90433, contextCostUsd: 0.31 },
        });
    });

    // A run whose runner never samples the container (kubernetes, a failed readout) still gets
    // its context stats stored: the merge creates the vitals object when none exists.
    it('stores context stats on a finished run with no container samples', async () => {
        const { id } = await queue('echo hi');
        const claim = await store.claim('w1', 300);

        await store.complete(id, claim!.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'done',
            contextTokens: 1200,
            contextCostUsd: 0,
        });

        expect(await store.get(id)).toMatchObject({
            runtime: { contextTokens: 1200, contextCostUsd: 0 },
        });
        expect(await store.get(id)).toMatchObject({ output: 'done' });
    });

    it('refuses an output tail from a worker whose lease was reclaimed', async () => {
        const { id } = await queue('echo hi');
        const stale = await store.claim('w1', 300);
        await expireLease(id);
        await store.claim('w2', 300);

        expect(await store.progress(id, stale!.leaseToken, 'from the zombie')).toBe('lost');
        expect(await store.progress(ABSENT, stale!.leaseToken, 'nowhere')).toBe('missing');
    });

    it('records the session an attempt is running as', async () => {
        const { id } = await queue('echo hi');
        const claim = await store.claim('w1', 300);

        expect(await store.session(id, claim!.leaseToken, SESSION, null)).toBe('ok');
        expect(await store.get(id)).toMatchObject({ sessionId: SESSION });
    });

    /**
     * Session ids are not pinned to uuids: opencode mints its own (`ses_…`), scraped by the
     * runner after the run and reported before the verdict. A follow-up on such a task must work
     * exactly like a claude one — and the claim must hand the token back, because `run --session
     * <id>` is how the runner restores that conversation.
     */
    it('follows up a task whose session is an executor token, and hands it back on the claim', async () => {
        const { id } = await queue('drive me');
        const claim = await store.claim('w1', 300);
        const ses = 'ses_f86188c3dffeZGYO4yZq4atba9';

        await store.session(id, claim!.leaseToken, ses, null);
        await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });

        const followUp = await store.createFollowUp(id, 'again', null);
        expect(await store.get(followUp.id)).toMatchObject({ followUpTo: id, sessionId: ses });

        const second = await store.claim('w2', 300);
        expect(second).toMatchObject({ id: followUp.id, resumeSessionId: ses, followUp: true });
    });

    // Two reports per attempt: the local id at spawn, the remote one once the bridge connects. The
    // second must not be able to wipe the first, and the first must not wipe a remote id that a
    // later report already stored.
    it('adds the remote session id without clearing what is already there', async () => {
        const { id } = await queue('drive me');
        const claim = await store.claim('w1', 300);

        await store.session(id, claim!.leaseToken, SESSION, null);
        await store.session(id, claim!.leaseToken, SESSION, REMOTE);
        await store.session(id, claim!.leaseToken, SESSION, null);

        expect(await store.get(id)).toMatchObject({ sessionId: SESSION, remoteSessionId: REMOTE });
    });

    it('drops the remote session when the job is claimed again', async () => {
        const { id } = await queue('drive me');
        const first = await store.claim('w1', 300);
        await store.session(id, first!.leaseToken, SESSION, REMOTE);
        await expireLease(id);

        await store.claim('w2', 300);

        expect((await store.get(id))?.remoteSessionId).toBeNull();
    });

    it('refuses a session report from a worker whose lease was reclaimed', async () => {
        const { id } = await queue('echo hi');
        const stale = await store.claim('w1', 300);
        await expireLease(id);
        await store.claim('w2', 300);

        expect(await store.session(id, stale!.leaseToken, SESSION, null)).toBe('lost');
        expect(await store.session(ABSENT, stale!.leaseToken, SESSION, null)).toBe('missing');
    });

    // The attempt that died ran a different session, and showing its link next to this attempt's
    // output would point a reader at work that was thrown away.
    it('clears the session when the job is claimed again', async () => {
        const { id } = await queue('echo hi');
        const first = await store.claim('w1', 300);
        await store.session(id, first!.leaseToken, SESSION, null);
        await expireLease(id);

        await store.claim('w2', 300);

        expect((await store.get(id))?.sessionId).toBeNull();
    });

    it('parks a running job without finishing it, keeping its session', async () => {
        const { id } = await queue('drive me');
        const claim = await store.claim('w1', 300);
        await store.session(id, claim!.leaseToken, SESSION, null);

        expect(await store.suspend(id, claim!.leaseToken)).toBe('ok');

        expect(await store.get(id)).toMatchObject({ status: 'standby', sessionId: SESSION });
        expect((await store.get(id))?.finishedAt).toBeNull();
    });

    // A parked job must not be picked up by the next idle poll — that would resume it instantly,
    // which is the opposite of parking it. The partial claim index is what makes this true.
    it('does not hand out a parked job', async () => {
        const { id } = await queue('drive me');
        const claim = await store.claim('w1', 300);
        await store.suspend(id, claim!.leaseToken);

        expect(await store.claim('w2', 300)).toBeNull();
    });

    // Parking is not a failed try. Without the give-back, a job parked three times is dead.
    it('hands back the attempt it took, so parking is not a retry', async () => {
        const { id } = await queue('drive me');

        for (let i = 0; i < 5; i += 1) {
            const claim = await store.claim(`w${i}`, 300);
            expect(claim).not.toBeNull();
            await store.suspend(id, claim!.leaseToken);
            await store.resume(id);
        }

        expect((await store.get(id))?.status).toBe('queued');
        expect((await store.get(id))?.attempts).toBe(0);
    });

    // The whole point of standby: the claim carries the parked session back to the worker, which
    // restores it instead of starting a new one — so the link the UI shows does not move.
    it('hands the parked session back on the claim that resumes it', async () => {
        const { id } = await queue('drive me');
        const first = await store.claim('w1', 300);
        await store.session(id, first!.leaseToken, SESSION, REMOTE);
        await store.suspend(id, first!.leaseToken);

        expect(await store.resume(id)).toBe('ok');
        const second = await store.claim('w2', 300);

        expect(second).toMatchObject({ id, resumeSessionId: SESSION, followUp: false });
        // Kept across the park too, so the link works while the job is waiting to be picked up.
        expect((await store.get(id))?.remoteSessionId).toBe(REMOTE);
    });

    // A lease that expired mid-run is not a park: that attempt's session is not this one, and
    // resuming it would replay a transcript whose output was thrown away.
    it('does not offer a session to resume when it is reclaiming a crashed attempt', async () => {
        const { id } = await queue('echo hi');
        const first = await store.claim('w1', 300);
        await store.session(id, first!.leaseToken, SESSION, null);
        await expireLease(id);

        const second = await store.claim('w2', 300);

        expect(second?.resumeSessionId).toBeNull();
    });

    it('refuses to park a job on a lease that has moved on', async () => {
        const { id } = await queue('echo hi');
        const stale = await store.claim('w1', 300);
        await expireLease(id);
        await store.claim('w2', 300);

        expect(await store.suspend(id, stale!.leaseToken)).toBe('lost');
        expect(await store.suspend(ABSENT, stale!.leaseToken)).toBe('missing');
    });

    it('separates a job that is not parked from one that does not exist', async () => {
        const { id } = await queue('echo hi');

        expect(await store.resume(id)).toBe('conflict');
        expect(await store.resume(ABSENT)).toBe('missing');
    });

    it('leaves output out of the list projection', async () => {
        const { id } = await queue('echo hi');
        const claim = await store.claim('w1', 300);
        await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'noise' });

        const [listed] = await store.list({ limit: 10 });
        expect(listed?.output).toBeNull();
        expect((await store.get(id))?.output).toBe('noise');
    });

    it('filters the list by status', async () => {
        await queue('one');
        const { id } = await queue('two');
        await store.claim('w1', 300);

        expect(await store.list({ status: 'running', limit: 10 })).toHaveLength(1);
        expect((await store.list({ status: 'queued', limit: 10 }))[0]?.id).toBe(id);
    });

    it('stores the repo and executor a job was queued with', async () => {
        const labelled = await store.create('drive me', null, { repo: 'acme/web', executor: 'main' });
        const unlabelled = await queue('echo hi');

        expect(await store.get(labelled.id)).toMatchObject({ repo: 'acme/web', executor: 'main' });
        // Jobs queued before the chat, and tasks sent without either label, read as null — the
        // state every pre-migration row is in.
        expect(await store.get(unlabelled.id)).toMatchObject({ repo: null, executor: null });
    });

    it('lists only the requested repository, newest first', async () => {
        await store.create('older web task', null, { repo: 'acme/web', executor: null });
        await store.create('other repo', null, { repo: 'acme/api', executor: null });
        await store.create('newer web task', null, { repo: 'acme/web', executor: null });
        await queue('no repo at all');

        const listed = await store.list({ repo: 'acme/web', limit: 50 });

        // Newest first, and the repo-less job stays in the unfiltered view only.
        expect(listed.map((job) => job.command)).toEqual(['newer web task', 'older web task']);
    });

    it('keeps another organization out of a repository filter', async () => {
        const { id } = await store.create('echo hi', null, { repo: 'acme/web', executor: null });
        await otherOrgStore.create('echo hi', null, { repo: 'acme/web', executor: null });

        const listed = await store.list({ repo: 'acme/web', limit: 50 });
        expect(listed.map((job) => job.id)).toEqual([id]);
    });

    it('keeps one organization out of another organization queue', async () => {
        const { id } = await queue('echo hi');

        expect(await otherOrgStore.claim('intruder', 300)).toBeNull();
        expect(await otherOrgStore.get(id)).toBeNull();
        expect(await store.claim('w1', 300)).not.toBeNull();
    });

    // Duplicates would prove a lost update; nulls would prove the row lock is being taken above the
    // limit, so a contended row is counted and then discarded rather than skipped.
    it('never hands the same job to two claimers', async () => {
        const ids = new Set<string>();
        for (let i = 0; i < 50; i += 1) ids.add((await queue(`job ${i}`)).id);

        const claims = await Promise.all(
            Array.from({ length: 50 }, (_, i) => store.claim(`w${i}`, 300)),
        );

        expect(claims.filter((claim) => claim === null)).toHaveLength(0);
        expect(new Set(claims.map((claim) => claim?.id)).size).toBe(50);
    });

    it('skips a locked row rather than waiting on it', async () => {
        const { id: pinned } = await queue('first');
        const { id: next } = await queue('second');

        await sql.begin(async (tx) => {
            await tx`select id from job where id = ${pinned} for update`;
            // Would block forever without `skip locked`, and the test would time out rather than
            // fail — which is itself the signal.
            expect((await store.claim('w1', 300))?.id).toBe(next);
        });
    });
});

describe.skipIf(!enabled)('follow-ups and done', () => {
    /**
     * Takes a job the whole way to a finished run, reporting a session on the way — the state a
     * task is in when its executor has stopped talking and a human is looking at the output. The
     * follow-up mechanic and the done button both start from exactly here.
     */
    const finishWithSession = async (
        command: string,
        target: { repo: string | null; executor: string | null } = { repo: null, executor: null },
        remote = false,
    ): Promise<string> => {
        const { id } = await store.create(command, null, target);
        const claim = await store.claim('w1', 300);
        await store.session(id, claim!.leaseToken, SESSION, remote ? REMOTE : null);
        await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        return id;
    };

    // The follow-up must arrive at the worker as a continuation of the conversation so far: the
    // parent's session is what makes "ask for an adjustment" mean anything to the agent.
    it('creates a follow-up that continues the parent session and links to it', async () => {
        const parent = await finishWithSession('drive me', { repo: null, executor: null }, true);

        const followUp = await store.createFollowUp(parent, 'now adjust the tone', null);

        expect(await store.get(followUp.id)).toMatchObject({
            command: 'now adjust the tone',
            status: 'queued',
            followUpTo: parent,
            sessionId: SESSION,
            remoteSessionId: REMOTE,
            doneAt: null,
        });
    });

    // The thread keeps its tab AND its runner: the follow-up renders in the parent's repository
    // view and is bound to the executor that ran the task — the board copies it at insert, and
    // no body can retarget it (a conversation switching executors mid-thread is exactly the
    // cross-CLI resume nothing can do).
    it('inherits the parent repo and the parent executor', async () => {
        const parent = await finishWithSession('drive me', { repo: 'acme/web', executor: 'main' });

        const followUp = await store.createFollowUp(parent, 'again, tighter', null);

        expect(await store.get(followUp.id)).toMatchObject({ repo: 'acme/web', executor: 'main' });
    });

    /*
     * The per-task worktree (issue #35) is keyed by the thread's ROOT job id, so every attempt
     * and every follow-up of one task lands in the same tree. The claim is where the board
     * tells the driver which thread it is handing out.
     */
    it('claims with the job itself as the thread root when it is not a follow-up', async () => {
        const { id } = await queue('echo hi');

        const claim = await store.claim('w1', 300);

        expect(claim?.rootJobId).toBe(id);
    });

    it('claims a follow-up — and a follow-up of a follow-up — with the thread root as the root', async () => {
        const root = await finishWithSession('drive me', { repo: 'acme/web', executor: null }, true);
        const child = await store.createFollowUp(root, 'adjust the tone', null);

        // Finish the child so the grandchild can attach to it.
        const childClaim = await store.claim('w1', 300);
        expect(childClaim?.id).toBe(child.id);
        await store.complete(child.id, childClaim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const grand = await store.createFollowUp(child.id, 'again, tighter', null);

        // The child is finished too, so the grandchild is the only claimable row.
        const grandClaim = await store.claim('w2', 300);
        expect(grandClaim?.id).toBe(grand.id);
        // NOT the child's id and NOT the grandchild's own: the thread's root.
        expect(grandClaim?.rootJobId).toBe(root);
    });

    // A moving job belongs to its worker and its run is not over; a follow-up on one would race it.
    it('refuses a follow-up on a job that is still moving', async () => {
        const { id } = await queue('echo hi');
        await store.claim('w1', 300);

        expect(await store.createFollowUp(id, 'again', null)).toBe('not_finished');
    });

    it('refuses a follow-up on a task the user has marked done', async () => {
        const parent = await finishWithSession('echo hi');
        await store.markDone(parent);

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
        const outcome = await Promise.race([
            followUp,
            new Promise<string>((resolve) => setTimeout(() => resolve('still_locked'), 450)),
        ]);
        expect(outcome).toBe('still_locked');

        release!();
        await blocker;
        // The held-up insert lands once the lock frees, and a done after it still works — the
        // sequential follow-up-then-done outcome the lock makes the only possible ordering.
        expect(await followUp).toMatchObject({ id: expect.any(String) });
        expect(await store.markDone(parent)).toMatchObject({ status: 'succeeded' });
    });

    // Without a session on the parent there is nothing to continue — an opencode run, for one, or a
    // claude-code run that died before its driver could report. Running the follow-up fresh would
    // look like a continuation while starting from nothing.
    it('refuses a follow-up on a run the board never saw a session for', async () => {
        const { id } = await queue('echo hi');
        const claim = await store.claim('w1', 300);
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
        const authorA = await account(6001, 'author-a');
        const authorB = await account(6002, 'author-b');
        const { id: parent } = await store.create('drive me', authorA, { repo: null, executor: null });
        const claim = await store.claim('w1', 300);
        await store.session(parent, claim!.leaseToken, SESSION, null);
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
        const first = await store.createFollowUp(parent, 'first adjustment', null);
        const claim = await store.claim('w1', 300);
        await store.session(first.id, claim!.leaseToken, SESSION, null);
        await store.complete(first.id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: null });
        const second = await store.createFollowUp(first.id, 'second adjustment', null);

        for (const member of [parent, first.id, second.id]) {
            const chain = await store.thread(member);
            expect(chain?.map((task) => task.command)).toEqual([
                'drive me',
                'first adjustment',
                'second adjustment',
            ]);
        }

        // And the org guard holds: another org's store reads nothing of this conversation.
        expect(await otherOrgStore.thread(parent)).toBeNull();
        expect(await store.thread(ABSENT)).toBeNull();
    });

    // The whole point: the worker gets the parent session back AND the new command to deliver
    // into it — restore and continue, not just restore.
    it('hands a follow-up claim the parent session and the command to deliver', async () => {
        const parent = await finishWithSession('drive me');
        const { id } = await store.createFollowUp(parent, 'again', null);

        const claim = await store.claim('w1', 300);

        expect(claim).toMatchObject({ id, resumeSessionId: SESSION, followUp: true });
    });

    // A crashed follow-up attempt re-claims with the session kept and the command re-delivered:
    // the conversation survives the crash, and the adjustment still reaches the agent.
    it('re-delivers the command when a follow-up attempt is reclaimed', async () => {
        const parent = await finishWithSession('drive me');
        const { id } = await store.createFollowUp(parent, 'again', null);
        await store.claim('w1', 300);
        await expireLease(id);

        const second = await store.claim('w2', 300);

        expect(second).toMatchObject({ id, attempts: 2, resumeSessionId: SESSION, followUp: true });
    });

    // "Delivered once" survives follow-ups: a parked follow-up has its command in the transcript
    // already, so its resume restores the session and delivers nothing — the same rule a parked
    // ordinary job has always had.
    it('does not re-deliver the command when a parked follow-up is resumed', async () => {
        const parent = await finishWithSession('drive me');
        const { id } = await store.createFollowUp(parent, 'drive me too', null);
        const first = await store.claim('w1', 300);
        await store.session(id, first!.leaseToken, SESSION, null);
        await store.suspend(id, first!.leaseToken);
        await store.resume(id);

        const second = await store.claim('w2', 300);

        expect(second).toMatchObject({ id, resumeSessionId: SESSION, followUp: false });
    });

    // The task is done when the user says so — a verdict no run can make and nobody can take back
    // by saying it twice.
    // The repeat half of "rinse and repeat": a follow-up is itself a finished task with a session
    // once its run ends, so the conversation chains — and it chains through the follow-up's OWN
    // session (whatever its run reported), never by reaching back to the root's.
    it('follows up on a follow-up, chaining the newest session', async () => {
        const parent = await finishWithSession('drive me');
        const first = await store.createFollowUp(parent, 'first adjustment', null);
        const claim = await store.claim('w1', 300);
        await store.session(first.id, claim!.leaseToken, CHAIN, null);
        await store.complete(first.id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: null });

        const second = await store.createFollowUp(first.id, 'second adjustment', null);

        expect(await store.get(second.id)).toMatchObject({
            followUpTo: first.id,
            sessionId: CHAIN,
            status: 'queued',
        });
    });

    it('marks a finished task done and answers the same moment twice', async () => {
        const parent = await finishWithSession('echo hi');

        const first = await store.markDone(parent);
        const second = await store.markDone(parent);

        expect(second.doneAt).toBe(first.doneAt);
        expect((await store.get(parent))?.doneAt).toBe(first.doneAt);
    });

    it('refuses to mark a moving task done, and to mark an absent one', async () => {
        const { id: queued } = await queue('echo hi');

        expect(await store.markDone(queued)).toBe('conflict');
        expect(await store.markDone(ABSENT)).toBe('missing');
    });
});

describe.runIf(enabled)('attribution', () => {
    /**
     * A real account for created_by to point at. Written directly rather than through the auth
     * store: this file is about the job table, and going through a sign-in would make these cases
     * fail for reasons that have nothing to do with them.
     */
    const account = async (githubUserId: number, login: string): Promise<string> => {
        const [row] = await sql<{ id: string }[]>`
            insert into app_user (github_user_id, github_login) values (${githubUserId}, ${login})
            on conflict (github_user_id) do update set github_login = excluded.github_login
            returning id
        `;
        return row!.id;
    };

    it('records who queued a job and reports it back on read', async () => {
        const userId = await account(5001, 'octocat');

        const { id } = await store.create('echo hi', userId, { repo: null, executor: null });

        expect((await store.get(id))?.createdBy).toBe(userId);
    });

    it('reports the author and their workspace to the worker that claims it', async () => {
        const userId = await account(5002, 'octodog');
        await store.create('echo hi', userId, { repo: null, executor: null });

        const claim = await store.claim('driver-1', 300);
        // `userId` is still the seam the per-user credential work will read; `workspacePath` is
        // what the workspace half of it turned into, and the driver runs the job there.
        expect(claim?.userId).toBe(userId);
        expect(claim?.workspacePath).toBe(`${ORG}/${userId}`);
    });

    it('claims an unattributed job with a null author rather than refusing it', async () => {
        // Every job written before this migration is in this state, and they must still run.
        await queue('echo hi');
        const claim = await store.claim('driver-1', 300);
        expect(claim?.userId).toBeNull();
        // No member, so no workspace. The driver fails such a job rather than choosing a directory.
        expect(claim?.workspacePath).toBeNull();
    });

    it('reports no workspace path when the deployment has no workspace root', async () => {
        /*
         * Naming a directory that was never created would be worse than saying nothing: `docker
         * run -w` CREATES a missing workdir, so the runner would start in an empty directory and
         * the job would look like it ran. The driver's null check only catches that if the board
         * is honest here.
         */
        const rootless = createJobStore({ sql, orgId: ORG, hasWorkspaces: false });
        const userId = await account(5004, 'nowhere');
        await rootless.create('echo hi', userId, { repo: null, executor: null });

        const claim = await rootless.claim('driver-1', 300);
        expect(claim?.userId).toBe(userId);
        expect(claim?.workspacePath).toBeNull();
    });

    it('carries the stacked environment on the claim, resolved for the author and repo label', async () => {
        const userId = await account(5005, 'env-cat');
        const envStore = createEnvVarStore({ sql, orgId: ORG });
        await sql`truncate env_var`;
        await envStore.replaceOrg([{ name: 'CORE', value: 'org-value', isSecret: true }]);
        await envStore.replaceWorkspace(userId, [{ name: 'CORE', value: 'workspace-value', isSecret: false }]);
        await envStore.replaceRepo('Bellows-AI', 'bellows.ai', [
            { name: 'CORE', value: 'repo-value', isSecret: false },
            { name: 'REPO_ONLY', value: 'repo-only-value', isSecret: true },
        ]);
        const envAware = createJobStore({ sql, orgId: ORG, env: envStore });

        await envAware.create('echo hi', userId, { repo: 'Bellows-AI/bellows.ai', executor: null });
        const claim = await envAware.claim('driver-1', 300);
        // Repo beats workspace beats org on the collision, and the secrets travel as values —
        // injection is what they are for.
        expect(claim?.env).toEqual({ CORE: 'repo-value', REPO_ONLY: 'repo-only-value' });

        // A job with no repo label gets org + workspace only.
        await envAware.create('echo hi', userId, { repo: null, executor: null });
        const second = await envAware.claim('driver-2', 300);
        expect(second?.env).toEqual({ CORE: 'workspace-value' });
    });

    it('carries no environment when the board was built without a resolver', async () => {
        const userId = await account(5006, 'plain-cat');
        await store.create('echo hi', userId, { repo: null, executor: null });
        const claim = await store.claim('driver-1', 300);
        expect(claim?.env).toBeUndefined();
    });

    it('leaves a job claimable when the env resolver fails, without burning an attempt', async () => {
        /*
         * The claim's UPDATE is only safe to keep if the resolver answers: a half-claim — running,
         * with a lease nobody holds and an attempt already burned — would strand the job until the
         * lease expired on every retry, walking it to dead on an infrastructure blip.
         */
        const userId = await account(5007, 'flaky-cat');
        let fail = true;
        const flaky = createJobStore({
            sql,
            orgId: ORG,
            env: {
                resolveFor: async () => {
                    if (fail) throw new Error('env store down');
                    return {};
                },
            },
        });
        await flaky.create('echo hi', userId, { repo: null, executor: null });

        await expect(flaky.claim('driver-1', 300)).rejects.toThrow('env store down');

        // The store is back: the job is still queued, still attempt 0, and the very next claim
        // takes it with a full environment.
        fail = false;
        const claim = await flaky.claim('driver-2', 300);
        expect(claim?.id).toBeTruthy();
        expect(claim?.attempts).toBe(1);
    });

    /** Unique per run — a shared factory_test database must not let one suite's accounts collide with another's. */
    const mintedAccountId = (() => {
        let next = 50_000 + Math.floor(Math.random() * 100_000);
        return () => ++next;
    })();

    it('mints the installation token onto the claim, under the stacked environment', async () => {
        // Issue #28: executors orchestrate github workflows (PRs, commits, CI reads). Under an
        // app-mode board the installation token rides the claim's env, minted at claim time — the
        // seam docs/env.md reserved for exactly this.
        const userId = await account(mintedAccountId(), 'minted-cat');
        const envStore = createEnvVarStore({ sql, orgId: ORG });
        await sql`truncate env_var`;
        await envStore.replaceOrg([{ name: 'CORE', value: 'org-value', isSecret: true }]);
        const minted = createJobStore({
            sql,
            orgId: ORG,
            env: envStore,
            githubToken: { fresh: async () => 'ghs_example' },
        });

        await minted.create('echo hi', userId, { repo: null, executor: null });
        const claim = await minted.claim('driver-1', 300);
        // The mint is the base layer: configured values ride above it.
        expect(claim?.env).toEqual({ GITHUB_TOKEN: 'ghs_example', CORE: 'org-value' });
    });

    it('lets a configured GITHUB_TOKEN beat the mint', async () => {
        /*
         * A credential an operator configured in a scope is deliberate; the mint fills only the
         * gap. Silently replacing it with a different token would be a failure nobody notices.
         */
        const userId = await account(mintedAccountId(), 'tokened-cat');
        const envStore = createEnvVarStore({ sql, orgId: ORG });
        await sql`truncate env_var`;
        await envStore.replaceOrg([{ name: 'GITHUB_TOKEN', value: 'operator-pat', isSecret: true }]);
        const minted = createJobStore({
            sql,
            orgId: ORG,
            env: envStore,
            githubToken: { fresh: async () => 'ghs_example' },
        });

        await minted.create('echo hi', userId, { repo: null, executor: null });
        const claim = await minted.claim('driver-1', 300);
        expect(claim?.env).toEqual({ GITHUB_TOKEN: 'operator-pat' });
    });

    it('leaves a job claimable when the mint fails, without burning an attempt', async () => {
        /*
         * The resolver-failure precedent, one layer down: the mint is a remote call on the claim
         * path, and a half-claim taken before it failed must roll back exactly the same way.
         */
        const userId = await account(mintedAccountId(), 'flaky-mint');
        let fail = true;
        const flaky = createJobStore({
            sql,
            orgId: ORG,
            githubToken: {
                fresh: async () => {
                    if (fail) throw new Error('mint down');
                    return 'ghs_late';
                },
            },
        });
        await flaky.create('echo hi', userId, { repo: null, executor: null });

        await expect(flaky.claim('driver-1', 300)).rejects.toThrow('mint down');

        // The provider is back: the job is still queued, still attempt 0, and the very next claim
        // takes it with the minted token.
        fail = false;
        const claim = await flaky.claim('driver-2', 300);
        expect(claim?.id).toBeTruthy();
        expect(claim?.attempts).toBe(1);
        expect(claim?.env).toEqual({ GITHUB_TOKEN: 'ghs_late' });
    });

    it('mints the token even when the board has no env resolver', async () => {
        const userId = await account(mintedAccountId(), 'bare-mint');
        const bare = createJobStore({ sql, orgId: ORG, githubToken: { fresh: async () => 'ghs_example' } });
        await bare.create('echo hi', userId, { repo: null, executor: null });

        const claim = await bare.claim('driver-1', 300);
        expect(claim?.env).toEqual({ GITHUB_TOKEN: 'ghs_example' });
    });

    it('mints a fresh token for every claim, so the credential outlives the claim', async () => {
        /*
         * Served from the provider's cache, a token can carry the five-minute refresh margin into
         * a run capped at thirty minutes, and the runner has no refresh path — its env file is
         * written once. So each claim mints for itself, and the credential starts with a full hour.
         */
        const userId = await account(mintedAccountId(), 'fresh-mint');
        let mints = 0;
        const counting = createJobStore({
            sql,
            orgId: ORG,
            githubToken: {
                fresh: async () => `ghs_${++mints}`,
            },
        });

        await counting.create('echo hi', userId, { repo: null, executor: null });
        const first = await counting.claim('driver-1', 300);
        expect(first?.env).toEqual({ GITHUB_TOKEN: 'ghs_1' });

        // The first job holds a live lease, so the second claim takes the new one — and mints again.
        await counting.create('echo hi', userId, { repo: null, executor: null });
        const second = await counting.claim('driver-2', 300);
        expect(second?.env).toEqual({ GITHUB_TOKEN: 'ghs_2' });
    });

    it('keeps the job when the account that queued it is deleted', async () => {
        // `on delete set null`, never cascade: removing a person must not erase the record of what
        // they ran, on the one route that runs shell commands.
        const userId = await account(5003, 'departing');
        const { id } = await store.create('echo hi', userId, { repo: null, executor: null });

        await sql`delete from app_user where id = ${userId}`;

        const job = await store.get(id);
        expect(job).not.toBeNull();
        expect(job?.createdBy).toBeNull();
    });

    it('reports the workspace directory on reads, not only on the claim', async () => {
        /*
         * The task view's status sidebar shows where the run's checkout lives, and a reader of the
         * board has no other way to learn it: the layout is the board's own knowledge
         * (`<orgId>/<author>`), so the same derivation the claim makes travels on the reads the
         * dashboard polls. An unattributed job answers null — the same null the claim reports,
         * for the same reason.
         */
        const userId = await account(5008, 'reading-cat');
        const { id } = await store.create('echo hi', userId, { repo: null, executor: null });

        expect((await store.get(id))?.workspacePath).toBe(`${ORG}/${userId}`);
        expect((await store.thread(id))?.[0]?.workspacePath).toBe(`${ORG}/${userId}`);

        const unattributed = await queue('echo hi');
        expect((await store.get(unattributed.id))?.workspacePath).toBeNull();

        // The list projection carries the derivation too — the sidenav and any list view read it
        // like the detail, and never `null`-because-unselected.
        const listed = await store.list({ limit: 10 });
        expect(listed.find((job) => job.id === id)?.workspacePath).toBe(`${ORG}/${userId}`);
        expect(listed.find((job) => job.id === unattributed.id)?.workspacePath).toBeNull();
    });

    it('reports no workspace directory on reads when the deployment has no workspace root', async () => {
        /*
         * The claim refuses to name a directory that was never created; the reads must not either,
         * or the sidebar would show a path that does not exist.
         */
        const rootless = createJobStore({ sql, orgId: ORG, hasWorkspaces: false });
        const userId = await account(5009, 'unread-cat');
        const { id } = await rootless.create('echo hi', userId, { repo: null, executor: null });

        expect((await rootless.get(id))?.workspacePath).toBeNull();
    });
});
