import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { orgOf } from '../auth/plugin.js';
import type { JobStore, TaskListFilters, TaskState } from '../db/job-store.js';
import { decodeCursor, type TaskCursorFilters } from '../db/task-summary.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, guard } from './helpers.js';
import { repoReason } from './jobs.js';

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
            // Fastify's query parser hands repeated keys over as an array, so every param is
            // shape-checked before use — a malformed filter is a 400, never a TypeError.
            const query = request.query as Record<string, unknown>;

            const state: TaskState | null = query.state === undefined ? 'attention' : oneOf(query.state, TASK_STATES);
            if (state === null) {
                return bad(reply, 'BAD_TASK_STATE', `state must be one of ${TASK_STATES.join(', ')}`);
            }

            let q: string | undefined;
            if (query.q !== undefined) {
                if (!isText(query.q)) return bad(reply, 'BAD_QUERY', 'q must be a string');
                q = query.q.trim();
                if (q.length > QUERY_MAX) {
                    return bad(reply, 'BAD_QUERY', `q must be at most ${QUERY_MAX} characters`);
                }
                if (q === '') q = undefined;
            }

            let repo: string | undefined;
            if (query.repo !== undefined) {
                if (!isText(query.repo)) return bad(reply, 'BAD_REPO', 'repo must be owner/name');
                const reason = repoReason(query.repo);
                if (reason !== null) return bad(reply, 'BAD_REPO', reason);
                repo = query.repo;
            }

            let author: string | undefined;
            if (query.author !== undefined) {
                if (!isText(query.author)) return bad(reply, 'BAD_AUTHOR', 'author must be a string');
                author = query.author.trim();
                if (author === '') {
                    author = undefined;
                } else if (author.length > AUTHOR_MAX || !AUTHOR_SHAPE.test(author)) {
                    return bad(
                        reply,
                        'BAD_AUTHOR',
                        `author must be a login of letters, digits and dashes, at most ${AUTHOR_MAX} characters`
                    );
                } else {
                    // Logins compare case-insensitively; the normalized form is what the store
                    // filters by and what the cursor binds.
                    author = author.toLowerCase();
                }
            }

            const sort = query.sort === undefined ? 'newest' : oneOf(query.sort, SORTS);
            if (sort === null) return bad(reply, 'BAD_SORT', 'sort must be newest or oldest');

            const limit = query.limit === undefined ? TASK_LIMIT_DEFAULT : Number(query.limit);
            if (!Number.isInteger(limit) || limit < 1 || limit > TASK_LIMIT_MAX) {
                return bad(reply, 'BAD_LIMIT', `limit must be an integer 1..${TASK_LIMIT_MAX}`);
            }

            let cursor: string | undefined;
            if (query.cursor !== undefined) {
                // A cursor is only ever spent under the exact query that minted it — decode
                // against the normalized filters before the store ever sees it.
                const expected: TaskCursorFilters = {
                    sort,
                    state,
                    ...(q !== undefined && { q }),
                    ...(repo !== undefined && { repo }),
                    ...(author !== undefined && { author }),
                };
                const raw = query.cursor;
                if (!isText(raw) || decodeCursor(raw, expected) === null) {
                    return bad(reply, 'BAD_CURSOR', 'cursor was not issued by this endpoint for this query');
                }
                cursor = raw;
            }

            const filters: TaskListFilters = {
                state,
                sort,
                limit,
                ...(q !== undefined && { q }),
                ...(repo !== undefined && { repo }),
                ...(author !== undefined && { author }),
                ...(cursor !== undefined && { cursor }),
            };

            const tasks = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'task list failed'),
                () => store.listTasks(filters)
            );
            if (!tasks.ok) return reply;
            return reply.code(200).send(tasks.value);
        });
    };
