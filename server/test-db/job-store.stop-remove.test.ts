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
const AUTHOR_GITHUB_ID = Number.parseInt(randomUUID().slice(0, 8), 16);

const db = useTestDb({ max: 8, users: [{ id: AUTHOR, githubUserId: AUTHOR_GITHUB_ID, login: 'stop-remove-cat' }] });

/** Written directly rather than through the auth store, like the sibling suites: this file is about
 * stop and remove, and a sign-in round trip would fail these cases for reasons foreign to them. */
const account = async (githubUserId: number, login: string): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
        insert into app_user (github_user_id, github_login) values (${githubUserId}, ${login})
        on conflict (github_user_id) do update set github_login = excluded.github_login
        returning id
    `;
    return row!.id;
};

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

describe.skipIf(!enabled)('stopping a task', () => {
    it('settles a queued job directly — the turn ends before it began', async () => {
        const id = await craft();

        expect(await store.stop(id, null)).toEqual({ result: 'stopped' });

        const job = await store.get(id);
        expect(job?.status).toBe('stopped');
        expect(job?.finishedAt).toBeTruthy();
        expect(job?.cancelRequestedAt).toBeNull();
    });

    it('settles an already-parked job directly too', async () => {
        const id = await craft({ status: 'standby' });

        expect(await store.stop(id, null)).toEqual({ result: 'stopped' });
        expect((await store.get(id))?.status).toBe('stopped');
    });

    it('stamps a running job as stop-requested and leaves it running until the worker settles it', async () => {
        const id = await craft({ status: 'running', lease: 'live' });

        const result = await store.stop(id, null);
        expect(result).toMatchObject({ result: 'requested', cancelRequestedAt: expect.any(String) });

        const job = await store.get(id);
        expect(job?.status).toBe('running');
        expect(Date.parse(job!.cancelRequestedAt!)).toBeGreaterThan(0);
    });

    it('answers the SAME instant on a second stop of a running job — idempotent, not rewriting', async () => {
        const id = await craft({ status: 'running', lease: 'live' });

        const first = await store.stop(id, null);
        const second = await store.stop(id, null);

        expect(second).toEqual(first);
    });

    it('refuses a task that already ended', async () => {
        for (const status of ['succeeded', 'failed', 'dead', 'stopped'] as const) {
            const id = await craft({ status });
            expect(await store.stop(id, null)).toEqual({ result: 'conflict', status });
        }
    });

    it('says missing for a job that is not here', async () => {
        expect(await store.stop(randomUUID(), null)).toBe('missing');
    });

    it('leaves a queued task out of the claim queue once stopped', async () => {
        const id = await craft();
        await store.stop(id, null);

        expect(await store.claim('w1', 300)).toBeNull();
    });

    it("is reported by the worker's heartbeat, and suspending settles the run stopped", async () => {
        const id = await craft();
        const token = (await store.claim('w1', 300))!.leaseToken;

        expect(await store.heartbeat(id, token, 300)).toMatchObject({
            result: 'ok',
            cancelRequested: false,
        });

        await store.stop(id, null);
        expect(await store.heartbeat(id, token, 300)).toMatchObject({
            result: 'ok',
            cancelRequested: true,
        });

        // The worker honours the request by parking (suspend), which IS the stop landing: the row
        // settles `stopped` — terminal, the turn over — and the flag is gone with it.
        expect(await store.suspend(id, token)).toEqual({ result: 'ok', status: 'stopped' });
        const job = await store.get(id);
        expect(job?.status).toBe('stopped');
        expect(job?.finishedAt).toBeTruthy();
        expect(job?.cancelRequestedAt).toBeNull();
    });

    // The whole point of ending the turn instead of parking: the session survives the stop, so
    // the follow-up composer is what the member sees next.
    it('keeps the session when the stop lands', async () => {
        const id = await craft();
        const token = (await store.claim('w1', 300))!.leaseToken;
        // The worker reports the session mid-run — after the claim, which clears a fresh
        // attempt's session (only a follow-up keeps a copied one). This is the lease-guarded
        // route a real run uses, not a direct row write the claim would erase.
        await store.session(id, token, randomUUID(), null);

        await store.stop(id, null);
        await store.suspend(id, token);

        const job = await store.get(id);
        expect(job?.status).toBe('stopped');
        expect(job?.sessionId).not.toBeNull();
    });
});

describe.skipIf(!enabled)('removing a task', () => {
    it('deletes the whole thread and queues a worktree reclaim', async () => {
        const root = await craft();
        const followUp = await craft({ parent: root });

        const result = await store.removeThread(followUp, null);
        expect(result).toEqual({
            result: 'ok',
            rootJobId: root,
            repo: 'acme/widgets',
            workspacePath: `${ORG}/${AUTHOR}`,
        });

        expect(await store.get(root)).toBeNull();
        expect(await store.get(followUp)).toBeNull();
        expect(await store.thread(root)).toBeNull();

        // Exactly one reclaim row, addressed at the resolved root.
        const claim = await store.claimReclaim('w1', 300);
        expect(claim).toMatchObject({
            rootJobId: root,
            repo: 'acme/widgets',
            workspacePath: `${ORG}/${AUTHOR}`,
        });
    });

    it('refuses while any member of the thread is running, deleting nothing', async () => {
        const root = await craft({ status: 'running', lease: 'live' });
        await craft({ parent: root, status: 'running', lease: 'live' });

        expect(await store.removeThread(root, null)).toBe('conflict');

        expect(await store.thread(root)).not.toBeNull();
        expect(await store.claimReclaim('w1', 300)).toBeNull();
    });

    it('also notices a running FOLLOW-UP when asked about the root', async () => {
        const root = await craft({ status: 'succeeded' });
        await craft({ parent: root, status: 'running', lease: 'live' });

        expect(await store.removeThread(root, null)).toBe('conflict');
    });

    it('says missing when the id is not here', async () => {
        expect(await store.removeThread(randomUUID(), null)).toBe('missing');
    });

    it('queues no reclaim for a deputy that never queued to a repo or an author', async () => {
        const root = await craft({ createdBy: null, repo: null });

        const result = await store.removeThread(root, null);
        expect(result).toEqual({ result: 'ok', rootJobId: root, repo: null, workspacePath: null });

        const claim = await store.claimReclaim('w1', 300);
        expect(claim).toMatchObject({ rootJobId: root, repo: null, workspacePath: null });
    });
});

describe.skipIf(!enabled)('the reclaim queue', () => {
    it('answers null on an empty queue', async () => {
        expect(await store.claimReclaim('w1', 300)).toBeNull();
    });

    it('hands the oldest row, oldest first, one row per claim', async () => {
        const a = await craft();
        const b = await craft();
        await store.removeThread(a, null);
        await store.removeThread(b, null);

        const first = await store.claimReclaim('w1', 300);
        const second = await store.claimReclaim('w2', 300);

        expect(first).toMatchObject({ rootJobId: a });
        expect(second).toMatchObject({ rootJobId: b });
    });

    it("re-leases by the expiry GRANTED to the holder, never by the polling worker's requested lease", async () => {
        const a = await craft();
        await store.removeThread(a, null);

        const first = await store.claimReclaim('w1', 300);
        expect(first).not.toBeNull();

        // Twenty seconds into w1's 300-second lease — long past any 10-second lease, nowhere near
        // its expiry. Backdated rather than slept: what decides is the persisted expiry, not the
        // wall clock since claiming.
        await sql`update task_reclaim set lease_expires_at = now() + interval '280 seconds' where id = ${first!.id}`;

        // A poller asking for a 10-second lease must not inherit the row: the check reads the
        // granted expiry, never the polling worker's own leaseSeconds against claimed_at.
        expect(await store.claimReclaim('w2', 10)).toBeNull();

        // Once the granted expiry itself has passed, the row is claimable again — by the persisted
        // column, whatever the next poller asks for.
        await sql`update task_reclaim set lease_expires_at = now() - interval '1 second' where id = ${first!.id}`;
        expect((await store.claimReclaim('w2', 10))?.rootJobId).toBe(a);
    });

    it('re-leases a claim whose lease has expired, without touching a live one', async () => {
        const a = await craft();
        await store.removeThread(a, null);

        const first = await store.claimReclaim('w1', 2);
        expect(first).not.toBeNull();

        // Live lease: refused.
        expect(await store.claimReclaim('w2', 300)).toBeNull();

        // Expired lease: claimable by another worker.
        await new Promise((resolve) => setTimeout(resolve, 2300));
        const second = await store.claimReclaim('w2', 300);
        expect(second?.rootJobId).toBe(a);
    });

    it('acks only the worker that holds the claim, deleting the row on success', async () => {
        const a = await craft();
        await store.removeThread(a, null);
        const claim = await store.claimReclaim('w1', 300);

        expect(await store.ackReclaim(claim!.id, 'w2')).toBe('lost');
        expect(await store.claimReclaim('w2', 300)).toBeNull();

        expect(await store.ackReclaim(claim!.id, 'w1')).toBe('ok');
    });

    it('says missing on a double ack — the row is already gone', async () => {
        const a = await craft();
        await store.removeThread(a, null);
        const claim = await store.claimReclaim('w1', 300);

        expect(await store.ackReclaim(claim!.id, 'w1')).toBe('ok');
        expect(await store.ackReclaim(claim!.id, 'w1')).toBe('missing');
    });

    it('says missing for a reclaim that never existed', async () => {
        expect(await store.ackReclaim(randomUUID(), 'w1')).toBe('missing');
    });
});

describe.skipIf(!enabled)('lifecycle actors', () => {
    // Stop and done are a person's verdict; 025 records which person. The actor comes off the
    // session at the route, rides beside the idempotence coalesces (first writer wins), and dies
    // with the member's account (`on delete set null`) — never with the record of the action.

    it('stamps the stopping caller, resolved to their account labels', async () => {
        const id = await craft();
        await store.stop(id, AUTHOR);

        const job = await store.get(id);
        expect(job?.stoppedBy).toMatchObject({ id: AUTHOR, login: 'stop-remove-cat' });
        expect(job?.doneBy).toBeNull();
    });

    it('keeps the FIRST stopper when a second caller asks again', async () => {
        const other = await account(Number.parseInt(randomUUID().slice(0, 8), 16), 'second-stopper');
        const id = await craft({ status: 'running', lease: 'live' });

        await store.stop(id, AUTHOR);
        await store.stop(id, other);

        expect((await store.get(id))?.stoppedBy?.id).toBe(AUTHOR);
        await sql`delete from app_user where id = ${other}`;
    });

    it('keeps the stopper through the suspend landing', async () => {
        const id = await craft();
        const token = (await store.claim('w1', 300))!.leaseToken;
        await store.stop(id, AUTHOR);
        await store.suspend(id, token);

        expect((await store.get(id))?.stoppedBy?.id).toBe(AUTHOR);
    });

    it('stamps the done caller once, beside the done_at coalesce', async () => {
        const other = await account(Number.parseInt(randomUUID().slice(0, 8), 16), 'second-doner');
        const id = await craft({ status: 'succeeded' });

        await store.markDone(id, AUTHOR);
        await store.markDone(id, other);

        const job = await store.get(id);
        expect(job?.doneBy?.id).toBe(AUTHOR);
        expect(job?.stoppedBy).toBeNull();
        await sql`delete from app_user where id = ${other}`;
    });

    it('rides the remover onto the task_reclaim row the thread leaves behind', async () => {
        const id = await craft();
        await store.removeThread(id, AUTHOR);

        const [row] = await sql<{ removed_by: string | null }[]>`
            select removed_by from task_reclaim where org_id = ${ORG}
        `;
        expect(row?.removed_by).toBe(AUTHOR);
    });

    it("nulls the actors when their account is deleted, keeping the stamps' columns", async () => {
        const ephemeral = await account(Number.parseInt(randomUUID().slice(0, 8), 16), 'ephemeral');
        const id = await craft({ createdBy: ephemeral, status: 'succeeded' });
        await store.stop(id, ephemeral);
        await store.markDone(id, ephemeral);
        await sql`delete from app_user where id = ${ephemeral}`;

        const job = await store.get(id);
        expect(job?.author).toBeNull();
        expect(job?.stoppedBy).toBeNull();
        expect(job?.doneBy).toBeNull();
    });

    it('resolves the author onto every read, and honestly null for a pre-accounts row', async () => {
        const authored = await craft();
        const anonymous = await craft({ createdBy: null });
        await store.stop(authored, AUTHOR);
        await store.markDone(authored, AUTHOR);

        const got = await store.get(authored);
        expect(got?.author).toMatchObject({ id: AUTHOR, login: 'stop-remove-cat' });
        expect(got?.stoppedBy?.login).toBe('stop-remove-cat');
        expect(got?.doneBy?.login).toBe('stop-remove-cat');
        expect((await store.get(anonymous))?.author).toBeNull();

        const listed = await store.list({ limit: 100 });
        expect(listed.find((j) => j.id === authored)?.author?.id).toBe(AUTHOR);
        expect(listed.find((j) => j.id === anonymous)?.author).toBeNull();

        const thread = await store.thread(authored);
        expect(thread?.map((j) => j.author?.id)).toEqual([AUTHOR]);
    });
});
