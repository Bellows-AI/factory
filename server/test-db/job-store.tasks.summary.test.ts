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
    otherOrgStore = createJobStore({ sql, orgId: OTHER_ORG });
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

describe.skipIf(!enabled)('listTasks: organization-wide summary', () => {
    it('keeps counts and previews organization-wide while the page obeys the filters', async () => {
        const RUNNING_STARTED_MINUTES_AGO = 59;
        await craft({
            status: 'running',
            createdMinutesAgo: 60,
            startedMinutesAgo: RUNNING_STARTED_MINUTES_AGO,
            repo: 'acme/one',
        });
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
        expect(Math.abs(minutesAgo(navigation.running[0]!.activityAt) - RUNNING_STARTED_MINUTES_AGO)).toBeLessThan(2);
        expect(page.items.map((task) => task.repo)).toEqual(['acme/two']);
    });

    it('never mixes another organization into counts, previews, page or search', async () => {
        await craft({ status: 'running', createdMinutesAgo: 60, startedMinutesAgo: 59, command: 'mine running' });
        await craft({ status: 'succeeded', createdMinutesAgo: 50, finishedMinutesAgo: 45, command: 'mine review' });

        const LEASE_SECONDS = 300;
        const other = await otherOrgStore.create('theirs', null, { repo: null, executor: null });
        const claim = await otherOrgStore.claim('w1', LEASE_SECONDS);
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
