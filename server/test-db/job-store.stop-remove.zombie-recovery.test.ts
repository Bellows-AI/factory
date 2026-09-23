import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createJobStore, type JobStore } from '../src/db/job-store.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;

const ORG = 'test-org';

/**
 * The jobs' author — the workspace-path derivation reads it. A generated identity, never a
 * literal: integration tests do not hardcode ids, and a random one cannot collide with a real
 * backfilled user the way a memorable constant eventually would. Re-planted before every test,
 * because `created_by` is a uuid foreign key.
 */
const AUTHOR = randomUUID();
/** Turns a slice of a uuid into a plausible github id — hex digits, parsed as base 16. */
const UUID_HEX_SLICE_LENGTH = 8;
const HEX_RADIX = 16;
const AUTHOR_GITHUB_ID = Number.parseInt(randomUUID().slice(0, UUID_HEX_SLICE_LENGTH), HEX_RADIX);

/** A lease long enough that nothing in this suite outlives it by accident. */
const LEASE_SECONDS = 300;

const db = useTestDb({ max: 8, users: [{ id: AUTHOR, githubUserId: AUTHOR_GITHUB_ID, login: 'stop-remove-cat' }] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

/** Writes a job row in whatever state the case needs. `created_by` defaults to an author, so the
 * workspace-path derivation has something to read. */
const craft = async (
    shape: {
        parent?: string | null;
        status?: 'queued' | 'running' | 'standby' | 'succeeded' | 'failed' | 'dead' | 'stopped';
        lease?: 'live' | 'expired';
        createdBy?: string | null;
        repo?: string | null;
    } = {}
): Promise<string> => {
    const id = randomUUID();
    await sql`
        insert into job (org_id, id, command, status, parent_job_id, root_job_id, created_by, repo, lease_expires_at, created_at)
        values (
            ${ORG}, ${id}, 'crafted',
            ${shape.status ?? 'queued'},
            ${shape.parent ?? null},
            ${shape.parent ?? id},
            ${shape.createdBy === undefined ? AUTHOR : shape.createdBy},
            ${shape.repo === undefined ? 'acme/widgets' : shape.repo},
            ${shape.lease === 'live' ? sql`now() + interval '5 minutes'` : sql`now() - interval '1 second'`},
            now()
        )
    `;
    return id;
};

describe.skipIf(!enabled)('stopping a task: zombie recovery', () => {
    // A stop nobody delivers — the driver died before its heartbeat could carry the kill order —
    // must not re-issue the run (issue #152): the claim settles the stamped row `stopped` instead
    // of handing it to a new attempt, and the session the stopped run kept is what the follow-up
    // continues. Re-claiming would clear the session and spawn a container for a command the
    // member just cancelled.
    it('settles a stop-requested run stopped at the claim, instead of handing it out again', async () => {
        const id = await craft();
        const token = (await store.claim('w1', LEASE_SECONDS))!.leaseToken;
        const sid = randomUUID();
        await store.session(id, token, sid, null);
        expect(await store.stop(id, null)).toMatchObject({ result: 'requested' });
        await sql`update job set lease_expires_at = now() - interval '1 second' where id = ${id}`;

        expect(await store.claim('w2', LEASE_SECONDS)).toBeNull();

        const job = await store.get(id);
        expect(job?.status).toBe('stopped');
        expect(job?.finishedAt).toBeTruthy();
        expect(job?.cancelRequestedAt).toBeNull();
        expect(job?.sessionId).toBe(sid);
        // The park hands the attempt back, exactly as the delivered stop's suspend does — a stop
        // is a park, not a failed try.
        expect(job?.attempts).toBe(0);
    });

    // Exhausted attempts do not change the verdict: a stamped row is a park, not a failure, so
    // the dead-retirement sweep must never land it `dead` (issue #152) — the label is wrong and
    // the UI would read the task as over rather than stopped-and-continuable.
    it('lands a stamped exhausted run stopped, not dead, when the claim retires it', async () => {
        const id = await craft();
        const token = (await store.claim('w1', LEASE_SECONDS))!.leaseToken;
        const sid = randomUUID();
        await store.session(id, token, sid, null);
        await store.stop(id, null);
        await sql`update job set attempts = max_attempts, lease_expires_at = now() - interval '1 second'
                  where id = ${id}`;

        expect(await store.claim('w2', LEASE_SECONDS)).toBeNull();

        const job = await store.get(id);
        expect(job?.status).toBe('stopped');
        expect(job?.finishedAt).toBeTruthy();
        expect(job?.sessionId).toBe(sid);
    });

    // Nobody holds an expired lease, so the stop lands in place rather than waiting for a
    // heartbeat nobody will send (issue #152). A previous holder that is still beating renews
    // its lease and gets today's stamp-and-202 path instead — and one that lost the row gets
    // the heartbeat's 'lost' kill order, exactly as a reclaim delivers it.
    it("settles the stop in place when the run's lease is already gone", async () => {
        const id = await craft();
        const token = (await store.claim('w1', LEASE_SECONDS))!.leaseToken;
        const sid = randomUUID();
        await store.session(id, token, sid, null);
        await sql`update job set lease_expires_at = now() - interval '1 second' where id = ${id}`;

        expect(await store.stop(id, AUTHOR)).toEqual({ result: 'stopped' });

        const job = await store.get(id);
        expect(job?.status).toBe('stopped');
        expect(job?.finishedAt).toBeTruthy();
        expect(job?.cancelRequestedAt).toBeNull();
        expect(job?.sessionId).toBe(sid);
        expect(job?.attempts).toBe(0);
        // The stale worker's next beat is its kill order — the row no longer runs under this
        // lease.
        expect(await store.heartbeat(id, token, LEASE_SECONDS)).toMatchObject({ result: 'lost' });
    });

    // End to end: the stuck run's stop is delivered by the claim's settle, and the follow-up the
    // member then queues resumes the conversation — the whole continuable story of issue #152.
    it('unblocks the follow-up: the claim settles a stamped zombie parent and the child claims it', async () => {
        const id = await craft();
        const token = (await store.claim('w1', LEASE_SECONDS))!.leaseToken;
        const sid = randomUUID();
        await store.session(id, token, sid, null);
        await store.stop(id, null);
        await sql`update job set lease_expires_at = now() - interval '1 second' where id = ${id}`;
        expect(await store.claim('w2', LEASE_SECONDS)).toBeNull();

        const followUp = await store.createFollowUp(id, 'pick up', AUTHOR);
        if (typeof followUp === 'string') throw new Error(`createFollowUp refused: ${followUp}`);

        expect(await store.claim('w3', LEASE_SECONDS)).toMatchObject({
            id: followUp.id,
            resumeSessionId: sid,
            followUp: true,
        });
    });

    // The settle is committed on its own, before the claim transaction (review of PR #153): the
    // transaction also carries the claim's PREPARATION — the env resolution, the token mint —
    // and a throw there rolls the whole thing back, settlement included. Inside it, a board whose
    // preparation keeps failing would keep the stamped zombie `running` forever, and the
    // follow-up the member queued would keep answering not_finished — the exact stuck state this
    // issue exists to end.
    it("commits the settle even when the claim's preparation throws", async () => {
        const zombie = await craft();
        const token = (await store.claim('w1', LEASE_SECONDS))!.leaseToken;
        const sid = randomUUID();
        await store.session(zombie, token, sid, null);
        await store.stop(zombie, null);
        await sql`update job set lease_expires_at = now() - interval '1 second' where id = ${zombie}`;

        // A healthy candidate behind it: the claim takes it, reaches preparation, and the
        // resolver throws — the failure the claim route answers 503 to and the driver retries.
        const fresh = await craft();
        const failing = createJobStore({
            sql,
            orgId: ORG,
            env: {
                resolveFor: async () => {
                    throw new Error('resolver down');
                },
            },
        });
        await expect(failing.claim('w2', LEASE_SECONDS)).rejects.toThrow('resolver down');

        // The settle survived the rollback: the zombie is stopped with its session, and the
        // follow-up it was blocking can be created.
        const job = await store.get(zombie);
        expect(job?.status).toBe('stopped');
        expect(job?.sessionId).toBe(sid);
        expect(job?.cancelRequestedAt).toBeNull();
        const followUp = await store.createFollowUp(zombie, 'pick up', AUTHOR);
        if (typeof followUp === 'string') throw new Error(`createFollowUp refused: ${followUp}`);

        // And the failed claim's own candidate is back to queued, attempt unburned — the
        // rollback still guards exactly the half-claim it always did.
        expect(await store.get(fresh)).toMatchObject({ status: 'queued', attempts: 0 });
        expect((await store.claim('w3', LEASE_SECONDS))?.id).toBe(fresh);
    });
});
