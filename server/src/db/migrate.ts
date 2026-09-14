import { readFileSync, readdirSync } from 'node:fs';
import type { Sql } from 'postgres';
import { TelemetryError } from '../telemetry/errors.js';

/**
 * The .sql files are not compiled by tsc, so the Dockerfile has to copy them explicitly.
 * That failure only appears in the container, never in dev.
 */
const DIR = new URL('../../migrations/', import.meta.url);

export interface MigrateOptions {
    /**
     * The organization every pre-organization row is adopted into. Required, not defaulted: a
     * default here would be a second place that decides what the configured org is, and the two
     * disagreeing produces an empty dashboard with no error.
     */
    orgId: string;
    /**
     * The organization's display name. Seeded here rather than by 010_auth.sql for the same reason
     * adoptOrg exists: a .sql file cannot see the config.
     *
     * Defaulted where `orgId` is required, and the asymmetry is the same one config.ts draws: the id
     * is a key, so a second place deciding it produces an empty dashboard, whereas nothing keys on a
     * label and the worst a wrong one does is render oddly.
     */
    orgName?: string;
    /**
     * A GitHub login to make an admin, applied only when the organization has no members at all.
     *
     * Without this an upgrade is a lockout. After 010 an existing database has rows, zero users and
     * zero memberships, so turning auth on 401s every route forever with no log line — which reads
     * as "auth is broken" rather than "nobody has been invited". Exactly the class of silent failure
     * adoptOrg() exists to prevent, one level up.
     */
    bootstrapAdmin?: string | null;
    /**
     * Whether to create the stand-in account AUTH_MODE=none attributes everything to.
     *
     * `none` synthesises a caller rather than skipping the auth path, so that there is one
     * downstream code path instead of two and `job.created_by` is always populated. That requires a
     * real row for the foreign key to point at.
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
 * Underscores are not legal in a GitHub login, so this can never collide with a real one — which
 * matters twice: the account cannot be impersonated by registering the name, and bootstrapAdmin can
 * exclude it when asking whether an organization has any real members. Without that exclusion,
 * booting once without auth would leave a membership behind and silently suppress the bootstrap that
 * is the only way into the deployment afterwards.
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
 * Claims every row 005 parked in the reserved namespace for the configured organization.
 *
 * This is the other half of the migration, and it cannot live in the .sql file because that file
 * cannot see the config. Without it a deployment that sets ORG_ID=bellows reads an empty partition:
 * 200 OK, zero PRs, no log line, indistinguishable from data loss.
 *
 * Runs on every boot, and is a no-op after the first: nothing writes '__unclaimed__' once the
 * column default has been consumed, so the update matches nothing.
 */
async function adoptOrg(sql: Sql, orgId: string, log: (message: string) => void): Promise<void> {
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
 * Plants the configured organization so memberships have something to reference.
 *
 * The row is created, never updated: config decides the organization exists, and the database owns
 * its name afterwards. Renaming through `ORG_NAME` on a later boot would otherwise silently rewrite
 * a name somebody may have set deliberately.
 */
async function seedOrganization(sql: Sql, orgId: string, orgName: string): Promise<void> {
    await sql`
        insert into organization (id, name) values (${orgId}, ${orgName})
        on conflict (id) do nothing
    `;
}

/**
 * One-shot ignition for a deployment that has nobody in it yet.
 *
 * Deliberately not a standing grant: it fires only when the organization has no real members, so an
 * admin who removes themselves does not find the bootstrap silently reinstating them on the next
 * restart. The invite is unclaimed, like any other — the account is bound when that person first
 * signs in, through exactly the same path.
 */
async function bootstrapAdmin(sql: Sql, orgId: string, login: string, log: (message: string) => void): Promise<void> {
    const normalised = login.trim().toLowerCase();
    if (!normalised) return;

    const [existing] = await sql<{ count: number }[]>`
        select count(*)::int as count from org_membership
        where org_id = ${orgId} and github_login <> ${LOCAL_LOGIN}
    `;
    if (existing && existing.count > 0) return;

    await sql`
        insert into org_membership (org_id, github_login, role)
        values (${orgId}, ${normalised}, 'admin')
        on conflict (org_id, github_login) do nothing
    `;
    log(`bootstrapped admin "${normalised}" into "${orgId}"`);
}

/**
 * The account AUTH_MODE=none attributes every request to.
 *
 * Idempotent, and safe to run on a database that later switches to real auth: bootstrapAdmin ignores
 * this membership when deciding whether anyone has been invited.
 */
async function ensureLocalUser(sql: Sql, orgId: string): Promise<void> {
    const [user] = await sql<{ id: string }[]>`
        insert into app_user (github_user_id, github_login, display_name)
        values (${LOCAL_GITHUB_USER_ID}, ${LOCAL_LOGIN}, 'Local')
        on conflict (github_user_id) do update set last_login_at = now()
        returning id
    `;
    if (!user) return;
    await sql`
        insert into org_membership (org_id, github_login, user_id, role, claimed_at)
        values (${orgId}, ${LOCAL_LOGIN}, ${user.id}, 'admin', now())
        on conflict (org_id, github_login) do update set user_id = excluded.user_id
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
    const { orgId, orgName = orgId, attempts = 10, backoffMs = 1000, log = () => {} } = options;

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

            // After the files, so the column and its default exist. Inside the retry loop, so a
            // database that was not up for the first attempt gets adopted on the one that works.
            await adoptOrg(sql, orgId, log);

            // Same placement, same reason: these read the config, so they cannot live in a .sql
            // file, and a database that only came up on the fourth attempt still gets them.
            // Ordered — the organization row is the foreign key target for both that follow.
            await seedOrganization(sql, orgId, orgName);
            if (options.localUser) await ensureLocalUser(sql, orgId);
            if (options.bootstrapAdmin) await bootstrapAdmin(sql, orgId, options.bootstrapAdmin, log);
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
