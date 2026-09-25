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
        status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'stopped';
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

describe.skipIf(!enabled)('listTasks: filters', () => {
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
});
