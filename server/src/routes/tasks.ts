import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { orgOf } from '../auth/plugin.js';
import type { JobStore, TaskListFilters, TaskState } from '../db/job-store-read-model.js';
import { decodeCursor, type TaskCursorFilters } from '../db/task-summary.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, guard, repoReason } from './helpers.js';

export interface TaskRouteDeps {
    /** The per-org runtimes; the board a request reads is the CALLER's org's. */
    orgs: OrgRegistry;
}

/**
 * The task list is the read model of the board's threads — what a task INBOX renders, as opposed
 * to `GET /api/jobs`, the run list the audit views and the driver operations are built on. One
 * summary per conversation, the newest run's present tense, org-wide navigation counts, and
 * keyset pagination that survives follow-ups landing between polls.
 */

const TASK_STATES: readonly TaskState[] = ['attention', 'running', 'review', 'past'];
const SORTS = ['newest', 'oldest'] as const;

/** The page size bounds: a nav-sized window, not the run list's. */
const TASK_LIMIT_DEFAULT = 30;
const TASK_LIMIT_MAX = 50;

/** A search is one line of a task prompt, not an essay. */
const QUERY_MAX = 200;
/** A GitHub login's shape and bound — the author filter matches the root author's login. */
const AUTHOR_MAX = 100;
const AUTHOR_SHAPE = /^[A-Za-z0-9-]+$/;

const isText = (value: unknown): value is string => typeof value === 'string';

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
    isText(value) && (allowed as readonly string[]).includes(value) ? (value as T) : null;

const HTTP_OK = 200;
const HTTP_UNAVAILABLE = 503;

/** One field's refusal — the shape `bad()` wants, carried through the parse chain below. */
interface QueryError {
    code: string;
    message: string;
}

const isQueryError = (value: unknown): value is QueryError =>
    typeof value === 'object' && value !== null && 'code' in value && 'message' in value;

function parseState(query: Record<string, unknown>): TaskState | QueryError {
    if (query.state === undefined) return 'attention';
    const state = oneOf(query.state, TASK_STATES);
    if (state === null) return { code: 'BAD_TASK_STATE', message: `state must be one of ${TASK_STATES.join(', ')}` };
    return state;
}

function parseQ(query: Record<string, unknown>): string | undefined | QueryError {
    if (query.q === undefined) return undefined;
    if (!isText(query.q)) return { code: 'BAD_QUERY', message: 'q must be a string' };
    const q = query.q.trim();
    if (q.length > QUERY_MAX) return { code: 'BAD_QUERY', message: `q must be at most ${QUERY_MAX} characters` };
    return q === '' ? undefined : q;
}

function parseRepo(query: Record<string, unknown>): string | undefined | QueryError {
    if (query.repo === undefined) return undefined;
    if (!isText(query.repo)) return { code: 'BAD_REPO', message: 'repo must be owner/name' };
    const reason = repoReason(query.repo);
    if (reason !== null) return { code: 'BAD_REPO', message: reason };
    return query.repo;
}

function parseAuthor(query: Record<string, unknown>): string | undefined | QueryError {
    if (query.author === undefined) return undefined;
    if (!isText(query.author)) return { code: 'BAD_AUTHOR', message: 'author must be a string' };
    const author = query.author.trim();
    if (author === '') return undefined;
    if (author.length > AUTHOR_MAX || !AUTHOR_SHAPE.test(author)) {
        return {
            code: 'BAD_AUTHOR',
            message: `author must be a login of letters, digits and dashes, at most ${AUTHOR_MAX} characters`,
        };
    }
    // Logins compare case-insensitively; the normalized form is what the store filters by and
    // what the cursor binds.
    return author.toLowerCase();
}

function parseSort(query: Record<string, unknown>): 'newest' | 'oldest' | QueryError {
    if (query.sort === undefined) return 'newest';
    const sort = oneOf(query.sort, SORTS);
    if (sort === null) return { code: 'BAD_SORT', message: 'sort must be newest or oldest' };
    return sort;
}

function parseLimit(query: Record<string, unknown>): number | QueryError {
    const limit = query.limit === undefined ? TASK_LIMIT_DEFAULT : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > TASK_LIMIT_MAX) {
        return { code: 'BAD_LIMIT', message: `limit must be an integer 1..${TASK_LIMIT_MAX}` };
    }
    return limit;
}

/** A cursor is only ever spent under the exact query that minted it — decode against the
 * normalized filters before the store ever sees it. */
function parseCursor(query: Record<string, unknown>, expected: TaskCursorFilters): string | undefined | QueryError {
    if (query.cursor === undefined) return undefined;
    const raw = query.cursor;
    if (!isText(raw) || decodeCursor(raw, expected) === null) {
        return { code: 'BAD_CURSOR', message: 'cursor was not issued by this endpoint for this query' };
    }
    return raw;
}

/**
 * Every `GET /api/tasks` query param, shape-checked and assembled into store-ready filters —
 * pulled out of the route handler so each field's validation stays its own small function.
 */
function parseTaskFilters(
    query: Record<string, unknown>
): { ok: true; filters: TaskListFilters } | { ok: false; error: QueryError } {
    const state = parseState(query);
    if (isQueryError(state)) return { ok: false, error: state };

    const q = parseQ(query);
    if (isQueryError(q)) return { ok: false, error: q };

    const repo = parseRepo(query);
    if (isQueryError(repo)) return { ok: false, error: repo };

    const author = parseAuthor(query);
    if (isQueryError(author)) return { ok: false, error: author };

    const sort = parseSort(query);
    if (isQueryError(sort)) return { ok: false, error: sort };

    const limit = parseLimit(query);
    if (isQueryError(limit)) return { ok: false, error: limit };

    const expected: TaskCursorFilters = {
        sort,
        state,
        ...(q !== undefined && { q }),
        ...(repo !== undefined && { repo }),
        ...(author !== undefined && { author }),
    };
    const cursor = parseCursor(query, expected);
    if (isQueryError(cursor)) return { ok: false, error: cursor };

    return {
        ok: true,
        filters: {
            state,
            sort,
            limit,
            ...(q !== undefined && { q }),
            ...(repo !== undefined && { repo }),
            ...(author !== undefined && { author }),
            ...(cursor !== undefined && { cursor }),
        },
    };
}

export const taskRoutes =
    ({ orgs }: TaskRouteDeps): FastifyPluginAsync =>
    async (app) => {
        const storeOf = async (request: FastifyRequest): Promise<JobStore | null> => {
            const rt = await orgs.for(orgOf(request));
            return rt?.jobs ?? null;
        };

        app.get('/api/tasks', async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', HTTP_UNAVAILABLE);
            // Fastify's query parser hands repeated keys over as an array, so every param is
            // shape-checked before use — a malformed filter is a 400, never a TypeError.
            const query = request.query as Record<string, unknown>;

            const parsed = parseTaskFilters(query);
            if (!parsed.ok) return bad(reply, parsed.error.code, parsed.error.message);

            const tasks = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'task list failed'),
                () => store.listTasks(parsed.filters)
            );
            if (!tasks.ok) return reply;
            return reply.code(HTTP_OK).send(tasks.value);
        });
    };
