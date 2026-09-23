import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { telemetryStats } from '@factory-ai/core';
import { migrate } from '../src/db/migrate.js';
import { createPostgresTelemetryClient } from '../src/telemetry/postgres-client.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;

const ORG = 'test-org';
const OTHER_ORG = 'other-org';

const db = useTestDb({ max: 2 });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
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
        await migrate(sql, { attempts: 1 });
        await migrate(sql, { attempts: 1 });
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
        await migrate(sql, { attempts: 1 });
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
            point({ session: 's1', field: 'tokens_input', value: 100, time: '2026-08-01T10:00:00Z' })
        ).rejects.toThrow(/duplicate key/);
        const [row] = await sql<{ n: number }[]>`select count(*)::int as n from metric_point`;
        expect(row?.n).toBe(1);
    });
});

describe.skipIf(!enabled)('temporality reduction', () => {
    it('sums a delta series', async () => {
        const SECOND_DELTA = 20;
        const THIRD_DELTA = 30;
        const DELTA_VALUES = [10, SECOND_DELTA, THIRD_DELTA];
        for (const [i, v] of DELTA_VALUES.entries()) {
            await point({ session: 's1', field: 'tokens_input', value: v, time: `2026-08-01T10:0${i}:00Z` });
        }
        const [row] = await sql<{ value: number }[]>`
            select value from session_field_total where session_id = 's1' and field = 'tokens_input'
        `;
        const EXPECTED_TOTAL = 60;
        expect(Number(row?.value)).toBe(EXPECTED_TOTAL);
    });

    it('takes the last value of a cumulative series, not the sum', async () => {
        // The naive sum here is 150 against a real total of 60 — 2.5x wrong, with no error
        // anywhere. This is the assertion that stops a "simplify to SUM" refactor.
        const SECOND_CUMULATIVE = 20;
        const THIRD_CUMULATIVE = 40;
        const FOURTH_CUMULATIVE = 50;
        const CUMULATIVE_VALUES = [10, SECOND_CUMULATIVE, THIRD_CUMULATIVE, FOURTH_CUMULATIVE, 60];
        for (const [i, v] of CUMULATIVE_VALUES.entries()) {
            await point({
                session: 's1',
                field: 'tokens_input',
                value: v,
                time: `2026-08-01T10:0${i}:00Z`,
                temporality: 'cumulative',
                startTime: '2026-08-01T10:00:00Z',
            });
        }
        const [row] = await sql<{ value: number }[]>`
            select value from session_field_total where session_id = 's1' and field = 'tokens_input'
        `;
        const EXPECTED_TOTAL = 60;
        expect(Number(row?.value)).toBe(EXPECTED_TOTAL);
    });

    it('adds cumulative series across a restart', async () => {
        // A new start_time is a new counter, so the totals add rather than replace.
        const FIRST_WINDOW_SECOND_VALUE = 30;
        const FIRST_WINDOW_VALUES = [10, FIRST_WINDOW_SECOND_VALUE];
        for (const [i, v] of FIRST_WINDOW_VALUES.entries()) {
            await point({
                session: 's1',
                field: 'tokens_input',
                value: v,
                time: `2026-08-01T10:0${i}:00Z`,
                temporality: 'cumulative',
                startTime: '2026-08-01T10:00:00Z',
            });
        }
        const SECOND_WINDOW_FIRST_VALUE = 5;
        const SECOND_WINDOW_SECOND_VALUE = 12;
        const SECOND_WINDOW_VALUES = [SECOND_WINDOW_FIRST_VALUE, SECOND_WINDOW_SECOND_VALUE];
        for (const [i, v] of SECOND_WINDOW_VALUES.entries()) {
            await point({
                session: 's1',
                field: 'tokens_input',
                value: v,
                time: `2026-08-01T11:0${i}:00Z`,
                temporality: 'cumulative',
                startTime: '2026-08-01T11:00:00Z',
            });
        }
        const [row] = await sql<{ value: number }[]>`
            select value from session_field_total where session_id = 's1' and field = 'tokens_input'
        `;
        const EXPECTED_TOTAL = 42;
        expect(Number(row?.value)).toBe(EXPECTED_TOTAL);
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
        const EXPECTED_VALUE = 100;
        expect(Number(rows[0]?.value)).toBe(EXPECTED_VALUE);
    });

    it('divides a delta session across the branches it held', async () => {
        await branch({ session: 's1', branch: 'feat/a', from: '2026-08-01T10:00:00Z', to: '2026-08-01T10:30:00Z' });
        await branch({ session: 's1', branch: 'feat/b', from: '2026-08-01T10:30:00Z', to: '2026-08-01T11:00:00Z' });
        await point({ session: 's1', field: 'tokens_input', value: 60, time: '2026-08-01T10:10:00Z' });
        await point({ session: 's1', field: 'tokens_input', value: 40, time: '2026-08-01T10:45:00Z' });

        const rows = await sql<{ branch: string; value: number }[]>`
            select branch, value from branch_field_total where session_id = 's1' order by branch
        `;
        const FEAT_B_VALUE = 40;
        expect(rows.map((r) => [r.branch, Number(r.value)])).toEqual([
            ['feat/a', 60],
            ['feat/b', FEAT_B_VALUE],
        ]);
        // Conservation: nothing created, nothing lost.
        const [total] = await sql<{ value: number }[]>`
            select value from session_field_total where session_id = 's1' and field = 'tokens_input'
        `;
        const EXPECTED_TOTAL = 100;
        expect(Number(total?.value)).toBe(EXPECTED_TOTAL);
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
        const { input } = await client.fetchRollups();
        expect(input.sessions).toEqual([]);
        expect(input.coverage).toEqual({ from: null, to: null });
    });

    it('reports a session with no hook data as repo null', async () => {
        await point({ session: 's1', field: 'tokens_input', value: 10, time: '2026-08-01T10:00:00Z' });
        const { input } = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.sessions[0]?.repo).toBeNull();
    });

    it('still reports a hook-less session, which belongs to no organization', async () => {
        // session_summary reads its org from session_branch, so a session the hook never covered
        // has none. Those rows feed sessionsWithoutHook — the number that says the plugin is
        // missing or broken — so filtering them by org would make a broken hook look like an idle
        // week.
        await point({ session: 'orphan', field: 'tokens_input', value: 10, time: '2026-08-01T10:00:00Z' });
        const { input } = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.sessions.map((s) => s.sessionId)).toEqual(['orphan']);
        expect(input.sessions[0]?.repo).toBeNull();
    });

    it('leaves unmeasured fields null rather than zero', async () => {
        await branch({ session: 's1', branch: 'feat/a', from: '2026-08-01T10:00:00Z', to: '2026-08-01T11:00:00Z' });
        await point({ session: 's1', field: 'tokens_input', value: 10, time: '2026-08-01T10:00:00Z' });
        const { input } = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
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
            agent: 'unknown',
            metric: 'opencode.tokens.total',
            field: null,
            session_id: 's9',
            value: 5,
            temporality: 'delta',
            start_time: null,
            time: T('2026-08-01T10:00:00Z'),
            attrs: {},
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
            agent: 'opencode',
            metric: 'opencode.active_time.total',
            field: 'active_seconds',
            session_id: 's10',
            value: 12,
            temporality: 'delta',
            start_time: null,
            time: T('2026-08-01T10:00:00Z'),
            attrs: {},
        })}`;
        const [row] = await sql<{ agent: string; value: number }[]>`
            select agent, value from session_field_total where session_id = 's10'
        `;
        expect(row?.agent).toBe('opencode');
        const EXPECTED_ACTIVE_SECONDS = 12;
        expect(row?.value).toBe(EXPECTED_ACTIVE_SECONDS);
    });
});

describe.skipIf(!enabled)('session attribution', () => {
    // WHO queued the board task a session belongs to, resolved by joining the telemetry rows to
    // the job audit rows on session id at read time. The telemetry tables stay identity-free —
    // the collector strips identity on purpose — so a session with no matching job row (a local
    // dev run, a backfilled transcript) reads user null, never a guess.

    /** Unique per run — a shared factory_test database must not let accounts collide with
     * another suite's, or with rows a failed run left behind. */
    let userSeq = 0;
    const TIMESTAMP_MODULUS = 1_000_000_000;
    const TIMESTAMP_SHIFT = 1000;
    const githubUserId = () => (Date.now() % TIMESTAMP_MODULUS) * TIMESTAMP_SHIFT + ++userSeq;
    const account = async (login: string): Promise<string> => {
        const [row] = await sql<{ id: string }[]>`
            insert into app_user (github_user_id, github_login)
            values (${githubUserId()}, ${login})
            returning id
        `;
        return row!.id;
    };

    const job = async (row: { session: string; createdBy: string | null; org?: string }): Promise<string> => {
        const id = randomUUID();
        await sql`
            insert into job (org_id, id, command, status, root_job_id, created_by, session_id, created_at)
            values (${row.org ?? ORG}, ${id}, 'attributed', 'succeeded', ${id}, ${row.createdBy}, ${row.session}, now())
        `;
        return id;
    };

    it('resolves the user of the board task a session belongs to', async () => {
        const userId = await account('attributor');
        const jobId = await job({ session: 'attr-1', createdBy: userId });
        await point({ session: 'attr-1', field: 'tokens_input', value: 1, time: '2026-08-01T10:30:00Z' });
        await branch({
            session: 'attr-1',
            branch: 'feat/a',
            from: '2026-08-01T10:00:00Z',
            to: '2026-08-01T11:00:00Z',
        });

        const { input } = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.sessions[0]?.user).toEqual({
            id: userId,
            login: 'attributor',
            name: null,
            avatarUrl: null,
        });
        await sql`delete from job where id = ${jobId}`;
        await sql`delete from app_user where id = ${userId}`;
    });

    it('carries the display labels the account has, and null when it has none', async () => {
        const userId = (
            await sql<{ id: string }[]>`
                insert into app_user (github_user_id, github_login, display_name, avatar_url)
                values (${githubUserId()}, 'labeled', 'Ada Lovelace', 'https://example.com/ada.png')
                returning id
            `
        )[0]!.id;
        const jobId = await job({ session: 'attr-2', createdBy: userId });
        await point({ session: 'attr-2', field: 'tokens_input', value: 1, time: '2026-08-01T10:30:00Z' });
        await branch({
            session: 'attr-2',
            branch: 'feat/a',
            from: '2026-08-01T10:00:00Z',
            to: '2026-08-01T11:00:00Z',
        });

        const { input } = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.sessions[0]?.user).toEqual({
            id: userId,
            login: 'labeled',
            name: 'Ada Lovelace',
            avatarUrl: 'https://example.com/ada.png',
        });
        await sql`delete from job where id = ${jobId}`;
        await sql`delete from app_user where id = ${userId}`;
    });

    it('keeps a session with no matching task unattributed rather than guessed', async () => {
        await branch({
            session: 'attr-3',
            branch: 'feat/a',
            from: '2026-08-01T10:00:00Z',
            to: '2026-08-01T11:00:00Z',
        });
        await point({ session: 'attr-3', field: 'tokens_input', value: 1, time: '2026-08-01T10:30:00Z' });

        const { input } = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.sessions[0]?.user).toBeNull();
    });

    it('resolves a follow-up chain to its one shared author', async () => {
        // Every member of a thread shares the parent's session AND, by the follow-up author
        // guard, the parent's author — so the join is deterministic no matter which member's row
        // the minimum happens to pick.
        const userId = await account('thread-author');
        const rootId = await job({ session: 'attr-4', createdBy: userId });
        await sql`
            insert into job (org_id, id, command, status, root_job_id, parent_job_id, created_by, session_id, created_at)
            values (${ORG}, ${randomUUID()}, 'attributed', 'succeeded', ${rootId}, ${rootId}, ${userId}, 'attr-4', now())
        `;
        await branch({
            session: 'attr-4',
            branch: 'feat/a',
            from: '2026-08-01T10:00:00Z',
            to: '2026-08-01T11:00:00Z',
        });
        await point({ session: 'attr-4', field: 'tokens_input', value: 1, time: '2026-08-01T10:30:00Z' });

        const { input } = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.sessions).toHaveLength(1);
        expect(input.sessions[0]?.user?.login).toBe('thread-author');
        await sql`delete from job where root_job_id = ${rootId}`;
        await sql`delete from app_user where id = ${userId}`;
    });

    it("does not attribute one organization's session through another organization's job", async () => {
        const userId = await account('other-org-author');
        const jobId = await job({ session: 'attr-5', createdBy: userId, org: OTHER_ORG });
        await branch({
            session: 'attr-5',
            branch: 'feat/a',
            from: '2026-08-01T10:00:00Z',
            to: '2026-08-01T11:00:00Z',
        });
        await point({ session: 'attr-5', field: 'tokens_input', value: 1, time: '2026-08-01T10:30:00Z' });

        const mine = (await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups()).input;
        expect(mine.sessions[0]?.user).toBeNull();
        await sql`delete from job where id = ${jobId}`;
        await sql`delete from app_user where id = ${userId}`;
    });
});

describe.skipIf(!enabled)('task attribution', () => {
    // WHICH task thread a session belongs to, resolved by the SAME subquery that resolves its
    // member: a session id carried by any job row resolves to that row's thread root, so the
    // task travels beside the user it was landed with — never through a second lookup.

    let userSeq = 0;
    const TIMESTAMP_MODULUS = 1_000_000_000;
    const TIMESTAMP_SHIFT = 1000;
    const githubUserId = () => (Date.now() % TIMESTAMP_MODULUS) * TIMESTAMP_SHIFT + ++userSeq;
    const account = async (login: string): Promise<string> => {
        const [row] = await sql<{ id: string }[]>`
            insert into app_user (github_user_id, github_login)
            values (${githubUserId()}, ${login})
            returning id
        `;
        return row!.id;
    };

    const job = async (row: {
        session?: string | null;
        createdBy?: string | null;
        root?: string;
        parent?: string;
        org?: string;
    }): Promise<string> => {
        const id = randomUUID();
        await sql`
            insert into job (org_id, id, command, status, root_job_id, parent_job_id, created_by, session_id, created_at)
            values (${row.org ?? ORG}, ${id}, 'attributed', 'succeeded', ${row.root ?? id}, ${row.parent ?? null},
                    ${row.createdBy ?? null}, ${row.session ?? null}, now())
        `;
        return id;
    };

    const fetchOrg = async (org = ORG) => createPostgresTelemetryClient({ sql, orgId: org }).fetchRollups();

    const seedSession = async (session: string) => {
        await branch({
            session,
            branch: 'feat/a',
            from: '2026-08-01T10:00:00Z',
            to: '2026-08-01T11:00:00Z',
        });
        await point({ session, field: 'tokens_input', value: 10, time: '2026-08-01T10:30:00Z' });
    };

    it('attributes an executor session to its task beside the member attribution', async () => {
        const userId = await account('task-author');
        const rootId = await job({ session: 'task-1', createdBy: userId });
        await seedSession('task-1');

        const { input } = await fetchOrg();
        expect(input.sessions[0]?.user?.login).toBe('task-author');
        expect(input.sessions[0]?.taskKey).toBe(rootId);
        await sql`delete from job`;
        await sql`delete from app_user where id = ${userId}`;
    });

    it('resolves a follow-up chain to the one thread root', async () => {
        // The follow-up copies the parent's session AND root_job_id, so both rows land in the
        // same group and the minimum is that root — the session is counted once under it.
        const userId = await account('chain-author');
        const rootId = await job({ session: 'task-2', createdBy: userId });
        await job({ session: 'task-2', createdBy: userId, root: rootId, parent: rootId });
        await seedSession('task-2');

        const { input } = await fetchOrg();
        expect(input.sessions).toHaveLength(1);
        expect(input.sessions[0]?.taskKey).toBe(rootId);
        await sql`delete from job`;
        await sql`delete from app_user where id = ${userId}`;
    });

    it('keeps a session with no matching job row task-less, exactly as it is member-less', async () => {
        await seedSession('task-3');
        const { input } = await fetchOrg();
        expect(input.sessions[0]?.taskKey).toBeNull();
        expect(input.sessions[0]?.user).toBeNull();
    });

    it('resolves the task of an author-less row even though the member stays null', async () => {
        // A row that predates attribution still names its thread: min() ignores the null
        // author, so member resolution is untouched — and the task is still known.
        const rootId = await job({ session: 'task-4', createdBy: null });
        await seedSession('task-4');

        const { input } = await fetchOrg();
        expect(input.sessions[0]?.taskKey).toBe(rootId);
        expect(input.sessions[0]?.user).toBeNull();
        await sql`delete from job`;
    });

    it('leaves a removed thread with neither member nor task, its tokens still in the totals', async () => {
        // Deleting the thread's job rows removes the only bridge to both the member and the
        // task — the session falls into the unattributed figure rather than vanishing, and
        // its tokens keep counting in the organization's totals.
        const userId = await account('doomed-author');
        const rootId = await job({ session: 'task-5', createdBy: userId });
        await seedSession('task-5');

        const before = await fetchOrg();
        expect(before.input.sessions[0]?.taskKey).toBe(rootId);
        expect(before.input.sessions[0]?.tokens.input).toBe(10);

        await sql`delete from job where root_job_id = ${rootId}`;
        const { input } = await fetchOrg();
        expect(input.sessions[0]?.taskKey).toBeNull();
        expect(input.sessions[0]?.user).toBeNull();
        expect(input.sessions[0]?.tokens.input).toBe(10);
        const stats = telemetryStats(input);
        expect(stats.unattributedSessions).toBe(1);
        expect(stats.totals.tokens.input).toBe(10);
        await sql`delete from app_user where id = ${userId}`;
    });

    it('fetches the org run rows beside the rollups, and never another orgs', async () => {
        const mineRoot = await job({ session: 'task-6', createdBy: null });
        await seedSession('task-6');
        await job({ session: 'task-7', createdBy: null, org: OTHER_ORG });

        const { input, runs } = await fetchOrg();
        expect(input.sessions.map((s) => s.sessionId)).toEqual(['task-6']);
        // Org-scoped: the other organization's run row stays out of this snapshot.
        expect(runs.map((r) => r.rootJobId)).toEqual([mineRoot]);
        // The column is new: every row so far reads unmeasured, never zero.
        expect(runs[0]?.agentTurns).toBeNull();
        await sql`delete from job`;
    });
});
