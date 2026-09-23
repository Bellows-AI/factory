import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-read-model.js';
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

describe.skipIf(!enabled)('listTasks: reachability at scale', () => {
    it('reaches every root past fifty interleaved runs — the old web window is not the world', async () => {
        // 26 threads x 2 runs = 52 job rows. Ordered by recency the oldest ROOT lands outside the
        // newest-50 window GET /api/jobs serves — and every task must still be reachable here.
        const THREAD_COUNT = 26;
        const ROOT_CREATED_BASE_MINUTES_AGO = 200;
        const ROOT_FINISHED_BASE_MINUTES_AGO = 199;
        const ROOT_DONE_BASE_MINUTES_AGO = 198;
        const FOLLOW_UP_CREATED_BASE_MINUTES_AGO = 199;
        const FOLLOW_UP_FINISHED_BASE_MINUTES_AGO = 198;
        const FOLLOW_UP_DONE_BASE_MINUTES_AGO = 197;
        for (let thread = 0; thread < THREAD_COUNT; thread++) {
            const root = await craft({
                status: 'succeeded',
                createdMinutesAgo: ROOT_CREATED_BASE_MINUTES_AGO - thread * 2,
                finishedMinutesAgo: ROOT_FINISHED_BASE_MINUTES_AGO - thread * 2,
                doneMinutesAgo: ROOT_DONE_BASE_MINUTES_AGO - thread * 2,
            });
            await craft({
                parent: root,
                status: 'succeeded',
                createdMinutesAgo: FOLLOW_UP_CREATED_BASE_MINUTES_AGO - thread * 2,
                finishedMinutesAgo: FOLLOW_UP_FINISHED_BASE_MINUTES_AGO - thread * 2,
                doneMinutesAgo: FOLLOW_UP_DONE_BASE_MINUTES_AGO - thread * 2,
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
        expect(seen).toHaveLength(THREAD_COUNT);
        expect(new Set(seen).size).toBe(THREAD_COUNT);
    });
});
