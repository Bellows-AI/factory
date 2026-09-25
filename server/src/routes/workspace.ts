import { join } from 'node:path';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_CODES, EXECUTOR_TYPES } from '@factory-ai/core';
import type { ErrorCode } from '@factory-ai/core';
import { callerOf, orgOf } from '../auth/plugin.js';
import { bad, badSegment, body as jsonBody, checkReposVisible, guard } from './helpers.js';
import type { UserExecutor, UserExecutorStore } from '../db/user-executor-store.js';
import type { UserRepoStore } from '../db/user-repo-store.js';
import type { AppConfig, Repo } from '../config.js';
import type { UserRepo } from '../db/user-repo-store.js';
import type { OrgRegistry, OrgRuntime } from '../orgs.js';
import type { FactsCache } from '../workspace/facts.js';
import { ensureUserWorkspace } from '../workspace/provision.js';
import { workspaceDir } from '../workspace/reconcile.js';

const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
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

/**
 * A ceiling on how many executors one person can configure. Like MAX_REPOS_PER_USER, not a policy
 * about what anybody needs — just the bound that keeps one pasted list from growing without limit.
 */
export const MAX_EXECUTORS_PER_USER = 10;

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
 * The authoritative structural validation for a pasted executor list; the client's copy is UX only.
 *
 * No field-level schema inside `config` for now: the contract is "raw JSON the member pastes", and
 * deepening validation belongs to the day an actual consumer exists and can be wrong about the
 * fields. The route guards shape; 012's check constraints guard the row.
 */
function parseExecutors(raw: unknown): ExecutorEntry[] | string {
    const list = jsonBody(raw).executors;
    if (!Array.isArray(list)) return 'executors must be an array of { name, type, config }';
    if (list.length > MAX_EXECUTORS_PER_USER) {
        return `at most ${MAX_EXECUTORS_PER_USER} executors can be configured at once`;
    }
    const parsed: ExecutorEntry[] = [];
    for (const entry of list) {
        const item = entry as { name?: unknown; type?: unknown; config?: unknown; isDefault?: unknown };
        if (typeof item?.name !== 'string' || typeof item?.type !== 'string') {
            return 'each entry must be { name: string, type: string, config: object }';
        }
        if (typeof item.config !== 'object' || item.config === null || Array.isArray(item.config)) {
            return `config for "${item.name}" must be a JSON object`;
        }
        if (!(EXECUTOR_TYPES as readonly string[]).includes(item.type)) {
            return `unknown executor type "${item.type}" (known: ${EXECUTOR_TYPES.join(', ')})`;
        }
        if (item.isDefault !== undefined && typeof item.isDefault !== 'boolean') {
            return `isDefault for "${item.name}" must be a boolean`;
        }
        parsed.push({
            name: item.name,
            type: item.type,
            config: item.config as Record<string, unknown>,
            isDefault: item.isDefault ?? false,
        });
    }
    return parsed;
}

type ExecutorEntry = { name: string; type: string; config: Record<string, unknown>; isDefault: boolean };

type WorkspaceRuntime =
    | {
          userRepos: UserRepoStore;
          userExecutors: UserExecutorStore | undefined;
          repos: OrgRuntime['repos'];
          cloneQueue: OrgRuntime['cloneQueue'];
      }
    | { error: string; code: string; status: number };

/** The caller's org runtime, or the reason a route cannot serve them. */
async function runtimeOf(orgs: OrgRegistry, request: Parameters<typeof callerOf>[0]): Promise<WorkspaceRuntime> {
    const rt = await orgs.for(orgOf(request));
    if (!rt?.userRepos) {
        return {
            error: 'No workspace store for this organization',
            code: ERROR_CODES.WORKSPACE_UNAVAILABLE,
            status: HTTP_UNAVAILABLE,
        };
    }
    return {
        userRepos: rt.userRepos,
        userExecutors: rt.userExecutors,
        repos: rt.repos,
        cloneQueue: rt.cloneQueue,
    };
}

interface WorkspaceDeps {
    root: string | null;
    orgs: OrgRegistry;
    facts: FactsCache;
}

function describeRepo(deps: WorkspaceDeps, orgId: string, userId: string, row: UserRepo) {
    // Only a `ready` checkout has anything on disk to read. Asking about one that is still cloning
    // would walk a half-written tree and report a size that means nothing.
    const onDisk =
        deps.root && row.status === 'ready'
            ? deps.facts.get(join(workspaceDir(deps.root, orgId, userId), row.name))
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
        let code: ErrorCode = ERROR_CODES.BAD_BODY;
        if (list.startsWith('at most')) code = ERROR_CODES.TOO_MANY_EXECUTORS;
        else if (list.startsWith('unknown executor type')) code = ERROR_CODES.BAD_EXECUTOR_TYPE;
        return { ok: false, code, message: list };
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
    // Same argument, for the partial unique index 040 puts on `is_default`: a body naming two
    // defaults would otherwise surface as that index's violation, a 503 for a 400 the client
    // could have avoided by construction.
    if (list.filter((executor) => executor.isDefault).length > 1) {
        return { ok: false, code: ERROR_CODES.BAD_BODY, message: 'only one executor can be the default' };
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
    if (!root) return reply.code(HTTP_OK).send({ root: null, repos: [], orphaned: [], executors: [] });

    const rt = await runtimeOf(deps.orgs, request);
    if ('error' in rt) return bad(reply, rt.code, rt.error, rt.status);
    const { userRepos: store, userExecutors: executors } = rt;

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
            return Promise.all([
                store.list(caller.user.id),
                store.orphaned(caller.user.id),
                executors ? executors.list(caller.user.id) : Promise.resolve([]),
            ]);
        }
    );
    if (!loaded.ok) return reply;

    const [selected, orphaned, executorRows] = loaded.value;
    return reply.code(HTTP_OK).send({
        root: workspaceDir(root, caller.org.id, caller.user.id),
        repos: selected.map((row) => describeRepo(deps, caller.org.id, caller.user.id, row)),
        // Deselected, still on disk, nothing prunes them. Reported so that growth is at least
        // visible on the page rather than only in `df`.
        orphaned: orphaned.map((row) => ({ owner: row.owner, name: row.name })),
        // `config` is deliberately absent from these rows: it may hold credentials the member
        // pasted, and this payload is fetched by a poll that can run every two seconds.
        executors: executorRows.map((row: UserExecutor) => ({
            name: row.name,
            type: row.type,
            createdAt: row.createdAt,
            isDefault: row.isDefault,
        })),
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
        async () => {
            ensureUserWorkspace({
                root,
                orgId: caller.org.id,
                userId: caller.user.id,
                login: caller.user.login,
                githubUserId: caller.user.githubUserId,
            });
            await store.select(caller.user.id, selection);
        }
    );
    if (!saved.ok) return reply;

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
            isDefault: row.isDefault,
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
            isDefault: row.isDefault,
        })),
    });
}

export interface WorkspaceRoutesDeps {
    readonly config: AppConfig;
    /** The per-org runtimes; the stores, repo list and clone queue are the caller's org's. */
    readonly orgs: OrgRegistry;
    readonly facts: FactsCache;
}

export const workspaceRoutes =
    ({ config, orgs, facts }: WorkspaceRoutesDeps): FastifyPluginAsync =>
    async (app) => {
        const deps: WorkspaceDeps = { root: config.workspaceRoot, orgs, facts };

        app.get('/api/workspace', (request, reply) => handleGetWorkspace(deps, request, reply));
        app.put('/api/workspace/repos', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handlePutRepos(deps, request, reply)
        );
        app.get('/api/workspace/executors', (request, reply) => handleGetExecutors(deps, request, reply));
        app.put('/api/workspace/executors', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handlePutExecutors(deps, request, reply)
        );
    };
