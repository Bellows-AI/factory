import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_CODES } from '@factory-ai/core';
import type { UserExecutorStore } from '../db/user-executor-store.js';
import type { UserRepo, UserRepoStore } from '../db/user-repo-store.js';
import type { OrgRegistry, OrgRuntime } from '../orgs.js';
import type { FactsCache } from '../workspace/facts.js';
import type { Purger } from '../workspace/purge.js';
import { callerOf, orgOf } from '../auth/plugin.js';
import { bad, badSegment, guard } from './helpers.js';

const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_ACCEPTED = 202;
const HTTP_UNAVAILABLE = 503;

/**
 * What the caller's org runtime offers the workspace routes — or the reason none of them can
 * serve this caller. Split out of `workspace.ts` with the purge route so the file the poll and
 * the PUT share stays under the line budget; everything here is that pair's shared plumbing.
 */

export type WorkspaceRuntime =
    | {
          userRepos: UserRepoStore;
          userExecutors: UserExecutorStore | undefined;
          repos: OrgRuntime['repos'];
          cloneQueue: OrgRuntime['cloneQueue'];
          purger: Purger | undefined;
          facts: FactsCache;
      }
    | { error: string; code: string; status: number };

/** The caller's org runtime, or the reason a route cannot serve them. */
export async function runtimeOf(orgs: OrgRegistry, request: Parameters<typeof callerOf>[0]): Promise<WorkspaceRuntime> {
    const rt = await orgs.for(orgOf(request));
    if (!rt?.userRepos || !rt.facts) {
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
        purger: rt.purger,
        facts: rt.facts,
    };
}

/** One orphaned row as the payload carries it. */
export interface OrphanRow {
    owner: string;
    name: string;
    status: UserRepo['status'];
    error: string | null;
    sizeBytes: number | null;
}

/**
 * The orphaned list and the checkout total, computed for one member's workspace.
 *
 * The orphaned list is about what is ON DISK, whatever the row's last clone status says: a failed
 * clone can still have left a tree, and that tree is the member's disk usage. The existence check
 * is one stat per row — never a walk — and the size comes from the same asynchronous cache the
 * selected rows use. A row whose directory is gone drops out of the list (it is not using
 * anything) but stays deletable, which is how a stale row is cleaned: DELETE, answered 204.
 *
 * The total is the checkout usage: the clones only. The driver-owned `.worktrees/` sibling,
 * `.factory/` transcripts and the breadcrumb are workspace files that are not checkout rows, and
 * none of them are counted. `purging` rows are listed but excluded — a checkout being deleted is
 * on its way out. The total is null until EVERY included entry has a measurement: a partial sum
 * would read as the whole truth, and the poll simply renders an em dash until the walk lands. An
 * empty inclusion set is a measured 0, not a null — there is nothing unmeasured about owning no
 * checkouts.
 */
export function orphansAndTotal(
    facts: FactsCache,
    userDir: string,
    selected: readonly UserRepo[],
    orphanedRows: readonly UserRepo[]
): { orphaned: OrphanRow[]; checkoutTotalBytes: number | null } {
    const orphaned: OrphanRow[] = [];
    for (const row of orphanedRows) {
        const dir = join(userDir, row.name);
        if (!existsSync(dir)) continue;
        orphaned.push({
            owner: row.owner,
            name: row.name,
            status: row.status,
            error: row.error,
            sizeBytes: facts.get(dir).sizeBytes,
        });
    }

    const included: (number | null)[] = [
        ...selected.filter((row) => row.status === 'ready').map((row) => facts.get(join(userDir, row.name)).sizeBytes),
        ...orphaned.filter((row) => row.status !== 'purging').map((row) => row.sizeBytes),
    ];
    const checkoutTotalBytes = included.every((size) => size !== null)
        ? included.reduce((sum, size) => sum + (size ?? 0), 0)
        : null;
    return { orphaned, checkoutTotalBytes };
}

interface PurgeDeps {
    root: string | null;
    orgs: OrgRegistry;
}

/**
 * The manual purge (issue #92): one member, one orphaned checkout, deliberately.
 *
 * 202 means a removal child is running; 204 means there is nothing to remove — a replay after the
 * row was deleted, a row that never existed, or a stale row whose directory was already gone (the
 * cleanup of exactly one). All three are the same answer on purpose: DELETE is idempotent, and a
 * 404 would leak which rows belong to other members. The refusals are the store's, each decided
 * under the row's lock.
 */
export async function handleDeleteRepo(deps: PurgeDeps, request: FastifyRequest, reply: FastifyReply) {
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

    // The identity of the checkout comes from the authenticated caller and the stored row; the
    // path segments only ever select one of the caller's OWN rows. Segments are still shape-checked
    // — a `..` must be refused as a 400, not discovered as a path traversal by whichever store
    // lookup it reaches first.
    const { owner, name } = request.params as { owner: string; name: string };
    for (const [label, value] of [
        ['owner', owner],
        ['name', name],
    ] as const) {
        const reason = badSegment(label, value);
        if (reason) return bad(reply, ERROR_CODES.BAD_REPO_NAME, `"${owner}/${name}": ${reason}`);
    }

    const rt = await runtimeOf(deps.orgs, request);
    if ('error' in rt) return bad(reply, rt.code, rt.error, rt.status);
    const { purger } = rt;
    if (!purger) {
        return bad(
            reply,
            ERROR_CODES.WORKSPACE_UNAVAILABLE,
            'No purge service for this organization',
            HTTP_UNAVAILABLE
        );
    }

    const outcome = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => purger.purge(caller.user.id, { owner, name })
    );
    if (!outcome.ok) return reply;

    return purgeReply(reply, owner, name, outcome.value);
}

/** Maps one PurgeOutcome onto the response. Split out so the route reads as the contract table it is. */
function purgeReply(
    reply: FastifyReply,
    owner: string,
    name: string,
    result: Awaited<ReturnType<Purger['purge']>>
): FastifyReply {
    if (result === 'missing') return reply.code(HTTP_NO_CONTENT).send();
    if ('refused' in result) {
        switch (result.refused) {
            case 'selected':
                return bad(
                    reply,
                    ERROR_CODES.REPO_SELECTED,
                    `"${owner}/${name}" is still selected — deselect it before deleting its checkout`,
                    HTTP_CONFLICT
                );
            case 'cloning':
                return bad(
                    reply,
                    ERROR_CODES.REPO_CLONING,
                    `"${owner}/${name}" is still being cloned — wait for the clone to finish`,
                    HTTP_CONFLICT
                );
            case 'purging':
                return bad(
                    reply,
                    ERROR_CODES.PURGE_IN_PROGRESS,
                    `"${owner}/${name}" is already being deleted from disk`,
                    HTTP_CONFLICT
                );
            case 'tasks':
                return reply.code(HTTP_CONFLICT).send({
                    error: `"${owner}/${name}" has ${result.count} unfinished task${result.count === 1 ? '' : 's'} — stop and mark them done first`,
                    code: ERROR_CODES.TASKS_IN_FLIGHT,
                    count: result.count,
                });
        }
    }
    if (result.result === 'started') {
        return reply.code(HTTP_ACCEPTED).send({ status: 'purging' });
    }
    return reply.code(HTTP_NO_CONTENT).send();
}
