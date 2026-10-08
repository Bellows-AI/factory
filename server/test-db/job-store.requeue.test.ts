import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim, JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';

/**
 * Issue #559: a pre-run claim handed back after checkout contention — the attempt refunded, the
 * next claim deferred, the claim sequence still climbing, and Stop, Remove and a replacement
 * claim all winning their races with it.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = 'test-org';
const WORKER = 'worker-1';
const db = useTestDb({ orgs: [ORG] });

let sql: Sql;
let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

async function queue(): Promise<string> {
    const job = await store.create('do the thing', null, { repo: null, executor: null });
    if (typeof job === 'string') throw new Error(job);
    return job.id;
}

const claim = async (): Promise<Claim> => {
    const c = await store.claim(WORKER, 60);
    if (!c) throw new Error('nothing was claimable');
    return c;
};

/** Ages the row's lease (or its requeue deferral) into the past, as waiting it out would. */
const age = (id: string) => sql`update job set lease_expires_at = now() where id = ${id}`;

describe.skipIf(!enabled)('requeueing a pre-run claim after checkout contention — database', () => {
    it('refunds the attempt, defers the next claim, and the next claim still climbs the claim sequence', async () => {
        const id = await queue();
        const first = await claim();
        expect(first).toMatchObject({ id, attempts: 1, claimSeq: 1 });

        expect(await store.requeue(id, first.leaseToken)).toEqual({ result: 'ok', status: 'queued' });

        const row = await store.get(id);
        expect(row).toMatchObject({ status: 'queued', attempts: 0 });
        const [deferral] = await sql<{ seconds: number }[]>`
            select extract(epoch from lease_expires_at - now())::float as seconds from job where id = ${id}
        `;
        expect(deferral!.seconds).toBeGreaterThan(5);
        expect(deferral!.seconds).toBeLessThanOrEqual(30);
        expect(await store.claim(WORKER, 60)).toBeNull();

        await age(id);
        expect(await claim()).toMatchObject({ id, attempts: 1, claimSeq: 2 });
    });

    it('never exhausts maxAttempts however often the checkout is contended', async () => {
        const id = await queue();
        const { maxAttempts } = (await store.get(id))!;
        for (let round = 0; round < maxAttempts + 2; round += 1) {
            const c = await claim();
            expect(c.attempts).toBe(1);
            expect(c.claimSeq).toBe(round + 1);
            expect(await store.requeue(id, c.leaseToken)).toEqual({ result: 'ok', status: 'queued' });
            await age(id);
        }
        expect((await store.get(id))!.status).toBe('queued');
    });

    it('lets a stale lease token requeue nothing — the replacement keeps its claim', async () => {
        const id = await queue();
        const stale = await claim();
        await age(id);
        const replacement = await claim();

        expect(await store.requeue(id, stale.leaseToken)).toEqual({ result: 'lost' });

        const [row] = await sql<{ status: string; lease_token: string; attempts: number }[]>`
            select status, lease_token, attempts from job where id = ${id}
        `;
        expect(row).toEqual({ status: 'running', lease_token: replacement.leaseToken, attempts: 2 });
    });

    it('lets a Stop requested before the requeue win: the row settles stopped, never queued', async () => {
        const id = await queue();
        const c = await claim();
        expect(await store.stop(id, null)).toMatchObject({ result: 'requested' });

        expect(await store.requeue(id, c.leaseToken)).toEqual({ result: 'ok', status: 'stopped' });

        const [row] = await sql<
            { status: string; attempts: number; cancel_requested_at: Date | null; command_delivered_at: Date | null }[]
        >`select status, attempts, cancel_requested_at, command_delivered_at from job where id = ${id}`;
        // No agent ran, so the command was never delivered: nothing is fabricated about a run.
        expect(row).toEqual({ status: 'stopped', attempts: 0, cancel_requested_at: null, command_delivered_at: null });
        await age(id);
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    it('lets a Stop after the requeue settle the deferred row stopped', async () => {
        const id = await queue();
        const c = await claim();
        await store.requeue(id, c.leaseToken);

        expect(await store.stop(id, null)).toEqual({ result: 'stopped' });
        await age(id);
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    it('answers missing once the thread was removed behind the requeue', async () => {
        const id = await queue();
        const c = await claim();
        await store.requeue(id, c.leaseToken);
        expect(await store.removeThread(id, null)).not.toBe('conflict');

        expect(await store.requeue(id, c.leaseToken)).toEqual({ result: 'missing' });
    });
});
