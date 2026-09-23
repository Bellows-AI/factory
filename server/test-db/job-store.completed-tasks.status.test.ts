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

describe.skipIf(!enabled)('the terminal list, grouped as one row per task: stop and ordering', () => {
    it("keeps a stopped thread, and serves the thread's done from whichever member carries it", async () => {
        const DONE_MINUTES_AGO = 3;
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
            doneMinutesAgo: DONE_MINUTES_AGO,
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
        expect(Math.abs(minutesAgo(listed[0]!.doneAt!) - DONE_MINUTES_AGO)).toBeLessThan(2);
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
});
