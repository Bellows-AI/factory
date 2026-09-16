import type { Sql } from 'postgres';
import type { JobRun, SessionRollup, TelemetryInput, TokenTotals, UserRef } from '@factory-ai/core';
import type { TelemetryClient, TelemetryFetch, TelemetryHealth } from './client.js';
import { TelemetryError } from './errors.js';
import type { CanonicalField } from './metric-map.js';

interface SummaryRow {
    agent: string;
    session_id: string;
    repo: string | null;
    first_seen: Date;
    last_seen: Date;
    user_id: string | null;
    user_login: string | null;
    user_name: string | null;
    user_avatar_url: string | null;
    task_id: string | null;
}

interface RunRow {
    root_job_id: string;
    repo: string | null;
    created_by: string | null;
    created_at: Date;
    agent_turns: number | null;
    /** bigint reads back as a string; converted where the rows map to JobRun. */
    wall_clock_ms: string | null;
}

interface FieldRow {
    session_id: string;
    field: CanonicalField;
    value: number;
}

/** Fields absent from a query stay null: nothing measured is not the same as zero. */
function pick(values: Map<CanonicalField, number>) {
    const get = (field: CanonicalField) => values.get(field) ?? null;
    const tokens: TokenTotals = {
        input: get('tokens_input'),
        output: get('tokens_output'),
        cacheRead: get('tokens_cacheRead'),
        cacheCreation: get('tokens_cacheCreation'),
    };
    return {
        tokens,
        linesAdded: get('lines_added'),
        linesRemoved: get('lines_removed'),
        editsAccepted: get('edits_accept'),
        editsRejected: get('edits_reject'),
        activeSeconds: get('active_seconds'),
    };
}

function group<T extends { session_id: string }>(rows: T[]): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const row of rows) {
        const list = out.get(row.session_id) ?? [];
        list.push(row);
        out.set(row.session_id, list);
    }
    return out;
}

export interface PostgresTelemetryDeps {
    sql: Sql;
    /** The organization whose sessions this client reports. Bound once; see the stores. */
    orgId: string;
    /**
     * Resolves when migrations have been applied. Awaited per query rather than at
     * construction so the process can start serving before the database is up — the HTTP
     * surface needs no database, and must not wait for one.
     */
    ready?: Promise<unknown>;
}

export function createPostgresTelemetryClient({ sql, orgId, ready }: PostgresTelemetryDeps): TelemetryClient {
    return {
        async fetchRollups(): Promise<TelemetryFetch> {
            try {
                if (ready) await ready;
                // Not filtered by repo here: telemetryStats() applies the filter, and the counts
                // of other-repo and hook-less sessions are what diagnose a bad setup.
                //
                // The user join resolves WHO queued the board task each session belongs to,
                // at read time and from the board's own audit rows: session id → job (follow-ups
                // share the parent's session AND, by the follow-up author guard, its author, so
                // min(created_by) is that one author, never a coin flip between two) →
                // app_user. The telemetry tables carry no identity themselves — the collector
                // strips it on purpose (docs/organizations.md) — and they stay that way; this
                // read-side join is the whole attribution path, so a session with no matching
                // job row (a local dev run, a backfilled transcript) simply stays null. The
                // subquery groups job on (org_id, session_id) with no index behind it — the
                // stats read is cooldown-gated and job tables are small next to metric_point;
                // add one only when a real deployment measures this read.
                //
                // task_id rides the same subquery: every job row sharing a session id sits in
                // one thread (follow-ups copy the parent's root_job_id), so the minimum is that
                // root, deterministically. Author-less rows stay in the group rather than being
                // filtered — min() ignores the nulls, so member resolution is untouched, and a
                // session whose only row predates attribution still resolves to its task.
                // All three reads share ONE repeatable-read snapshot: the summary's taskKey and
                // the run rows both come from `job`, and a thread removal committing between
                // two independent reads would leave a session pointing at a task whose runs no
                // longer exist — taskUsageStats() must combine one database moment, not two.
                // Read-only: nothing here writes, and the mode is the database's to enforce.
                return sql.begin('isolation level repeatable read, read only', async (tx): Promise<TelemetryFetch> => {
                    const [summaries, sessionFields, runRows] = await Promise.all([
                        // `or org_id is null` is not laxity. session_summary reads its org from
                        // session_branch, so a session the hook never reported for has none — and
                        // those are exactly the rows that feed sessionsWithoutHook, the number that
                        // says the plugin is missing or broken. Filtering them out would make a
                        // broken hook look like an idle week.
                        tx<SummaryRow[]>`
                                select ss.*, ju.created_by as user_id, au.github_login as user_login,
                                       au.display_name as user_name, au.avatar_url as user_avatar_url,
                                       ju.task_id
                                from session_summary ss
                                left join (
                                    -- min over text: Postgres has no min(uuid) aggregate. Every member of
                                    -- a thread shares one author (the follow-up guard), so the minimum is
                                    -- that author, deterministically.
                                    select org_id, session_id, min(created_by::text)::uuid as created_by,
                                           min(root_job_id::text)::uuid as task_id
                                    from job
                                    where session_id is not null
                                    group by org_id, session_id
                                ) ju on ju.org_id = ss.org_id and ju.session_id = ss.session_id
                                left join app_user au on au.id = ju.created_by
                                where ss.org_id = ${orgId} or ss.org_id is null
                            `,
                        // Unfiltered: this view reads metric_point_used, which has no org column by
                        // design. It is a lookup keyed by session id, and only the ids present in the
                        // filtered summaries above are ever read out of it.
                        tx<FieldRow[]>`select session_id, field, value from session_field_total`,
                        // The org's own run rows, cached beside the rollups for the per-task
                        // statistics: one round-trip against the table the join above already
                        // touches, at a volume where that read is single-digit-ms. They ride the
                        // same snapshot and the same TTL, which is what lets every range AND scope
                        // be served without a second fetch.
                        tx<RunRow[]>`
                                select root_job_id, repo, created_by, created_at, agent_turns, wall_clock_ms
                                from job
                                where org_id = ${orgId}
                            `,
                    ]);

                    const byField = group(sessionFields);

                    const sessions: SessionRollup[] = summaries.map((s) => {
                        const values = new Map<CanonicalField, number>(
                            (byField.get(s.session_id) ?? []).map((r) => [r.field, Number(r.value)])
                        );
                        const user: UserRef | null =
                            s.user_id === null || s.user_login === null
                                ? null
                                : {
                                      id: s.user_id,
                                      login: s.user_login,
                                      name: s.user_name,
                                      avatarUrl: s.user_avatar_url,
                                  };
                        return {
                            sessionId: s.session_id,
                            agent: s.agent,
                            repo: s.repo,
                            user,
                            taskKey: s.task_id,
                            firstSeen: s.first_seen.toISOString(),
                            lastSeen: s.last_seen.toISOString(),
                            commits: values.get('commits') ?? null,
                            ...pick(values),
                        };
                    });

                    const times = summaries.flatMap((s) => [s.first_seen, s.last_seen]);
                    const runs: JobRun[] = runRows.map((r) => ({
                        rootJobId: r.root_job_id,
                        repo: r.repo,
                        createdBy: r.created_by,
                        createdAt: r.created_at.toISOString(),
                        agentTurns: r.agent_turns,
                        wallClockMs: r.wall_clock_ms == null ? null : Number(r.wall_clock_ms),
                    }));
                    return {
                        input: {
                            sessions,
                            coverage: {
                                from: times.length
                                    ? new Date(Math.min(...times.map((t) => t.getTime()))).toISOString()
                                    : null,
                                to: times.length
                                    ? new Date(Math.max(...times.map((t) => t.getTime()))).toISOString()
                                    : null,
                            },
                        },
                        runs,
                    };
                });
            } catch (e) {
                // A migration failure keeps its own code: "the schema is not there" and "the
                // query is wrong" want different fixes.
                if (e instanceof TelemetryError) throw e;
                throw new TelemetryError((e as Error).message, 'QUERY');
            }
        },

        async health(): Promise<TelemetryHealth> {
            try {
                if (ready) await ready;
                // Deliberately NOT org-scoped. This answers "is the ingest pipeline alive", which
                // is a property of the deployment, not of an organization — and metric_point has
                // no org column anyway, so scoping it would mean joining through session_branch
                // and thereby reporting `empty` for a pipeline that is receiving data from a
                // session the hook never reported. That is the exact state `empty` exists to
                // distinguish itself from.
                const [row] = await sql<{ n: number }[]>`select count(*)::int as n from metric_point`;
                if ((row?.n ?? 0) === 0) {
                    return { status: 'empty', reason: 'No telemetry datapoints have arrived yet' };
                }
                return { status: 'ok', reason: null };
            } catch (e) {
                return { status: 'unreachable', reason: (e as Error).message };
            }
        },
    };
}
