import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;

const ORG = randomUUID();

/**
 * The jobs' author. A generated identity, never a literal: integration tests do not hardcode ids,
 * and a random one cannot collide with a real backfilled user the way a memorable constant
 * eventually would. Re-planted before every test, because `created_by` is a uuid foreign key.
 */
const AUTHOR = randomUUID();
/** Turns a slice of a uuid into a plausible github id — hex digits, parsed as base 16. */
const HEX_RADIX = 16;
const UUID_HEX_SLICE_LENGTH = 8;
const AUTHOR_GITHUB_ID = Number.parseInt(randomUUID().slice(0, UUID_HEX_SLICE_LENGTH), HEX_RADIX);

const db = useTestDb({
    max: 8,
    users: [{ id: AUTHOR, githubUserId: AUTHOR_GITHUB_ID, login: 'completed-tasks-cat' }],
});

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

const MS_PER_MINUTE = 60_000;

/** How long ago an ISO stamp reads, in minutes — for asserting backdated times without sleeping. */
const minutesAgo = (iso: string): number => (Date.now() - Date.parse(iso)) / MS_PER_MINUTE;

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
        status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'stopped';
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
        const EXPECTED_TASK_WALL_CLOCK_MS = 100_000;
        expect(task.taskWallClockMs).toBe(EXPECTED_TASK_WALL_CLOCK_MS);
        // The head's own banked clock rides the per-run field, unchanged in meaning.
        const EXPECTED_HEAD_WALL_CLOCK_MS = 10_000;
        expect(task.wallClockMs).toBe(EXPECTED_HEAD_WALL_CLOCK_MS);
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

    it('excludes a thread whose follow-up is still queued or running', async () => {
        for (const moving of ['queued', 'running'] as const) {
            const root = await craft({ status: 'succeeded', finishedMinutesAgo: 30 });
            await craft({ parent: root, status: moving, createdMinutesAgo: 5 });

            const listed = await store.list({ status: 'terminal', limit: 10 });
            expect(listed.map((task) => task.id)).not.toContain(root);
        }
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
