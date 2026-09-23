import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-read-model.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
/** A second store on the same pool, bound to a different org. Only the org guard uses it. */
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
    otherOrgStore = createJobStore({ sql, orgId: OTHER_ORG });
});

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

describe.skipIf(!enabled)('the terminal list, grouped as one row per task: bounds and filters', () => {
    it('bounds tasks, not runs', async () => {
        const THREAD_COUNT = 3;
        const ROOT_FINISHED_BASE_MINUTES_AGO = 55;
        const FOLLOW_UP_CREATED_BASE_MINUTES_AGO = 58;
        const FOLLOW_UP_FINISHED_BASE_MINUTES_AGO = 53;
        for (let thread = 0; thread < THREAD_COUNT; thread++) {
            const root = await craft({
                status: 'succeeded',
                createdMinutesAgo: 60 - thread * 10,
                finishedMinutesAgo: ROOT_FINISHED_BASE_MINUTES_AGO - thread * 10,
                command: `thread ${thread}`,
            });
            await craft({
                parent: root,
                status: 'succeeded',
                createdMinutesAgo: FOLLOW_UP_CREATED_BASE_MINUTES_AGO - thread * 10,
                finishedMinutesAgo: FOLLOW_UP_FINISHED_BASE_MINUTES_AGO - thread * 10,
            });
        }

        expect(await store.list({ status: 'terminal', limit: 2 })).toHaveLength(2);
        expect(await store.list({ status: 'terminal', limit: THREAD_COUNT })).toHaveLength(THREAD_COUNT);
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
        const LEASE_SECONDS = 300;
        const root = await craft({ status: 'succeeded', finishedMinutesAgo: 20 });
        const other = await otherOrgStore.create('other org task', null, { repo: null, executor: null });
        const claim = await otherOrgStore.claim('w1', LEASE_SECONDS);
        await otherOrgStore.complete(other.id, claim!.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: null,
        });

        const listed = await store.list({ status: 'terminal', limit: 10 });
        expect(listed.map((task) => task.id)).toEqual([root]);
    });
});
