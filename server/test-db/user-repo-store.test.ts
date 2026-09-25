import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createUserRepoStore, type UserRepoStore } from '../src/db/user-repo-store.js';
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
