import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createJobStore, type JobStore, type TaskState } from '../src/db/job-store.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
/** A second store on the same pool, bound to a different org. Only the org guard uses it. */
let otherOrgStore: JobStore;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();

/**
 * The tasks' authors. Generated identities, never literals; re-planted before every test because
 * `created_by` is a uuid foreign key. Two of them, so the author filter has someone to exclude.
 */
const AUTHOR = randomUUID();
const OTHER_AUTHOR = randomUUID();
const githubIdOf = (id: string) => Number.parseInt(id.slice(0, 8), 16);

const db = useTestDb({
    max: 8,
    users: [
        { id: AUTHOR, githubUserId: githubIdOf(AUTHOR), login: 'tasks-cat' },
        { id: OTHER_AUTHOR, githubUserId: githubIdOf(OTHER_AUTHOR), login: 'tasks-dog' },
    ],
});

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    otherOrgStore = createJobStore({ sql, orgId: OTHER_ORG });
});

/**
 * Writes a job row in whatever state the case needs, straight SQL — the `craft` helper of the
 * terminal-list suite, carrying the fields the task read model reads: parent/root linkage,
 * repo, command and the runtime vitals whose `activity` line the head lends the task.
 */
const craft = async (
    shape: {
        id?: string;
        org?: string;
        root?: string;
        parent?: string | null;
        status?: 'queued' | 'running' | 'standby' | 'succeeded' | 'failed' | 'dead' | 'stopped';
        command?: string;
        author?: string;
        createdMinutesAgo?: number;
        /** An exact stamp, for the cases where two rows must share one (the id tie-break). */
        createdAt?: string;
        finishedMinutesAgo?: number;
        doneMinutesAgo?: number;
        summary?: string;
        runtime?: Record<string, unknown>;
        repo?: string | null;
    } = {}
): Promise<string> => {
    const id = shape.id ?? randomUUID();
    await sql`
        insert into job (org_id, id, command, status, parent_job_id, root_job_id, created_by, repo,
                         lease_expires_at, created_at, finished_at, done_at, done_by, summary, runtime)
        values (
            ${shape.org ?? ORG}, ${id}, ${shape.command ?? 'crafted'},
            ${shape.status ?? 'queued'},
            ${shape.parent ?? null},
            ${shape.root ?? shape.parent ?? id},
            ${shape.author ?? AUTHOR},
            ${shape.repo ?? 'acme/widgets'},
            now() - interval '1 second',
            ${shape.createdAt ?? sql`now() - (${shape.createdMinutesAgo ?? 0} * interval '1 minute')`},
            ${
                shape.finishedMinutesAgo === undefined
                    ? null
                    : sql`now() - (${shape.finishedMinutesAgo} * interval '1 minute')`
            },
            ${shape.doneMinutesAgo === undefined ? null : sql`now() - (${shape.doneMinutesAgo} * interval '1 minute')`},
            ${shape.doneMinutesAgo === undefined ? null : (shape.author ?? AUTHOR)},
            ${shape.summary ?? null},
            ${shape.runtime === undefined ? null : sql.json(shape.runtime as never)}
        )
    `;
    return id;
};

/** A single-run root in the review bucket (succeeded, no done stamp) whose activity is its creation. */
const reviewTask = (over: Parameters<typeof craft>[0] = {}) =>
    craft({ status: 'succeeded', createdMinutesAgo: 10, ...over });

describe.skipIf(!enabled)('listTasks, the task-summary read model', () => {
    it('answers one summary per thread root: identity from the root, present tense from the head', async () => {
        const root = await reviewTask({
            command: 'the opening ask\nsecond line',
            createdMinutesAgo: 60,
            runtime: { activity: 'old activity', sampledAt: '' },
        });
        await craft({
            parent: root,
            status: 'running',
            command: 'a follow-up line that is not the title',
            createdMinutesAgo: 20,
            runtime: { activity: 'running the gates', sampledAt: '' },
        });

        const { page, navigation } = await store.listTasks({
            state: 'attention',
            q: null,
            repo: null,
            author: null,
            sort: 'newest',
            limit: 10,
            cursor: null,
        });
        expect(page.items).toHaveLength(1);
        const summary = page.items[0]!;
        expect(summary.id).toBe(root);
        expect(summary.command).toBe('the opening ask\nsecond line');
        expect(summary.status).toBe('running');
        expect(summary.activity).toBe('running the gates');
        expect(summary.author?.login).toBe('tasks-cat');
        expect(summary.createdAt).not.toBeNull();
        expect(navigation.counts).toEqual({ running: 1, review: 0, past: 0 });
    });

    it('derives the summary column and the done stamp from the head, never the root', async () => {
        const root = await craft({
            status: 'succeeded',
            createdMinutesAgo: 60,
            summary: 'root words',
            doneMinutesAgo: 50,
        });
        await craft({
            parent: root,
            status: 'failed',
            createdMinutesAgo: 20,
            summary: 'head words',
            runtime: { activity: null, sampledAt: '' },
        });

        const { page, navigation } = await store.listTasks({
            state: 'review',
            q: null,
            repo: null,
            author: null,
            sort: 'newest',
            limit: 10,
            cursor: null,
        });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]!.id).toBe(root);
        expect(page.items[0]!.summary).toBe('head words');
        // The head carries no done stamp, so the task awaits the user's verdict — the ROOT's
        // done_at (50 minutes old) must not age it into Past.
        expect(page.items[0]!.doneAt).toBeNull();
        expect(navigation.counts).toEqual({ running: 0, review: 1, past: 0 });
    });

    it('buckets by the head: a done task resurrected by a queued follow-up is running again', async () => {
        const root = await craft({
            status: 'succeeded',
            createdMinutesAgo: 60,
            doneMinutesAgo: 50,
            summary: 'done words',
        });
        await craft({ parent: root, status: 'queued', createdMinutesAgo: 10 });

        const { page, navigation } = await store.listTasks({
            state: 'attention',
            q: null,
            repo: null,
            author: null,
            sort: 'newest',
            limit: 10,
            cursor: null,
        });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]!.status).toBe('queued');
        expect(navigation.counts).toEqual({ running: 1, review: 0, past: 0 });
    });

    it('serves every state filter from the head bucket', async () => {
        await reviewTask({ createdMinutesAgo: 30, id: randomUUID() });
        await craft({ status: 'running', createdMinutesAgo: 20 });
        await craft({ status: 'succeeded', createdMinutesAgo: 10, doneMinutesAgo: 5 });
        await craft({ status: 'standby', createdMinutesAgo: 15 });
        const list = async (state: TaskState) =>
            (
                await store.listTasks({
                    state,
                    q: null,
                    repo: null,
                    author: null,
                    sort: 'newest',
                    limit: 10,
                    cursor: null,
                })
            ).page.items
                .map((t) => t.status)
                .sort();

        expect(await list('running')).toEqual(['running', 'standby']);
        expect(await list('review')).toEqual(['succeeded']);
        expect(await list('past')).toEqual(['succeeded']);
        expect(await list('attention').then((statuses) => statuses.length)).toBe(3);
    });

    it('filters at the task level: root command, root repo, root author', async () => {
        const root = await reviewTask({
            command: 'fix the flaky LOGIN test',
            repo: 'acme/widgets',
            createdMinutesAgo: 40,
        });
        await craft({
            parent: root,
            status: 'succeeded',
            command: 'adjust the approach entirely',
            repo: 'acme/other',
            author: OTHER_AUTHOR,
            createdMinutesAgo: 20,
        });
        const gears = await reviewTask({ command: 'add a changelog', repo: 'acme/gears', createdMinutesAgo: 30 });

        const ask = (over: Record<string, unknown>) =>
            store.listTasks({
                state: 'attention',
                q: null,
                repo: null,
                author: null,
                sort: 'newest',
                limit: 10,
                cursor: null,
                ...over,
            } as never);

        expect((await ask({ q: 'login' })).page.items.map((t) => t.id)).toEqual([root]);
        expect((await ask({ repo: 'acme/widgets' })).page.items.map((t) => t.id)).toEqual([root]);
        expect((await ask({ repo: 'acme/other' })).page.items).toHaveLength(0);
        // Both roots are the cat's, matched case-insensitively — the dog-authored follow-up on
        // the first thread does not re-attribute the task.
        expect((await ask({ author: 'TASKS-CAT' })).page.items.map((t) => t.id).sort()).toEqual([gears, root].sort());
        expect((await ask({ author: 'tasks-dog' })).page.items).toHaveLength(0);
    });

    it('escapes the search wildcards instead of letting them loose', async () => {
        await reviewTask({ command: 'fix_flaky_test', createdMinutesAgo: 20 });
        await reviewTask({ command: 'fix the thing', createdMinutesAgo: 10 });

        const found = await store.listTasks({
            state: 'attention',
            q: '_',
            repo: null,
            author: null,
            sort: 'newest',
            limit: 10,
            cursor: null,
        });
        expect(found.page.items).toHaveLength(1);
        expect(found.page.items[0]!.command).toBe('fix_flaky_test');
    });

    it('orders by head activity with an id tie-break, and paginates without duplicates or omissions', async () => {
        const made: string[] = [];
        for (let i = 0; i < 7; i++) {
            made.push(await reviewTask({ createdMinutesAgo: i + 10 }));
        }
        // Two tasks at the SAME activity stamp — one literal, so two transactions cannot drift
        // by microseconds and hide the tie-break: the id decides, deterministically.
        const tieA = await reviewTask({
            createdAt: '2026-09-01T11:55:00.000Z',
            id: 'aaaaaaaa-0000-4000-8000-00000000000a',
        });
        const tieB = await reviewTask({
            createdAt: '2026-09-01T11:55:00.000Z',
            id: 'bbbbbbbb-0000-4000-8000-00000000000b',
        });

        const ask = (cursor: { activityAt: string; rootId: string } | null, sort: 'newest' | 'oldest') =>
            store.listTasks({ state: 'attention', q: null, repo: null, author: null, sort, limit: 3, cursor });

        const first = await ask(null, 'newest');
        expect(first.page.items).toHaveLength(3);
        expect(first.page.nextCursor).not.toBeNull();

        const seen = [...first.page.items.map((t) => t.id)];
        let cursor = first.page.nextCursor;
        while (cursor !== null) {
            const next = await ask(cursor, 'newest');
            seen.push(...next.page.items.map((t) => t.id));
            cursor = next.page.nextCursor;
        }
        expect(new Set(seen).size).toBe(seen.length);
        expect(new Set(seen)).toEqual(new Set([...made, tieA, tieB]));

        // The tie-break: within one stamp, the greater root id sorts first under newest.
        const stamps = await store.listTasks({
            state: 'attention',
            q: null,
            repo: null,
            author: null,
            sort: 'newest',
            limit: 10,
            cursor: null,
        });
        const tieOrder = stamps.page.items.filter((t) => t.id === tieA || t.id === tieB).map((t) => t.id);
        expect(tieOrder).toEqual([tieB, tieA]);

        // The oldest sort walks the same set the other way, with its own cursor direction. The
        // tie rows carry the one fixed stamp, older than every relative one, so the first page
        // opens with them in ID-ascending order, then the least-recent loop task.
        const oldest = await ask(null, 'oldest');
        expect(oldest.page.items).toHaveLength(3);
        expect(oldest.page.items.map((t) => t.id)).toEqual([tieA, tieB, made[made.length - 1]]);
        const secondOldest = await ask(oldest.page.nextCursor, 'oldest');
        expect(secondOldest.page.items.map((t) => t.id)).not.toContain(tieA);
        expect(secondOldest.page.items.map((t) => t.id)).not.toContain(made[made.length - 1]);
    });

    it('keeps every root discoverable when the thread outgrew any newest-50 run window', async () => {
        const old1 = await reviewTask({ command: 'ancient one', createdMinutesAgo: 100 });
        const old2 = await reviewTask({ command: 'ancient two', createdMinutesAgo: 100 });
        const fresh = await reviewTask({ command: 'fresh', createdMinutesAgo: 3 });
        for (const [root, from] of [
            [old1, 1],
            [old2, 21],
        ] as const) {
            for (let i = 19; i >= 0; i--) {
                await craft({ parent: root, status: 'succeeded', createdMinutesAgo: from + i });
            }
        }
        // 42 runs beyond the two roots: the newest-50 window still covers everything here, so
        // bury the roots deeper — follow-ups newer than everything else.
        for (let i = 30; i >= 1; i--) {
            await craft({ parent: fresh, status: 'succeeded', createdMinutesAgo: i / 100 });
        }

        const { page } = await store.listTasks({
            state: 'attention',
            q: null,
            repo: null,
            author: null,
            sort: 'newest',
            limit: 10,
            cursor: null,
        });
        // Head activity orders: fresh's follow-up is seconds old, old1's is a minute old,
        // old2's is twenty-one minutes old.
        expect(page.items.map((t) => t.id)).toEqual([fresh, old1, old2]);
    });

    it('computes navigation across the complete organization, capped previews regardless of filters', async () => {
        for (let i = 0; i < 5; i++) await craft({ status: 'running', createdMinutesAgo: i + 1 });
        for (let i = 0; i < 7; i++) await reviewTask({ createdMinutesAgo: i + 10 });
        for (let i = 0; i < 2; i++)
            await craft({ status: 'succeeded', createdMinutesAgo: i + 30, doneMinutesAgo: i + 29 });

        const ask = (over: Record<string, unknown>) =>
            store.listTasks({
                state: 'attention',
                q: null,
                repo: null,
                author: null,
                sort: 'newest',
                limit: 30,
                cursor: null,
                ...over,
            } as never);

        const bare = await ask({});
        expect(bare.navigation.counts).toEqual({ running: 5, review: 7, past: 2 });
        expect(bare.navigation.running).toHaveLength(3);
        expect(bare.navigation.review).toHaveLength(5);
        const narrow = await ask({ repo: 'acme/gears' });
        expect(narrow.page.items).toHaveLength(0);
        expect(narrow.navigation.counts).toEqual(bare.navigation.counts);
    });

    it("keeps another organization's tasks out of page, counts, previews and search", async () => {
        const mine = await reviewTask({ command: 'mine only', createdMinutesAgo: 20 });
        const other = await otherOrgStore.create('other org task', null, { repo: null, executor: null });
        const claim = await otherOrgStore.claim('w1', 300);
        await otherOrgStore.complete(other.id, claim!.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: null,
        });

        const { page, navigation } = await store.listTasks({
            state: 'attention',
            q: 'mine',
            repo: null,
            author: null,
            sort: 'newest',
            limit: 10,
            cursor: null,
        });
        expect(page.items.map((t) => t.id)).toEqual([mine]);
        expect(navigation.counts).toEqual({ running: 0, review: 1, past: 0 });
        // The other org's search reaches only its own rows.
        const theirs = await otherOrgStore.listTasks({
            state: 'attention',
            q: 'task',
            repo: null,
            author: null,
            sort: 'newest',
            limit: 10,
            cursor: null,
        });
        expect(theirs.page.items.map((t) => t.id)).toEqual([other.id]);
    });
});

describe.skipIf(!enabled)('the listTasks query shape', () => {
    // The same Proxy pin the terminal list carries: the statement the org's history walks must
    // stay scoped by org everywhere, resolve the head with the chainHead shape, and bound the
    // page with a keyset limit — never an OFFSET. The shared `task` CTE rides the statements as
    // an embedded fragment, so its strings are spliced back in before asserting.
    const flatten = (strings: readonly string[], values: readonly unknown[]): string => {
        let text = '';
        for (let i = 0; i < strings.length; i++) {
            text += strings[i];
            const value = values[i];
            if (value && typeof value === 'object' && Array.isArray((value as { strings?: unknown }).strings)) {
                const fragment = value as unknown as { strings: string[]; args: unknown[] };
                text += flatten(fragment.strings, fragment.args);
            }
        }
        return text;
    };

    it('scopes every reference by org, resolves the head newest-first, and paginates by keyset', async () => {
        const captured: { strings: string[]; values: unknown[] }[] = [];
        const recording = new Proxy(sql, {
            apply(target, _this, args) {
                const [strings] = args as unknown[];
                if (Array.isArray(strings) && Array.isArray((strings as { raw?: unknown }).raw)) {
                    captured.push({ strings: [...(strings as unknown as string[])], values: args.slice(1) });
                }
                return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, target, args);
            },
            get(target, prop) {
                const value = Reflect.get(target, prop, target);
                return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
            },
        }) as Sql;
        const recordingStore = createJobStore({ sql: recording, orgId: ORG });
        const filters = {
            state: 'attention' as const,
            q: 'needle',
            repo: 'acme/widgets',
            author: 'cat',
            sort: 'newest' as const,
            limit: 30,
            cursor: { activityAt: '2026-09-01T00:00:00.000Z', rootId: randomUUID() },
        };

        await recordingStore.listTasks(filters);

        const taskQueries = captured.filter((q) => flatten(q.strings, q.values).includes('running_preview'));
        const pageQuery = captured.find((q) => flatten(q.strings, q.values).includes('order by activity_at'));
        expect(taskQueries).toHaveLength(1);
        expect(pageQuery).toBeDefined();
        for (const query of [...taskQueries, pageQuery!]) {
            const text = flatten(query.strings, query.values);
            expect(text).toContain('org_id');
            expect(text).not.toMatch(/offset/i);
            expect(text).toContain('join lateral');
            expect(text).toContain('order by h.created_at desc, h.id desc');
        }
    });
});
