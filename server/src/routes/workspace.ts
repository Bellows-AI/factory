import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { EXECUTOR_TYPES } from '@factory-ai/core';
import { callerOf } from '../auth/plugin.js';
import { bad, badSegment, body as jsonBody, guard } from './helpers.js';
import type { UserExecutor, UserExecutorStore } from '../db/user-executor-store.js';
import { fullName, type AppConfig, type Repo } from '../config.js';
import type { UserRepo, UserRepoStore } from '../db/user-repo-store.js';
import type { RepoSource } from '../github/repo-source.js';
import type { FactsCache } from '../workspace/facts.js';
import type { CloneQueue } from '../workspace/queue.js';
import { ensureUserWorkspace } from '../workspace/provision.js';
import { workspaceDir } from '../workspace/reconcile.js';

/**
 * A member's checkouts: what they picked, where each clone got to, and what is on disk.
 *
 * `PUT` rather than `POST` because the body is the WHOLE selection — replaying it changes nothing,
 * which is what makes the retry a browser does after a dropped connection safe.
 */

/**
 * A ceiling on how many repositories one person can check out.
 *
 * docs/workspace.md already admits that nothing prunes and that disk growth is unbounded and
 * unmonitored. Per-member checkouts multiply that by the number of members, so this is the one
 * bound there is — not a policy about what anybody needs, just a limit that keeps a single click
 * from cloning an entire GitHub organization onto a shared volume.
 */
export const MAX_REPOS_PER_USER = 20;

/**
 * A ceiling on how many executors one person can configure. Like MAX_REPOS_PER_USER, not a policy
 * about what anybody needs — just the bound that keeps one pasted list from growing without limit.
 */
export const MAX_EXECUTORS_PER_USER = 10;

const BODY_LIMIT = 64 * 1024;

/**
 * The path-segment rules live in `routes/helpers.ts`, shared with the jobs route, which validates
 * the repo label of a queued task the same way this file validates a checkout's name.
 */

function badName(repo: Repo): string | null {
    for (const [label, value] of [
        ['owner', repo.owner],
        ['name', repo.name],
    ] as const) {
        const reason = badSegment(label, value);
        if (reason) return reason;
    }
    return null;
}

function parseSelection(raw: unknown): Repo[] | string {
    const repos = jsonBody(raw).repos;
    if (!Array.isArray(repos)) return 'repos must be an array of { owner, name }';
    if (repos.length > MAX_REPOS_PER_USER) {
        return `at most ${MAX_REPOS_PER_USER} repositories can be checked out at once`;
    }
    const parsed: Repo[] = [];
    for (const entry of repos) {
        const item = entry as { owner?: unknown; name?: unknown };
        if (typeof item?.owner !== 'string' || typeof item?.name !== 'string') {
            return 'each entry must be { owner: string, name: string }';
        }
        parsed.push({ owner: item.owner, name: item.name });
    }
    return parsed;
}

/**
 * The authoritative structural validation for a pasted executor list; the client's copy is UX only.
 *
 * No field-level schema inside `config` for now: the contract is "raw JSON the member pastes", and
 * deepening validation belongs to the day an actual consumer exists and can be wrong about the
 * fields. The route guards shape; 012's check constraints guard the row.
 */
function parseExecutors(raw: unknown): { name: string; type: string; config: Record<string, unknown> }[] | string {
    const list = jsonBody(raw).executors;
    if (!Array.isArray(list)) return 'executors must be an array of { name, type, config }';
    if (list.length > MAX_EXECUTORS_PER_USER) {
        return `at most ${MAX_EXECUTORS_PER_USER} executors can be configured at once`;
    }
    const parsed: { name: string; type: string; config: Record<string, unknown> }[] = [];
    for (const entry of list) {
        const item = entry as { name?: unknown; type?: unknown; config?: unknown };
        if (typeof item?.name !== 'string' || typeof item?.type !== 'string') {
            return 'each entry must be { name: string, type: string, config: object }';
        }
        if (
            typeof item.config !== 'object' ||
            item.config === null ||
            Array.isArray(item.config)
        ) {
            return `config for "${item.name}" must be a JSON object`;
        }
        if (!(EXECUTOR_TYPES as readonly string[]).includes(item.type)) {
            return `unknown executor type "${item.type}" (known: ${EXECUTOR_TYPES.join(', ')})`;
        }
        parsed.push({ name: item.name, type: item.type, config: item.config as Record<string, unknown> });
    }
    return parsed;
}

export interface WorkspaceRoutesDeps {
    readonly config: AppConfig;
    readonly store: UserRepoStore;
    /** Null in the same configurations queue is: a store is always built in index.ts. */
    readonly executors: UserExecutorStore | null;
    readonly repos: RepoSource;
    readonly facts: FactsCache;
    readonly queue: CloneQueue | null;
}

export const workspaceRoutes =
    ({ config, store, executors, repos, facts, queue }: WorkspaceRoutesDeps): FastifyPluginAsync =>
    async (app) => {
        const root = config.workspaceRoot;

        const describe = (userId: string, row: UserRepo) => {
            // Only a `ready` checkout has anything on disk to read. Asking about one that is still
            // cloning would walk a half-written tree and report a size that means nothing.
            const onDisk =
                root && row.status === 'ready'
                    ? facts.get(join(workspaceDir(root, config.orgId, userId), row.name))
                    : { branch: null, lastCommit: null, sizeBytes: null };
            return {
                owner: row.owner,
                name: row.name,
                status: row.status,
                error: row.error,
                selectedAt: row.selectedAt,
                readyAt: row.readyAt,
                ...onDisk,
            };
        };

        app.get('/api/workspace', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);

            // 200 with a null root, never a 503. "Workspaces are switched off" is a configuration an
            // operator chose, and the page renders a sentence about it rather than an error.
            if (!root) return reply.code(200).send({ root: null, repos: [], orphaned: [], executors: [] });

            const loaded = await guard(reply, (e) => request.log.error({ err: e }), async () => {
                // Idempotent, and not redundant with the call in the sign-in callback: it covers
                // AUTH_MODE=none, whose caller never passes through that callback, and every
                // session that predates this deploy.
                ensureUserWorkspace({
                    root,
                    orgId: config.orgId,
                    userId: caller.user.id,
                    login: caller.user.login,
                    githubUserId: caller.user.githubUserId,
                });
                return Promise.all([
                    store.list(caller.user.id),
                    store.orphaned(caller.user.id),
                    executors ? executors.list(caller.user.id) : Promise.resolve([]),
                ]);
            });
            if (!loaded.ok) return reply;

            const [selected, orphaned, executorRows] = loaded.value;
            return reply.code(200).send({
                root: workspaceDir(root, config.orgId, caller.user.id),
                repos: selected.map((row) => describe(caller.user.id, row)),
                // Deselected, still on disk, nothing prunes them. Reported so that growth is at
                // least visible on the page rather than only in `df`.
                orphaned: orphaned.map((row) => ({ owner: row.owner, name: row.name })),
                // `config` is deliberately absent from these rows: it may hold credentials the
                // member pasted, and this payload is fetched by a poll that can run every two
                // seconds.
                executors: executorRows.map((row: UserExecutor) => ({
                    name: row.name,
                    type: row.type,
                    createdAt: row.createdAt,
                })),
            });
        });

        app.put('/api/workspace/repos', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);
            if (!root) {
                return bad(reply, 'WORKSPACE_DISABLED', 'This deployment has no workspace root configured', 409);
            }

            const selection = parseSelection(request.body);
            if (typeof selection === 'string') {
                const code = selection.startsWith('at most') ? 'TOO_MANY_REPOS' : 'BAD_BODY';
                return bad(reply, code, selection);
            }

            for (const repo of selection) {
                const reason = badName(repo);
                if (reason) {
                    return bad(
                        reply,
                        'BAD_REPO_NAME',
                        `"${repo.owner}/${repo.name}" cannot become a directory: ${reason}`,
                    );
                }
            }

            // The checkout directory is the bare repo name, so two owners' same-named repositories
            // are one directory. Refused here by name rather than discovered as a unique-index
            // violation, which would surface as a 503.
            const byName = new Map<string, string>();
            for (const repo of selection) {
                const first = byName.get(repo.name);
                if (first) {
                    return bad(
                        reply,
                        'REPO_NAME_CONFLICT',
                        `"${first}/${repo.name}" and "${repo.owner}/${repo.name}" share the checkout directory "${repo.name}"`,
                    );
                }
                byName.set(repo.name, repo.owner);
            }

            /*
             * Every selected repo must be one the installation can actually see.
             *
             * Not a formality: the clone uses the App's installation token, so a repository outside
             * the installation is one this deployment has no business fetching — and accepting the
             * name would write a row that fails on every retry with a 404.
             */
            const available = new Set((await repos.list()).map(fullName));
            // An unreachable installation is refused rather than waved through. The list is empty
            // in two very different situations — nothing is installed, or GitHub could not be
            // asked — and only the first is a state in which "no repository matches" is true.
            if (!available.size && repos.lastError()) {
                return reply.code(503).send({
                    error: `Cannot check the selection against the GitHub App installation: ${repos.lastError()}`,
                    code: 'UNAVAILABLE',
                });
            }
            for (const repo of selection) {
                if (available.has(`${repo.owner}/${repo.name}`)) continue;
                return bad(
                    reply,
                    'UNKNOWN_REPO',
                    `"${repo.owner}/${repo.name}" is not one of the repositories this GitHub App installation can see`,
                );
            }

            const saved = await guard(reply, (e) => request.log.error({ err: e }), async () => {
                ensureUserWorkspace({
                    root,
                    orgId: config.orgId,
                    userId: caller.user.id,
                    login: caller.user.login,
                    githubUserId: caller.user.githubUserId,
                });
                await store.select(caller.user.id, selection);
            });
            if (!saved.ok) return reply;

            // 202, and the clones run in the background: a clone is minutes, and a request that
            // waited for one would be killed by any proxy in front of it long before it finished.
            queue?.kick();
            return reply.code(202).send({ repos: selection });
        });

        // PUT, whole-list replace — the same idiom as the repos route above. The body is the entire
        // list, so replaying it after a dropped connection changes nothing.
        app.put('/api/workspace/executors', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);
            if (!root) {
                return bad(reply, 'WORKSPACE_DISABLED', 'This deployment has no workspace root configured', 409);
            }
            if (!executors) {
                return reply.code(503).send({
                    error: 'No executor store is configured for this deployment',
                    code: 'UNAVAILABLE',
                });
            }

            const list = parseExecutors(request.body);
            if (typeof list === 'string') {
                let code = 'BAD_BODY';
                if (list.startsWith('at most')) code = 'TOO_MANY_EXECUTORS';
                else if (list.startsWith('unknown executor type')) code = 'BAD_EXECUTOR_TYPE';
                return bad(reply, code, list);
            }

            for (const executor of list) {
                const reason = badSegment('name', executor.name);
                if (reason) {
                    return bad(
                        reply,
                        'BAD_EXECUTOR_NAME',
                        `"${executor.name}" cannot be used as an executor name: ${reason}`,
                    );
                }
            }

            // A duplicate name in one body would otherwise surface as a primary-key violation,
            // which the member would see as a 503.
            const names = new Set(list.map((executor) => executor.name));
            if (names.size !== list.length) {
                return bad(reply, 'EXECUTOR_NAME_CONFLICT', 'executor names must be unique');
            }

            const saved = await guard(reply, (e) => request.log.error({ err: e }), async () => {
                await executors.replace(caller.user.id, list);
                // Answered from the store, not echoed from the body: created_at is the database's.
                return executors.list(caller.user.id);
            });
            if (!saved.ok) return reply;

            // 200, not 202: unlike the repos route nothing runs in the background — the rows are
            // written by the time this returns.
            return reply.code(200).send({
                executors: saved.value.map((row) => ({
                    name: row.name,
                    type: row.type,
                    createdAt: row.createdAt,
                })),
            });
        });
    };
