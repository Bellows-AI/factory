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
const UUID_HEX_SLICE_LENGTH = 8;
const HEX_RADIX = 16;
const AUTHOR_GITHUB_ID = Number.parseInt(randomUUID().slice(0, UUID_HEX_SLICE_LENGTH), HEX_RADIX);

const db = useTestDb({
    max: 8,
    users: [{ id: AUTHOR, githubUserId: AUTHOR_GITHUB_ID, login: 'tasks-cat' }],
});

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

const MS_PER_MINUTE = 60_000;

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

describe.skipIf(!enabled)('listTasks: ordering and pagination', () => {
    it('orders by head activity, the id descending on an exactly equal stamp', async () => {
        // Two roots whose heads carry the SAME absolute stamps: the id descending breaks the tie.
        // One literal shared by both crafts — two Date.now() calls could straddle a millisecond.
        const TIE_MINUTES_AGO = 30;
        const tieStamp = new Date(Date.now() - TIE_MINUTES_AGO * MS_PER_MINUTE).toISOString();
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
        const TIE_MINUTES_AGO = 45;
        const stamp = new Date(Date.now() - TIE_MINUTES_AGO * MS_PER_MINUTE).toISOString();
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
        const RUN_COUNT = 7;
        const BASE_CREATED_MINUTES_AGO = 100;
        const BASE_STARTED_MINUTES_AGO = 99;
        for (let i = 0; i < RUN_COUNT; i++) {
            await craft({
                status: 'running',
                createdMinutesAgo: BASE_CREATED_MINUTES_AGO - i,
                startedMinutesAgo: BASE_STARTED_MINUTES_AGO - i,
            });
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
        expect(seen).toHaveLength(RUN_COUNT);
        expect(new Set(seen).size).toBe(RUN_COUNT);
    });

    it('paginates oldest first under its own cursor direction', async () => {
        const RUN_COUNT = 5;
        const BASE_CREATED_MINUTES_AGO = 100;
        const BASE_STARTED_MINUTES_AGO = 99;
        for (let i = 0; i < RUN_COUNT; i++) {
            await craft({
                status: 'running',
                createdMinutesAgo: BASE_CREATED_MINUTES_AGO - i,
                startedMinutesAgo: BASE_STARTED_MINUTES_AGO - i,
            });
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
        expect(seen).toHaveLength(RUN_COUNT);
        expect(new Set(seen).size).toBe(RUN_COUNT);
        // The first page really is the oldest end.
        const first = await store.listTasks({ state: 'running', sort: 'oldest', limit: 1 });
        expect(seen[0]).toBe(first.page.items[0]!.id);
    });
});
