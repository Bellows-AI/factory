import type { Sql } from 'postgres';

/**
 * The org's tracked-repo allowlist (#125) — the onboarding screen's per-org checkbox answer.
 *
 * No rows means the org tracks EVERYTHING its installation reports: the default, and the reason a
 * confirm-with-everything-checked writes nothing. The org's repo source intersects its
 * installation listing with this table (see repo-source.ts), so stats scoping and the
 * workspace/env writes all follow one truth.
 */

/** The org's allowlist, as "owner/name" strings. Empty when everything is tracked. */
export async function trackedRepos({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown>;
}): Promise<string[]> {
    if (ready) await ready;
    const rows = await sql<{ repo: string }[]>`
        select owner || '/' || name as repo from tracked_repo
        where org_id = ${orgId}
        order by repo
    `;
    return rows.map((row) => row.repo);
}

/** Replaces the org's allowlist in one transaction — the completion route's whole write. */
export async function replaceTrackedRepos({
    sql,
    orgId,
    repos,
    ready,
}: {
    sql: Sql;
    orgId: string;
    repos: readonly string[];
    ready?: Promise<unknown>;
}): Promise<void> {
    if (ready) await ready;
    // "owner/name", the one spelling every repo identity takes here — the same split parseFullName
    // makes. A malformed name has no owner column to land in, and the route has already validated
    // every entry against the installation listing.
    const rows = repos.flatMap((repo) => {
        const slash = repo.indexOf('/');
        if (slash <= 0 || slash === repo.length - 1) return [];
        return [{ org_id: orgId, owner: repo.slice(0, slash), name: repo.slice(slash + 1) }];
    });
    await sql.begin(async (tx) => {
        await tx`delete from tracked_repo where org_id = ${orgId}`;
        // One multi-row insert, not one round trip per repo: a large App install's selection is
        // hundreds of names and this sits on the onboarding click.
        if (rows.length) await tx`insert into tracked_repo ${tx(rows)}`;
    });
}
