import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { createJobStore, type JobStore } from '../src/db/job-store.js';

const url = process.env.DATABASE_URL;

/** Same guard as the sibling suites: these tests truncate, so they refuse a non-test database. */
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

const ORG = 'test-org';

/** A real account for created_by to point at — the workspace-path derivation reads it. Resolved in
 * beforeAll: `created_by` is a uuid foreign key, so a literal login will not do. */
let AUTHOR: string;

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
    sql = postgres(url as string, { max: 8 });
    await migrate(sql, { orgId: ORG, attempts: 3 });
    // A generated identity, never a literal: integration tests do not hardcode ids, and a random
    // one cannot collide with a real backfilled user the way a memorable constant eventually would.
    AUTHOR = await account(Number.parseInt(randomUUID().slice(0, 8), 16), 'stop-remove-cat');
    store = createJobStore({ sql, orgId: ORG });
});

afterAll(async () => {
    if (enabled) await sql.end();
});

beforeEach(async () => {
    if (!enabled) return;
    await sql`truncate job`;
    await sql`truncate task_reclaim`;
});

/** Writes a job row in whatever state the case needs. `created_by` defaults to an author, so the
 * workspace-path derivation has something to read. */
const craft = async (shape: {
    parent?: string | null;
    status?: 'queued' | 'running' | 'standby' | 'succeeded' | 'failed' | 'dead';
    lease?: 'live' | 'expired';
    createdBy?: string | null;
    repo?: string | null;
} = {}): Promise<string> => {
    const id = randomUUID();
    await sql`
        insert into job (org_id, id, command, status, parent_job_id, created_by, repo, lease_expires_at, created_at)
        values (
            ${ORG}, ${id}, 'crafted',
            ${shape.status ?? 'queued'},
            ${shape.parent ?? null},
            ${shape.createdBy === undefined ? AUTHOR : shape.createdBy},
            ${shape.repo === undefined ? 'acme/widgets' : shape.repo},
            ${shape.lease === 'live' ? sql`now() + interval '5 minutes'` : sql`now() - interval '1 second'`},
            now()
        )
    `;
    return id;
};

describe.skipIf(!enabled)('stopping a task', () => {
    it('parks a queued job directly, and the flag stays off', async () => {
        const id = await craft();

        expect(await store.stop(id)).toEqual({ result: 'parked' });

        const job = await store.get(id);
        expect(job?.status).toBe('standby');
        expect(job?.cancelRequestedAt).toBeNull();
    });

    it('parks an already-parked job again, idempotently', async () => {
        const id = await craft({ status: 'standby' });

        expect(await store.stop(id)).toEqual({ result: 'parked' });
        expect((await store.get(id))?.status).toBe('standby');
    });

    it('stamps a running job as stop-requested and leaves it running until the worker parks it', async () => {
        const id = await craft({ status: 'running', lease: 'live' });

        const result = await store.stop(id);
        expect(result).toMatchObject({ result: 'requested' });
        expect(result?.cancelRequestedAt).toBeTruthy();

        const job = await store.get(id);
        expect(job?.status).toBe('running');
        expect(Date.parse(job!.cancelRequestedAt!)).toBeGreaterThan(0);
    });

    it('answers the SAME instant on a second stop of a running job — idempotent, not rewriting', async () => {
        const id = await craft({ status: 'running', lease: 'live' });

        const first = await store.stop(id);
        const second = await store.stop(id);

        expect(second).toEqual(first);
    });

    it('refuses a finished task', async () => {
        for (const status of ['succeeded', 'failed', 'dead'] as const) {
            const id = await craft({ status });
            expect(await store.stop(id)).toEqual({ result: 'conflict', status });
        }
    });

    it('says missing for a job that is not here', async () => {
        expect(await store.stop(randomUUID())).toBe('missing');
    });

    it('leaves a queued task out of the claim queue once parked', async () => {
        const id = await craft();
        await store.stop(id);

        expect(await store.claim('w1', 300)).toBeNull();
    });

    it('is reported by the worker\'s heartbeat, and parking clears it', async () => {
        const id = await craft();
        const token = (await store.claim('w1', 300))!.leaseToken;

        expect(await store.heartbeat(id, token, 300)).toMatchObject({
            result: 'ok',
            cancelRequested: false,
        });

        await store.stop(id);
        expect(await store.heartbeat(id, token, 300)).toMatchObject({
            result: 'ok',
            cancelRequested: true,
        });

        // The worker honours the request by parking (suspend), which is the stopping happening:
        // the row is standby and the flag is gone, so a resumed run is a plain parked run.
        expect(await store.suspend(id, token, 300)).toBe('ok');
        const job = await store.get(id);
        expect(job?.status).toBe('standby');
        expect(job?.cancelRequestedAt).toBeNull();
    });
});

describe.skipIf(!enabled)('removing a task', () => {
    it('deletes the whole thread and queues a worktree reclaim', async () => {
        const root = await craft();
        const followUp = await craft({ parent: root });

        const result = await store.removeThread(followUp);
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

        expect(await store.removeThread(root)).toBe('conflict');

        expect(await store.thread(root)).not.toBeNull();
        expect(await store.claimReclaim('w1', 300)).toBeNull();
    });

    it('also notices a running FOLLOW-UP when asked about the root', async () => {
        const root = await craft({ status: 'succeeded' });
        await craft({ parent: root, status: 'running', lease: 'live' });

        expect(await store.removeThread(root)).toBe('conflict');
    });

    it('says missing when the id is not here', async () => {
        expect(await store.removeThread(randomUUID())).toBe('missing');
    });

    it('queues no reclaim for a deputy that never queued to a repo or an author', async () => {
        const root = await craft({ createdBy: null, repo: null });

        const result = await store.removeThread(root);
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
        await store.removeThread(a);
        await store.removeThread(b);

        const first = await store.claimReclaim('w1', 300);
        const second = await store.claimReclaim('w2', 300);

        expect(first).toMatchObject({ rootJobId: a });
        expect(second).toMatchObject({ rootJobId: b });
    });

    it('re-leases by the expiry GRANTED to the holder, never by the polling worker\'s requested lease', async () => {
        const a = await craft();
        await store.removeThread(a);

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
        await store.removeThread(a);

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
        await store.removeThread(a);
        const claim = await store.claimReclaim('w1', 300);

        expect(await store.ackReclaim(claim!.id, 'w2')).toBe('lost');
        expect(await store.claimReclaim('w2', 300)).toBeNull();

        expect(await store.ackReclaim(claim!.id, 'w1')).toBe('ok');
    });

    it('says missing on a double ack — the row is already gone', async () => {
        const a = await craft();
        await store.removeThread(a);
        const claim = await store.claimReclaim('w1', 300);

        expect(await store.ackReclaim(claim!.id, 'w1')).toBe('ok');
        expect(await store.ackReclaim(claim!.id, 'w1')).toBe('missing');
    });

    it('says missing for a reclaim that never existed', async () => {
        expect(await store.ackReclaim(randomUUID(), 'w1')).toBe('missing');
    });
});