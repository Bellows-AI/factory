import {
    ENV_NAME,
    ENV_NAME_LIMIT,
    ENV_VALUE_LIMIT,
    MAX_ENV_VARS_PER_SCOPE,
    RESERVED_ENV_NAMES,
} from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import { bad, badSegment, body as jsonBody, guard } from './helpers.js';
import type { EnvVarEntry, EnvVarStore } from '../db/env-var-store.js';
import { fullName, type AppConfig, type Repo } from '../config.js';
import type { OrgRegistry, OrgRuntime } from '../orgs.js';

/**
 * Environment variables and secrets for runners, in three stacked scopes — org ("core") <
 * workspace < repository — configured here and injected at claim time. Storage and precedence are
 * the env-var-store's; this file is who may write which scope and what shape is accepted.
 *
 * PUT rather than POST because every body is the WHOLE list for its scope — replaying it changes
 * nothing, which is what makes the retry a browser does after a dropped connection safe. The one
 * exception to "the body is the truth" is a secret sent back with `value: null`: that means "keep
 * the stored value", the write-only escape hatch that lets a browser edit a scope without ever
 * seeing — or re-sending — the secrets it holds. An omitted name still deletes.
 */

// The scope cap, reserved names and name/value bounds are core's (core/src/env.ts), shared with
// the web editors.
const BYTES_PER_KIB = 1024;

/** JSON escaping's worst case: up to six bytes per byte of a control character. */
const JSON_ESCAPE_WORST_CASE = 6;
/** What a name/isSecret/structure can roughly cost per entry, beside its value. */
const ENTRY_STRUCTURE_OVERHEAD = 2048;
/** Slack for the JSON envelope itself. */
const BODY_ENVELOPE_SLACK_KIB = 64;

/**
 * The body limit is DERIVED, not guessed: the documented maximum PUT — every variable at the value
 * ceiling — must actually fit, including JSON escaping's worst case plus per-entry structure. A
 * smaller limit here would let fastify's body parser kill a body the validation rules accept with
 * a raw 413 and no code, which is the one failure this constant exists to prevent.
 */
const BODY_LIMIT =
    MAX_ENV_VARS_PER_SCOPE * (ENV_VALUE_LIMIT * JSON_ESCAPE_WORST_CASE + ENTRY_STRUCTURE_OVERHEAD) +
    BODY_ENVELOPE_SLACK_KIB * BYTES_PER_KIB;

/** How much of an over-long name the refusal message quotes back — a name, not a paragraph. */
const NAME_PREVIEW_LIMIT = 16;

/** One entry's structural checks — split out of `parseVars` so each stays under the complexity cap. */
function parseVarEntry(entry: unknown): EnvVarEntry | string {
    const item = entry as { name?: unknown; value?: unknown; isSecret?: unknown };
    if (typeof item?.name !== 'string' || typeof item?.isSecret !== 'boolean') {
        return 'each entry must be { name: string, value: string | null, isSecret: boolean }';
    }
    if (item.name.length > ENV_NAME_LIMIT) {
        return `name "${item.name.slice(0, NAME_PREVIEW_LIMIT)}…" exceeds ${ENV_NAME_LIMIT} characters`;
    }
    if (typeof item.value !== 'string' && item.value !== null) {
        return `value for "${item.name}" must be a string or null`;
    }
    if (!ENV_NAME.test(item.name)) {
        return `"${item.name}" is not a legal environment variable name`;
    }
    if (RESERVED_ENV_NAMES.includes(item.name)) {
        return `"${item.name}" is reserved by the runner`;
    }
    if (item.value !== null && (item.value.length > ENV_VALUE_LIMIT || /[\r\n]/.test(item.value))) {
        return `value for "${item.name}" exceeds the limit or contains a newline`;
    }
    // A null value is the keep-it marker, and only a secret can keep: a readable value always
    // arrives with the body that owns it.
    if (item.value === null && !item.isSecret) {
        return `value for "${item.name}" must be set — only a secret may be left blank`;
    }
    return { name: item.name, value: item.value, isSecret: item.isSecret };
}

/**
 * Structural validation for a vars list; the client's copy is UX only. Returns the list or the
 * reason it was refused — the workspace route's parseExecutors shape.
 */
function parseVars(raw: unknown): EnvVarEntry[] | string {
    const list = jsonBody(raw).vars;
    if (!Array.isArray(list)) return 'vars must be an array of { name, value, isSecret }';
    if (list.length > MAX_ENV_VARS_PER_SCOPE) {
        return `at most ${MAX_ENV_VARS_PER_SCOPE} variables can be configured per scope`;
    }
    const parsed: EnvVarEntry[] = [];
    for (const entry of list) {
        const one = parseVarEntry(entry);
        if (typeof one === 'string') return one;
        parsed.push(one);
    }
    const names = new Set(parsed.map((entry) => entry.name));
    if (names.size !== parsed.length) return 'variable names must be unique within one scope';
    return parsed;
}

function parseRepo(raw: unknown): Repo | string {
    const repo = jsonBody(raw).repo as { owner?: unknown; name?: unknown } | undefined;
    if (!repo || typeof repo.owner !== 'string' || typeof repo.name !== 'string') {
        return 'repo must be { owner: string, name: string }';
    }
    return { owner: repo.owner, name: repo.name };
}

/**
 * The scope becomes a check-constraint key here and a directory-shaped key at the row; the same
 * segment rules a checkout's name obeys, refused with a code rather than discovered as a
 * constraint violation.
 */
function repoSegmentReason(repo: Repo): string | null {
    for (const [label, value] of [
        ['owner', repo.owner],
        ['name', repo.name],
    ] as const) {
        const reason = badSegment(label, value);
        if (reason) return `"${repo.owner}/${repo.name}": ${reason}`;
    }
    return null;
}

/**
 * The same bargain the workspace selection route makes: the scope must be one the installation can
 * actually see, or the row is one this deployment has no business holding.
 */
async function checkRepoVisible(
    repos: OrgRuntime['repos'],
    repo: Repo
): Promise<{ ok: true } | { ok: false; status?: number; code: string; message: string }> {
    const available = new Set((await repos.list()).map(fullName));
    if (!available.size && repos.lastError()) {
        return {
            ok: false,
            status: HTTP_UNAVAILABLE,
            code: 'UNAVAILABLE',
            message: `Cannot check the repository against the GitHub App installation: ${repos.lastError()}`,
        };
    }
    if (!available.has(`${repo.owner}/${repo.name}`)) {
        return {
            ok: false,
            code: 'UNKNOWN_REPO',
            message: `"${repo.owner}/${repo.name}" is not one of the repositories this GitHub App installation can see`,
        };
    }
    return { ok: true };
}

/**
 * Every check the repo-scope PUT applies before it touches the store, in one place so the route
 * handler itself stays a single guard-and-save.
 */
async function validatePutRepoRequest(
    request: FastifyRequest,
    repos: OrgRuntime['repos']
): Promise<
    { ok: true; repo: Repo; vars: EnvVarEntry[] } | { ok: false; code: string; message: string; status?: number }
> {
    const repo = parseRepo(request.body);
    if (typeof repo === 'string') return { ok: false, code: 'BAD_BODY', message: repo };
    const segmentReason = repoSegmentReason(repo);
    if (segmentReason) return { ok: false, code: 'BAD_REPO_NAME', message: segmentReason };
    const vars = parseVars(request.body);
    if (typeof vars === 'string') return { ok: false, code: varsCode(vars), message: vars };
    const visible = await checkRepoVisible(repos, repo);
    if (!visible.ok) return visible;
    return { ok: true, repo, vars };
}

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_UNAVAILABLE = 503;

export interface EnvRoutesDeps {
    readonly config: AppConfig;
    /** The per-org runtimes; the env store and repo list a request touches are the caller's org's. */
    readonly orgs: OrgRegistry;
}

export const envRoutes =
    ({ config: _config, orgs }: EnvRoutesDeps): FastifyPluginAsync =>
    async (app) => {
        /**
         * The caller's org env context, narrowed to what these routes touch — no runtime (no such
         * org) or no store behind it, and there is nothing to serve.
         */
        const runtimeOf = async (
            request: Parameters<typeof callerOf>[0]
        ): Promise<{ envVars: EnvVarStore; repos: OrgRuntime['repos'] } | null> => {
            const rt = await orgs.for(orgOf(request));
            if (!rt?.envVars) return null;
            return { envVars: rt.envVars, repos: rt.repos };
        };

        app.get('/api/env', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', HTTP_UNAUTHORIZED);
            const rt = await runtimeOf(request);
            if (!rt)
                return bad(reply, 'ENV_UNAVAILABLE', 'No environment store for this organization', HTTP_UNAVAILABLE);
            const store = rt.envVars;

            const loaded = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                async () => {
                    // Secret values are nulled in the SELECT — for admins too. The page renders "set"
                    // from isSecret; no caller ever reads one back.
                    return Promise.all([store.listOrg(), store.listWorkspace(caller.user.id), store.listRepos()]);
                }
            );
            if (!loaded.ok) return reply;

            return reply.code(HTTP_OK).send({
                org: loaded.value[0],
                workspace: loaded.value[1],
                repos: loaded.value[2],
            });
        });

        // The "Core secrets" scope: one list for the whole organization. Written by any member —
        // installation access is membership, and there are no roles above member to gate it with.
        app.put('/api/env/org', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', HTTP_UNAUTHORIZED);
            const rt = await runtimeOf(request);
            if (!rt)
                return bad(reply, 'ENV_UNAVAILABLE', 'No environment store for this organization', HTTP_UNAVAILABLE);
            const store = rt.envVars;

            const vars = parseVars(request.body);
            if (typeof vars === 'string') {
                return bad(reply, varsCode(vars), vars);
            }

            const saved = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                async () => {
                    await store.replaceOrg(vars);
                    return store.listOrg();
                }
            );
            if (!saved.ok) return reply;
            return reply.code(HTTP_OK).send({ vars: saved.value });
        });

        // The caller's own scope. Any member may write it — it is their runners' environment.
        app.put('/api/env/workspace', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', HTTP_UNAUTHORIZED);
            const rt = await runtimeOf(request);
            if (!rt)
                return bad(reply, 'ENV_UNAVAILABLE', 'No environment store for this organization', HTTP_UNAVAILABLE);
            const store = rt.envVars;

            const vars = parseVars(request.body);
            if (typeof vars === 'string') {
                return bad(reply, varsCode(vars), vars);
            }

            const saved = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                async () => {
                    await store.replaceWorkspace(caller.user.id, vars);
                    return store.listWorkspace(caller.user.id);
                }
            );
            if (!saved.ok) return reply;
            return reply.code(HTTP_OK).send({ vars: saved.value });
        });

        // Org-wide per-repository scope: one configuration per repository, applied to every
        // member's runs in it — the GitHub Actions precedent.
        app.put('/api/env/repo', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', HTTP_UNAUTHORIZED);
            const rt = await runtimeOf(request);
            if (!rt)
                return bad(reply, 'ENV_UNAVAILABLE', 'No environment store for this organization', HTTP_UNAVAILABLE);
            const store = rt.envVars;

            const parsed = await validatePutRepoRequest(request, rt.repos);
            if (!parsed.ok) return bad(reply, parsed.code, parsed.message, parsed.status);
            const { repo, vars } = parsed;

            const saved = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                async () => {
                    await store.replaceRepo(repo.owner, repo.name, vars);
                    return store.listRepo(repo.owner, repo.name);
                }
            );
            if (!saved.ok) return reply;
            return reply.code(HTTP_OK).send({ vars: saved.value });
        });
    };

/** The refusal code for a parseVars reason, in one place so the codes stay honest. */
function varsCode(reason: string): string {
    if (reason.startsWith('at most')) return 'TOO_MANY_ENV_VARS';
    if (reason.includes('exceeds the limit or contains a newline')) return 'BAD_ENV_VALUE';
    if (reason.includes('exceeds 255 characters')) return 'BAD_ENV_NAME';
    if (reason.endsWith('is not a legal environment variable name')) return 'BAD_ENV_NAME';
    if (reason.endsWith('is reserved by the runner')) return 'RESERVED_ENV_NAME';
    if (reason.includes('only a secret may be left blank')) return 'BAD_VALUE';
    if (reason.startsWith('variable names must be unique')) return 'ENV_NAME_CONFLICT';
    return 'BAD_BODY';
}
