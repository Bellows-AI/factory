import type { Sql } from 'postgres';
import type { SessionRollup, TelemetryInput, TokenTotals } from '@factory-ai/core';
import type { TelemetryClient, TelemetryHealth } from './client.js';
import { TelemetryError } from './errors.js';
import type { CanonicalField } from './metric-map.js';

interface SummaryRow {
    agent: string;
    session_id: string;
    repo: string | null;
    first_seen: Date;
    last_seen: Date;
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
                    sql<SummaryRow[]>`
                        select * from session_summary where org_id = ${orgId} or org_id is null
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
                    return {
                        sessionId: s.session_id,
                        agent: s.agent,
                        repo: s.repo,
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
