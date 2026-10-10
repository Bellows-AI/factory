import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import {
    IDEMPOTENCY_RETENTION_HOURS,
    IdempotencyKeyReusedError,
    type IdempotencyInput,
    type IdempotentOperation,
} from '../src/db/job-store-idempotency.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
let otherOrgStore: JobStore;

const ORG = 'test-org';
const OTHER_ORG = 'other-org';
/** A lease long enough that nothing in this suite outlives it by accident. */
const LEASE_SECONDS = 300;
const CONCURRENT_DUPLICATES = 8;

/** Parallel duplicates need real connections; a pool of two would serialise them into a vacuous pass. */
const db = useTestDb({ max: CONCURRENT_DUPLICATES + 2, orgs: [ORG, OTHER_ORG] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    otherOrgStore = createJobStore({ sql, orgId: OTHER_ORG });
});

let accounts = 0;
/** A real account for created_by to point at, written directly: this file is about the job table. */
const account = async (): Promise<string> => {
    accounts += 1;
    const [row] = await sql<{ id: string }[]>`
        insert into app_user (github_user_id, github_login)
        values (${9_000_000 + accounts}, ${`idem-user-${accounts}`})
        returning id
    `;
    return row!.id;
};

let keys = 0;
/** A fresh, valid key per call, so no test leans on another's rows. */
const freshKey = (): string => {
    keys += 1;
    return `key-${keys}-${Math.random().toString(36).slice(2, 10)}`;
};

const idem = (operation: IdempotentOperation, key: string, fingerprint = 'fp-a'): IdempotencyInput => ({
    operation,
    key,
    fingerprint,
});

const TARGET = { repo: null, executor: null };

const createdOk = async (
    s: JobStore,
    command: string,
    by: string | null,
    input?: IdempotencyInput
): Promise<{ id: string; replayed?: boolean }> => {
    const ref = await s.create(command, by, { ...TARGET, ...(input ? { idempotency: input } : {}) });
    if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
    return ref;
};

const jobCount = async (): Promise<number> => {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from job`;
    return row!.n;
};

/** Takes a queued job to a finished run, the state a follow-up and a retry accept. */
const finish = async (id: string): Promise<void> => {
    const claim = await store.claim('w1', LEASE_SECONDS);
    await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
};

describe.runIf(enabled)('mutation idempotency (#589)', () => {
    describe('create', () => {
        it('answers the first attempt as new and every repeat with the same task', async () => {
            const user = await account();
            const input = idem('create', freshKey());

            const first = await createdOk(store, 'echo hi', user, input);
            const repeat = await createdOk(store, 'echo hi', user, input);

            expect(first.replayed).toBeUndefined();
            expect(repeat).toEqual({ id: first.id, replayed: true });
            expect(await jobCount()).toBe(1);
        });

        it('makes one task when duplicates arrive concurrently', async () => {
            const user = await account();
            const input = idem('create', freshKey());

            const results = await Promise.all(
                Array.from({ length: CONCURRENT_DUPLICATES }, () => createdOk(store, 'echo hi', user, input))
            );

            expect(new Set(results.map((r) => r.id)).size).toBe(1);
            expect(results.filter((r) => r.replayed).length).toBe(CONCURRENT_DUPLICATES - 1);
            expect(await jobCount()).toBe(1);
        });

        it('recovers the result of a write whose response was lost after commit', async () => {
            const user = await account();
            const input = idem('create', freshKey());
            // The first call commits; the caller never sees its answer, so it asks again.
            const lost = await createdOk(store, 'echo hi', user, input);

            const recovered = await createdOk(store, 'echo hi', user, input);

            expect(recovered.id).toBe(lost.id);
        });

        it('refuses the same key with a different payload and creates nothing', async () => {
            const user = await account();
            const key = freshKey();
            await createdOk(store, 'echo hi', user, idem('create', key, 'fp-a'));

            await expect(createdOk(store, 'echo other', user, idem('create', key, 'fp-b'))).rejects.toBeInstanceOf(
                IdempotencyKeyReusedError
            );
            expect(await jobCount()).toBe(1);
        });

        it('keeps a key per caller, per organization and per operation', async () => {
            const alice = await account();
            const bob = await account();
            const key = freshKey();

            const a = await createdOk(store, 'echo hi', alice, idem('create', key));
            const b = await createdOk(store, 'echo hi', bob, idem('create', key));
            const elsewhere = await createdOk(otherOrgStore, 'echo hi', alice, idem('create', key));
            const finished = await createdOk(store, 'parent', alice);
            await finish(finished.id);
            const followUp = await store.createFollowUp(finished.id, 'echo hi', alice, idem('follow-up', key));

            expect(new Set([a.id, b.id, elsewhere.id]).size).toBe(3);
            expect([a, b, elsewhere].some((r) => r.replayed)).toBe(false);
            expect(followUp).toMatchObject({ id: expect.any(String) });
            expect(followUp).not.toHaveProperty('replayed');
        });

        it('keys the no-account caller too', async () => {
            const input = idem('create', freshKey());
            const first = await createdOk(store, 'echo hi', null, input);
            const repeat = await createdOk(store, 'echo hi', null, input);
            expect(repeat).toEqual({ id: first.id, replayed: true });
        });

        it('persists across a restart: a fresh store on the same database still replays', async () => {
            const user = await account();
            const input = idem('create', freshKey());
            const first = await createdOk(store, 'echo hi', user, input);

            const restarted = createJobStore({ sql, orgId: ORG });

            expect(await createdOk(restarted, 'echo hi', user, input)).toEqual({ id: first.id, replayed: true });
        });

        it('stops replaying once the retention window has passed, and frees the key', async () => {
            const user = await account();
            const key = freshKey();
            const first = await createdOk(store, 'echo hi', user, idem('create', key, 'fp-a'));
            await sql`
                update job set idempotency_at = now() - make_interval(hours => ${IDEMPOTENCY_RETENTION_HOURS + 1})
                where id = ${first.id}
            `;

            // Past retention the key is free again — even for a different request.
            const next = await createdOk(store, 'echo other', user, idem('create', key, 'fp-b'));

            expect(next.id).not.toBe(first.id);
            expect(next.replayed).toBeUndefined();
            const [old] = await sql<{ idempotency_key: string | null }[]>`
                select idempotency_key from job where id = ${first.id}
            `;
            expect(old!.idempotency_key).toBeNull();
        });

        it('still replays just inside the retention window', async () => {
            const user = await account();
            const input = idem('create', freshKey());
            const first = await createdOk(store, 'echo hi', user, input);
            await sql`
                update job set idempotency_at = now() - make_interval(hours => ${IDEMPOTENCY_RETENTION_HOURS - 1})
                where id = ${first.id}
            `;
            expect(await createdOk(store, 'echo hi', user, input)).toEqual({ id: first.id, replayed: true });
        });

        it('forgets the key with the task: removing the thread frees it', async () => {
            const user = await account();
            const input = idem('create', freshKey());
            const first = await createdOk(store, 'echo hi', user, input);
            await store.removeThread(first.id, user);

            const again = await createdOk(store, 'echo hi', user, input);

            expect(again.id).not.toBe(first.id);
            expect(again.replayed).toBeUndefined();
        });

        it('creates without recording anything when no key is sent', async () => {
            const user = await account();
            const first = await createdOk(store, 'echo hi', user);
            const second = await createdOk(store, 'echo hi', user);
            expect(second.id).not.toBe(first.id);
            const [row] = await sql<
                { n: number }[]
            >`select count(*)::int as n from job where idempotency_key is not null`;
            expect(row!.n).toBe(0);
        });
    });

    describe('follow-up', () => {
        it('replays instead of refusing the parent as still unfinished', async () => {
            const user = await account();
            const parent = await createdOk(store, 'first', user);
            await finish(parent.id);
            const input = idem('follow-up', freshKey());

            const first = await store.createFollowUp(parent.id, 'again', user, input);
            // The follow-up is now queued, so a keyless repeat is refused...
            expect(await store.createFollowUp(parent.id, 'again', user)).toBe('not_finished');
            // ...but the keyed repeat finds the row it already made.
            const repeat = await store.createFollowUp(parent.id, 'again', user, input);

            expect(first).toMatchObject({ id: expect.any(String) });
            expect(repeat).toEqual({ id: (first as { id: string }).id, replayed: true });
        });

        it('refuses a changed command under the same key', async () => {
            const user = await account();
            const parent = await createdOk(store, 'first', user);
            await finish(parent.id);
            const key = freshKey();
            await store.createFollowUp(parent.id, 'again', user, idem('follow-up', key, 'fp-a'));

            await expect(
                store.createFollowUp(parent.id, 'different', user, idem('follow-up', key, 'fp-b'))
            ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
        });

        it('stores no key for a follow-up the store refused', async () => {
            const user = await account();
            const queued = await createdOk(store, 'still queued', user);
            const key = freshKey();

            // Not finished: refused, and the refusal must not have claimed the key.
            expect(await store.createFollowUp(queued.id, 'again', user, idem('follow-up', key, 'fp-a'))).toBe(
                'not_finished'
            );
            await finish(queued.id);
            const later = await store.createFollowUp(queued.id, 'other', user, idem('follow-up', key, 'fp-b'));

            expect(later).toMatchObject({ id: expect.any(String) });
        });

        it('does not let a stored result bypass the author check once the parent changed hands', async () => {
            const owner = await account();
            const stranger = await account();
            const parent = await createdOk(store, 'first', owner);
            await finish(parent.id);
            const input = idem('follow-up', freshKey());
            await store.createFollowUp(parent.id, 'again', owner, input);
            await sql`update job set created_by = ${stranger} where id = ${parent.id}`;

            expect(await store.createFollowUp(parent.id, 'again', owner, input)).toBe('forbidden');
        });
    });

    describe('retry', () => {
        it('replays a retried retry instead of refusing the head as still unfinished', async () => {
            const user = await account();
            const parent = await createdOk(store, 'first', user);
            await finish(parent.id);
            const input = idem('retry', freshKey());

            const first = await store.createRetry(parent.id, user, input);
            const repeat = await store.createRetry(parent.id, user, input);

            expect(first).toMatchObject({ id: expect.any(String) });
            expect(repeat).toEqual({ id: (first as { id: string }).id, replayed: true });
            expect(await store.createRetry(parent.id, user)).toBe('not_finished');
        });

        it('makes one retry when duplicates arrive concurrently', async () => {
            const user = await account();
            const parent = await createdOk(store, 'first', user);
            await finish(parent.id);
            const input = idem('retry', freshKey());

            const results = await Promise.all(
                Array.from({ length: CONCURRENT_DUPLICATES }, () => store.createRetry(parent.id, user, input))
            );

            const ids = results.map((r) => (typeof r === 'string' ? r : r.id));
            expect(new Set(ids).size).toBe(1);
            expect(await jobCount()).toBe(2);
        });

        it('does not replay to a caller who is not the thread author', async () => {
            const owner = await account();
            const stranger = await account();
            const parent = await createdOk(store, 'first', owner);
            await finish(parent.id);
            const key = freshKey();
            await store.createRetry(parent.id, owner, idem('retry', key));

            // The key is the owner's: the stranger's request is a different scope, so it is not
            // replayed — it meets the thread as it is (a queued head) and is refused.
            const refused = await store.createRetry(parent.id, stranger, idem('retry', key));
            expect(typeof refused).toBe('string');
        });
    });
});
