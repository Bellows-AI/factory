import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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

const ORG = 'test-org';

beforeAll(async () => {
    if (!enabled) return;
    sql = postgres(url as string, { max: 8 });
    await migrate(sql, { orgId: ORG, attempts: 3 });
    store = createJobStore({ sql, orgId: ORG });
});

afterAll(async () => {
    if (enabled) await sql.end();
});

beforeEach(async () => {
    if (!enabled) return;
    await sql`truncate job`;
});

/**
 * Writes a job row in whatever state the case needs, straight SQL. The states under test — a
 * running root with a queued follow-up beside it — are unreachable through the store's own
 * inserts (a follow-up only lands on a finished parent), which is exactly the gap the claim-side
 * fix closes: the query must be correct under ANY row state, so the tests make the state directly.
 * `lease: 'expired'` is the insert default; 'live' fakes a worker still holding the row.
 */
const craft = async (shape: {
    parent?: string | null;
    status?: 'queued' | 'running' | 'standby' | 'succeeded' | 'failed' | 'dead';
    lease?: 'live' | 'expired';
    /** Seconds before now the row was created. Bigger = older: orders the queue deterministically. */
    olderBySeconds?: number;
}): Promise<string> => {
    const id = randomUUID();
    await sql`
        insert into job (org_id, id, command, status, parent_job_id, lease_expires_at, created_at)
        values (
            ${ORG}, ${id}, 'crafted',
            ${shape.status ?? 'queued'},
            ${shape.parent ?? null},
            ${shape.lease === 'live' ? sql`now() + interval '5 minutes'` : sql`now() - interval '1 second'`},
            now() - make_interval(secs => ${shape.olderBySeconds ?? 0}::int)
        )
    `;
    return id;
};

describe.skipIf(!enabled)('thread-serialized claims', () => {
    // The per-task worktree is keyed by the thread's root job id: a claimed follow-up alongside a
    // claimed ancestor would run two runners and two sync jobs into the same tree.
    it('does not hand out a follow-up while its thread root is running', async () => {
        const root = await craft({ status: 'running', lease: 'live' });
        await craft({ parent: root });

        expect(await store.claim('w1', 300)).toBeNull();
    });

    it('reclaims the running root itself, and unblocks its follow-up only at a terminal status', async () => {
        const root = await craft({ status: 'running', lease: 'expired' });
        const followUp = await craft({ parent: root });

        // The root's own reclaim is the heartbeat-fenced path and stays — never the follow-up.
        const first = await store.claim('w1', 300);
        expect(first).toMatchObject({ id: root, attempts: 1 });
        expect(first?.rootJobId).toBe(root);

        // The root runs on: the follow-up still waits.
        expect(await store.claim('w2', 300)).toBeNull();

        // The moment the root is terminal the follow-up is claimable, carrying exactly the fields
        // it always did — the new predicate composes with the claim, it does not reshape it.
        await store.complete(root, first!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const second = await store.claim('w3', 300);
        expect(second).toMatchObject({
            id: followUp,
            command: 'crafted',
            rootJobId: root,
            followUp: true,
            resumeSessionId: null,
            userId: null,
            workspacePath: null,
        });
        expect(second?.env).toBeUndefined();
        expect(second?.gates).toBeUndefined();
    });

    // Queue order must not leak the row past the exclusion: a blocked follow-up is skipped, and
    // the claim moves on to the next candidate rather than answering null.
    it('skips a blocked follow-up and takes the expired root behind it in the queue', async () => {
        const root = await craft({ status: 'running', lease: 'expired' });
        await craft({ parent: root, olderBySeconds: 60 });

        expect((await store.claim('w1', 300))?.id).toBe(root);
    });

    // The exclusion is symmetric: whichever member of the thread runs, the others wait — a root
    // is its follow-up's root, so a running follow-up blocks the root the same way.
    it('a running descendant blocks its root', async () => {
        const root = await craft({});
        await craft({ parent: root, status: 'running', lease: 'live' });

        expect(await store.claim('w1', 300)).toBeNull();
    });

    // Standby is parked, not running: it holds no worktree work, so it blocks nothing — and the
    // claim's status filter already keeps it unclaimable.
    it('a standby row neither blocks nor is claimable', async () => {
        await craft({ status: 'standby', lease: 'expired' });
        const followUp = await craft({ parent: '00000000-0000-4000-8000-000000000001', status: 'queued' });

        expect((await store.claim('w1', 300))?.id).toBe(followUp);
    });

    it('different roots never block each other', async () => {
        const rootA = await craft({ status: 'running', lease: 'live' });
        await craft({ parent: rootA });
        const rootB = await craft({});

        expect((await store.claim('w1', 300))?.id).toBe(rootB);
        // Thread A's follow-up still waits — the exclusion is per thread, not global.
        expect(await store.claim('w2', 300)).toBeNull();
    });

    it('terminal roots — failed and dead — block nothing', async () => {
        const failedRoot = await craft({ status: 'failed' });
        const deadRoot = await craft({ status: 'dead' });
        const failedChild = await craft({ parent: failedRoot });
        const deadChild = await craft({ parent: deadRoot });

        const first = await store.claim('w1', 300);
        const second = await store.claim('w2', 300);
        expect([first?.id, second?.id].sort()).toEqual([failedChild, deadChild].sort());
    });
});
