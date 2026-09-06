import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { createJobStore, type JobStore } from '../src/db/job-store.js';

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
        expect(first).toMatchObject({ id, command: 'echo hi', attempts: 1 });

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

    it('records the session an attempt is running as', async () => {
        const { id } = await queue('echo hi');
        const claim = await store.claim('w1', 300);

        expect(await store.session(id, claim!.leaseToken, SESSION, null)).toBe('ok');
        expect(await store.get(id)).toMatchObject({ sessionId: SESSION });
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

        expect(second).toMatchObject({ id, resumeSessionId: SESSION });
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
});
