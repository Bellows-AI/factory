import { join } from 'node:path';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_CODES, type ExecutorScope, ORG_SCOPE, USER_SCOPE } from '@factory-ai/core';
import { callerOf } from '../auth/plugin.js';
import { bad, badSegment, body as jsonBody, checkReposVisible, guard } from './helpers.js';
import { handleDeleteRepo, orphansAndTotal, runtimeOf } from './workspace-purge.js';
import { executorFieldRefusal, MAX_EXECUTORS_PER_USER, parseExecutorFields } from './executor-fields.js';
import { ExecutorDefaultNotFoundError, type ExecutorProfile } from '../db/user-executor-store.js';
import type { PurgeConflictError } from '../db/user-repo-store.js';
import type { AppConfig, Repo } from '../config.js';
import type { UserRepo } from '../db/user-repo-store.js';
import type { OrgRegistry } from '../orgs.js';
import type { FactsCache } from '../workspace/facts.js';
import { ensureUserWorkspace } from '../workspace/provision.js';
import { workspaceDir } from '../workspace/reconcile.js';

const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;

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

const BYTES_PER_KIB = 1024;
const BODY_LIMIT_KIB = 64;
const BODY_LIMIT = BODY_LIMIT_KIB * BYTES_PER_KIB;

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
 * One PERSONAL executor entry: the shared fields plus the tamper refusals. The personal PUT writes
 * the caller's own rows and nothing else — an entry claiming an org scope, another owner or the
 * old default flag is refused loudly rather than rewritten (issue 391): scope and ownership are
 * decided by the route, never by the body.
 */
function parseExecutorEntry(entry: unknown): ExecutorEntry | string {
    const item = entry as {
        scope?: unknown;
        userId?: unknown;
        isDefault?: unknown;
        name?: unknown;
    };
    if (item?.scope !== undefined) {
        return 'scope in a personal entry is an organization tamper attempt; organization profiles are managed through /api/org/executors';
    }
    if (item?.userId !== undefined) {
        return 'userId in a personal entry is an ownership tamper attempt';
    }
    if (item?.isDefault !== undefined) {
        return 'isDefault is set through PUT /api/workspace/executors/default, not on the row';
    }
    return parseExecutorFields(entry);
}

/**
 * The authoritative structural validation for a pasted executor list; the client's copy is UX only.
 *
 * No field-level schema inside `config` for now: the contract is "raw JSON the member pastes", and
 * deepening validation belongs to the day an actual consumer exists and can be wrong about the
 * fields. The route guards shape; the check constraints guard the row.
 */
function parseExecutors(raw: unknown): ExecutorEntry[] | string {
    const list = jsonBody(raw).executors;
    if (!Array.isArray(list)) return 'executors must be an array of { name, type, config }';
    if (list.length > MAX_EXECUTORS_PER_USER) {
        return `at most ${MAX_EXECUTORS_PER_USER} executors can be configured at once`;
    }
    const parsed: ExecutorEntry[] = [];
    for (const entry of list) {
        const one = parseExecutorEntry(entry);
        if (typeof one === 'string') return one;
        parsed.push(one);
    }
    return parsed;
}

type ExecutorEntry = {
    name: string;
    type: string;
    config: Record<string, unknown>;
    gateFixRounds: number;
};

interface WorkspaceDeps {
    root: string | null;
    orgs: OrgRegistry;
}

function describeRepo(ctx: { facts: FactsCache; root: string; orgId: string; userId: string }, row: UserRepo) {
    // Only a `ready` checkout has anything on disk to read. Asking about one that is still cloning
    // would walk a half-written tree and report a size that means nothing.
    const dir = join(workspaceDir(ctx.root, ctx.orgId, ctx.userId), row.name);
    const onDisk = row.status === 'ready' ? ctx.facts.get(dir) : null;
    return {
        owner: row.owner,
        name: row.name,
        status: row.status,
        error: row.error,
        selectedAt: row.selectedAt,
        readyAt: row.readyAt,
        ...(onDisk ?? { branch: null, lastCommit: null, sizeBytes: null }),
    };
}

/** `selection`'s per-repo name-shape and cross-entry conflict checks, in one place. */
function validateRepoSelection(
    raw: unknown
): { ok: true; value: Repo[] } | { ok: false; code: string; message: string } {
    const selection = parseSelection(raw);
    if (typeof selection === 'string') {
        return {
            ok: false,
            code: selection.startsWith('at most') ? ERROR_CODES.TOO_MANY_REPOS : ERROR_CODES.BAD_BODY,
            message: selection,
        };
    }
    for (const repo of selection) {
        const reason = badName(repo);
        if (reason) {
            return {
                ok: false,
                code: ERROR_CODES.BAD_REPO_NAME,
                message: `"${repo.owner}/${repo.name}" cannot become a directory: ${reason}`,
            };
        }
    }
    // The checkout directory is the bare repo name, so two owners' same-named repositories are one
    // directory. Refused here by name rather than discovered as a unique-index violation, which
    // would surface as a 503.
    const byName = new Map<string, string>();
    for (const repo of selection) {
        const first = byName.get(repo.name);
        if (first) {
            return {
                ok: false,
                code: ERROR_CODES.REPO_NAME_CONFLICT,
                message: `"${first}/${repo.name}" and "${repo.owner}/${repo.name}" share the checkout directory "${repo.name}"`,
            };
        }
        byName.set(repo.name, repo.owner);
    }
    return { ok: true, value: selection };
}

/** `list`'s per-entry name-shape and duplicate-name checks, in one place. */
function validateExecutorList(
    raw: unknown
): { ok: true; value: ExecutorEntry[] } | { ok: false; code: string; message: string } {
    const list = parseExecutors(raw);
    if (typeof list === 'string') {
        return { ok: false, code: executorFieldRefusal(list), message: list };
    }
    for (const executor of list) {
        const reason = badSegment('name', executor.name);
        if (reason) {
            return {
                ok: false,
                code: ERROR_CODES.BAD_EXECUTOR_NAME,
                message: `"${executor.name}" cannot be used as an executor name: ${reason}`,
            };
        }
    }
    // A duplicate name in one body would otherwise surface as a primary-key violation, which the
    // member would see as a 503.
    const names = new Set(list.map((executor) => executor.name));
    if (names.size !== list.length) {
        return { ok: false, code: ERROR_CODES.EXECUTOR_NAME_CONFLICT, message: 'executor names must be unique' };
    }
    return { ok: true, value: list };
}

const NO_EXECUTOR_STORE = {
    error: 'No executor store is configured for this deployment',
    code: ERROR_CODES.UNAVAILABLE,
};

async function handleGetWorkspace(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);

    const { root } = deps;
    // 200 with a null root, never a 503. "Workspaces are switched off" is a configuration an
    // operator chose, and the page renders a sentence about it rather than an error.
    if (!root) {
        return reply.code(HTTP_OK).send({
            root: null,
            repos: [],
            orphaned: [],
            executors: [],
            orgExecutors: [],
            defaultExecutor: null,
            checkoutTotalBytes: null,
        });
    }

    const rt = await runtimeOf(deps.orgs, request);
    if ('error' in rt) return bad(reply, rt.code, rt.error, rt.status);
    const { userRepos: store, userExecutors: executors, facts } = rt;

    const loaded = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async () => {
            // Idempotent, and not redundant with the call in the sign-in callback: it covers
            // AUTH_MODE=none, whose caller never passes through that callback, and every session
            // that predates this deploy.
            ensureUserWorkspace({
                root,
                orgId: caller.org.id,
                userId: caller.user.id,
                login: caller.user.login,
                githubUserId: caller.user.githubUserId,
            });
            return executors
                ? Promise.all([
                      store.list(caller.user.id),
                      store.orphaned(caller.user.id),
                      executors.list(caller.user.id),
                      executors.listOrg(),
                      executors.resolvedDefault(caller.user.id),
                  ])
                : Promise.all([
                      store.list(caller.user.id),
                      store.orphaned(caller.user.id),
                      Promise.resolve([] as ExecutorProfile[]),
                      Promise.resolve([] as ExecutorProfile[]),
                      Promise.resolve(null),
                  ]);
        }
    );
    if (!loaded.ok) return reply;

    const [selected, orphanedRows, executorRows, orgExecutorRows, defaultExecutor] = loaded.value;
    const userDir = workspaceDir(root, caller.org.id, caller.user.id);
    const { orphaned, checkoutTotalBytes } = orphansAndTotal(facts, userDir, selected, orphanedRows);

    return reply.code(HTTP_OK).send({
        root: userDir,
        repos: selected.map((row) => describeRepo({ facts, root, orgId: caller.org.id, userId: caller.user.id }, row)),
        // Deselected, still on disk, and now measurable — with a delete that actually reclaims.
        orphaned,
        checkoutTotalBytes,
        // `config` is deliberately absent from these rows: it may hold credentials the member
        // pasted, and this payload is fetched by a poll that can run every two seconds. The org
        // rows are selection metadata for the same reason — their configuration answers to the
        // admin list, never to the poll every member's browser runs.
        executors: executorRows.map((row: ExecutorProfile) => ({
            name: row.name,
            type: row.type,
            createdAt: row.createdAt,
            gateFixRounds: row.gateFixRounds,
        })),
        orgExecutors: orgExecutorRows.map((row: ExecutorProfile) => ({
            name: row.name,
            type: row.type,
            createdAt: row.createdAt,
        })),
        // The member's resolved default: their stored preference while it still resolves, else the
        // deterministic fallback the store computes — what a new task draft autoselects.
        defaultExecutor,
    });
}

async function handlePutRepos(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    const { root } = deps;
    if (!root) {
        return bad(
            reply,
            ERROR_CODES.WORKSPACE_DISABLED,
            'This deployment has no workspace root configured',
            HTTP_CONFLICT
        );
    }
    const rt = await runtimeOf(deps.orgs, request);
    if ('error' in rt) return bad(reply, rt.code, rt.error, rt.status);
    const { userRepos: store, repos, cloneQueue: queue } = rt;

    const parsedSelection = validateRepoSelection(request.body);
    if (!parsedSelection.ok) return bad(reply, parsedSelection.code, parsedSelection.message);
    const { value: selection } = parsedSelection;

    /*
     * Every selected repo must be one the installation can actually see.
     *
     * Not a formality: the clone uses the App's installation token, so a repository outside the
     * installation is one this deployment has no business fetching — and accepting the name would
     * write a row that fails on every retry with a 404.
     */
    const visible = await checkReposVisible(repos, selection, { subject: 'the selection' });
    if (!visible.ok) return bad(reply, visible.code, visible.message, visible.status);

    const saved = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async (): Promise<string[] | null> => {
            ensureUserWorkspace({
                root,
                orgId: caller.org.id,
                userId: caller.user.id,
                login: caller.user.login,
                githubUserId: caller.user.githubUserId,
            });
            try {
                await store.select(caller.user.id, selection);
            } catch (error) {
                // A checkout stamped `purging` cannot be re-selected underneath its deletion. Not
                // a 503: the refusal IS the answer, and it names the offending checkouts.
                if ((error as Error).name === 'PurgeConflictError') {
                    return (error as PurgeConflictError).names;
                }
                throw error;
            }
            return null;
        }
    );
    if (!saved.ok) return reply;
    if (saved.value) {
        return bad(
            reply,
            ERROR_CODES.PURGE_IN_PROGRESS,
            `"${saved.value.join(', ')}" is being deleted from disk — wait for the deletion to finish`,
            HTTP_CONFLICT
        );
    }

    // 202, and the clones run in the background: a clone is minutes, and a request that waited for
    // one would be killed by any proxy in front of it long before it finished.
    queue?.kick();
    return reply.code(HTTP_ACCEPTED).send({ repos: selection });
}

// The edit dialog's opening read: the member's own rows, config included. The poll on
// GET /api/workspace never carries configs — they may hold credentials and that payload is
// fetched every few seconds — so this on-demand read is the one place a client gets them back,
// once per dialog open rather than on a poll.
async function handleGetExecutors(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    if (!deps.root) {
        return bad(
            reply,
            ERROR_CODES.WORKSPACE_DISABLED,
            'This deployment has no workspace root configured',
            HTTP_CONFLICT
        );
    }
    const rt = await runtimeOf(deps.orgs, request);
    if ('error' in rt) return bad(reply, rt.code, rt.error, rt.status);
    const { userExecutors: executors } = rt;
    if (!executors) return reply.code(HTTP_UNAVAILABLE).send(NO_EXECUTOR_STORE);

    const loaded = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => executors.listWithConfigs(caller.user.id)
    );
    if (!loaded.ok) return reply;

    return reply.code(HTTP_OK).send({
        executors: loaded.value.map((row) => ({
            name: row.name,
            type: row.type,
            createdAt: row.createdAt,
            gateFixRounds: row.gateFixRounds,
            config: row.config,
        })),
    });
}

// PUT, whole-list replace — the same idiom as the repos route above. The body is the entire list,
// so replaying it after a dropped connection changes nothing.
async function handlePutExecutors(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    if (!deps.root) {
        return bad(
            reply,
            ERROR_CODES.WORKSPACE_DISABLED,
            'This deployment has no workspace root configured',
            HTTP_CONFLICT
        );
    }
    const rt = await runtimeOf(deps.orgs, request);
    if ('error' in rt) return bad(reply, rt.code, rt.error, rt.status);
    const { userExecutors: executors } = rt;
    if (!executors) return reply.code(HTTP_UNAVAILABLE).send(NO_EXECUTOR_STORE);

    const parsed = validateExecutorList(request.body);
    if (!parsed.ok) return bad(reply, parsed.code, parsed.message);
    const { value: list } = parsed;

    const saved = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async () => {
            await executors.replace(caller.user.id, list);
            // Answered from the store, not echoed from the body: created_at is the database's.
            return executors.list(caller.user.id);
        }
    );
    if (!saved.ok) return reply;

    // 200, not 202: unlike the repos route nothing runs in the background — the rows are written
    // by the time this returns.
    return reply.code(HTTP_OK).send({
        executors: saved.value.map((row) => ({
            name: row.name,
            type: row.type,
            createdAt: row.createdAt,
            gateFixRounds: row.gateFixRounds,
        })),
    });
}

/**
 * The member's default-executor preference (issue 391): names a profile by scope and name, either
 * scope, without touching the shared profile or anyone else's default. The store refuses a
 * preference naming no accessible profile, which is this route's 404 — a selection the caller
 * cannot resolve is not a default they can hold.
 */
async function handlePutDefaultExecutor(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    if (!deps.root) {
        return bad(
            reply,
            ERROR_CODES.WORKSPACE_DISABLED,
            'This deployment has no workspace root configured',
            HTTP_CONFLICT
        );
    }
    const rt = await runtimeOf(deps.orgs, request);
    if ('error' in rt) return bad(reply, rt.code, rt.error, rt.status);
    const { userExecutors: executors } = rt;
    if (!executors) return reply.code(HTTP_UNAVAILABLE).send(NO_EXECUTOR_STORE);

    const fields = jsonBody(request.body);
    const name = fields.executor;
    const scope = fields.executorScope;
    if (typeof name !== 'string' || !name) return bad(reply, ERROR_CODES.BAD_BODY, 'executor must be a string');
    if (scope !== USER_SCOPE && scope !== ORG_SCOPE) {
        return bad(reply, ERROR_CODES.BAD_EXECUTOR_SCOPE, `executorScope must be one of: ${USER_SCOPE}, ${ORG_SCOPE}`);
    }

    // Not under `guard`: a preference naming no accessible profile is a 404 answer, not a
    // failure — the store throws the typed refusal, this route names it; anything else is a real
    // failure and reaches the error handler as one.
    try {
        await executors.setDefault(caller.user.id, { scope: scope as ExecutorScope, name });
    } catch (error) {
        if (!(error instanceof ExecutorDefaultNotFoundError)) throw error;
        return bad(
            reply,
            ERROR_CODES.NOT_FOUND,
            `no ${scope} executor named "${name}" is available to you`,
            HTTP_NOT_FOUND
        );
    }
    return reply.code(HTTP_OK).send({ defaultExecutor: { scope, name } });
}

export interface WorkspaceRoutesDeps {
    readonly config: AppConfig;
    /** The per-org runtimes; the stores, repo list, clone queue, purge service and facts cache are the caller's org's. */
    readonly orgs: OrgRegistry;
}

export const workspaceRoutes =
    ({ config, orgs }: WorkspaceRoutesDeps): FastifyPluginAsync =>
    async (app) => {
        const deps: WorkspaceDeps = { root: config.workspaceRoot, orgs };

        app.get('/api/workspace', (request, reply) => handleGetWorkspace(deps, request, reply));
        app.put('/api/workspace/repos', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handlePutRepos(deps, request, reply)
        );
        app.delete('/api/workspace/repos/:owner/:name', (request, reply) => handleDeleteRepo(deps, request, reply));
        app.get('/api/workspace/executors', (request, reply) => handleGetExecutors(deps, request, reply));
        app.put('/api/workspace/executors', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handlePutExecutors(deps, request, reply)
        );
        app.put('/api/workspace/executors/default', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handlePutDefaultExecutor(deps, request, reply)
        );
    };
