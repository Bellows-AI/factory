import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createUserRepoStore, PurgeConflictError, type UserRepoStore } from '../src/db/user-repo-store.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: UserRepoStore;

const ORG = 'test-org';
const ALICE = '00000000-0000-4000-8000-00000000a11c';
const BOB = '00000000-0000-4000-8000-00000000b0b0';

const web = { owner: 'acme', name: 'web' };
const api = { owner: 'acme', name: 'api' };

/** A limit above every row this suite ever queues, so a claim proves it exhausted the queue. */
const CLAIM_LIMIT = 5;

const db = useTestDb({
    orgs: [ORG],
    users: [
        { id: ALICE, githubUserId: 90001, login: 'alice' },
        { id: BOB, githubUserId: 90002, login: 'bob' },
    ],
});

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createUserRepoStore({ sql, orgId: ORG });
});

describe.skipIf(!enabled)('the user repo store', () => {
    it('replaces the whole selection, so replaying a PUT changes nothing', async () => {
        await store.select(ALICE, [web, api]);
        await store.select(ALICE, [web, api]);
        expect(await store.list(ALICE)).toHaveLength(2);
    });

    it('marks a dropped repo deselected rather than deleting the row', async () => {
        // The row is the only record that the directory exists on disk. Deleting it would make
        // unbounded disk growth invisible, which is the failure docs/workspace.md already admits to.
        await store.select(ALICE, [web, api]);
        await store.select(ALICE, [web]);

        expect((await store.list(ALICE)).map((r) => r.name)).toEqual(['web']);
        expect((await store.orphaned(ALICE)).map((r) => r.name)).toEqual(['api']);
    });

    it('resurrects a deselected row instead of inserting beside it', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await store.select(ALICE, [web]);

        expect(await store.list(ALICE)).toHaveLength(1);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
    });

    it('keeps a ready checkout ready when it is re-selected', async () => {
        // A clone that is on disk is on disk. Re-queueing it would throw away a working tree that
        // may hold an agent's uncommitted work.
        await store.select(ALICE, [web]);
        await store.claimPending(1);
        await store.markReady(ALICE, web);
        await store.select(ALICE, [web, api]);

        const byName = Object.fromEntries((await store.list(ALICE)).map((r) => [r.name, r.status]));
        expect(byName).toEqual({ web: 'ready', api: 'queued' });
    });

    it("re-queues a failed repo when it is re-selected, so a retry is the member's choice", async () => {
        await store.select(ALICE, [web]);
        await store.claimPending(1);
        await store.markFailed(ALICE, web, 'fatal: repository not found');
        expect((await store.list(ALICE))[0]).toMatchObject({ status: 'failed', error: expect.any(String) });

        await store.select(ALICE, [web]);
        expect((await store.list(ALICE))[0]).toMatchObject({ status: 'queued', error: null });
    });

    it("keeps two members' selections apart", async () => {
        await store.select(ALICE, [web]);
        await store.select(BOB, [api]);

        expect((await store.list(ALICE)).map((r) => r.name)).toEqual(['web']);
        expect((await store.list(BOB)).map((r) => r.name)).toEqual(['api']);
    });

    it('claims at most `limit` rows and counts the attempt', async () => {
        await store.select(ALICE, [web, api]);
        expect(await store.claimPending(1)).toHaveLength(1);
        expect(await store.claimPending(CLAIM_LIMIT)).toHaveLength(1);
        // Nothing left queued: both are `cloning` now.
        expect(await store.claimPending(CLAIM_LIMIT)).toHaveLength(0);
        expect((await store.list(ALICE)).every((r) => r.attempts === 1)).toBe(true);
    });

    it('never hands the same row to two claimers', async () => {
        // `for update skip locked`, the same guard the job board uses. This is the property that
        // makes a second dashboard replica a schema question rather than a correctness one.
        await store.select(ALICE, [web, api]);
        const [a, b] = await Promise.all([store.claimPending(2), store.claimPending(2)]);
        expect([...a, ...b]).toHaveLength(2);
    });

    it('does not claim a repo that was deselected while queued', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        expect(await store.claimPending(CLAIM_LIMIT)).toHaveLength(0);
    });

    it('returns rows a restart stranded in cloning', async () => {
        // A `cloning` row is owned by a process that no longer exists, and the claim only takes
        // `queued` — so without this it stays cloning forever while nothing is cloning it.
        await store.select(ALICE, [web, api]);
        await store.claimPending(2);

        expect(await store.requeueStranded()).toBe(2);
        expect(await store.claimPending(2)).toHaveLength(2);
    });

    it('refuses a repo name that cannot be a directory, at the row', async () => {
        /*
         * The database's own copy of the rules the route applies. Duplicated on purpose, exactly as
         * organization_id_ck restates ORG_ID_PATTERN: the route guards the request, this guards the
         * row, and a name arrives in a JSON body now rather than from an operator's config.
         */
        for (const name of ['-x', '.', '..', 'a/b', 'a\\b', '']) {
            await expect(store.select(ALICE, [{ owner: 'acme', name }]), name).rejects.toThrow();
        }
    });

    it("refuses two owners' same-named repos, because they are one directory", async () => {
        // The checkout is `<repo_name>` alone. This is the check `checkWorkspaceNames` used to make
        // against ORG_REPOS at boot, restated where a name actually becomes a path.
        await expect(
            store.select(ALICE, [
                { owner: 'acme', name: 'api' },
                { owner: 'other-owner', name: 'api' },
            ])
        ).rejects.toThrow();
    });

    it("removes a member's rows when the account goes, unlike a job's author", async () => {
        // `on delete cascade` here, `set null` on job.created_by. A job is an audit record of what
        // somebody ran and must outlive them; this row describes a directory nobody can reach.
        await store.select(BOB, [web]);
        await sql`delete from app_user where id = ${BOB}`;
        expect(await store.list(BOB)).toEqual([]);

        await sql`
            insert into app_user (id, github_user_id, github_login) values (${BOB}, 90002, 'bob')
            on conflict (github_user_id) do update set id = excluded.id
        `;
    });
});

/**
 * The manual purge (issue #92). The stamp is one transaction that locks the row and checks
 * deselection, clone status and blocking tasks; every refusal is decided under that lock so the
 * losing operation observes the winning transaction's state.
 */
describe.skipIf(!enabled)('the manual purge', () => {
    /** Plants a task row. `repo` is `owner/name` as the routes store it; null is command-only. */
    async function insertJob(user: string, repo: string | null, status = 'queued', done = false) {
        const id = randomUUID();
        await sql`
            insert into job (org_id, id, command, status, repo, created_by, root_job_id, done_at)
            values (${ORG}, ${id}, 'do it', ${status}, ${repo}, ${user}, ${id}, ${done ? new Date() : null})
        `;
        return id;
    }

    it('stamps a deselected row purging and records the start time', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);

        expect(await store.stampPurge(ALICE, web)).toEqual({ stamped: true });

        const [row] = await store.orphaned(ALICE);
        expect(row!.status).toBe('purging');
        expect(row!.purgeStartedAt).not.toBeNull();
    });

    it('refuses a selected row regardless of its clone status', async () => {
        await store.select(ALICE, [web]);
        await store.claimPending(1);
        await store.markReady(ALICE, web);

        expect(await store.stampPurge(ALICE, web)).toEqual({ refused: 'selected' });
    });

    it('answers a duplicate request with purging', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await store.stampPurge(ALICE, web);

        expect(await store.stampPurge(ALICE, web)).toEqual({ refused: 'purging' });
    });

    it('refuses a row still owned by a clone', async () => {
        await store.select(ALICE, [web]);
        await store.claimPending(1);
        await store.select(ALICE, []);

        expect(await store.stampPurge(ALICE, web)).toEqual({ refused: 'cloning' });
    });

    it('counts a same-name task whose repo label names another owner as blocking', async () => {
        // The directory is keyed by repo NAME, so an old task queued against `other/web` writes in
        // the member's `web` checkout exactly as one queued against `acme/web` would. The tasks
        // counted are the member's own; only the repo label's owner part is free to differ.
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await insertJob(ALICE, 'other/web');

        expect(await store.stampPurge(ALICE, web)).toEqual({ refused: 'tasks', count: 1 });
    });

    it('does not count another member\u2019s tasks, whatever their name', async () => {
        // Another member's tasks run in that member's workspace, never in this checkout.
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await insertJob(BOB, 'other/web');
        await insertJob(BOB, 'acme/web');

        expect(await store.stampPurge(ALICE, web)).toEqual({ stamped: true });
    });

    it('does not count a thread that is terminal and marked done', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        const root = await insertJob(ALICE, 'acme/web', 'succeeded', true);
        await insertJob(ALICE, 'acme/web', 'failed', true).then(
            () => sql`update job set root_job_id = ${root} where command = 'do it' and status = 'failed'`
        );

        expect(await store.stampPurge(ALICE, web)).toEqual({ stamped: true });
    });

    it('counts a thread that is terminal but never marked done', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await insertJob(ALICE, 'acme/web', 'succeeded');

        expect(await store.stampPurge(ALICE, web)).toEqual({ refused: 'tasks', count: 1 });
    });

    it('does not count command-only tasks', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await insertJob(ALICE, null);

        expect(await store.stampPurge(ALICE, web)).toEqual({ stamped: true });
    });

    it('answers missing for a row that is not there', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);

        expect(await store.stampPurge(ALICE, api)).toBe('missing');
    });

    it('refuses a selection that would change a purging row', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await store.stampPurge(ALICE, web);

        await expect(store.select(ALICE, [web])).rejects.toBeInstanceOf(PurgeConflictError);
        // The refusal names the offending checkout, and the whole selection is refused.
        await expect(store.select(ALICE, [web, api])).rejects.toMatchObject({ names: ['web'] });
        expect(await store.orphaned(ALICE)).toHaveLength(1);
        expect(await store.list(ALICE)).toHaveLength(0);
    });

    it('deletes only a row that is still deselected and purging', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await store.stampPurge(ALICE, web);

        expect(await store.deletePurged(ALICE, web)).toBe(true);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
        // A replay performs no second delete: the row is gone.
        expect(await store.deletePurged(ALICE, web)).toBe(false);
    });

    it('deletePurged leaves a row that moved behind the purge\u2019s back', async () => {
        // The second transaction must find the row still deselected and still purging — a select
        // that commits first re-queues the row, and the stale purge must not delete it.
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await store.stampPurge(ALICE, web);
        await sql`
            update user_repo set deselected_at = null, status = 'queued'
            where org_id = ${ORG} and user_id = ${ALICE} and repo_name = 'web'
        `;

        expect(await store.deletePurged(ALICE, web)).toBe(false);
        expect(await store.list(ALICE)).toHaveLength(1);
    });

    it('lands a failed purge back on failed with the reason', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await store.stampPurge(ALICE, web);

        await store.markPurgeFailed(ALICE, web, 'rm: permission denied');

        const [row] = await store.orphaned(ALICE);
        expect(row!.status).toBe('failed');
        expect(row!.error).toBe('rm: permission denied');
        expect(row!.purgeStartedAt).not.toBeNull();
    });

    it('lists every purging row of the org with its member, for boot recovery', async () => {
        await store.select(ALICE, [web]);
        await store.select(BOB, [api]);
        await store.select(ALICE, []);
        await store.select(BOB, []);
        await store.stampPurge(ALICE, web);
        await store.stampPurge(BOB, api);

        const purging = await store.listPurging();
        expect(purging.map((r) => [r.userId, r.name]).sort()).toEqual(
            [
                [ALICE, 'web'],
                [BOB, 'api'],
            ].sort()
        );
    });
});
