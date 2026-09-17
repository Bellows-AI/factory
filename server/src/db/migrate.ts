import { readFileSync, readdirSync } from 'node:fs';
import type { Sql } from 'postgres';
import { LOCAL_ORG_ID } from '../config.js';
import { TelemetryError } from '../telemetry/errors.js';

/**
 * The .sql files are not compiled by tsc, so the Dockerfile has to copy them explicitly.
 * That failure only appears in the container, never in dev.
 */
const DIR = new URL('../../migrations/', import.meta.url);

export interface MigrateOptions {
    /**
     * Whether to prepare the single LOCAL organization AUTH_MODE=none lives in (#99): the
     * `default` row, the stand-in account, and the adoption of pre-organization rows into it.
     *
     * Github mode leaves all of it alone — there the organizations are the App's installations,
     * materialized at sign-in, and booting cannot know any installation id. Legacy data is
     * re-homed by `npm run adopt`, which calls adoptOrg() itself.
     */
    localUser?: boolean;
    /**
     * The container is usually still starting when the app boots, and the dashboard must not
     * die waiting for a database it can serve without.
     */
    attempts?: number;
    backoffMs?: number;
    log?: (message: string) => void;
}

/**
 * The login of the stand-in account used when AUTH_MODE=none.
 *
 * Underscores are not legal in a GitHub login, so this can never collide with a real one: the
 * stand-in account cannot be impersonated by somebody registering the name.
 */
export const LOCAL_LOGIN = '__local__';

/** GitHub numbers its accounts from 1, so 0 is permanently free for the stand-in. */
const LOCAL_GITHUB_USER_ID = 0;

/**
 * The namespace 005_organizations.sql parks pre-organization rows in. Kept in step with
 * RESERVED_ORG_PREFIX in config.ts, which refuses any configured id that could collide with it.
 */
const UNCLAIMED_ORG = '__unclaimed__';

/**
 * The tables adoptOrg() has to update directly.
 *
 * metric_point is absent because it has no org_id at all — see the header of
 * 005_organizations.sql. The pull-request tables 005 also partitioned were dropped by
 * 023_drop_pull_requests.sql and are absent for that reason; their children carried org_id
 * inside their foreign key, so adoptOrg() never listed them either.
 */
const ORG_OWNED = ['session_branch'] as const;

/**
 * Claims every row parked in the reserved `__unclaimed__` namespace into `orgId`.
 *
 * Since #99 this runs at boot only for the LOCAL org (AUTH_MODE=none); github mode's adoption is
 * the one-off `npm run adopt` CLI, which imports this function — boot cannot know an installation
 * id, so it cannot know an org to claim rows into. Without an adoption somewhere, a re-homed
 * deployment reads an empty partition: 200 OK, zero sessions, no log line, indistinguishable from
 * data loss.
 *
 * Also a no-op after the first run: nothing writes '__unclaimed__' once the column default has
 * been consumed, so the update matches nothing.
 */
export async function adoptOrg(sql: Sql, orgId: string, log: (message: string) => void): Promise<void> {
    if (orgId.startsWith('__')) {
        // config.ts already refuses this. Asserted again because the DB layer must not trust its
        // caller with a value that decides which partition every row lands in.
        throw new TelemetryError(`orgId "${orgId}" is inside the reserved "__" namespace`, 'MIGRATION');
    }

    let moved = 0;
    for (const table of ORG_OWNED) {
        const result = await sql`
            update ${sql(table)} set org_id = ${orgId} where org_id = ${UNCLAIMED_ORG}
        `;
        moved += result.count;
    }
    // Undercounts by however many child rows the cascade carried along, which is the honest thing
    // to report: the count is a signal that adoption happened, not an inventory.
    if (moved) log(`adopted ${moved} pre-organization rows into "${orgId}"`);
}

/**
 * Every table a legacy organization can still hold rows in, and how each moves.
 *
 * The uuid-keyed tables move with a plain update: their key is global, so the re-homed rows
 * cannot collide with anything already under the installation org. The natural-keyed tables
 * merge instead — the installation org's own row wins a collision, so each gets an explicit
 * statement in the body. session_branch keeps the wider merge its unique key always needed
 * (see the where-used comment in the body). metric_point is absent because it has no org_id
 * (001); the pull-request tables 005 partitioned were dropped by 023.
 */
const MERGE_MOVES = {
    updates: ['session', 'job', 'task_reclaim', 'worker_token', 'access_token'] as const,
};

/**
 * Re-homes every org-owned row from a legacy (pre-#99) organization into an installation's org,
 * then retires the legacy organization row itself (#123).
 *
 * The `--from` arm of `npm run adopt` used to stop at session_branch and memberships, which kept
 * the legacy org row — and with it the selector's duplicate and an org husk jobs, tokens and
 * executor config still pointed into — alive forever. One transaction, because a crash partway
 * must roll back whole: a rerun that finds half a merge would sum `samples` twice or strand rows
 * whose org it already re-wrote.
 */
export async function mergeLegacyOrg(
    sql: Sql,
    installation: string,
    from: string,
    log: (message: string) => void
): Promise<void> {
    if (installation === from) {
        // The merge would upsert every row onto itself and the retirement would then delete the
        // org's whole history — the one argument pair that turns an adoption into a wipe. The
        // CLI refuses it too; restated here because the database layer must not trust its caller
        // with a value that decides which partition every row lands in.
        throw new TelemetryError(`cannot merge organization "${from}" into itself`, 'MIGRATION');
    }

    // The counts are collected inside the transaction but logged only after it commits: the
    // CLI's output is the operator's evidence of what happened, and a line for work a later
    // statement rolled back would be a lie about a merge that never landed.
    let mergedBranches: number | null = null;
    let mergedMembers: number | null = null;
    await sql.begin(async (tx) => {
        // MERGE, not an update: the unique key (org_id, agent, session_id, repo, branch) may
        // already hold the same session under the new org — a sign-in after the installation
        // appeared writes exactly that row. UPDATE would violate it on the first collision and
        // abort the merge partway; upserting widens the span instead, and only a successful
        // merge deletes the legacy rows.
        const branches = await tx`
            insert into session_branch (org_id, agent, session_id, repo, branch, head_sha, first_seen, last_seen, samples)
            select ${installation}, agent, session_id, repo, branch, head_sha, first_seen, last_seen, samples
            from session_branch where org_id = ${from}
            on conflict (org_id, agent, session_id, repo, branch) do update set
                head_sha   = coalesce(excluded.head_sha, session_branch.head_sha),
                first_seen = least(session_branch.first_seen, excluded.first_seen),
                last_seen  = greatest(session_branch.last_seen, excluded.last_seen),
                samples    = session_branch.samples + excluded.samples
        `;
        await tx`delete from session_branch where org_id = ${from}`;
        mergedBranches = branches.count;

        // Members merge, never duplicate: a person already reported by a sign-in into the
        // installation keeps that row untouched.
        const members = await tx`
            insert into org_membership (org_id, github_login, user_id, role, invited_at, claimed_at)
            select ${installation}, github_login, user_id, role, invited_at, claimed_at
            from org_membership where org_id = ${from}
            on conflict (org_id, user_id) do nothing
        `;
        await tx`delete from org_membership where org_id = ${from}`;
        mergedMembers = members.count;

        for (const table of MERGE_MOVES.updates) {
            await tx`update ${tx(table)} set org_id = ${installation} where org_id = ${from}`;
        }
        // One merge statement per table, each naming its columns after org_id: the installation
        // org's own row wins a collision (`on conflict do nothing`, bare — the coalesce unique
        // indexes are expression-keyed, and the bare clause covers the natural-keyed primary
        // keys besides), and the legacy copy is deleted after the insert.
        await tx`
            insert into workflow (org_id, id, name, user_id, repo_owner, repo_name, definition, is_default, created_by, created_at, updated_at)
            select ${installation}, id, name, user_id, repo_owner, repo_name, definition, is_default, created_by, created_at, updated_at
            from workflow where org_id = ${from}
            on conflict do nothing
        `;
        await tx`delete from workflow where org_id = ${from}`;
        await tx`
            insert into env_var (org_id, user_id, repo_owner, repo_name, name, value, is_secret, created_at, updated_at)
            select ${installation}, user_id, repo_owner, repo_name, name, value, is_secret, created_at, updated_at
            from env_var where org_id = ${from}
            on conflict do nothing
        `;
        await tx`delete from env_var where org_id = ${from}`;
        // The clone state does NOT move with the row: the on-disk checkout is
        // <workspaceRoot>/<orgId>/<userId>/<name>, keyed by the org id, so a 'ready' row moved
        // as-is would point at a directory that has no clone in it — and the queue claims
        // 'queued'/'cloning' only, so nothing would ever fix it. Re-queued, the clone queue
        // re-clones at the installation org's path; the member's selection survives.
        await tx`
            insert into user_repo (org_id, user_id, repo_owner, repo_name, status, error, attempts, selected_at, deselected_at, started_at, ready_at)
            select ${installation}, user_id, repo_owner, repo_name, 'queued', null, attempts, selected_at, deselected_at, null, null
            from user_repo where org_id = ${from}
            on conflict do nothing
        `;
        await tx`delete from user_repo where org_id = ${from}`;
        await tx`
            insert into user_executor (org_id, user_id, name, type, config, created_at, updated_at)
            select ${installation}, user_id, name, type, config, created_at, updated_at
            from user_executor where org_id = ${from}
            on conflict do nothing
        `;
        await tx`delete from user_executor where org_id = ${from}`;

        // Safe only here: every row that references the legacy org has been re-homed, so the
        // delete cascades nothing. This is what turns the adoption notice off — its signal is
        // the org row itself.
        await tx`delete from organization where id = ${from}`;
    });
    log(`merged ${mergedBranches} session_branch rows from "${from}" into "${installation}"`);
    log(`merged ${mergedMembers} memberships from "${from}" into "${installation}"`);
    log(`retired legacy organization "${from}"`);
}

/**
 * Plants the LOCAL organization so the stand-in membership has something to reference.
 *
 * The row is created, never updated, and only in localUser mode: github mode's organizations are
 * materialized at sign-in from the App's installations, and none of them can be named at boot.
 */
async function seedOrganization(sql: Sql, orgId: string): Promise<void> {
    await sql`
        insert into organization (id, name) values (${orgId}, ${orgId})
        on conflict (id) do nothing
    `;
}

/**
 * The account AUTH_MODE=none attributes every request to.
 */
async function ensureLocalUser(sql: Sql, orgId: string): Promise<void> {
    const [user] = await sql<{ id: string }[]>`
        insert into app_user (github_user_id, github_login, display_name)
        values (${LOCAL_GITHUB_USER_ID}, ${LOCAL_LOGIN}, 'Local')
        on conflict (github_user_id) do update set last_login_at = now()
        returning id
    `;
    if (!user) return;
    // The stand-in is the org's admin: AUTH_MODE=none has no sign-in to materialize a membership,
    // so the local org seeds its own — keyed like every membership since 029, by account.
    await sql`
        insert into org_membership (org_id, github_login, user_id, role, claimed_at)
        values (${orgId}, ${LOCAL_LOGIN}, ${user.id}, 'admin', now())
        on conflict (org_id, user_id) do update set user_id = excluded.user_id
    `;
}

/**
 * Drops sessions nobody can present any more.
 *
 * The cookie carries the same expiry, so this is not what enforces it — the read path checks
 * `expires_at` regardless. It exists so the table does not grow without bound on a deployment whose
 * users never log out.
 */
export async function reapSessions(sql: Sql): Promise<number> {
    const result = await sql`delete from session where expires_at < now()`;
    return result.count;
}

/**
 * A `.repeatable.sql` file is re-applied on every boot instead of being recorded.
 *
 * Without this a fix to a view would never land: the version is already in
 * schema_migrations, so the file is skipped and the old definition survives until someone
 * deletes the volume. Every repeatable file must therefore be `create or replace` only.
 */
const isRepeatable = (name: string) => name.endsWith('.repeatable.sql');

function files(): { version: string; sql: string; repeatable: boolean }[] {
    const all = readdirSync(DIR)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => ({
            version: name,
            sql: readFileSync(new URL(name, DIR), 'utf8'),
            repeatable: isRepeatable(name),
        }));

    // Versioned first, repeatable last, regardless of filename order. Repeatable files define
    // views over the finished schema, so a new versioned file that adds a column the views read
    // would otherwise fail purely because it sorts after them.
    return [...all.filter((f) => !f.repeatable), ...all.filter((f) => f.repeatable)];
}

/**
 * Applies pending migrations. Idempotent: every statement is `if not exists` or
 * `create or replace`, and applied versions are recorded, so a second run is a no-op.
 */
export async function migrate(sql: Sql, options: MigrateOptions): Promise<void> {
    const { attempts = 10, backoffMs = 1000, log = () => {} } = options;

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            await sql`
                create table if not exists schema_migrations (
                    version    text primary key,
                    applied_at timestamptz not null default now()
                )
            `;

            // A file that used to be versioned and is now repeatable leaves a row behind. The
            // runner ignores it, so this is hygiene rather than a fix — but leaving it makes
            // "repeatable files are never recorded" true only of new writes, not of the table.
            await sql`delete from schema_migrations where version like '%.repeatable.sql'`;

            const applied = new Set(
                (await sql<{ version: string }[]>`select version from schema_migrations`).map((r) => r.version)
            );

            for (const { version, sql: body, repeatable } of files()) {
                if (!repeatable && applied.has(version)) continue;
                log(`applying ${repeatable ? 'repeatable ' : ''}migration ${version}`);
                // Not wrapped in a transaction with the insert: create_hypertable and
                // create extension behave badly inside one, and every file is idempotent
                // anyway, so a crash between the two costs one harmless re-run.
                await sql.unsafe(body);
                if (repeatable) continue;
                await sql`insert into schema_migrations (version) values (${version})
                          on conflict (version) do nothing`;
            }

            if (options.localUser) {
                // After the files, so the columns and defaults exist. Inside the retry loop, so a
                // database that was not up for the first attempt still gets them on a later one.
                // Ordered — the organization row is the foreign key target for what follows.
                await seedOrganization(sql, LOCAL_ORG_ID);
                await adoptOrg(sql, LOCAL_ORG_ID, log);
                await ensureLocalUser(sql, LOCAL_ORG_ID);
            }
            await reapSessions(sql);
            return;
        } catch (e) {
            lastError = e;
            if (attempt === attempts) break;
            log(`migration attempt ${attempt} failed, retrying: ${(e as Error).message}`);
            await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
        }
    }

    throw new TelemetryError(
        `Migrations failed after ${attempts} attempts: ${(lastError as Error)?.message}`,
        'MIGRATION'
    );
}
