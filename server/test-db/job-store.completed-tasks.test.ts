import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { createJobStore, type JobStore } from '../src/db/job-store.js';

const url = process.env.DATABASE_URL;

/** Same guard as the sibling suites: these tests truncate, so they refuse a non-test database. */
function assertTestDatabase(raw: string): void {
    const name = new URL(raw).pathname.replace(/^\//, '');
    if (!/_test$/.test(name)) {
        throw new Error(`Refusing to run: this suite truncates its tables, and "${name}" is not a test database.`);
    }
}

const enabled = Boolean(url);
if (url) assertTestDatabase(url);

let sql: Sql;
let store: JobStore;
/** A second store on the same pool, bound to a different org. Only the org guard uses it. */
let otherOrgStore: JobStore;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();

let AUTHOR: string;

/** Written directly rather than through the auth store, like the sibling suites. */
const account = async (githubUserId: number, login: string): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
        insert into app_user (github_user_id, github_login) values (${githubUserId}, ${login})
        on conflict (github_user_id) do update set github_login = excluded.github_login
        returning id
    `;
    return row!.id;
};

beforeAll(async () => {
    if (!enabled) return;
    sql = postgres(url as string, { max: 8 });
    await migrate(sql, { orgId: ORG, attempts: 3 });
    AUTHOR = await account(Number.parseInt(randomUUID().slice(0, 8), 16), 'completed-tasks-cat');
    store = createJobStore({ sql, orgId: ORG });
    otherOrgStore = createJobStore({ sql, orgId: OTHER_ORG });
});

afterAll(async () => {
    if (enabled) await sql.end();
});

beforeEach(async () => {
    if (!enabled) return;
    await sql`truncate job, task_reclaim`;
});

/** How long ago an ISO stamp reads, in minutes — for asserting backdated times without sleeping. */
const minutesAgo = (iso: string): number => (Date.now() - Date.parse(iso)) / 60_000;

/**
 * Writes a job row in whatever state the case needs, straight SQL — the `craft` helper of the
 * wall-clock suite, extended with the fields the grouped terminal read rolls up: summary,
 * finished_at, done_at (with the actor) and the runtime vitals. `parent` chains a follow-up;
 * `root` overrides the thread root for rows whose parent is not the root itself.
 */
const craft = async (
    shape: {
        root?: string;
        parent?: string | null;
        status?: 'queued' | 'running' | 'standby' | 'succeeded' | 'failed' | 'dead' | 'stopped';
        command?: string;
        createdMinutesAgo?: number;
        finishedMinutesAgo?: number;
        wallClockMs?: number;
        summary?: string;
        doneMinutesAgo?: number;
        stoppedBy?: boolean;
        runtime?: Record<string, unknown>;
        repo?: string;
    } = {}
): Promise<string> => {
    const id = randomUUID();
    await sql`
        insert into job (org_id, id, command, status, parent_job_id, root_job_id, created_by, repo, stopped_by,
                         lease_expires_at, created_at, finished_at, wall_clock_ms, summary, done_at, done_by, runtime)
        values (
            ${ORG}, ${id}, ${shape.command ?? 'crafted'},
            ${shape.status ?? 'queued'},
            ${shape.parent ?? null},
            ${shape.root ?? shape.parent ?? id},
            ${AUTHOR},
            ${shape.repo ?? 'acme/widgets'},
            ${shape.stoppedBy === true ? AUTHOR : null},
            now() - interval '1 second',
            now() - (${shape.createdMinutesAgo ?? 0} * interval '1 minute'),
            ${
                shape.finishedMinutesAgo === undefined
                    ? null
                    : sql`now() - (${shape.finishedMinutesAgo} * interval '1 minute')`
            },
            ${shape.wallClockMs ?? null},
            ${shape.summary ?? null},
            ${shape.doneMinutesAgo === undefined ? null : sql`now() - (${shape.doneMinutesAgo} * interval '1 minute')`},
            ${shape.doneMinutesAgo === undefined ? null : AUTHOR},
            ${shape.runtime === undefined ? null : sql.json(shape.runtime as never)}
        )
    `;
    return id;
};

describe.skipIf(!enabled)('the terminal list, grouped as one row per task', () => {
    it('answers one row for a root-only task, carrying its own figures', async () => {
        const root = await craft({
            status: 'succeeded',
            wallClockMs: 60_000,
            finishedMinutesAgo: 5,
            summary: 'did the thing',
        });

        const listed = await store.list({ status: 'terminal', limit: 10 });
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
            id: root,
            rootJobId: root,
            followUpTo: null,
            status: 'succeeded',
            summary: 'did the thing',
            wallClockMs: 60_000,
            taskWallClockMs: 60_000,
        });
        expect(listed[0]?.finishedAt).not.toBeNull();
    });

    it('folds a thread of N runs into one row: identity from the root, state from the head, clock from the thread', async () => {
        const root = await craft({
            status: 'succeeded',
            command: 'the opening ask',
            createdMinutesAgo: 60,
            finishedMinutesAgo: 50,
            wallClockMs: 60_000,
            summary: 'root words',
            runtime: { contextTokens: 111, activity: null, sampledAt: '' },
        });
        await craft({
            parent: root,
            status: 'failed',
            createdMinutesAgo: 40,
            finishedMinutesAgo: 30,
            wallClockMs: 30_000,
            summary: 'middle words',
            runtime: { contextTokens: 222, activity: null, sampledAt: '' },
        });
        await craft({
            parent: root,
            status: 'succeeded',
            createdMinutesAgo: 20,
            finishedMinutesAgo: 10,
            wallClockMs: 10_000,
            summary: 'last words',
            runtime: { contextTokens: 4242, activity: null, sampledAt: '' },
        });

        const listed = await store.list({ status: 'terminal', limit: 10 });
        expect(listed).toHaveLength(1);
        const task = listed[0]!;
        // Identity is the ROOT's: the task's stable id, its opening ask, its author.
        expect(task.id).toBe(root);
        expect(task.rootJobId).toBe(root);
        expect(task.followUpTo).toBeNull();
        expect(task.command).toBe('the opening ask');
        expect(task.author?.login).toBe('completed-tasks-cat');
        expect(Math.abs(minutesAgo(task.createdAt) - 60)).toBeLessThan(2);
        // State is the HEAD's: the conversation's present tense.
        expect(task.status).toBe('succeeded');
        expect(task.summary).toBe('last words');
        expect(task.runtime).toMatchObject({ contextTokens: 4242 });
        // The clock is the THREAD's — the figure the task view's head clock shows.
        expect(task.taskWallClockMs).toBe(100_000);
        // The head's own banked clock rides the per-run field, unchanged in meaning.
        expect(task.wallClockMs).toBe(10_000);
        // Completion is the thread's newest: the head's finish stamp here.
        expect(Math.abs(minutesAgo(task.finishedAt!) - 10)).toBeLessThan(2);
    });

    it("takes the summary from the head run, null included — the fallback is the panel's job", async () => {
        const withWords = await craft({
            status: 'succeeded',
            createdMinutesAgo: 40,
            finishedMinutesAgo: 35,
            summary: 'root words',
        });
        await craft({ parent: withWords, status: 'succeeded', createdMinutesAgo: 10, finishedMinutesAgo: 5 });

        const withoutWords = await craft({
            status: 'succeeded',
            createdMinutesAgo: 38,
            finishedMinutesAgo: 34,
        });
        await craft({
            parent: withoutWords,
            status: 'succeeded',
            createdMinutesAgo: 9,
            finishedMinutesAgo: 4,
            summary: 'head words',
        });

        const listed = await store.list({ status: 'terminal', limit: 10 });
        expect(listed.map((task) => task.id)).toEqual([withoutWords, withWords]);
        expect(listed[0]?.summary).toBe('head words');
        expect(listed[1]?.summary).toBeNull();
    });

    it('excludes a thread whose follow-up is still queued, running or parked', async () => {
        for (const moving of ['queued', 'running', 'standby'] as const) {
            const root = await craft({ status: 'succeeded', finishedMinutesAgo: 30 });
            await craft({ parent: root, status: moving, createdMinutesAgo: 5 });

            const listed = await store.list({ status: 'terminal', limit: 10 });
            expect(listed.map((task) => task.id)).not.toContain(root);
        }
    });

    it("keeps a stopped thread, and serves the thread's done from whichever member carries it", async () => {
        const stopped = await craft({ status: 'stopped', finishedMinutesAgo: 20 });
        const done = await craft({
            status: 'succeeded',
            createdMinutesAgo: 20,
            finishedMinutesAgo: 15,
        });
        await craft({
            parent: done,
            status: 'failed',
            createdMinutesAgo: 10,
            finishedMinutesAgo: 5,
            doneMinutesAgo: 3,
        });
        // A stop that landed on the FOLLOW-UP: the head carries the verdict and its actor —
        // the stopper join aims at the head's stopped_by, not the root row's.
        const stoppedLate = await craft({
            status: 'succeeded',
            createdMinutesAgo: 30,
            finishedMinutesAgo: 25,
        });
        await craft({
            parent: stoppedLate,
            status: 'stopped',
            createdMinutesAgo: 12,
            finishedMinutesAgo: 8,
            stoppedBy: true,
        });

        const listed = await store.list({ status: 'terminal', limit: 10 });
        expect(listed.map((task) => task.id)).toEqual([done, stoppedLate, stopped]);
        expect(listed[0]?.status).toBe('failed');
        expect(listed[0]?.doneAt).not.toBeNull();
        expect(Math.abs(minutesAgo(listed[0]!.doneAt!) - 3)).toBeLessThan(2);
        expect(listed[0]?.doneBy?.login).toBe('completed-tasks-cat');
        expect(listed[1]?.status).toBe('stopped');
        expect(listed[1]?.stoppedBy?.login).toBe('completed-tasks-cat');
        expect(listed[2]?.status).toBe('stopped');
        expect(listed[2]?.doneAt).toBeNull();
    });

    it("orders by each thread's newest completion, not by any member's", async () => {
        const older = await craft({
            status: 'succeeded',
            createdMinutesAgo: 60,
            finishedMinutesAgo: 30,
        });
        await craft({ parent: older, status: 'succeeded', createdMinutesAgo: 50, finishedMinutesAgo: 20 });
        const newer = await craft({
            status: 'succeeded',
            createdMinutesAgo: 40,
            finishedMinutesAgo: 5,
        });

        const listed = await store.list({ status: 'terminal', limit: 10 });
        expect(listed.map((task) => task.id)).toEqual([newer, older]);
    });

    it("serves the thread's max finished_at even when the head run is not the last to finish", async () => {
        // A branched thread: the head is the newest-CREATED member, but an older sibling finished
        // after it. The row's Finished column is the task's — the max.
        const root = await craft({
            status: 'succeeded',
            createdMinutesAgo: 70,
            finishedMinutesAgo: 65,
        });
        await craft({ parent: root, status: 'succeeded', createdMinutesAgo: 60, finishedMinutesAgo: 10 });
        await craft({ parent: root, status: 'stopped', createdMinutesAgo: 50, finishedMinutesAgo: 55 });

        const listed = await store.list({ status: 'terminal', limit: 10 });
        expect(listed).toHaveLength(1);
        expect(listed[0]?.status).toBe('stopped');
        expect(Math.abs(minutesAgo(listed[0]!.finishedAt!) - 10)).toBeLessThan(2);
    });

    it('bounds tasks, not runs', async () => {
        for (let thread = 0; thread < 3; thread++) {
            const root = await craft({
                status: 'succeeded',
                createdMinutesAgo: 60 - thread * 10,
                finishedMinutesAgo: 55 - thread * 10,
                command: `thread ${thread}`,
            });
            await craft({
                parent: root,
                status: 'succeeded',
                createdMinutesAgo: 58 - thread * 10,
                finishedMinutesAgo: 53 - thread * 10,
            });
        }

        expect(await store.list({ status: 'terminal', limit: 2 })).toHaveLength(2);
        expect(await store.list({ status: 'terminal', limit: 3 })).toHaveLength(3);
    });

    it('answers null where nothing was ever banked — never zero', async () => {
        const root = await craft({ status: 'stopped', finishedMinutesAgo: 20 });
        await craft({ parent: root, status: 'succeeded', createdMinutesAgo: 10, finishedMinutesAgo: 5 });

        const listed = await store.list({ status: 'terminal', limit: 10 });
        expect(listed).toHaveLength(1);
        expect(listed[0]?.taskWallClockMs).toBeNull();
        expect(listed[0]?.wallClockMs).toBeNull();
    });

    it("groups the repo filter by thread under the root's label", async () => {
        const widgets = await craft({ status: 'succeeded', finishedMinutesAgo: 20, repo: 'acme/widgets' });
        await craft({ parent: widgets, status: 'succeeded', createdMinutesAgo: 10, finishedMinutesAgo: 5 });
        await craft({ status: 'succeeded', finishedMinutesAgo: 15, repo: 'acme/other' });
        await craft({ status: 'succeeded', finishedMinutesAgo: 1, repo: 'acme/widgets' });

        const listed = await store.list({ status: 'terminal', repo: 'acme/widgets', limit: 10 });
        expect(listed).toHaveLength(2);
        expect(listed.every((task) => task.repo === 'acme/widgets')).toBe(true);
        expect(await store.list({ status: 'terminal', repo: 'acme/other', limit: 10 })).toHaveLength(1);
    });

    it("keeps another organization's tasks out", async () => {
        const root = await craft({ status: 'succeeded', finishedMinutesAgo: 20 });
        const other = await otherOrgStore.create('other org task', null, { repo: null, executor: null });
        const claim = await otherOrgStore.claim('w1', 300);
        await otherOrgStore.complete(other.id, claim!.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: null,
        });

        const listed = await store.list({ status: 'terminal', limit: 10 });
        expect(listed.map((task) => task.id)).toEqual([root]);
    });
});

describe.skipIf(!enabled)('the terminal list query shape', () => {
    // The store's sql is a tagged template, so a Proxy around it records the raw statement
    // text — every \u0000 below marks one interpolated value — without touching the bytes
    // that reach the database. The shape is the fix for #128's review note: the work the
    // query does per thread must not grow with retained history when the caller asks for 30.
    it('rolls the clock and completion up inside the terminality scan and binds the limit before head and actor resolution', async () => {
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

        await recordingStore.list({ status: 'terminal', limit: 30 });

        const query = captured.find((q) => q.strings[0]?.includes('finished_thread'));
        expect(query).toBeDefined();
        const text = query!.strings.join('\u0000');
        const limitIndex = query!.values.findIndex((value) => typeof value === 'number');
        expect(limitIndex).toBeGreaterThan(-1);
        const limitPos = query!.strings.slice(0, limitIndex).join('').length + limitIndex;
        const groupByPos = text.indexOf('group by root_job_id');
        expect(groupByPos).toBeGreaterThan(-1);
        // The clock and completion aggregates are computed by the same scan that establishes
        // terminality — one read of retained history — not by a second per-thread pass over it.
        expect(text.search(/sum\((\w+\.)?wall_clock_ms\)/)).toBeLessThan(groupByPos);
        expect(text.search(/max\((\w+\.)?done_at\)/)).toBeLessThan(groupByPos);
        expect(text.search(/max\((\w+\.)?finished_at\)/)).toBeLessThan(groupByPos);
        // The limit binds to those aggregate rows, so the per-thread head resolution (and the
        // actor joins after it) run for the selected tasks alone, never once per kept thread.
        expect(limitPos).toBeLessThan(text.indexOf(') head on true'));
    });
});
