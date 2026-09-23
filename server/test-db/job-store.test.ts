import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import { createOrgOfLease } from '../src/db/job-store-org-resolvers.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
/** A second store on the same pool, bound to a different org. Only the org guard uses it. */
let otherOrgStore: JobStore;
/** The org-less lease resolver the branch-ingest credential is verified against. */
let orgOfLease: (jobId: string, leaseToken: string) => Promise<string | null>;

const ORG = 'test-org';
const OTHER_ORG = 'other-org';
/** A well-formed uuid, only ever used where the job or the lease is expected not to exist. */
const ABSENT = '00000000-0000-4000-8000-000000000000';
const SESSION = '33333333-3333-4333-8333-333333333333';
/** Shaped like a real one: opaque, prefixed, and not a uuid. */
const REMOTE = 'cse_015tb2nHhHNrBuL7ZDhn9Wx5';
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
    orgOfLease = createOrgOfLease({ sql });
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

/** Ages a lease into the past. Deterministic where sleeping for a one-second lease is not. */
const expireLease = (id: string) => sql`update job set lease_expires_at = now() - interval '1 second' where id = ${id}`;

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

        const first = await store.claim('w1', LEASE_SECONDS);
        expect(first).toMatchObject({ id, command: 'echo hi', attempts: 1, followUp: false });

        expect(await store.claim('w2', LEASE_SECONDS)).toBeNull();
        expect((await row(id))[0]).toMatchObject({ status: 'running', claimed_by: 'w1' });
    });

    it('takes the oldest job first', async () => {
        const { id: first } = await queue('first');
        const { id: second } = await queue('second');

        expect((await store.claim('w1', LEASE_SECONDS))?.id).toBe(first);
        expect((await store.claim('w2', LEASE_SECONDS))?.id).toBe(second);
    });

    it('reclaims an expired lease with a fresh token and a bumped attempt', async () => {
        const { id } = await queue('echo hi');
        const first = await store.claim('w1', LEASE_SECONDS);
        const firstStart = (await row(id))[0]?.started_at as Date;
        await expireLease(id);

        const second = await store.claim('w2', LEASE_SECONDS);

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
        await store.claim('w1', LEASE_SECONDS);
        await expireLease(id);

        expect(await store.claim('w2', LEASE_SECONDS)).toBeNull();
        expect((await row(id))[0]?.status).toBe('dead');
    });

    it('extends a live lease on a heartbeat', async () => {
        const { id } = await queue('echo hi');
        const claim = await store.claim('w1', 60);

        const RENEWED_LEASE_SECONDS = 600;
        const beat = await store.heartbeat(id, claim!.leaseToken, RENEWED_LEASE_SECONDS);

        expect(beat.result).toBe('ok');
        expect(Date.parse(beat.leaseExpiresAt as string)).toBeGreaterThan(Date.parse(claim!.leaseExpiresAt));
    });

    it('separates an unknown job from a lost lease', async () => {
        const { id } = await queue('echo hi');
        const stale = await store.claim('w1', LEASE_SECONDS);
        await expireLease(id);
        await store.claim('w2', LEASE_SECONDS);

        expect((await store.heartbeat(id, stale!.leaseToken, LEASE_SECONDS)).result).toBe('lost');
        expect((await store.heartbeat(ABSENT, stale!.leaseToken, LEASE_SECONDS)).result).toBe('missing');
    });

    // The whole point of the fencing token: the two runs did different work, so the loser's report
    // is refused rather than merged.
    it('refuses a completion from a worker whose lease was reclaimed', async () => {
        const { id } = await queue('echo hi');
        const stale = await store.claim('w1', LEASE_SECONDS);
        await expireLease(id);
        const winner = await store.claim('w2', LEASE_SECONDS);

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

        expect(refused).toEqual({ result: 'lost' });
        // Terminal, but nobody closed it — the tree stays until a done says otherwise.
        expect(accepted).toEqual({ result: 'ok', threadDone: false });
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
        expect(result).toEqual({ result: 'missing' });
    });

    // The branch-ingest credential: the runner's reporter presents the pair it runs for, and
    // this resolver answers the org — with no status filter but two bounds: the tail grace on
    // `finished_at` (the reporter's final `--once` sample lands seconds after the verdict, while
    // a pair captured from a runner's env must not stay a write credential forever — nothing
    // prunes completed jobs), and a live `lease_expires_at` for UNFINISHED jobs, so a lease that
    // expired without a reclaim takes its captured pair with it. The pair resolves from the job
    // row with no membership join, which is exactly why it must expire like every other
    // credential. That only works because complete() RETAINS the lease token; the dead retirement
    // and the suspend park clear it, because those attempts end without a verdict whose tail
    // matters; and a reclaim rotates it, which is what makes the pair attempt-scoped — a
    // superseded attempt can no longer write into the winner's org.
    describe('orgOfLease', () => {
        it('resolves the org for a live lease pair, and only for the matching lease', async () => {
            const { id } = await queue('echo hi');
            const claim = await store.claim('w1', LEASE_SECONDS);

            expect(await orgOfLease(claim!.id, claim!.leaseToken)).toBe(ORG);
            expect(await orgOfLease(id, '99999999-9999-4999-8999-999999999999')).toBeNull();
            expect(await orgOfLease(ABSENT, claim!.leaseToken)).toBeNull();
        });

        it('stops resolving once an unfinished lease expires — a dead run takes its pair with it', async () => {
            // Claim, then expire, with no reclaim and no verdict: the row is still 'running', but
            // the lease is gone, and the pair must not outlive it.
            const { id } = await queue('echo hi');
            const claim = await store.claim('w1', LEASE_SECONDS);
            await expireLease(id);

            expect((await row(id))[0]?.status).toBe('running');
            expect(await orgOfLease(id, claim!.leaseToken)).toBeNull();
        });

        it('keeps resolving after complete — the reporter’s tail sample lands after the verdict', async () => {
            const { id } = await queue('echo hi');
            const claim = await store.claim('w1', LEASE_SECONDS);
            await store.complete(id, claim!.leaseToken, {
                status: 'succeeded',
                exitCode: 0,
                output: 'done',
            });

            expect((await row(id))[0]?.status).toBe('succeeded');
            expect(await orgOfLease(id, claim!.leaseToken)).toBe(ORG);
        });

        it('stops resolving once the verdict is older than the tail grace', async () => {
            // The bound that keeps retention honest: the pair rides the job row with no
            // membership join, so a captured pair must expire like every other credential here.
            // The tail sample needs seconds; the grace is an hour.
            const { id } = await queue('echo hi');
            const claim = await store.claim('w1', LEASE_SECONDS);
            await store.complete(id, claim!.leaseToken, {
                status: 'succeeded',
                exitCode: 0,
                output: 'done',
            });
            await sql`update job set finished_at = now() - interval '2 hours' where id = ${id}`;

            expect(await orgOfLease(id, claim!.leaseToken)).toBeNull();
        });

        it('stops resolving the OLD lease once a reclaim rotated the token', async () => {
            const { id } = await queue('echo hi');
            const stale = await store.claim('w1', LEASE_SECONDS);
            await expireLease(id);
            const winner = await store.claim('w2', LEASE_SECONDS);
            expect(winner!.leaseToken).not.toBe(stale!.leaseToken);

            expect(await orgOfLease(id, stale!.leaseToken)).toBeNull();
            expect(await orgOfLease(id, winner!.leaseToken)).toBe(ORG);
        });

        it('stops resolving after a suspend — a parked attempt ends without a verdict', async () => {
            const { id } = await queue('echo hi');
            const claim = await store.claim('w1', LEASE_SECONDS);
            await store.suspend(id, claim!.leaseToken);

            expect(await orgOfLease(id, claim!.leaseToken)).toBeNull();
        });

        it('stops resolving after the dead retirement', async () => {
            const { id } = await queue('kill -9 $$');
            await sql`update job set max_attempts = 1 where id = ${id}`;
            const claim = await store.claim('w1', LEASE_SECONDS);
            await expireLease(id);
            await store.claim('w2', LEASE_SECONDS);
            expect((await row(id))[0]?.status).toBe('dead');

            expect(await orgOfLease(id, claim!.leaseToken)).toBeNull();
        });
    });

    it('stores the close-time agent-turn count, and unmeasured when the report carries none', async () => {
        const EXPECTED_AGENT_TURNS = 11;
        const first = await queue('echo hi');
        const one = await store.claim('w1', LEASE_SECONDS);
        await store.complete(first.id, one!.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'done',
            agentTurns: EXPECTED_AGENT_TURNS,
        });
        const rows = await sql<{ agent_turns: number | null }[]>`
            select agent_turns from job where org_id = ${ORG} and id = ${first.id}
        `;
        expect(rows[0]?.agent_turns).toBe(EXPECTED_AGENT_TURNS);

        // A report without a count overwrites to null: the verdict is the attempt's whole
        // write, and a retried report that lost its read must not inherit the killed
        // attempt's number.
        const second = await queue('echo hi');
        const two = await store.claim('w2', LEASE_SECONDS);
        await store.complete(second.id, two!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const rows2 = await sql<{ agent_turns: number | null }[]>`
            select agent_turns from job where org_id = ${ORG} and id = ${second.id}
        `;
        expect(rows2[0]?.agent_turns).toBeNull();
    });

    it('stores the close-time summary, and unmeasured when the report carries none', async () => {
        const first = await queue('echo hi');
        const one = await store.claim('w1', LEASE_SECONDS);
        await store.complete(first.id, one!.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'done',
            summary: 'Fixed the failing gates and pushed',
        });
        // The summary rides every read, list included — it is the recently-completed view's text.
        expect(await store.get(first.id)).toMatchObject({ summary: 'Fixed the failing gates and pushed' });
        const listed = await store.list({ limit: 10 });
        expect(listed.find((row) => row.id === first.id)).toMatchObject({
            summary: 'Fixed the failing gates and pushed',
        });

        // A report without a summary overwrites to null, exactly like the turn count.
        const second = await queue('echo hi');
        const two = await store.claim('w2', LEASE_SECONDS);
        await store.complete(second.id, two!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        expect(await store.get(second.id)).toMatchObject({ summary: null });
    });

    it('carries the run banked wall clock on list rows, and the thread sum only on the thread read', async () => {
        const first = await queue('echo hi');
        const one = await store.claim('w1', LEASE_SECONDS);
        await store.complete(first.id, one!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        // The verdict banks the attempt's segment, so the row's own clock is no longer null.
        const listed = await store.list({ limit: 10 });
        const row = listed.find((entry) => entry.id === first.id);
        expect(row).toBeDefined();
        expect(row!.wallClockMs).toEqual(expect.any(Number));
        // The thread total rides the thread read alone.
        expect(row?.taskWallClockMs ?? null).toBeNull();
        const thread = await store.thread(first.id);
        expect(thread).not.toBeNull();
        expect(thread![0]!.taskWallClockMs).toEqual(expect.any(Number));
    });

    it('streams a rolling output tail while the run is going', async () => {
        const { id } = await queue('echo hi');
        const claim = await store.claim('w1', LEASE_SECONDS);

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
        const first = await store.claim('w1', LEASE_SECONDS);
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
        const second = await store.claim('w2', LEASE_SECONDS);
        expect(await store.get(id)).toMatchObject({ runtime: null });

        // The last sample stays on a FINISHED row: "was it doing anything when it died" reads off
        // sampledAt.
        await store.progress(id, second!.leaseToken, 'again', vitals);
        await store.complete(id, second!.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: 'done',
            contextTokens: 90433,
            contextCostUsd: 0.31,
        });
        // The context stats MERGE into the sampled vitals — the row keeps its last sample and
        // gains the context the run reached beside it. The wire field is `contextCostUsd`; the
        // stored key is the cost's own name, `costUsd` — the one the task view reads.
        expect(await store.get(id)).toMatchObject({
            runtime: { ...vitals, contextTokens: 90433, costUsd: 0.31 },
        });
    });

    /**
     * The attempt's service fleet rides the same runtime object (issue #60), and the object
     * merges KEY-WISE: a report without services keeps the fleet a previous one carried, a
     * report whose numbers could not be read keeps the last good numbers, and the claim clears
     * the whole column — the fleet describes the attempt that took the lease, exactly like the
     * numbers do.
     */
    it('merges service states key-wise into the runtime, and clears them with it on a new attempt', async () => {
        const { id } = await queue('echo hi');
        const first = await store.claim('w1', LEASE_SECONDS);
        const vitals = {
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7,
            activity: '→ Read src/x.ts',
            sampledAt: '2026-09-09T10:00:00.000Z',
        };
        const services = [{ name: 'db', image: 'postgres:16', state: 'running' }];

        await store.progress(id, first!.leaseToken, 'working', { ...vitals, services });
        expect(await store.get(id)).toMatchObject({ runtime: { ...vitals, services } });

        // A vitals-only report keeps the fleet: the services half did not change this round.
        await store.progress(id, first!.leaseToken, 'still working', vitals);
        expect(await store.get(id)).toMatchObject({ runtime: { ...vitals, services } });

        // A services-only report (the vitals read failed this round) keeps the last good numbers.
        await store.progress(id, first!.leaseToken, 'still working', {
            cpuPercent: null,
            memUsedMb: null,
            memPercent: null,
            activity: null,
            sampledAt: '2026-09-09T10:01:00.000Z',
            services: [{ name: 'db', image: 'postgres:16', state: 'exited' }],
        });
        expect(await store.get(id)).toMatchObject({
            runtime: {
                cpuPercent: 93,
                memUsedMb: 544,
                services: [{ name: 'db', image: 'postgres:16', state: 'exited' }],
            },
        });

        // The next attempt's claim clears the whole column, fleet included — and the fresh
        // attempt's sample is exactly what it reports, nothing of the previous fleet left.
        await expireLease(id);
        const second = await store.claim('w2', LEASE_SECONDS);
        expect(await store.get(id)).toMatchObject({ runtime: null });
        await store.progress(id, second!.leaseToken, 'again', vitals);
        expect((await store.get(id))!.runtime).toEqual(vitals);
    });

    // The list feeds the task tree, whose task rows render the newest run's `activity` — so the
    // list projection carries the vitals too, the one field `gates` stays spared from and
    // `output` stays spared from still.
    it('carries the runtime vitals on list rows, for the task tree summaries', async () => {
        const { id } = await store.create('echo hi', null, { repo: 'owner/repo', executor: null });
        const claim = await store.claim('w1', LEASE_SECONDS);
        const vitals = {
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7,
            activity: '→ Read src/x.ts',
            sampledAt: '2026-09-09T10:00:00.000Z',
        };
        await store.progress(id, claim!.leaseToken, 'working', vitals);
        expect(await store.list({ limit: 50 })).toMatchObject([{ id, runtime: vitals }]);
        // The repo-filtered read serves the same projection — the summaries read either list.
        expect(await store.list({ limit: 50, repo: 'owner/repo' })).toMatchObject([{ id, runtime: vitals }]);
    });

    // A run whose runner never samples the container (kubernetes, a failed readout) still gets
    // its context stats stored: the merge creates the vitals object when none exists.
    it('stores context stats on a finished run with no container samples', async () => {
        const { id } = await queue('echo hi');
        const claim = await store.claim('w1', LEASE_SECONDS);

        await store.complete(id, claim!.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'done',
            contextTokens: 1200,
            contextCostUsd: 0,
        });

        expect(await store.get(id)).toMatchObject({
            runtime: { contextTokens: 1200, costUsd: 0 },
        });
        expect(await store.get(id)).toMatchObject({ output: 'done' });
    });

    it('refuses an output tail from a worker whose lease was reclaimed', async () => {
        const { id } = await queue('echo hi');
        const stale = await store.claim('w1', LEASE_SECONDS);
        await expireLease(id);
        await store.claim('w2', LEASE_SECONDS);

        expect(await store.progress(id, stale!.leaseToken, 'from the zombie')).toBe('lost');
        expect(await store.progress(ABSENT, stale!.leaseToken, 'nowhere')).toBe('missing');
    });

    it('records the session an attempt is running as', async () => {
        const { id } = await queue('echo hi');
        const claim = await store.claim('w1', LEASE_SECONDS);

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
        const claim = await store.claim('w1', LEASE_SECONDS);
        const ses = 'ses_f86188c3dffeZGYO4yZq4atba9';

        await store.session(id, claim!.leaseToken, ses, null);
        await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });

        const followUp = await mustFollowUp(id, 'again', null);
        expect(await store.get(followUp.id)).toMatchObject({ followUpTo: id, sessionId: ses });

        const second = await store.claim('w2', LEASE_SECONDS);
        expect(second).toMatchObject({ id: followUp.id, resumeSessionId: ses, followUp: true });
    });

    // Two reports per attempt: the local id at spawn, the remote one once the bridge connects. The
    // second must not be able to wipe the first, and the first must not wipe a remote id that a
    // later report already stored.
    it('adds the remote session id without clearing what is already there', async () => {
        const { id } = await queue('drive me');
        const claim = await store.claim('w1', LEASE_SECONDS);

        await store.session(id, claim!.leaseToken, SESSION, null);
        await store.session(id, claim!.leaseToken, SESSION, REMOTE);
        await store.session(id, claim!.leaseToken, SESSION, null);

        expect(await store.get(id)).toMatchObject({ sessionId: SESSION, remoteSessionId: REMOTE });
    });

    it('drops the remote session when the job is claimed again', async () => {
        const { id } = await queue('drive me');
        const first = await store.claim('w1', LEASE_SECONDS);
        await store.session(id, first!.leaseToken, SESSION, REMOTE);
        await expireLease(id);

        await store.claim('w2', LEASE_SECONDS);

        expect((await store.get(id))?.remoteSessionId).toBeNull();
    });

    it('refuses a session report from a worker whose lease was reclaimed', async () => {
        const { id } = await queue('echo hi');
        const stale = await store.claim('w1', LEASE_SECONDS);
        await expireLease(id);
        await store.claim('w2', LEASE_SECONDS);

        expect(await store.session(id, stale!.leaseToken, SESSION, null)).toBe('lost');
        expect(await store.session(ABSENT, stale!.leaseToken, SESSION, null)).toBe('missing');
    });

    // The attempt that died ran a different session, and showing its link next to this attempt's
    // output would point a reader at work that was thrown away.
    it('clears the session when the job is claimed again', async () => {
        const { id } = await queue('echo hi');
        const first = await store.claim('w1', LEASE_SECONDS);
        await store.session(id, first!.leaseToken, SESSION, null);
        await expireLease(id);

        await store.claim('w2', LEASE_SECONDS);

        expect((await store.get(id))?.sessionId).toBeNull();
    });

    it('parks a running job without finishing it, keeping its session', async () => {
        const { id } = await queue('drive me');
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.session(id, claim!.leaseToken, SESSION, null);

        // No stop was asked, so this is the Remote Control idle landing: standby, not finished.
        expect(await store.suspend(id, claim!.leaseToken)).toEqual({ result: 'ok', status: 'standby' });

        expect(await store.get(id)).toMatchObject({ status: 'standby', sessionId: SESSION });
        expect((await store.get(id))?.finishedAt).toBeNull();
    });

    // A parked job must not be picked up by the next idle poll — that would resume it instantly,
    // which is the opposite of parking it. The partial claim index is what makes this true.
    it('does not hand out a parked job', async () => {
        const { id } = await queue('drive me');
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.suspend(id, claim!.leaseToken);

        expect(await store.claim('w2', LEASE_SECONDS)).toBeNull();
    });

    // Parking is not a failed try: the attempt is handed back, whatever the landing.
    it('hands back the attempt it took, so parking is not a retry', async () => {
        const { id } = await queue('drive me');
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.suspend(id, claim!.leaseToken);

        expect(await store.get(id)).toMatchObject({ status: 'standby', attempts: 0 });
    });

    // A lease that expired mid-run is not a park: that attempt's session is not this one, and
    // resuming it would replay a transcript whose output was thrown away.
    it('does not offer a session to resume when it is reclaiming a crashed attempt', async () => {
        const { id } = await queue('echo hi');
        const first = await store.claim('w1', LEASE_SECONDS);
        await store.session(id, first!.leaseToken, SESSION, null);
        await expireLease(id);

        const second = await store.claim('w2', LEASE_SECONDS);

        expect(second?.resumeSessionId).toBeNull();
    });

    it('refuses to park a job on a lease that has moved on', async () => {
        const { id } = await queue('echo hi');
        const stale = await store.claim('w1', LEASE_SECONDS);
        await expireLease(id);
        await store.claim('w2', LEASE_SECONDS);

        expect(await store.suspend(id, stale!.leaseToken)).toEqual({ result: 'lost' });
        expect(await store.suspend(ABSENT, stale!.leaseToken)).toEqual({ result: 'missing' });
    });

    it('leaves output out of the list projection', async () => {
        const { id } = await queue('echo hi');
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'noise' });

        const [listed] = await store.list({ limit: 10 });
        expect(listed?.output).toBeNull();
        expect((await store.get(id))?.output).toBe('noise');
    });

    it('filters the list by status', async () => {
        await queue('one');
        const { id } = await queue('two');
        await store.claim('w1', LEASE_SECONDS);

        expect(await store.list({ status: 'running', limit: 10 })).toHaveLength(1);
        expect((await store.list({ status: 'queued', limit: 10 }))[0]?.id).toBe(id);
    });

    it("filters the list by the 'terminal' pseudo-status — every settled verdict at once", async () => {
        const done = await queue('one');
        await queue('two');
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.complete(done.id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });

        const terminal = await store.list({ status: 'terminal', limit: 10 });
        expect(terminal).toHaveLength(1);
        expect(terminal[0]?.id).toBe(done.id);
        // The still-queued row never appears: the filter is exactly the settled-verdict set
        // the thread-done computation uses.
        expect(await store.list({ limit: 10 })).toHaveLength(2);
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

        expect(await otherOrgStore.claim('intruder', LEASE_SECONDS)).toBeNull();
        expect(await otherOrgStore.get(id)).toBeNull();
        expect(await store.claim('w1', LEASE_SECONDS)).not.toBeNull();
    });

    // Duplicates would prove a lost update; nulls would prove the row lock is being taken above the
    // limit, so a contended row is counted and then discarded rather than skipped.
    it('never hands the same job to two claimers', async () => {
        const CONCURRENT_CLAIM_COUNT = 50;
        const ids = new Set<string>();
        for (let i = 0; i < CONCURRENT_CLAIM_COUNT; i += 1) ids.add((await queue(`job ${i}`)).id);

        const claims = await Promise.all(
            Array.from({ length: CONCURRENT_CLAIM_COUNT }, (_, i) => store.claim(`w${i}`, LEASE_SECONDS))
        );

        expect(claims.filter((claim) => claim === null)).toHaveLength(0);
        expect(new Set(claims.map((claim) => claim?.id)).size).toBe(CONCURRENT_CLAIM_COUNT);
    });

    it('skips a locked row rather than waiting on it', async () => {
        const { id: pinned } = await queue('first');
        const { id: next } = await queue('second');

        await sql.begin(async (tx) => {
            await tx`select id from job where id = ${pinned} for update`;
            // Would block forever without `skip locked`, and the test would time out rather than
            // fail — which is itself the signal.
            expect((await store.claim('w1', LEASE_SECONDS))?.id).toBe(next);
        });
    });
});
