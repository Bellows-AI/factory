import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { createUserRepoStore, PurgeConflictError, type UserRepoStore } from '../src/db/user-repo-store.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: UserRepoStore;
let jobs: JobStore;

const ORG = 'test-org';
const ALICE = '00000000-0000-4000-8000-00000000a11c';
const BOB = '00000000-0000-4000-8000-00000000b0b0';

const web = { owner: 'acme', name: 'web' };

/**
 * The races the manual purge can lose (issue #92's acceptance criterion): duplicate/replayed
 * purge, selection versus purge, ALL THREE job-insert paths (create, follow-up, retry) versus
 * purge, and same-name tasks from another owner. The losing operation must observe the winning
 * transaction's state — which is what the row lock buys, and what these tests exercise with a
 * real second transaction holding the lock.
 */
const db = useTestDb({
    orgs: [ORG],
    users: [
        { id: ALICE, githubUserId: 90001, login: 'alice' },
        { id: BOB, githubUserId: 90002, login: 'bob' },
    ],
    max: 8,
});

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createUserRepoStore({ sql, orgId: ORG });
    jobs = createJobStore({ sql, orgId: ORG });
});

/**
 * Holds the user_repo row's lock in an open transaction until the test releases it, running the
 * winner's own write (the stamp's `purging` update) INSIDE that transaction — uncommitted and
 * invisible until release, which is exactly the state a purge's stamp is in while it holds the
 * lock. Releasing commits, and the blocked loser re-reads the row under READ COMMITTED.
 */
function holdRowLock(repo: { owner: string; name: string }, work?: (tx: TransactionSql) => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const opened = new Promise<void>((resolve) => {
        void sql
            .begin(async (tx) => {
                await tx`
                    select status from user_repo
                    where org_id = ${ORG} and user_id = ${ALICE}
                      and repo_owner = ${repo.owner} and repo_name = ${repo.name}
                    for update
                `;
                if (work) await work(tx);
                resolve();
                await gate;
            })
            .catch(() => {});
    });
    return { opened, release };
}

const settlesWithin = (promise: Promise<unknown>, ms: number) =>
    Promise.race([promise.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), ms))]);

async function seedOrphan(repo: { owner: string; name: string }) {
    await store.select(ALICE, [repo]);
    await store.select(ALICE, []);
}

describe.skipIf(!enabled)('the purge races', () => {
    it('a job insert waits behind the stamp, then refuses — and nothing was queued', async () => {
        await seedOrphan(web);
        const lock = holdRowLock(
            web,
            (tx) =>
                tx`update user_repo set status = 'purging', purge_started_at = now()
               where org_id = ${ORG} and user_id = ${ALICE} and repo_name = 'web'`
        );
        await lock.opened;

        const attempt = jobs.create('do it', ALICE, { repo: 'other/web', executor: null, workflow: null });
        // Blocked on the row lock: the insert cannot decide before the stamp's transaction ends.
        expect(await settlesWithin(attempt, 150)).toBe(false);

        lock.release(); // the stamp commits

        expect(await attempt).toBe('purging');
        const queued = await sql<{ n: number }[]>`select count(*)::int as n from job where org_id = ${ORG}`;
        expect(queued[0]?.n).toBe(0);
    });

    it('a job insert that commits first makes the stamp refuse with the count', async () => {
        await seedOrphan(web);
        // The create takes the row lock, inserts, commits — all before the stamp runs.
        await jobs.create('do it', ALICE, { repo: 'other/web', executor: null, workflow: null });

        expect(await store.stampPurge(ALICE, web)).toEqual({ refused: 'tasks', count: 1 });
    });

    it('a selection that commits first makes the stamp\u2019s deselection check fail', async () => {
        await store.select(ALICE, [web]);
        // The select is the winner here: the row is not deselected, and the stamp must say so.
        expect(await store.stampPurge(ALICE, web)).toEqual({ refused: 'selected' });
    });

    it('a stamp that commits first refuses all three job-insert paths', async () => {
        await seedOrphan(web);
        await store.stampPurge(ALICE, web);

        const root = await jobs.create('do it', ALICE, { repo: 'acme/web', executor: null, workflow: null });
        expect(root).toBe('purging');

        // And the follow-up path, against a finished parent whose repo names the purging checkout.
        const parentId = randomUUID();
        await sql`
            insert into job (org_id, id, command, status, repo, created_by, session_id, root_job_id)
            values (${ORG}, ${parentId}, 'root', 'succeeded', 'acme/web', ${ALICE},
                    ${'33333333-3333-4333-8333-333333333333'}, ${parentId})
        `;
        expect(await jobs.createFollowUp(parentId, 'again', ALICE)).toBe('purging');

        // And the retry path (issue #326), whose guard reads the NAMED task's repo label.
        expect(await jobs.createRetry(parentId, ALICE)).toBe('purging');
    });

    it('a re-selection while the stamp is held waits, then refuses with the row intact', async () => {
        await seedOrphan(web);
        const lock = holdRowLock(
            web,
            (tx) =>
                tx`update user_repo set status = 'purging', purge_started_at = now()
               where org_id = ${ORG} and user_id = ${ALICE} and repo_name = 'web'`
        );
        await lock.opened;

        const attempt = store.select(ALICE, [web]);
        expect(await settlesWithin(attempt, 150)).toBe(false);

        lock.release(); // the stamp commits

        await expect(attempt).rejects.toBeInstanceOf(PurgeConflictError);
        // Nothing moved: the row is still deselected and still purging.
        const [row] = await store.orphaned(ALICE);
        expect(row!.status).toBe('purging');
    });

    it('a replay after the row is gone deletes nothing and reports so', async () => {
        await seedOrphan(web);
        await store.stampPurge(ALICE, web);

        expect(await store.deletePurged(ALICE, web)).toBe(true);
        expect(await store.deletePurged(ALICE, web)).toBe(false);
    });

    it('another member\u2019s same-name tasks never block the purge', async () => {
        await seedOrphan(web);
        await jobs.create('do it', BOB, { repo: 'acme/web', executor: null, workflow: null });

        expect(await store.stampPurge(ALICE, web)).toEqual({ stamped: true });
    });

    it('a follow-up whose checkout row is absent still queues — the existing task contract', async () => {
        const parentId = randomUUID();
        await sql`
            insert into job (org_id, id, command, status, repo, created_by, session_id, root_job_id)
            values (${ORG}, ${parentId}, 'root', 'succeeded', 'ghost/repo', ${ALICE},
                    ${'33333333-3333-4333-8333-333333333333'}, ${parentId})
        `;

        const followUp = await jobs.createFollowUp(parentId, 'again', ALICE);
        expect(followUp).toHaveProperty('id');
        // The retry path reads the same absent row as no refusal, the same contract.
        const retry = await jobs.createRetry(parentId, ALICE);
        expect(retry).toHaveProperty('id');
    });
});
