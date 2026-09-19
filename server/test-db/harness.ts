import { afterAll, beforeAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';

/**
 * The shared harness for the suites in this directory (`npm run test:db`).
 *
 * Every suite here used to grow its own pool, its own `_test`-name guard, its own table lists,
 * and its own quiet reliance on whatever rows an older run had left behind — which is exactly
 * how the suites came to pass on a used database and fail on a fresh one, when the row an old
 * version of `migrate()` had planted was no longer planted. The harness replaces all of it:
 *
 * - beforeAll: open the pool and run the migrations;
 * - beforeEach: truncate EVERY user table and re-plant the suite's declared fakes, so each
 *   test starts from the same known state regardless of what the database has been through;
 * - afterAll: truncate again, so the run leaves the database schema-only.
 *
 * This is only safe because the db suites share one database and run with
 * `fileParallelism: false` (vitest.db.config.ts) — a second concurrent file would see its rows
 * vanish mid-test.
 */

/**
 * These suites truncate their tables, so pointing them at the database the dashboard actually
 * uses destroys real history — including anything imported by `npm run backfill`. Requiring a
 * `_test` database name is the guard, because the failure is silent: the tests pass and the
 * data is simply gone.
 */
export function assertTestDatabase(raw: string): void {
    const name = new URL(raw).pathname.replace(/^\//, '');
    if (!/_test$/.test(name)) {
        throw new Error(
            `Refusing to run: this suite truncates its tables, and "${name}" is not a test database.\n` +
                `Create one and point DATABASE_URL at it:\n` +
                `  docker compose exec timescale psql -U factory -d postgres -c 'create database factory_test'\n` +
                `  DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test npm run test:db`
        );
    }
}

/** An account a suite plants for its foreign keys to reference. */
export interface TestUser {
    id: string;
    githubUserId: number;
    login: string;
}

export interface TestDbOptions {
    /** Organizations re-planted before every test — env_var, workflow and friends are FK'd to organization. */
    orgs?: string[];
    /** Accounts re-planted before every test. */
    users?: TestUser[];
    /** Pool size. The default 4 covers every store a suite builds; raise it when a test needs real parallelism. */
    max?: number;
}

export interface TestDb {
    /** The DATABASE_URL the suite runs against. Undefined when it is not set — the whole suite is skipped then. */
    url?: string;
    /** Undefined when DATABASE_URL is not set — the whole suite is skipped in that case. */
    sql: Sql;
}

/** The one name the reset must never truncate: it is what makes a second migrate a no-op. */
const SYSTEM_TABLES = new Set(['schema_migrations']);

/** Table names come from our own catalog, and this is the shape every migration creates. */
const PLAIN_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Truncates every user table in one statement. The list is read from the catalog rather than
 * written per suite, so a new migration's tables are covered without the suites moving, and no
 * suite can quietly leave a table out of its list again.
 */
async function truncateAll(sql: Sql): Promise<void> {
    const tables = await sql<{ tablename: string }[]>`
        select tablename from pg_tables where schemaname = 'public'
    `;
    const names = tables.map((t) => t.tablename).filter((name) => !SYSTEM_TABLES.has(name));
    for (const name of names) {
        if (!PLAIN_NAME.test(name)) throw new Error(`Unexpected table name in the test reset: "${name}"`);
    }
    if (names.length === 0) return;
    await sql.unsafe(`truncate table ${names.join(', ')} restart identity cascade`);
}

/**
 * Plants the suite's declared fakes. Runs after every truncate, so the rows exist for every
 * test exactly the same way, on a database that has never been touched before included.
 */
async function seedFakes(sql: Sql, options: TestDbOptions): Promise<void> {
    for (const org of options.orgs ?? []) {
        await sql`insert into organization (id, name) values (${org}, ${org})`;
    }
    for (const user of options.users ?? []) {
        await sql`insert into app_user (id, github_user_id, github_login)
                  values (${user.id}, ${user.githubUserId}, ${user.login})`;
    }
}

/**
 * Declares the suite's database lifecycle. Call once at the top of the file, before the
 * suite's own `beforeAll` builds its stores — the hooks run in registration order.
 */
export function useTestDb(options: TestDbOptions = {}): TestDb {
    const url = process.env.DATABASE_URL;
    if (url) assertTestDatabase(url);

    const db = { url } as TestDb;

    beforeAll(async () => {
        if (!url) return;
        db.sql = postgres(url, { max: options.max ?? 4 });
        await migrate(db.sql, { attempts: 3 });
    });

    beforeEach(async () => {
        if (!url) return;
        await truncateAll(db.sql);
        await seedFakes(db.sql, options);
    });

    afterAll(async () => {
        if (!url) return;
        await truncateAll(db.sql);
        await db.sql.end({ timeout: 5 });
    });

    return db;
}
