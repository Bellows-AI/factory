import type { Sql } from 'postgres';

export interface StoredReposDeps {
    sql: Sql;
    orgId: string;
    /** Resolves when migrations have been applied; awaited per query. */
    ready?: Promise<unknown>;
}

/**
 * The repos this organization already holds sessions for, as "owner/name".
 *
 * The no-App fallback for the repo source (the offline tooling's code-only `none` arm). Without
 * it a credential-less process reports no repos, and since every stored read is scoped by the
 * repo list, a warm database would render as an empty dashboard — which is what `npm run seed`
 * followed by `npm run verify:ui` is.
 */
export async function storedRepoNames({ sql, orgId, ready }: StoredReposDeps): Promise<string[]> {
    if (ready) await ready;
    const rows = await sql<{ repo: string }[]>`
        select distinct repo from session_branch
        where org_id = ${orgId} and repo is not null
        order by repo asc
    `;
    return rows.map((row) => row.repo);
}
