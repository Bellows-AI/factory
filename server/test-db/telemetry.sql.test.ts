import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { createPostgresTelemetryClient } from '../src/telemetry/postgres-client.js';

const url = process.env.DATABASE_URL;

/**
 * This suite TRUNCATES metric_point and session_branch before every test, so pointing it at
 * the database the dashboard actually uses destroys real history — including anything
 * imported by `npm run backfill`. Requiring a `_test` database name is the guard, because the
 * failure is silent: the tests pass and the data is simply gone.
 */
function assertTestDatabase(raw: string): void {
    const name = new URL(raw).pathname.replace(/^\//, '');
    if (!/_test$/.test(name)) {
        throw new Error(
            `Refusing to run: this suite truncates its tables, and "${name}" is not a test database.\n` +
                `Create one and point DATABASE_URL at it:\n` +
                `  docker compose exec timescale psql -U factory -d postgres -c 'create database factory_test'\n` +
                `  DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test npm run test:db`,
        );
    }
}

const enabled = Boolean(url);
if (url) assertTestDatabase(url);

let sql: Sql;

const ORG = 'test-org';
const OTHER_ORG = 'other-org';

beforeAll(async () => {
    if (!enabled) return;
    sql = postgres(url as string, { max: 2 });
    await migrate(sql, { orgId: ORG, attempts: 3 });
});

afterAll(async () => {
    if (enabled) await sql.end();
});

beforeEach(async () => {
    if (!enabled) return;
    await sql`truncate metric_point`;
    await sql`truncate session_branch`;
});

const T = (iso: string) => new Date(iso);

async function point(row: {
    session: string;
    field: string;
    value: number;
    time: string;
    temporality?: string;
    startTime?: string;
    metric?: string;
    attrs?: Record<string, string>;
}) {
    await sql`insert into metric_point ${sql({
        agent: 'claude-code',
        metric: row.metric ?? 'claude_code.token.usage',
        field: row.field,
        session_id: row.session,
        value: row.value,
        temporality: row.temporality ?? 'delta',
        start_time: row.startTime ? T(row.startTime) : null,
        time: T(row.time),
        attrs: row.attrs ?? {},
    })}`;
}

async function branch(row: {
    session: string;
    branch: string | null;
    from: string;
    to: string;
    repo?: string;
    org?: string;
}) {
    await sql`insert into session_branch ${sql({
        org_id: row.org ?? ORG,
        agent: 'claude-code',
        session_id: row.session,
        repo: row.repo ?? 'acme/app',
        branch: row.branch,
        head_sha: null,
        first_seen: T(row.from),
        last_seen: T(row.to),
        samples: 1,
    })}`;
}

describe.skipIf(!enabled)('migrations', () => {
    it('makes metric_point a hypertable', async () => {
        const rows = await sql<{ hypertable_name: string }[]>`
            select hypertable_name from timescaledb_information.hypertables
        `;
        expect(rows.map((r) => r.hypertable_name)).toContain('metric_point');
    });

    it('is idempotent, recording each versioned file once', async () => {
        await migrate(sql, { orgId: ORG, attempts: 1 });
        await migrate(sql, { orgId: ORG, attempts: 1 });
        const rows = await sql<{ version: string; n: number }[]>`
            select version, count(*)::int as n from schema_migrations group by version
        `;
        for (const row of rows) expect(row.n).toBe(1);
        expect(rows.map((r) => r.version)).toContain('001_init.sql');
        // Repeatable files are re-applied rather than recorded, so a view fix actually lands
        // instead of being skipped until someone deletes the volume.
        expect(rows.filter((r) => r.version.endsWith('.repeatable.sql'))).toEqual([]);
    });

    it('re-applies a repeatable file on every run', async () => {
        await sql`drop view if exists session_summary`;
        await migrate(sql, { orgId: ORG, attempts: 1 });
        const [row] = await sql<{ n: number }[]>`
            select count(*)::int as n from pg_views where viewname = 'session_summary'
        `;
        expect(row?.n).toBe(1);
    });

    it('rejects a replayed datapoint rather than double-counting it', async () => {
        // OTLP delivery is at-least-once, so this index is the only thing between a retry and
        // a doubled token count.
        await point({ session: 's1', field: 'tokens_input', value: 100, time: '2026-08-01T10:00:00Z' });
        await expect(
            point({ session: 's1', field: 'tokens_input', value: 100, time: '2026-08-01T10:00:00Z' }),
        ).rejects.toThrow(/duplicate key/);
        const [row] = await sql<{ n: number }[]>`select count(*)::int as n from metric_point`;
        expect(row?.n).toBe(1);
    });
});

describe.skipIf(!enabled)('temporality reduction', () => {
    it('sums a delta series', async () => {
        for (const [i, v] of [10, 20, 30].entries()) {
            await point({ session: 's1', field: 'tokens_input', value: v, time: `2026-08-01T10:0${i}:00Z` });
        }
        const [row] = await sql<{ value: number }[]>`
            select value from session_field_total where session_id = 's1' and field = 'tokens_input'
        `;
        expect(Number(row?.value)).toBe(60);
    });

    it('takes the last value of a cumulative series, not the sum', async () => {
        // The naive sum here is 150 against a real total of 60 — 2.5x wrong, with no error
        // anywhere. This is the assertion that stops a "simplify to SUM" refactor.
        for (const [i, v] of [10, 20, 40, 50, 60].entries()) {
            await point({
                session: 's1', field: 'tokens_input', value: v,
                time: `2026-08-01T10:0${i}:00Z`,
                temporality: 'cumulative', startTime: '2026-08-01T10:00:00Z',
            });
        }
        const [row] = await sql<{ value: number }[]>`
            select value from session_field_total where session_id = 's1' and field = 'tokens_input'
        `;
        expect(Number(row?.value)).toBe(60);
    });

    it('adds cumulative series across a restart', async () => {
        // A new start_time is a new counter, so the totals add rather than replace.
        for (const [i, v] of [10, 30].entries()) {
            await point({
                session: 's1', field: 'tokens_input', value: v, time: `2026-08-01T10:0${i}:00Z`,
                temporality: 'cumulative', startTime: '2026-08-01T10:00:00Z',
            });
        }
        for (const [i, v] of [5, 12].entries()) {
            await point({
                session: 's1', field: 'tokens_input', value: v, time: `2026-08-01T11:0${i}:00Z`,
                temporality: 'cumulative', startTime: '2026-08-01T11:00:00Z',
            });
        }
        const [row] = await sql<{ value: number }[]>`
            select value from session_field_total where session_id = 's1' and field = 'tokens_input'
        `;
        expect(Number(row?.value)).toBe(42);
    });
});

describe.skipIf(!enabled)('branch slicing', () => {
    it('clamps overlapping intervals so a datapoint is counted once', async () => {
        // The upsert widens intervals, so consecutive branches routinely overlap. Without the
        // clamp in session_branch_slice this datapoint lands on both branches.
        await branch({ session: 's1', branch: 'feat/a', from: '2026-08-01T10:00:00Z', to: '2026-08-01T11:00:00Z' });
        await branch({ session: 's1', branch: 'feat/b', from: '2026-08-01T10:30:00Z', to: '2026-08-01T11:30:00Z' });
        await point({ session: 's1', field: 'tokens_input', value: 100, time: '2026-08-01T10:45:00Z' });

        const rows = await sql<{ branch: string; value: number }[]>`
            select branch, value from branch_field_total where session_id = 's1'
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.branch).toBe('feat/b');
        expect(Number(rows[0]?.value)).toBe(100);
    });

    it('divides a delta session across the branches it held', async () => {
        await branch({ session: 's1', branch: 'feat/a', from: '2026-08-01T10:00:00Z', to: '2026-08-01T10:30:00Z' });
        await branch({ session: 's1', branch: 'feat/b', from: '2026-08-01T10:30:00Z', to: '2026-08-01T11:00:00Z' });
        await point({ session: 's1', field: 'tokens_input', value: 60, time: '2026-08-01T10:10:00Z' });
        await point({ session: 's1', field: 'tokens_input', value: 40, time: '2026-08-01T10:45:00Z' });

        const rows = await sql<{ branch: string; value: number }[]>`
            select branch, value from branch_field_total where session_id = 's1' order by branch
        `;
        expect(rows.map((r) => [r.branch, Number(r.value)])).toEqual([
            ['feat/a', 60],
            ['feat/b', 40],
        ]);
        // Conservation: nothing created, nothing lost.
        const [total] = await sql<{ value: number }[]>`
            select value from session_field_total where session_id = 's1' and field = 'tokens_input'
        `;
        expect(Number(total?.value)).toBe(100);
    });

    it('widens rather than overwrites on a repeated upsert', async () => {
        await branch({ session: 's1', branch: 'feat/a', from: '2026-08-01T10:00:00Z', to: '2026-08-01T10:10:00Z' });
        await sql`
            insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen, samples)
            values (${ORG}, 'claude-code', 's1', 'acme/app', 'feat/a', ${T('2026-08-01T10:20:00Z')}, ${T('2026-08-01T10:30:00Z')}, 1)
            on conflict (org_id, agent, session_id, repo, branch) do update
                set first_seen = least(session_branch.first_seen, excluded.first_seen),
                    last_seen  = greatest(session_branch.last_seen, excluded.last_seen),
                    samples    = session_branch.samples + 1
        `;
        const [row] = await sql<{ first_seen: Date; last_seen: Date; samples: number }[]>`
            select first_seen, last_seen, samples from session_branch where session_id = 's1'
        `;
        expect(row?.first_seen.toISOString()).toBe('2026-08-01T10:00:00.000Z');
        expect(row?.last_seen.toISOString()).toBe('2026-08-01T10:30:00.000Z');
        expect(row?.samples).toBe(2);
    });
});

describe.skipIf(!enabled)('the postgres client', () => {
    it('reports an empty store as empty, not unreachable', async () => {
        const client = createPostgresTelemetryClient({ sql, orgId: ORG });
        expect((await client.health()).status).toBe('empty');
        const input = await client.fetchRollups();
        expect(input.sessions).toEqual([]);
        expect(input.coverage).toEqual({ from: null, to: null });
    });

    it('marks a multi-branch cumulative session indivisible instead of halving it', async () => {
        await branch({ session: 's1', branch: 'feat/a', from: '2026-08-01T10:00:00Z', to: '2026-08-01T10:30:00Z' });
        await branch({ session: 's1', branch: 'feat/b', from: '2026-08-01T10:30:00Z', to: '2026-08-01T11:00:00Z' });
        await point({
            session: 's1', field: 'tokens_input', value: 100, time: '2026-08-01T10:59:00Z',
            temporality: 'cumulative', startTime: '2026-08-01T10:00:00Z',
        });

        const client = createPostgresTelemetryClient({ sql, orgId: ORG });
        const input = await client.fetchRollups();
        expect(input.sessions[0]?.granularity).toBe('session');
        expect(input.splits).toHaveLength(2);
        for (const split of input.splits) {
            expect(split.share).toBeNull();
            expect(split.tokens.input).toBeNull();
        }
        // The session total survives: the work happened, it just cannot be placed.
        expect(input.sessions[0]?.tokens.input).toBe(100);
    });

    it('attributes a single-branch cumulative session in full', async () => {
        await branch({ session: 's1', branch: 'feat/a', from: '2026-08-01T10:00:00Z', to: '2026-08-01T11:00:00Z' });
        await point({
            session: 's1', field: 'tokens_input', value: 100, time: '2026-08-01T10:59:00Z',
            temporality: 'cumulative', startTime: '2026-08-01T10:00:00Z',
        });

        const input = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.splits[0]?.share).toBe(1);
        expect(input.splits[0]?.tokens.input).toBe(100);
    });

    it('reports a session with no hook data as repo null', async () => {
        await point({ session: 's1', field: 'tokens_input', value: 10, time: '2026-08-01T10:00:00Z' });
        const input = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.sessions[0]?.repo).toBeNull();
        expect(input.splits).toEqual([]);
    });

    it("does not attribute one organization's session to another's branch", async () => {
        // Same repo path, same branch name, same session window — routine across tenants. Keyed
        // without org_id, the slice from one organization would claim the other's datapoints, and
        // the number rendered would be plausible and wrong.
        await branch({
            session: 's1', branch: 'feat/a',
            from: '2026-08-01T10:00:00Z', to: '2026-08-01T11:00:00Z',
        });
        await branch({
            session: 's1', branch: 'feat/a', org: OTHER_ORG,
            from: '2026-08-01T10:00:00Z', to: '2026-08-01T11:00:00Z',
        });
        await point({ session: 's1', field: 'tokens_input', value: 100, time: '2026-08-01T10:30:00Z' });

        // One slice each, not two apiece: session_branch_slice partitions its window by org, so
        // neither organization's clamp truncates the other's.
        const mine = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        const theirs = await createPostgresTelemetryClient({ sql, orgId: OTHER_ORG }).fetchRollups();
        expect(mine.spans).toHaveLength(1);
        expect(theirs.spans).toHaveLength(1);
        expect(mine.splits.map((s) => s.tokens.input)).toEqual([100]);
        expect(theirs.splits.map((s) => s.tokens.input)).toEqual([100]);
    });

    it('still reports a hook-less session, which belongs to no organization', async () => {
        // session_summary reads its org from session_branch, so a session the hook never covered
        // has none. Those rows feed sessionsWithoutHook — the number that says the plugin is
        // missing or broken — so filtering them by org would make a broken hook look like an idle
        // week.
        await point({ session: 'orphan', field: 'tokens_input', value: 10, time: '2026-08-01T10:00:00Z' });
        const input = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.sessions.map((s) => s.sessionId)).toEqual(['orphan']);
        expect(input.sessions[0]?.repo).toBeNull();
    });

    it('leaves unmeasured fields null rather than zero', async () => {
        await branch({ session: 's1', branch: 'feat/a', from: '2026-08-01T10:00:00Z', to: '2026-08-01T11:00:00Z' });
        await point({ session: 's1', field: 'tokens_input', value: 10, time: '2026-08-01T10:00:00Z' });
        const input = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        const session = input.sessions[0];
        expect(session?.tokens.input).toBe(10);
        expect(session?.tokens.output).toBeNull();
        expect(session?.linesAdded).toBeNull();
        expect(session?.editsAccepted).toBeNull();
        expect(session?.activeSeconds).toBeNull();
    });

    it('stores an unmapped metric rather than rejecting it', async () => {
        // A future tool's data must accumulate before support for it is written.
        await sql`insert into metric_point ${sql({
            agent: 'unknown', metric: 'opencode.tokens.total', field: null, session_id: 's9',
            value: 5, temporality: 'delta', start_time: null, time: T('2026-08-01T10:00:00Z'), attrs: {},
        })}`;
        const [row] = await sql<{ n: number }[]>`
            select count(*)::int as n from metric_point where field is null
        `;
        expect(row?.n).toBe(1);
        // ...and it does not leak into the aggregation.
        const totals = await sql`select * from session_field_total where session_id = 's9'`;
        expect(totals).toHaveLength(0);
    });

    it('aggregates an opencode run under its own agent', async () => {
        // The opencode-executor emits `opencode.*` metrics; they must price as their own agent,
        // not vanish into the null-field filter or mislabel as claude-code.
        await sql`insert into metric_point ${sql({
            agent: 'opencode', metric: 'opencode.active_time.total', field: 'active_seconds',
            session_id: 's10', value: 12, temporality: 'delta', start_time: null,
            time: T('2026-08-01T10:00:00Z'), attrs: {},
        })}`;
        const [row] = await sql<{ agent: string; value: number }[]>`
            select agent, value from session_field_total where session_id = 's10'
        `;
        expect(row?.agent).toBe('opencode');
        expect(row?.value).toBe(12);
    });
});
