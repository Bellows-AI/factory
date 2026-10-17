import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore, INTERRUPTION_BUDGET, LEASE_EXPIRED_REASON } from '../src/db/job-store.js';
import type { Claim, JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';
import { spendInterruptionBudget, testOrg } from './fixtures.js';

/**
 * Issue #792: an attempt the infrastructure interrupted (a node drained under the driver, a runner
 * pod evicted) is handed back with its attempt refunded and its reason recorded, inside a budget of
 * its own — never spending a `max_attempts` slot the way a failed run does.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
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

/** Ages the row's lease into the past, as waiting it out would. */
const age = (id: string) => sql`update job set lease_expires_at = now() where id = ${id}`;

/** Backdates the running attempt's start, so the segment it banks is measurable. */
const ranFor = (id: string, seconds: number) =>
    sql`update job set started_at = now() - make_interval(secs => ${seconds}) where id = ${id}`;

describe.skipIf(!enabled)('interrupting an attempt the infrastructure took away — database', () => {
    it('refunds the attempt, frees the lease at once and records why', async () => {
        const id = await queue();
        const first = await claim();
        expect(first).toMatchObject({ id, attempts: 1, claimSeq: 1 });

        expect(
            await store.interrupt(id, first.leaseToken, { reason: 'the driver was drained', release: true })
        ).toEqual({ result: 'ok', status: 'queued' });

        const row = await store.get(id);
        expect(row).toMatchObject({ status: 'queued', attempts: 0 });
        expect(row!.interruptions).toEqual([{ at: expect.any(String), reason: 'the driver was drained', claimSeq: 1 }]);
        // Claimable now — no lease to wait out.
        expect(await claim()).toMatchObject({ id, attempts: 1, claimSeq: 2 });
        // A released row is queued, not an expired lease: the claim records nothing of its own.
        expect((await store.get(id))!.interruptions).toHaveLength(1);
    });

    it('banks the interrupted segment on the wall clock, and the next claim never banks it twice', async () => {
        const id = await queue();
        const c = await claim();
        await ranFor(id, 40);
        await store.interrupt(id, c.leaseToken, { reason: 'evicted', release: true });
        const banked = (await store.get(id))!.wallClockMs!;
        expect(banked).toBeGreaterThanOrEqual(40_000);

        await claim();
        expect((await store.get(id))!.wallClockMs).toBe(banked);
    });

    it('never exhausts maxAttempts while the interruption budget lasts', async () => {
        const id = await queue();
        const { maxAttempts } = (await store.get(id))!;
        expect(INTERRUPTION_BUDGET).toBeGreaterThan(maxAttempts);
        for (let round = 0; round < INTERRUPTION_BUDGET; round += 1) {
            const c = await claim();
            expect(c.attempts).toBe(1);
            expect(await store.interrupt(id, c.leaseToken, { reason: `round ${round}`, release: true })).toEqual({
                result: 'ok',
                status: 'queued',
            });
        }
        expect((await store.get(id))!.interruptions).toHaveLength(INTERRUPTION_BUDGET);
    });

    it('answers exhausted once the budget is spent, and changes nothing', async () => {
        const id = await queue();
        for (let round = 0; round < INTERRUPTION_BUDGET; round += 1) {
            const c = await claim();
            await store.interrupt(id, c.leaseToken, { reason: 'evicted', release: true });
        }
        const last = await claim();
        expect(await store.interrupt(id, last.leaseToken, { reason: 'evicted', release: true })).toEqual({
            result: 'exhausted',
        });
        const [row] = await sql<{ status: string; lease_token: string; attempts: number }[]>`
            select status, lease_token, attempts from job where id = ${id}
        `;
        expect(row).toEqual({ status: 'running', lease_token: last.leaseToken, attempts: 1 });
    });

    // The lease expired under claim 1, so claim 2 recorded the interruption as it took the row
    // over; the adoption that follows names claim 1 and is the same disruption: no second refund.
    it('answers an adoption after a lease expiry with the interruption the claim already recorded', async () => {
        const id = await queue();
        const stale = await claim();
        await age(id);
        const adopter = await claim();
        expect(adopter).toMatchObject({ attempts: 1, claimSeq: 2 });

        expect(
            await store.interrupt(id, adopter.leaseToken, {
                reason: 'adopted the runner of claim 1',
                release: false,
                claimSeq: 1,
            })
        ).toEqual({ result: 'ok', status: 'running' });

        const row = await store.get(id);
        expect(row).toMatchObject({ status: 'running', attempts: 1 });
        expect(row!.interruptions).toEqual([{ at: expect.any(String), reason: LEASE_EXPIRED_REASON, claimSeq: 1 }]);
        expect(await store.interrupt(id, stale.leaseToken, { reason: 'late', release: true })).toEqual({
            result: 'lost',
        });
    });

    it('lets a Stop requested before the interruption win: the row settles stopped', async () => {
        const id = await queue();
        const c = await claim();
        expect(await store.stop(id, null)).toMatchObject({ result: 'requested' });

        expect(await store.interrupt(id, c.leaseToken, { reason: 'evicted', release: true })).toEqual({
            result: 'ok',
            status: 'stopped',
        });
        await age(id);
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    it('answers missing for a job that does not exist', async () => {
        expect(await store.interrupt(randomUUID(), randomUUID(), { reason: 'evicted', release: true })).toEqual({
            result: 'missing',
        });
    });

    // A drain hands claim 1 over (refunded, recorded); the runner then finishes and claim 2 adopts
    // it. One disruption: one refund, one entry, and the adopting attempt is the one it counts.
    it('records an attempt handed over and then adopted once, refunding it once', async () => {
        const id = await queue();
        const first = await claim();
        await store.interrupt(id, first.leaseToken, { reason: 'the driver was drained', release: true });
        const adopter = await claim();

        expect(
            await store.interrupt(id, adopter.leaseToken, { reason: 'adopted', release: false, claimSeq: 1 })
        ).toEqual({ result: 'ok', status: 'running' });

        const row = await store.get(id);
        expect(row).toMatchObject({ status: 'running', attempts: 1 });
        expect(row!.interruptions).toEqual([{ at: expect.any(String), reason: 'the driver was drained', claimSeq: 1 }]);
    });

    it('resumes the session of an attempt the driver handed back', async () => {
        const id = await queue();
        const first = await claim();
        const session = randomUUID();
        await store.session(id, first.leaseToken, session);
        await store.interrupt(id, first.leaseToken, { reason: 'the driver was drained', release: true });

        expect(await claim()).toMatchObject({ id, resumeSessionId: session, followUp: false });
    });
});

/**
 * Issue #822: an expired lease is the infrastructure losing an attempt — its driver went silent —
 * so the claim that takes the row over records it as that attempt's interruption, inside the same
 * budget, rather than spending a `max_attempts` slot; and the session the lost attempt reported is
 * the one the takeover resumes.
 */
describe.skipIf(!enabled)('a lease expiry is an interruption the next claim records — database', () => {
    const lastAttempt = async (): Promise<string> => {
        const id = await queue();
        await sql`update job set max_attempts = 1 where id = ${id}`;
        return id;
    };

    it('records a lease expiry at the last allowed attempt as an interruption and hands the job out again', async () => {
        const id = await lastAttempt();
        expect(await claim()).toMatchObject({ id, attempts: 1, claimSeq: 1 });
        await age(id);

        expect(await claim()).toMatchObject({ id, attempts: 1, maxAttempts: 1, claimSeq: 2 });
        const row = await store.get(id);
        expect(row).toMatchObject({ status: 'running', attempts: 1 });
        expect(row!.interruptions).toEqual([{ at: expect.any(String), reason: LEASE_EXPIRED_REASON, claimSeq: 1 }]);
    });

    // The driver reports a failed verdict for an attempt it cannot run only when the board would not
    // recover its loss: at the last allowed attempt a lost driver is still an interruption.
    it('tells the claim it is the last attempt only once its attempts and the interruption budget are spent', async () => {
        const recoverable = await lastAttempt();
        expect(await claim()).toMatchObject({ id: recoverable, attempts: 1, maxAttempts: 1, lastAttempt: false });

        const spent = await lastAttempt();
        await spendInterruptionBudget(sql, spent);
        expect(await claim()).toMatchObject({ id: spent, attempts: 1, maxAttempts: 1, lastAttempt: true });
    });

    it('spends no attempt on lease expiries while the interruption budget lasts', async () => {
        const id = await queue();
        await claim();
        for (let round = 0; round < INTERRUPTION_BUDGET; round += 1) {
            await age(id);
            expect(await claim()).toMatchObject({ id, attempts: 1, claimSeq: round + 2 });
        }
        const row = await store.get(id);
        expect(row!.interruptions.map((i) => i.claimSeq)).toEqual(
            Array.from({ length: INTERRUPTION_BUDGET }, (_, n) => n + 1)
        );
    });

    it('spends an attempt on an expiry once the budget is spent', async () => {
        const id = await queue();
        await claim();
        await spendInterruptionBudget(sql, id);
        await age(id);

        expect(await claim()).toMatchObject({ id, attempts: 2, claimSeq: 2 });
        expect((await store.get(id))!.interruptions).toHaveLength(INTERRUPTION_BUDGET);
    });

    it('retires a job dead once its interruption budget and its attempts are both spent', async () => {
        const id = await lastAttempt();
        await claim();
        await spendInterruptionBudget(sql, id);
        await age(id);

        expect(await store.claim(WORKER, 60)).toBeNull();
        expect(await store.get(id)).toMatchObject({ status: 'dead', attempts: 1 });
    });

    // The bound ends the task, never its state: the session the lost attempts resumed stays on the
    // row a follow-up continues from, and the checkout stays on the workspaces volume.
    it('keeps the session of a job retired dead, and a follow-up continues it', async () => {
        const id = await lastAttempt();
        const first = await claim();
        const session = randomUUID();
        await store.session(id, first.leaseToken, session);
        for (let round = 0; round < INTERRUPTION_BUDGET; round += 1) {
            await age(id);
            expect(await claim()).toMatchObject({ id, attempts: 1, resumeSessionId: session });
        }
        await age(id);
        expect(await store.claim(WORKER, 60)).toBeNull();
        expect(await store.get(id)).toMatchObject({ status: 'dead', sessionId: session });

        const followUp = await store.createFollowUp(id, 'carry on', null);
        if (typeof followUp === 'string') throw new Error(`createFollowUp refused: ${followUp}`);
        expect(await claim()).toMatchObject({ id: followUp.id, resumeSessionId: session, followUp: true });
    });
});
