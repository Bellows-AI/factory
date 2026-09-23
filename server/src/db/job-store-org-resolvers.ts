/**
 * The org resolvers the auth layer asks before a worker write (which org a lease, a job or a reclaim
 * belongs to), and `withMintedToken`, the claim env's base layer.
 */

import type { Sql } from 'postgres';

/**
 * Lays the minted installation token under the claim's stacked environment, in one place and pure
 * — the `stackEnv` precedent: a rule this load-bearing is pinned by the offline suite, which cannot
 * reach the claim that runs it.
 *
 * The mint is the BASE layer. A `GITHUB_TOKEN` configured in any env scope (org, workspace, repo)
 * wins over it, because that value is something an operator deliberately chose and silently
 * replacing a credential with a different one is a failure nobody notices; the mint fills only the
 * gap. No mint (the offline tooling builds no provider) changes nothing at all, so a board that
 * cannot fetch still reads exactly as it did.
 */
export function withMintedToken(
    minted: string | undefined,
    resolved: Record<string, string> | undefined
): Record<string, string> | undefined {
    if (minted === undefined) return resolved;
    return { GITHUB_TOKEN: minted, ...resolved };
}

/**
 * The branch-ingest credential's verifier, and the ONE job query in this module that is org-less —
 * deliberately, because its whole purpose is to say which org a request is speaking for: the
 * runner's reporter presents the job it claimed and that attempt's lease token, and the pair's
 * answer IS the org. `createJobStore` binds the org at construction; this resolver must run before
 * any org is known, which is why it is a factory of its own and not a store method.
 *
 * No status filter, but nothing unbounded either. The reporter's final `--once` sample lands
 * seconds after the verdict, and `complete` retains the lease token for exactly that reason (the
 * only settle point that does — dead and suspend clear theirs, because those attempts end without
 * a verdict whose tail matters). The pair is attempt-scoped regardless: a reclaim rotates the
 * token on the row (`gen_random_uuid`), so a superseded attempt's pair stops resolving the moment
 * the job is handed to its replacement and cannot write into the winner's org.
 *
 * Two bounds keep retention honest. The pair resolves from the job row alone — no membership
 * join, because the runner is not a person — so a pair captured from a runner's env would
 * otherwise outlive its author's removal from the org indefinitely: nothing prunes completed
 * jobs, and a claimed-but-never-settled row would keep resolving forever too. So a finished job
 * resolves only within an hour of the verdict (the tail sample needs seconds; this has orders of
 * magnitude to spare), and an UNFINISHED job resolves only while its lease is live — a lease that
 * expired without a reclaim is a run that died, and its captured pair dies with it.
 */
export const LEASE_TAIL_GRACE = '1 hour';

export function createOrgOfLease({
    sql,
    ready,
}: {
    sql: Sql;
    ready?: Promise<unknown>;
}): (jobId: string, leaseToken: string) => Promise<string | null> {
    return async (jobId, leaseToken) => {
        if (ready) await ready;
        const rows = await sql<{ org_id: string }[]>`
            select org_id from job
            where id = ${jobId} and lease_token = ${leaseToken}
              and (
                  (finished_at is not null and finished_at > now() - ${LEASE_TAIL_GRACE}::interval)
                  or
                  (finished_at is null and lease_expires_at > now())
              )
        `;
        return rows[0]?.org_id ?? null;
    };
}

/**
 * Two more org-less resolvers beside `createOrgOfLease`, for the worker routes under the shared
 * board secret: the secret authenticates the DRIVER, so the org a call operates on is read from
 * the row its URL names — the job for the `/api/jobs/:id/…` routes, the queued worktree removal
 * for the reclaim ack. Unbounded by lease or status, unlike the pair above: the secret already
 * answered the authorization question, and this is routing — a heartbeat on a finished job must
 * still find its board to answer 404 through.
 */
export function createOrgOfJob({
    sql,
    ready,
}: {
    sql: Sql;
    ready?: Promise<unknown>;
}): (jobId: string) => Promise<string | null> {
    return async (jobId) => {
        if (ready) await ready;
        const rows = await sql<{ org_id: string }[]>`select org_id from job where id = ${jobId}`;
        return rows[0]?.org_id ?? null;
    };
}

export function createOrgOfReclaim({
    sql,
    ready,
}: {
    sql: Sql;
    ready?: Promise<unknown>;
}): (reclaimId: string) => Promise<string | null> {
    return async (reclaimId) => {
        if (ready) await ready;
        const rows = await sql<{ org_id: string }[]>`select org_id from task_reclaim where id = ${reclaimId}`;
        return rows[0]?.org_id ?? null;
    };
}
