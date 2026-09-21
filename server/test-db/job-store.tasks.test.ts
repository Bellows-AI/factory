import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createJobStore, type JobStore } from '../src/db/job-store.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
/** A second store on the same pool, bound to a different org — the isolation guard's other side. */
let otherOrgStore: JobStore;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();

/**
 * Two authors: the author filter and the root-author join need more than one account to mean
 * anything. Generated identities, re-planted before every test — `created_by` is a uuid FK.
 */
const AUTHOR = randomUUID();
const OTHER_AUTHOR = randomUUID();
const AUTHOR_GITHUB_ID = Number.parseInt(randomUUID().slice(0, 8), 16);
const OTHER_AUTHOR_GITHUB_ID = Number.parseInt(randomUUID().slice(0, 8), 16);

const db = useTestDb({
    max: 8,
    users: [
        { id: AUTHOR, githubUserId: AUTHOR_GITHUB_ID, login: 'tasks-cat' },
        { id: OTHER_AUTHOR, githubUserId: OTHER_AUTHOR_GITHUB_ID, login: 'tasks-other' },
    ],
});

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    otherOrgStore = createJobStore({ sql, orgId: OTHER_ORG });
});

/** How long ago an ISO stamp reads, in minutes — for asserting backdated times without sleeping. */
const minutesAgo = (iso: string): number => (Date.now() - Date.parse(iso)) / 60_000;

/**
 * Writes a job row in whatever state the case needs, straight SQL — the completed-tasks suite's
 * `craft`, extended with the fields the task summary reads: started_at (an activity_at stamp) and
 * the runtime vitals the head's activity line comes from. `at` pins absolute stamps, for the
 * cases where two rows must carry EXACTLY equal activity — relative intervals are written by
 * separate statements, and two `now()`s are never equal.
 */
const craft = async (
    shape: {
        root?: string;
        parent?: string | null;
        status?: 'queued' | 'running' | 'standby' | 'succeeded' | 'failed' | 'dead' | 'stopped';
        command?: string;
        createdMinutesAgo?: number;
        startedMinutesAgo?: number;
        finishedMinutesAgo?: number;
        doneMinutesAgo?: number;
        at?: { created?: string; started?: string; finished?: string; done?: string };
        summary?: string;
        repo?: string;
        author?: string;
        runtime?: Record<string, unknown>;
    } = {}
): Promise<string> => {
    const id = randomUUID();
    await sql`
        insert into job (org_id, id, command, status, parent_job_id, root_job_id, created_by, repo,
                         lease_expires_at, created_at, started_at, finished_at, summary, done_at, done_by, runtime)
        values (
            ${ORG}, ${id}, ${shape.command ?? 'crafted'},
            ${shape.status ?? 'queued'},
            ${shape.parent ?? null},
            ${shape.root ?? shape.parent ?? id},
            ${shape.author ?? AUTHOR},
            ${shape.repo ?? 'acme/widgets'},
            now() - interval '1 second',
            ${shape.at?.created ?? sql`now() - (${shape.createdMinutesAgo ?? 0} * interval '1 minute')`},
            ${
                shape.at?.started ??
                (shape.startedMinutesAgo === undefined
                    ? null
                    : sql`now() - (${shape.startedMinutesAgo} * interval '1 minute')`)
            },
            ${
                shape.at?.finished ??
                (shape.finishedMinutesAgo === undefined
                    ? null
                    : sql`now() - (${shape.finishedMinutesAgo} * interval '1 minute')`)
            },
            ${shape.summary ?? null},
            ${
                shape.at?.done ??
                (shape.doneMinutesAgo === undefined
                    ? null
                    : sql`now() - (${shape.doneMinutesAgo} * interval '1 minute')`)
            },
            ${shape.at?.done === undefined && shape.doneMinutesAgo === undefined ? null : (shape.author ?? AUTHOR)},
            ${shape.runtime === undefined ? null : sql.json(shape.runtime as never)}
        )
    `;
    return id;
};

describe.skipIf(!enabled)('listTasks', () => {
    it('folds a thread with follow-ups into one summary: root identity, head present tense', async () => {
        const root = await craft({
            command: 'the opening ask',
            createdMinutesAgo: 60,
            status: 'succeeded',
            finishedMinutesAgo: 55,
            summary: 'root words',
            author: OTHER_AUTHOR,
        });
        await craft({ parent: root, status: 'failed', createdMinutesAgo: 40, finishedMinutesAgo: 35 });
        await craft({
            parent: root,
            status: 'running',
            createdMinutesAgo: 20,
            startedMinutesAgo: 19,
            runtime: {
                cpuPercent: 1,
                memUsedMb: 2,
                memPercent: 3,
                activity: 'the live line',
                sampledAt: '2026-09-10T11:59:00Z',
            },
        });

        const { page } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        expect(page.items).toHaveLength(1);
        const task = page.items[0]!;
        // Identity is the ROOT's: the id every link targets, the opening ask, the thread's author.
        expect(task.id).toBe(root);
        expect(task.command).toBe('the opening ask');
        expect(task.author?.login).toBe('tasks-other');
        expect(Math.abs(minutesAgo(task.createdAt) - 60)).toBeLessThan(2);
        // Present tense is the HEAD's: status, live activity, close-time summary, activity stamp.
        expect(task.status).toBe('running');
        expect(task.activity).toBe('the live line');
        expect(task.summary).toBeNull();
        expect(task.doneAt).toBeNull();
        expect(Math.abs(minutesAgo(task.activityAt) - 19)).toBeLessThan(2);
    });

    it('buckets queued, running and standby heads as running', async () => {
        for (const status of ['queued', 'running', 'standby'] as const) {
            await craft({ status, command: `task ${status}`, createdMinutesAgo: 30 });
        }
        const { navigation, page } = await store.listTasks({ state: 'running', sort: 'newest', limit: 30 });
        expect(navigation.counts).toEqual({ running: 3, review: 0, past: 0 });
        expect(page.items).toHaveLength(3);
    });

    it('buckets terminal heads by the head done stamp — review without it, past with it', async () => {
        for (const status of ['succeeded', 'failed', 'dead', 'stopped'] as const) {
            await craft({ status, createdMinutesAgo: 40, finishedMinutesAgo: 35 });
            await craft({ status, createdMinutesAgo: 30, finishedMinutesAgo: 25, doneMinutesAgo: 20 });
        }
        const { navigation } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        expect(navigation.counts).toEqual({ running: 0, review: 4, past: 4 });
        const review = await store.listTasks({ state: 'review', sort: 'newest', limit: 30 });
        expect(review.page.items).toHaveLength(4);
        for (const task of review.page.items) expect(task.doneAt).toBeNull();
        const past = await store.listTasks({ state: 'past', sort: 'newest', limit: 30 });
        expect(past.page.items).toHaveLength(4);
        for (const task of past.page.items) expect(task.doneAt).not.toBeNull();
    });

    it('resurrects a done task with a queued follow-up — running again, done gone', async () => {
        const root = await craft({
            status: 'succeeded',
            createdMinutesAgo: 60,
            finishedMinutesAgo: 50,
            doneMinutesAgo: 40,
        });
        await craft({ parent: root, status: 'queued', createdMinutesAgo: 10 });

        const { navigation, page } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({ id: root, status: 'queued', doneAt: null });
        expect(navigation.counts).toEqual({ running: 1, review: 0, past: 0 });
    });

    it('orders by head activity, the id descending on an exactly equal stamp', async () => {
        // Two roots whose heads carry the SAME absolute stamps: the id descending breaks the tie.
        // One literal shared by both crafts — two Date.now() calls could straddle a millisecond.
        const tieStamp = new Date(Date.now() - 30 * 60_000).toISOString();
        const tieA = await craft({
            status: 'running',
            at: { created: tieStamp, started: tieStamp },
        });
        const tieB = await craft({
            status: 'running',
            at: { created: tieStamp, started: tieStamp },
        });
        const older = await craft({ status: 'running', createdMinutesAgo: 60, startedMinutesAgo: 59 });

        const { page } = await store.listTasks({ state: 'running', sort: 'newest', limit: 30 });
        const ids = page.items.map((task) => task.id);
        expect(ids.slice(0, 2)).toEqual([tieA, tieB].sort().reverse());
        expect(ids[2]).toBe(older);
    });

    it('splits an exactly-tied pair across a page boundary', async () => {
        // Three roots on one stamp, limit 2: the exclusive (activity_at, id) comparison must hand
        // the tied third over whole — neither duplicated nor skipped.
        const stamp = new Date(Date.now() - 45 * 60_000).toISOString();
        const craftTie = (): Promise<string> => craft({ status: 'running', at: { created: stamp, started: stamp } });
        const tieA = await craftTie();
        const tieB = await craftTie();
        const tieC = await craftTie();
        const expected = [tieA, tieB, tieC].sort().reverse();

        const first = await store.listTasks({ state: 'running', sort: 'newest', limit: 2 });
        expect(first.page.items.map((task) => task.id)).toEqual(expected.slice(0, 2));
        const second = await store.listTasks({
            state: 'running',
            sort: 'newest',
            limit: 2,
            cursor: first.page.nextCursor!,
        });
        expect(second.page.items.map((task) => task.id)).toEqual(expected.slice(2));
        expect(second.page.nextCursor).toBeNull();
    });

    it('paginates forward on (activity_at, root id) without duplicates or omissions', async () => {
        for (let i = 0; i < 7; i++) {
            await craft({ status: 'running', createdMinutesAgo: 100 - i, startedMinutesAgo: 99 - i });
        }
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard++) {
            const { page } = await store.listTasks({
                state: 'running',
                sort: 'newest',
                limit: 3,
                ...(cursor ? { cursor } : {}),
            });
            seen.push(...page.items.map((task) => task.id));
            if (page.nextCursor === null) break;
            cursor = page.nextCursor;
        }
        expect(seen).toHaveLength(7);
        expect(new Set(seen).size).toBe(7);
    });

    it('paginates oldest first under its own cursor direction', async () => {
        for (let i = 0; i < 5; i++) {
            await craft({ status: 'running', createdMinutesAgo: 100 - i, startedMinutesAgo: 99 - i });
        }
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard++) {
            const { page } = await store.listTasks({
                state: 'running',
                sort: 'oldest',
                limit: 2,
                ...(cursor ? { cursor } : {}),
            });
            seen.push(...page.items.map((task) => task.id));
            if (page.nextCursor === null) break;
            cursor = page.nextCursor;
        }
        expect(seen).toHaveLength(5);
        expect(new Set(seen).size).toBe(5);
        // The first page really is the oldest end.
        const first = await store.listTasks({ state: 'running', sort: 'oldest', limit: 1 });
        expect(seen[0]).toBe(first.page.items[0]!.id);
    });

    it('reaches every root past fifty interleaved runs — the old web window is not the world', async () => {
        // 26 threads x 2 runs = 52 job rows. Ordered by recency the oldest ROOT lands outside the
        // newest-50 window GET /api/jobs serves — and every task must still be reachable here.
        for (let thread = 0; thread < 26; thread++) {
            const root = await craft({
                status: 'succeeded',
                createdMinutesAgo: 200 - thread * 2,
                finishedMinutesAgo: 199 - thread * 2,
                doneMinutesAgo: 198 - thread * 2,
            });
            await craft({
                parent: root,
                status: 'succeeded',
                createdMinutesAgo: 199 - thread * 2,
                finishedMinutesAgo: 198 - thread * 2,
                doneMinutesAgo: 197 - thread * 2,
            });
        }
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard++) {
            const { page } = await store.listTasks({
                state: 'past',
                sort: 'newest',
                limit: 10,
                ...(cursor ? { cursor } : {}),
            });
            seen.push(...page.items.map((task) => task.id));
            if (page.nextCursor === null) break;
            cursor = page.nextCursor;
        }
        expect(seen).toHaveLength(26);
        expect(new Set(seen).size).toBe(26);
    });

    it('filters by repository, author and search at task level, not run level', async () => {
        // A task whose follow-up mentions the term but whose ROOT does not: the search reads the
        // root command only, so the task must not match. It sits in review — reachable by every
        // other filter — so only the search can exclude it.
        const wrongRoot = await craft({
            command: 'unrelated ask',
            status: 'succeeded',
            createdMinutesAgo: 50,
            finishedMinutesAgo: 45,
            repo: 'acme/other',
        });
        await craft({
            parent: wrongRoot,
            command: 'now fix the LOGIN page',
            status: 'succeeded',
            createdMinutesAgo: 10,
            finishedMinutesAgo: 5,
        });
        // A task whose root matches, carried by a follow-up that does not have to.
        const match = await craft({
            command: 'Fix the LOGIN flow',
            status: 'running',
            createdMinutesAgo: 40,
            startedMinutesAgo: 39,
            repo: 'acme/widgets',
        });
        await craft({ parent: match, command: 'carry on', status: 'running', createdMinutesAgo: 10 });
        // Another author's task, on another repository, matching the same term.
        const other = await craft({
            command: 'fix the login flow for tests',
            status: 'running',
            createdMinutesAgo: 30,
            startedMinutesAgo: 29,
            repo: 'acme/other',
            author: OTHER_AUTHOR,
        });

        // `match`'s head is its follow-up (`carry on`, the newest run), so its activity stamp is
        // the newest of the two — newest activity first.
        const bySearch = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30, q: 'login' });
        expect(bySearch.page.items.map((task) => task.id)).toEqual([match, other]);

        const byRepo = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30, repo: 'acme/widgets' });
        expect(byRepo.page.items.map((task) => task.id)).toEqual([match]);

        // The author filter is a login, compared case-insensitively.
        const byAuthor = await store.listTasks({
            state: 'attention',
            sort: 'newest',
            limit: 30,
            author: 'TASKS-OTHER',
        });
        expect(byAuthor.page.items.map((task) => task.id)).toEqual([other]);

        const combined = await store.listTasks({
            state: 'running',
            sort: 'newest',
            limit: 30,
            q: 'LOGIN',
            repo: 'acme/widgets',
            author: 'tasks-cat',
        });
        expect(combined.page.items.map((task) => task.id)).toEqual([match]);
    });

    it('keeps counts and previews organization-wide while the page obeys the filters', async () => {
        await craft({ status: 'running', createdMinutesAgo: 60, startedMinutesAgo: 59, repo: 'acme/one' });
        await craft({ status: 'succeeded', createdMinutesAgo: 50, finishedMinutesAgo: 45, repo: 'acme/two' });
        await craft({
            status: 'failed',
            createdMinutesAgo: 40,
            finishedMinutesAgo: 35,
            doneMinutesAgo: 30,
            repo: 'acme/three',
        });

        const { navigation, page } = await store.listTasks({
            state: 'review',
            sort: 'newest',
            limit: 30,
            repo: 'acme/two',
        });
        expect(navigation.counts).toEqual({ running: 1, review: 1, past: 1 });
        expect(navigation.running).toHaveLength(1);
        expect(navigation.review).toHaveLength(1);
        // Preview rows arrive through the json path, where stamps read back as offset strings —
        // the shape stampOf exists to normalize. A regression there would null these stamps.
        expect(navigation.running[0]).toMatchObject({ repo: 'acme/one' });
        expect(Math.abs(minutesAgo(navigation.running[0]!.createdAt) - 60)).toBeLessThan(2);
        expect(Math.abs(minutesAgo(navigation.running[0]!.activityAt) - 59)).toBeLessThan(2);
        expect(page.items.map((task) => task.repo)).toEqual(['acme/two']);
    });

    it('never mixes another organization into counts, previews, page or search', async () => {
        await craft({ status: 'running', createdMinutesAgo: 60, startedMinutesAgo: 59, command: 'mine running' });
        await craft({ status: 'succeeded', createdMinutesAgo: 50, finishedMinutesAgo: 45, command: 'mine review' });

        const other = await otherOrgStore.create('theirs', null, { repo: null, executor: null });
        const claim = await otherOrgStore.claim('w1', 300);
        await otherOrgStore.complete(other.id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: null });

        const { navigation, page } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        expect(navigation.counts).toEqual({ running: 1, review: 1, past: 0 });
        expect(navigation.running.map((task) => task.command)).toEqual(['mine running']);
        expect(navigation.review.map((task) => task.command)).toEqual(['mine review']);
        // `mine review` finished 45 minutes ago; `mine running` last changed 59 minutes ago.
        expect(page.items.map((task) => task.command)).toEqual(['mine review', 'mine running']);

        const search = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30, q: 'theirs' });
        expect(search.page.items).toEqual([]);
    });

    it('carries no run detail: no output, no gates, no runtime object', async () => {
        const root = await craft({
            status: 'running',
            createdMinutesAgo: 30,
            startedMinutesAgo: 29,
            runtime: {
                cpuPercent: 1,
                memUsedMb: 2,
                memPercent: 3,
                activity: 'line',
                sampledAt: '2026-09-10T11:59:00Z',
            },
        });

        const { page } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        expect(page.items[0]!.id).toBe(root);
        expect(Object.keys(page.items[0]!).sort()).toEqual([
            'activity',
            'activityAt',
            'author',
            'cancelRequestedAt',
            'command',
            'createdAt',
            'doneAt',
            'executor',
            'id',
            'repo',
            'status',
            'summary',
            // The PR-wait fields (036) ride the summary contract; this thread never waited, so all
            // three read null.
            'waitReason',
            'waitTerminalReason',
            'waitingSince',
        ]);
        expect(JSON.stringify(page.items[0])).not.toContain('cpuPercent');
    });
});
