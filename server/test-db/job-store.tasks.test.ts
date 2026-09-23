import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createJobStore, type JobStore } from '../src/db/job-store.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;

const ORG = randomUUID();

/**
 * Two authors: the author filter and the root-author join need more than one account to mean
 * anything. Generated identities, re-planted before every test — `created_by` is a uuid FK.
 */
const AUTHOR = randomUUID();
const OTHER_AUTHOR = randomUUID();
/** Turns a slice of a uuid into a plausible github id — hex digits, parsed as base 16. */
const UUID_HEX_SLICE_LENGTH = 8;
const HEX_RADIX = 16;
const AUTHOR_GITHUB_ID = Number.parseInt(randomUUID().slice(0, UUID_HEX_SLICE_LENGTH), HEX_RADIX);
const OTHER_AUTHOR_GITHUB_ID = Number.parseInt(randomUUID().slice(0, UUID_HEX_SLICE_LENGTH), HEX_RADIX);

const db = useTestDb({
    max: 8,
    // workflow_wait FKs to organization — the wait tests below need it planted.
    orgs: [ORG],
    users: [
        { id: AUTHOR, githubUserId: AUTHOR_GITHUB_ID, login: 'tasks-cat' },
        { id: OTHER_AUTHOR, githubUserId: OTHER_AUTHOR_GITHUB_ID, login: 'tasks-other' },
    ],
});

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

const MS_PER_MINUTE = 60_000;

/** How long ago an ISO stamp reads, in minutes — for asserting backdated times without sleeping. */
const minutesAgo = (iso: string): number => (Date.now() - Date.parse(iso)) / MS_PER_MINUTE;

/** Resolves a column's stamp: an absolute override, a relative minutes-ago, or null. */
const stampOrMinutesAgo = (explicit: string | undefined, minutesAgoValue: number | undefined) =>
    explicit ?? (minutesAgoValue === undefined ? null : sql`now() - (${minutesAgoValue} * interval '1 minute')`);

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
            ${stampOrMinutesAgo(shape.at?.started, shape.startedMinutesAgo)},
            ${stampOrMinutesAgo(shape.at?.finished, shape.finishedMinutesAgo)},
            ${shape.summary ?? null},
            ${stampOrMinutesAgo(shape.at?.done, shape.doneMinutesAgo)},
            ${shape.at?.done === undefined && shape.doneMinutesAgo === undefined ? null : (shape.author ?? AUTHOR)},
            ${shape.runtime === undefined ? null : sql.json(shape.runtime as never)}
        )
    `;
    return id;
};

/** Writes a `workflow_wait` row for a root, straight SQL — the 036 wait store's own shape. */
const enterWait = async (
    root: string,
    shape: {
        reason?: string;
        activeMinutesAgo?: number;
        terminalReason?: string | null;
        completed?: boolean;
        cancelled?: boolean;
    } = {}
): Promise<void> => {
    await sql`
        insert into workflow_wait (org_id, root_job_id, reason, repo, pr_number, active_at, completed_at, cancelled_at, terminal_reason)
        values (
            ${ORG}, ${root}, ${shape.reason ?? 'review'}, 'acme/widgets', 1,
            now() - (${shape.activeMinutesAgo ?? 5} * interval '1 minute'),
            ${shape.completed ? sql`now()` : null},
            ${shape.cancelled ? sql`now()` : null},
            ${shape.terminalReason ?? null}
        )
    `;
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
        const RUNNING_HEAD_STARTED_MINUTES_AGO = 19;
        await craft({
            parent: root,
            status: 'running',
            createdMinutesAgo: 20,
            startedMinutesAgo: RUNNING_HEAD_STARTED_MINUTES_AGO,
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
        expect(Math.abs(minutesAgo(task.activityAt) - RUNNING_HEAD_STARTED_MINUTES_AGO)).toBeLessThan(2);
    });

    it('buckets queued, running and standby heads as running', async () => {
        const RUNNING_STATUSES = ['queued', 'running', 'standby'] as const;
        for (const status of RUNNING_STATUSES) {
            await craft({ status, command: `task ${status}`, createdMinutesAgo: 30 });
        }
        const { navigation, page } = await store.listTasks({ state: 'running', sort: 'newest', limit: 30 });
        expect(navigation.counts).toEqual({ running: RUNNING_STATUSES.length, review: 0, past: 0 });
        expect(page.items).toHaveLength(RUNNING_STATUSES.length);
    });

    it('buckets a non-terminal head with an open wait as review, not running', async () => {
        const root = await craft({ status: 'standby', command: 'waiting task', createdMinutesAgo: 30 });
        await enterWait(root, { activeMinutesAgo: 10 });

        const { navigation } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        expect(navigation.counts).toEqual({ running: 0, review: 1, past: 0 });
        const review = await store.listTasks({ state: 'review', sort: 'newest', limit: 30 });
        expect(review.page.items).toHaveLength(1);
        expect(review.page.items[0]).toMatchObject({
            id: root,
            waitReason: 'review',
            waitTerminalReason: null,
        });
        expect(review.page.items[0]!.waitingSince).not.toBeNull();
    });

    it('falls back to the ordinary bucket once the wait has gone terminal', async () => {
        const root = await craft({ status: 'standby', command: 'exhausted wait task', createdMinutesAgo: 30 });
        await enterWait(root, { activeMinutesAgo: 20, completed: true, terminalReason: 'exhausted' });

        const { navigation } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        // standby is not itself terminal, and the wait no longer overrides it — back to running.
        expect(navigation.counts).toEqual({ running: 1, review: 0, past: 0 });
        const running = await store.listTasks({ state: 'running', sort: 'newest', limit: 30 });
        expect(running.page.items[0]).toMatchObject({
            id: root,
            waitReason: 'review',
            waitTerminalReason: 'exhausted',
        });
    });

    it('buckets terminal heads by the head done stamp — review without it, past with it', async () => {
        const TERMINAL_STATUSES = ['succeeded', 'failed', 'dead', 'stopped'] as const;
        for (const status of TERMINAL_STATUSES) {
            await craft({ status, createdMinutesAgo: 40, finishedMinutesAgo: 35 });
            await craft({ status, createdMinutesAgo: 30, finishedMinutesAgo: 25, doneMinutesAgo: 20 });
        }
        const { navigation } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        expect(navigation.counts).toEqual({
            running: 0,
            review: TERMINAL_STATUSES.length,
            past: TERMINAL_STATUSES.length,
        });
        const review = await store.listTasks({ state: 'review', sort: 'newest', limit: 30 });
        expect(review.page.items).toHaveLength(TERMINAL_STATUSES.length);
        for (const task of review.page.items) expect(task.doneAt).toBeNull();
        const past = await store.listTasks({ state: 'past', sort: 'newest', limit: 30 });
        expect(past.page.items).toHaveLength(TERMINAL_STATUSES.length);
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
});
