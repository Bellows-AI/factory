import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { orgOf } from '../auth/plugin.js';
import type { JobStore, TaskCursorPosition, TaskListFilters, TaskSort, TaskState } from '../db/job-store.js';
import type { OrgRegistry } from '../orgs.js';
import { UUID, bad, guard, repoReason } from './helpers.js';

export interface TaskRouteDeps {
    /** The per-org runtimes; the store a request touches is the CALLER's org's. */
    orgs: OrgRegistry;
}

/** The page size bounds — a poll asks for one page, never the whole org. */
const TASK_LIMIT_DEFAULT = 30;
const TASK_LIMIT_MAX = 50;
const TASK_QUERY_MAX = 200;
const TASK_AUTHOR_MAX = 100;
/** A login shape, not a people-directory lookup: the member's own filter text. */
const TASK_AUTHOR_SHAPE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,98}[a-zA-Z0-9])?$/;

const TASK_STATES: readonly TaskState[] = ['attention', 'running', 'review', 'past'];
const TASK_SORTS: readonly TaskSort[] = ['newest', 'oldest'];

/**
 * The cursor payload, bound to everything that would silently change what "after this row" means:
 * its version, the sort, and the normalized filters. A cursor is opaque to the client and decode
 * refuses anything that does not match the request it arrived with.
 */
interface TaskCursorPayload {
    v: 1;
    sort: TaskSort;
    state: TaskState;
    q: string | null;
    repo: string | null;
    author: string | null;
    activityAt: string;
    rootId: string;
}

/** Opaque to the client: base64url JSON the route itself issued. */
export const encodeTaskCursor = (payload: TaskCursorPayload): string =>
    Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

/**
 * Decodes a cursor that must belong to THIS endpoint's question — same version, same sort, same
 * normalized filters. Anything else (a malformed encoding, a foreign payload, a cursor carried
 * over from a different view) is refused as a whole, never partially honored: the page would
 * silently skip or repeat rows. Null means "not a cursor for this query".
 */
export const decodeTaskCursor = (
    raw: string,
    expected: Pick<TaskCursorPayload, 'sort' | 'state' | 'q' | 'repo' | 'author'>
): TaskCursorPosition | null => {
    try {
        const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null) return null;
        const payload = parsed as Record<string, unknown>;
        if (payload.v !== 1) return null;
        if (payload.sort !== expected.sort) return null;
        if (payload.state !== expected.state) return null;
        if (payload.q !== expected.q || payload.repo !== expected.repo || payload.author !== expected.author) {
            return null;
        }
        const { activityAt, rootId } = payload;
        if (typeof activityAt !== 'string' || !Number.isFinite(Date.parse(activityAt))) return null;
        if (typeof rootId !== 'string' || !UUID.test(rootId)) return null;
        return { activityAt, rootId };
    } catch {
        return null;
    }
};

/** One query parameter, shape-checked: Fastify hands repeated keys over as arrays. */
const single = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The task-summary read for people: one row per thread root with head semantics, org-wide
 * navigation that never moves with the filters, and a keyset-paginated page. The same
 * authentication as every other human job read — the session cookie, a personal token or a
 * read-only org token; the shared worker secret is refused by the hook, because the driver has
 * no business pulling a human's inbox. The org comes from the credential, never the query.
 */
export const taskRoutes =
    ({ orgs }: TaskRouteDeps): FastifyPluginAsync =>
    async (app) => {
        const storeOf = async (request: FastifyRequest): Promise<JobStore | null> => {
            const rt = await orgs.for(orgOf(request));
            return rt?.jobs ?? null;
        };

        app.get('/api/tasks', async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const query = request.query as Record<string, unknown>;

            const rawState = single(query.state) ?? 'attention';
            if (!TASK_STATES.includes(rawState as TaskState)) {
                return bad(reply, 'BAD_TASK_STATE', `state must be one of ${TASK_STATES.join(', ')}`);
            }
            const rawQ = single(query.q);
            const q = rawQ === null ? null : rawQ.trim() || null;
            if (q !== null && q.length > TASK_QUERY_MAX) {
                return bad(reply, 'BAD_QUERY', `q exceeds ${TASK_QUERY_MAX} characters`);
            }
            const rawRepo = single(query.repo);
            const repo = rawRepo === null || rawRepo === '' ? null : rawRepo;
            if (repo !== null && repoReason(repo) !== null) {
                return bad(reply, 'BAD_REPO', repoReason(repo) ?? 'repo must be owner/name');
            }
            const rawAuthor = single(query.author);
            const author = rawAuthor === null || rawAuthor.trim() === '' ? null : rawAuthor.trim();
            if (author !== null && (author.length > TASK_AUTHOR_MAX || !TASK_AUTHOR_SHAPE.test(author))) {
                return bad(reply, 'BAD_AUTHOR', 'author must be a login of at most 100 characters');
            }
            const rawSort = single(query.sort) ?? 'newest';
            if (!TASK_SORTS.includes(rawSort as TaskSort)) {
                return bad(reply, 'BAD_SORT', `sort must be one of ${TASK_SORTS.join(', ')}`);
            }
            const rawLimit = single(query.limit);
            const limit = rawLimit === null ? TASK_LIMIT_DEFAULT : Number(rawLimit);
            if (!Number.isInteger(limit) || limit < 1 || limit > TASK_LIMIT_MAX) {
                return bad(reply, 'BAD_LIMIT', `limit must be an integer 1..${TASK_LIMIT_MAX}`);
            }

            const expected = { sort: rawSort as TaskSort, state: rawState as TaskState, q, repo, author };
            const rawCursor = single(query.cursor);
            const cursor = rawCursor === null ? null : decodeTaskCursor(rawCursor, expected);
            if (rawCursor !== null && cursor === null) {
                return bad(reply, 'BAD_CURSOR', 'cursor does not belong to this query');
            }

            const filters: TaskListFilters = {
                state: expected.state,
                q,
                repo,
                author,
                sort: expected.sort,
                limit,
                cursor,
            };
            const listed = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'task list failed'),
                () => store.listTasks(filters)
            );
            if (!listed.ok) return reply;
            const { navigation, page } = listed.value;
            return reply.code(200).send({
                navigation,
                page: {
                    items: page.items,
                    nextCursor:
                        page.nextCursor === null ? null : encodeTaskCursor({ v: 1, ...expected, ...page.nextCursor }),
                },
            });
        });
    };
