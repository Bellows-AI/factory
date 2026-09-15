import type { Sql } from 'postgres';
import type { SessionRollup, TelemetryInput, TokenTotals, UserRef } from '@factory-ai/core';
import type { TelemetryClient, TelemetryHealth } from './client.js';
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
        async fetchRollups(): Promise<TelemetryInput> {
            try {
                if (ready) await ready;
                // Not filtered by repo here: telemetryStats() applies the filter, and the counts
                // of other-repo and hook-less sessions are what diagnose a bad setup.
                const [summaries, sessionFields] = await Promise.all([
                    // `or org_id is null` is not laxity. session_summary reads its org from
                    // session_branch, so a session the hook never reported for has none — and
                    // those are exactly the rows that feed sessionsWithoutHook, the number that
                    // says the plugin is missing or broken. Filtering them out would make a
                    // broken hook look like an idle week.
                    //
                    // The user join resolves WHO queued the board task each session belongs to,
                    // at read time and from the board's own audit rows: session id → job (follow-ups
                    // share the parent's session AND, by the follow-up author guard, its author, so
                    // min(created_by) is that one author, never a coin flip between two) →
                    // app_user. The telemetry tables carry no identity themselves — the collector
                    // strips it on purpose (docs/organizations.md) — and they stay that way; this
                    // read-side join is the whole attribution path, so a session with no matching
                    // job row (a local dev run, a backfilled transcript) simply stays null.
                    sql<SummaryRow[]>`
                        select ss.*, ju.created_by as user_id, au.github_login as user_login,
                               au.display_name as user_name, au.avatar_url as user_avatar_url
                        from session_summary ss
                        left join (
                            -- min over text: Postgres has no min(uuid) aggregate. Every member of
                            -- a thread shares one author (the follow-up guard), so the minimum is
                            -- that author, deterministically.
                            select org_id, session_id, min(created_by::text)::uuid as created_by
                            from job
                            where session_id is not null and created_by is not null
                            group by org_id, session_id
                        ) ju on ju.org_id = ss.org_id and ju.session_id = ss.session_id
                        left join app_user au on au.id = ju.created_by
                        where ss.org_id = ${orgId} or ss.org_id is null
                    `,
                    // Unfiltered: this view reads metric_point_used, which has no org column by
                    // design. It is a lookup keyed by session id, and only the ids present in the
                    // filtered summaries above are ever read out of it.
                    sql<FieldRow[]>`select session_id, field, value from session_field_total`,
                ]);

                const byField = group(sessionFields);

                const sessions: SessionRollup[] = summaries.map((s) => {
                    const values = new Map<CanonicalField, number>(
                        (byField.get(s.session_id) ?? []).map((r) => [r.field, Number(r.value)])
                    );
                    const user: UserRef | null =
                        s.user_id === null || s.user_login === null
                            ? null
                            : { id: s.user_id, login: s.user_login, name: s.user_name, avatarUrl: s.user_avatar_url };
                    return {
                        sessionId: s.session_id,
                        agent: s.agent,
                        repo: s.repo,
                        user,
                        firstSeen: s.first_seen.toISOString(),
                        lastSeen: s.last_seen.toISOString(),
                        commits: values.get('commits') ?? null,
                        ...pick(values),
                    };
                });

                const times = summaries.flatMap((s) => [s.first_seen, s.last_seen]);
                return {
                    sessions,
                    coverage: {
                        from: times.length ? new Date(Math.min(...times.map((t) => t.getTime()))).toISOString() : null,
                        to: times.length ? new Date(Math.max(...times.map((t) => t.getTime()))).toISOString() : null,
                    },
                };
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
