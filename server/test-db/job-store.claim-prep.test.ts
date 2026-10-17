import { beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim, CreateJobStoreDeps, JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';
import {
    account,
    expectUnblocked,
    expireLease,
    holdLock,
    lapseDeferral,
    mustCreate,
    randomGithubId,
    spendInterruptionBudget,
    testOrg,
} from './fixtures.js';

/**
 * Issue #822 (D12): a claim's preparation — the plan read through the GitHub API, up to tens of
 * seconds — runs outside every lock, the lease is measured from the acquisition that follows it,
 * and a candidate whose preparation fails is deferred so the next poll takes healthy work.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const WORKER = 'driver-1';
const LEASE_SECONDS = 300;
/** How much of a lease the round trip from the claim to the database clock read may eat. */
const LEASE_SLACK_MS = 500;
const DELAY_MS = 1500;
const HEALTHY = 'acme/web';
const POISON = 'acme/poison';
const REVISION = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const db = useTestDb({ max: 8 });

let sql: Sql;
let plain: JobStore;
let author: string;

beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    plain = createJobStore({ sql, orgId: ORG });
    author = await account(sql, randomGithubId(), 'prep-cat');
});

type PlanReader = NonNullable<CreateJobStoreDeps['plan']>;
type Plan = Awaited<ReturnType<PlanReader['readFor']>>;

const plan = (over: Partial<Plan> = {}): Plan =>
    ({ config: null, services: [], revision: REVISION, error: null, ...over }) as Plan;

const readerStore = (readFor: PlanReader['readFor']): JobStore =>
    createJobStore({ sql, orgId: ORG, plan: { readFor } });

/** A reader whose FIRST read waits for `release()`; every read answers `answer(call)`. */
function gatedReader(answer: (call: number) => Plan = () => plan()) {
    let calls = 0;
    let open!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((resolve) => {
        open = resolve;
    });
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    const readFor: PlanReader['readFor'] = async () => {
        calls += 1;
        const call = calls;
        if (call === 1) {
            enter();
            await gate;
        }
        return answer(call);
    };
    return { readFor, entered, release: () => open() };
}

/** A reader that fails for the poison repository while `poisoned()` holds. */
const poisonReader =
    (poisoned: () => boolean): PlanReader['readFor'] =>
    async (repo) => {
        if (repo === POISON && poisoned()) throw new Error('the plan source is rate limited');
        return plan();
    };

const queue = async (repo = HEALTHY): Promise<string> =>
    (await mustCreate(plain.create('do the thing', author, { repo, executor: null }))).id;

const claimed = async (store: JobStore = plain): Promise<Claim> => {
    const c = await store.claim(WORKER, LEASE_SECONDS);
    if (!c) throw new Error('nothing was claimable');
    return c;
};

const rowOf = async (id: string) => {
    const [row] = await sql<
        {
            status: string;
            attempts: number;
            claim_seq: string;
            lease_token: string | null;
            interruptions: unknown[];
            policy: unknown;
            session_id: string | null;
            lease_live: boolean;
            deferred: boolean;
            deferral_set: boolean;
        }[]
    >`
        select status, attempts, claim_seq, lease_token, interruptions, policy, session_id,
               lease_expires_at > now() as lease_live,
               coalesce(claim_deferred_until > now(), false) as deferred,
               claim_deferred_until is not null as deferral_set
        from job where org_id = ${ORG} and id = ${id}
    `;
    return row;
};

/** How much of the lease is left by the database clock, read after the claim returned. */
const leaseLeftMs = async (claim: Claim): Promise<number> => {
    const [clock] = await sql<{ now: Date }[]>`select now()`;
    return new Date(claim.leaseExpiresAt).getTime() - clock!.now.getTime();
};

describe.skipIf(!enabled)('claim preparation outside the locks — database', () => {
    it('holds no row or thread lock while the plan read is pending, and hands out no row stopped meanwhile', async () => {
        const id = await queue();
        const reader = gatedReader();
        const pending = readerStore(reader.readFor).claim(WORKER, LEASE_SECONDS);
        try {
            await reader.entered;
            expect(await expectUnblocked(plain.stop(id, null))).toEqual({ result: 'stopped' });
            const [lock] = await sql.begin(
                (tx) =>
                    tx<{ free: boolean }[]>`select pg_try_advisory_xact_lock(hashtextextended(${id}::text, 0)) as free`
            );
            expect(lock?.free).toBe(true);
        } finally {
            reader.release();
        }

        expect(await pending).toBeNull();
        expect(await rowOf(id)).toMatchObject({ status: 'stopped', attempts: 0 });
    });

    it("lets the lost holder's heartbeat land during preparation, and leaves its lease alone", async () => {
        const id = await queue();
        const lost = await claimed();
        await expireLease(sql, id);
        const reader = gatedReader();
        const pending = readerStore(reader.readFor).claim(WORKER, LEASE_SECONDS);
        try {
            await reader.entered;
            const beat = await expectUnblocked(plain.heartbeat(id, lost.leaseToken, LEASE_SECONDS));
            expect(beat.result).toBe('ok');
        } finally {
            reader.release();
        }

        expect(await pending).toBeNull();
        expect(await rowOf(id)).toMatchObject({
            status: 'running',
            lease_token: lost.leaseToken,
            claim_seq: '1',
            interruptions: [],
            lease_live: true,
        });
    });

    it('returns a lease measured from acquisition, not from before a delayed plan read', async () => {
        await queue();
        const slow = readerStore(async () => {
            await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
            return plan();
        });

        const claim = await claimed(slow);

        expect(await leaseLeftMs(claim)).toBeGreaterThanOrEqual(LEASE_SECONDS * 1000 - LEASE_SLACK_MS);
    });

    it('measures the lease after a wait on the thread lock', async () => {
        const id = await queue();
        const lock = await holdLock(sql, 'thread', id);
        const pending = plain.claim(WORKER, LEASE_SECONDS);
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        await lock.release();

        const claim = await pending;

        expect(claim?.id).toBe(id);
        expect(await leaseLeftMs(claim!)).toBeGreaterThanOrEqual(LEASE_SECONDS * 1000 - LEASE_SLACK_MS);
    });

    // A poll that tries a poison candidate demotes it: it sorts behind every candidate that never
    // failed, however long the driver waits between polls, until it prepares once.
    it('takes the healthy task on the next poll after a candidate whose plan read fails, spending nothing of the failed one', async () => {
        let poisoned = true;
        const store = readerStore(poisonReader(() => poisoned));
        const poison = await queue(POISON);
        const healthy = await queue();

        await expect(store.claim(WORKER, LEASE_SECONDS)).rejects.toThrow('rate limited');
        expect(await rowOf(poison)).toMatchObject({ status: 'queued', attempts: 0, deferred: true });

        await lapseDeferral(sql, poison);
        expect((await claimed(store)).id).toBe(healthy);
        const later = await queue();
        expect((await claimed(store)).id).toBe(later);
        expect(await rowOf(poison)).toMatchObject({ status: 'queued', attempts: 0, deferral_set: true });

        poisoned = false;
        expect(await claimed(store)).toMatchObject({ id: poison, attempts: 1 });
        expect(await rowOf(poison)).toMatchObject({ deferral_set: false });
    });

    it("defers a lost attempt's takeover whose plan read fails without reviving its lease or recording an interruption", async () => {
        const store = readerStore(poisonReader(() => true));
        const poison = await queue(POISON);
        const lost = await claimed();
        await expireLease(sql, poison);
        const healthy = await queue();

        await expect(store.claim(WORKER, LEASE_SECONDS)).rejects.toThrow('rate limited');
        expect(await rowOf(poison)).toMatchObject({
            status: 'running',
            lease_token: lost.leaseToken,
            attempts: 1,
            interruptions: [],
            lease_live: false,
            deferred: true,
        });

        expect((await claimed(store)).id).toBe(healthy);
        expect(await plain.stop(poison, null)).toEqual({ result: 'stopped' });
    });

    it('commits the retirement of an exhausted attempt even when the claim preparation throws, and keeps a recoverable one', async () => {
        const store = readerStore(poisonReader(() => true));
        const exhausted = await queue();
        const exhaustedClaim = await claimed();
        await plain.session(exhausted, exhaustedClaim.leaseToken, 'ses-exhausted');
        const recoverable = await queue(POISON);
        await claimed();
        await sql`update job set attempts = max_attempts where id in ${sql([exhausted, recoverable])}`;
        await spendInterruptionBudget(sql, exhausted);
        await expireLease(sql, exhausted);
        await expireLease(sql, recoverable);

        await expect(store.claim(WORKER, LEASE_SECONDS)).rejects.toThrow('rate limited');

        expect(await rowOf(exhausted)).toMatchObject({ status: 'dead', session_id: 'ses-exhausted' });
        expect(await rowOf(recoverable)).toMatchObject({ status: 'running', interruptions: [], deferred: true });
    });

    it('hands out nothing for a thread removed while its plan was read', async () => {
        const id = await queue();
        const reader = gatedReader();
        const pending = readerStore(reader.readFor).claim(WORKER, LEASE_SECONDS);
        try {
            await reader.entered;
            expect(await expectUnblocked(plain.removeThread(id, null))).toMatchObject({ result: 'ok' });
        } finally {
            reader.release();
        }

        expect(await pending).toBeNull();
        expect(await rowOf(id)).toBeUndefined();
    });

    // A claim that committed while this one prepared moved claim_seq: the stale preparation is
    // dropped and the row prepared afresh — its plan read never stamps the row.
    it('never stamps a stale plan read: a candidate claimed meanwhile is prepared again under its new sequence', async () => {
        const id = await queue();
        const reader = gatedReader((call) => plan({ policy: { gates: call === 1 } } as Partial<Plan>));
        const pending = readerStore(reader.readFor).claim(WORKER, LEASE_SECONDS);
        try {
            await reader.entered;
            await lapseDeferral(sql, id);
            const meanwhile = await expectUnblocked(plain.claim('driver-2', LEASE_SECONDS));
            expect(meanwhile).toMatchObject({ id, claimSeq: 1 });
            await plain.interrupt(id, meanwhile!.leaseToken, { reason: 'the driver was drained', release: true });
        } finally {
            reader.release();
        }

        expect(await pending).toMatchObject({ id, claimSeq: 2, policy: { gates: false } });
        expect((await rowOf(id))?.policy).toEqual({ gates: false });
    });
});
