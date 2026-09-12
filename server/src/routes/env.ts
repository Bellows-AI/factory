import type { FastifyPluginAsync } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import { bad, badSegment, body as jsonBody, guard } from './helpers.js';
import type { EnvVarEntry, EnvVarStore } from '../db/env-var-store.js';
import { fullName, type Repo } from '../config.js';
import type { RepoSource } from '../github/repo-source.js';

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

/** A bound on one scope's list, like MAX_EXECUTORS_PER_USER: a ceiling, not a policy. */
export const MAX_ENV_VARS_PER_SCOPE = 100;

/**
 * The names the driver's own contract with the runner claims. A claim env named WORKDIR would be
 * two different paths to one runner's working directory; TRUST_WORKDIR is how a Remote Control
 * runner is told its checkout is trusted; CRED_HELPER is the credential-helper CODE the sync
 * fetch runs — a member value there would be member-controlled code executed by the sync
 * container's git; RESTORE is the sync's restore-mode switch — a member value there would flip
 * starting claims into restore mode, silently skipping the fetch and rebase (issue #58). The
 * three reporter names steer the branch reporter — where it posts, what
 * authenticates it, and which session it claims — and a member value in any of them is a
 * cross-tenant write into the telemetry store. Reserved at the route, restated at the driver
 * (RESERVED_ENV_NAMES in driver/src/docker.ts — copied, not imported, per that package's
 * zero-dependency rule).
 */
export const RESERVED_ENV_NAMES = [
    'WORKDIR',
    'TRUST_WORKDIR',
    'BELLOWS_GATE_URL',
    'BELLOWS_GATE_TOKEN',
    'CRED_HELPER',
    'RESTORE',
    'FACTORY_STATS_URL',
    'INGEST_TOKEN',
    'BELLOWS_SESSION_ID',
] as const;

/**
 * A per-value ceiling. Far past any real variable, and the bound that keeps one value from being
 * an essay. Newlines are refused outright: the driver delivers values in a docker `--env-file`,
 * which is line-structured and has no quoting — a newline would arrive in the runner truncated,
 * with no error anywhere.
 */
const VALUE_LIMIT = 32 * 1024;

/**
 * The body limit is DERIVED, not guessed: the documented maximum PUT — every variable at the value
 * ceiling — must actually fit, including JSON escaping's worst case (six bytes per byte of control
 * character) plus per-entry structure. A smaller limit here would let fastify's body parser kill a
 * body the validation rules accept with a raw 413 and no code, which is the one failure this
 * constant exists to prevent.
 */
const BODY_LIMIT =
    // 6× escaping, the 2048 a name/isSecret/structure can roughly cost per entry, and slack for
    // the JSON envelope itself.
    MAX_ENV_VARS_PER_SCOPE * (VALUE_LIMIT * 6 + 2048) + 64 * 1024;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A per-name ceiling, under the 2048-per-entry structure allowance the BODY_LIMIT arithmetic
 * assumes — and far under the kernel's per-environment-string limit, which a name past it would
 * turn every later `docker run` for this scope into an E2BIG.
 */
const NAME_LIMIT = 255;

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
        const item = entry as { name?: unknown; value?: unknown; isSecret?: unknown };
        if (typeof item?.name !== 'string' || typeof item?.isSecret !== 'boolean') {
            return 'each entry must be { name: string, value: string | null, isSecret: boolean }';
        }
        if (item.name.length > NAME_LIMIT) {
            return `name "${item.name.slice(0, 16)}…" exceeds ${NAME_LIMIT} characters`;
        }
        if (typeof item.value !== 'string' && item.value !== null) {
            return `value for "${item.name}" must be a string or null`;
        }
        if (!ENV_NAME.test(item.name)) {
            return `"${item.name}" is not a legal environment variable name`;
        }
        if ((RESERVED_ENV_NAMES as readonly string[]).includes(item.name)) {
            return `"${item.name}" is reserved by the runner`;
        }
        if (item.value !== null && (item.value.length > VALUE_LIMIT || /[\r\n]/.test(item.value))) {
            return `value for "${item.name}" exceeds the limit or contains a newline`;
        }
        // A null value is the keep-it marker, and only a secret can keep: a readable value always
        // arrives with the body that owns it.
        if (item.value === null && !item.isSecret) {
            return `value for "${item.name}" must be set — only a secret may be left blank`;
        }
        parsed.push({ name: item.name, value: item.value, isSecret: item.isSecret });
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

export interface EnvRoutesDeps {
    readonly store: EnvVarStore;
    readonly repos: RepoSource;
}

export const envRoutes =
    ({ store, repos }: EnvRoutesDeps): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/env', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);

            const loaded = await guard(reply, (e) => request.log.error({ err: e }), async () => {
                // Secret values are nulled in the SELECT — for admins too. The page renders "set"
                // from isSecret; no caller ever reads one back.
                return Promise.all([store.listOrg(), store.listWorkspace(caller.user.id), store.listRepos()]);
            });
            if (!loaded.ok) return reply;

            return reply.code(200).send({
                org: loaded.value[0],
                workspace: loaded.value[1],
                repos: loaded.value[2],
            });
        });

        // The "Core secrets" scope: one list for the whole deployment, admin-written.
        app.put('/api/env/org', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);
            if (caller.role !== 'admin') {
                return bad(reply, 'FORBIDDEN', 'Only an admin can configure core environment', 403);
            }

            const vars = parseVars(request.body);
            if (typeof vars === 'string') {
                return bad(reply, varsCode(vars), vars);
            }

            const saved = await guard(reply, (e) => request.log.error({ err: e }), async () => {
                await store.replaceOrg(vars);
                return store.listOrg();
            });
            if (!saved.ok) return reply;
            return reply.code(200).send({ vars: saved.value });
        });

        // The caller's own scope. Any member may write it — it is their runners' environment.
        app.put('/api/env/workspace', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);

            const vars = parseVars(request.body);
            if (typeof vars === 'string') {
                return bad(reply, varsCode(vars), vars);
            }

            const saved = await guard(reply, (e) => request.log.error({ err: e }), async () => {
                await store.replaceWorkspace(caller.user.id, vars);
                return store.listWorkspace(caller.user.id);
            });
            if (!saved.ok) return reply;
            return reply.code(200).send({ vars: saved.value });
        });

        // Org-wide per-repository scope: one configuration per repository, applied to every
        // member's runs in it — the GitHub Actions precedent — so admin-written, like core.
        app.put('/api/env/repo', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);
            if (caller.role !== 'admin') {
                return bad(reply, 'FORBIDDEN', 'Only an admin can configure repository environment', 403);
            }

            const repo = parseRepo(request.body);
            if (typeof repo === 'string') return bad(reply, 'BAD_BODY', repo);
            // The scope becomes a check-constraint key here and a directory-shaped key at the row;
            // the same segment rules a checkout's name obeys, refused with a code rather than
            // discovered as a constraint violation.
            for (const [label, value] of [
                ['owner', repo.owner],
                ['name', repo.name],
            ] as const) {
                const reason = badSegment(label, value);
                if (reason) return bad(reply, 'BAD_REPO_NAME', `"${repo.owner}/${repo.name}": ${reason}`);
            }

            const vars = parseVars(request.body);
            if (typeof vars === 'string') {
                return bad(reply, varsCode(vars), vars);
            }

            /*
             * The same bargain the workspace selection route makes: the scope must be one the
             * installation can actually see, or the row is one this deployment has no business
             * holding.
             */
            const available = new Set((await repos.list()).map(fullName));
            if (!available.size && repos.lastError()) {
                return reply.code(503).send({
                    error: `Cannot check the repository against the GitHub App installation: ${repos.lastError()}`,
                    code: 'UNAVAILABLE',
                });
            }
            if (!available.has(`${repo.owner}/${repo.name}`)) {
                return bad(
                    reply,
                    'UNKNOWN_REPO',
                    `"${repo.owner}/${repo.name}" is not one of the repositories this GitHub App installation can see`,
                );
            }

            const saved = await guard(reply, (e) => request.log.error({ err: e }), async () => {
                await store.replaceRepo(repo.owner, repo.name, vars);
                return store.listRepo(repo.owner, repo.name);
            });
            if (!saved.ok) return reply;
            return reply.code(200).send({ vars: saved.value });
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
