/**
 * The claim's env and executor resolution (see `job-store-claim.ts`): the stacked env, the minted
 * installation token under it, and the author's executor row merged over the runner's config env
 * name. Split out of the claim file for its size cap; a reviewer's claim (issue #549) reuses it
 * with an env grant.
 */

import {
    CLAUDE_CODE,
    EXECUTOR_TYPES,
    executorSuspendedMessage,
    USER_SCOPE,
    type ExecutorScope,
    type ExecutorType,
    OPENCODE,
    RUNNER_MANAGED_KEYS,
} from '@factory-ai/core';
import type { TransactionSql } from 'postgres';
import { withMintedToken } from './job-store-org-resolvers.js';
import type { CreateJobStoreDeps } from './job-store-types.js';

export interface ResolvedClaimExecutor {
    claimEnv: Record<string, string> | undefined;
    executorType: ExecutorType | null;
    executorRefusal: string | null;
}

/**
 * The pasted executor config rides the claim env under the name that CLI's entrypoint merges
 * over the baked configuration, applied LAST so the synthesized value wins a collision with a
 * member env var — both names are reserved at PUT besides.
 */
export function mergeExecutorConfigEnv(
    claimEnv: Record<string, string> | undefined,
    configured: { type: string; config: Record<string, unknown> } | null
): Record<string, string> | undefined {
    const member = configured?.config;
    if (member === null || member === undefined || typeof member !== 'object' || Array.isArray(member)) {
        return claimEnv;
    }
    // RUNNER_MANAGED_KEYS is the runner's fence per type, stripped before the config travels.
    // opencode's `permission` is baked into the image and patched by its entrypoint — a pasted
    // `external_directory: allow` would open every member's tree to this run. claude-code's `hooks`,
    // `enabledPlugins` and `extraKnownMarketplaces` are the git guard hook and the baked
    // context-mode plugin install: a pasted `hooks` would silently drop the guard; a pasted
    // plugin/marketplace pair would run code the image never installed. Everything else — model,
    // env, permissions.allow, provider — travels verbatim.
    const envName =
        configured?.type === OPENCODE
            ? 'OPENCODE_CONFIG_CONTENT'
            : configured?.type === CLAUDE_CODE
              ? 'CLAUDE_CODE_CONFIG_CONTENT'
              : null;
    if (envName === null) return claimEnv;
    const fenced = new Set(RUNNER_MANAGED_KEYS[configured!.type as ExecutorType]);
    const rest = Object.fromEntries(Object.entries(member).filter(([key]) => !fenced.has(key)));
    return { ...(claimEnv ?? {}), [envName]: JSON.stringify(rest) };
}

/** The entries of `env` named in `grant`, nothing else: a reviewer profile's `connections`. */
function grantedEnv(
    env: Record<string, string> | undefined,
    grant: readonly string[]
): Record<string, string> | undefined {
    if (env === undefined) return undefined;
    return Object.fromEntries(Object.entries(env).filter(([name]) => grant.includes(name)));
}

/**
 * claim()'s env + executor resolution: the stacked env, the minted installation token under it as
 * the base layer, and the author's executor row merged over the runner's config env name.
 * Resolved ON THE TRANSACTION, so a claim holds one connection rather than two, and a resolver or
 * mint failure rolls the whole claim back (docs/env.md).
 */
export async function resolveClaimExecutor(
    tx: TransactionSql,
    deps: {
        env: CreateJobStoreDeps['env'];
        githubToken: CreateJobStoreDeps['githubToken'];
        executorConfig: CreateJobStoreDeps['executorConfig'];
        /**
         * Set for a reviewer's claim (issue #549): ONLY these member env names reach it, and no
         * installation token is minted for it. The executor config (the agent's own runtime
         * settings) still travels — a reviewer needs to run — but nothing of the caller's access does.
         */
        grant?: readonly string[];
    },
    row: { created_by: string | null; repo: string | null; executor: string | null; executor_scope: string | null }
): Promise<ResolvedClaimExecutor> {
    const { env, githubToken, executorConfig, grant } = deps;
    const resolvedEnv = env ? await env.resolveFor({ userId: row.created_by, repo: row.repo }, tx) : undefined;
    // The mint fills only the gap: when the stacked env already carries a GITHUB_TOKEN, the mint
    // would be discarded — so it is not made at all, rather than spend a GitHub call and leave a
    // live token nothing holds. A granted claim mints nothing: a token is access the profile never named.
    let claimEnv =
        grant !== undefined
            ? grantedEnv(resolvedEnv, grant)
            : githubToken && resolvedEnv?.GITHUB_TOKEN === undefined
              ? withMintedToken(await githubToken.fresh(row.repo), resolvedEnv)
              : resolvedEnv;
    // The executor label a task was queued with names a row in the STAMPED SCOPE's list (issue
    // 391): the author's own rows when the stamp is 'user' — null reads as 'user', the pre-391
    // meaning — and the organization's when it is 'org', which is how a team-shared profile
    // resolves for any author. Its TYPE is the execution input: it tells the driver which
    // CLI/image family to run. A label matching nothing IN THAT SCOPE remains null on the claim
    // and is failed explicitly by the driver; there is no global CLI fallback, and no cross-scope
    // one either — a selection names its scope, and the other scope's same-named row is simply not
    // this selection's answer.
    let executorType: ExecutorType | null = null;
    let executorRefusal: string | null = null;
    if (executorConfig && row.executor !== null && row.created_by !== null) {
        const scope = (row.executor_scope ?? USER_SCOPE) as ExecutorScope;
        const configured = await executorConfig.configFor(row.created_by, row.executor, scope, tx);
        if (configured?.suspended) {
            // A suspended profile (issue 440) launches nothing and its config never reaches the
            // claim: the driver fails the task with this sentence before any runner starts, for a
            // fresh task, a retry and a follow-up alike — they all claim through here.
            executorRefusal = executorSuspendedMessage(scope, row.executor);
        } else {
            if (configured && EXECUTOR_TYPES.includes(configured.type as ExecutorType)) {
                executorType = configured.type as ExecutorType;
            }
            claimEnv = mergeExecutorConfigEnv(claimEnv, configured);
        }
    }
    return { claimEnv, executorType, executorRefusal };
}
