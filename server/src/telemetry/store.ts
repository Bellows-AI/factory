import type { Sql } from 'postgres';
import type { MetricRow } from './otlp.js';

export interface SessionBranchReport {
    agent: string;
    sessionId: string;
    repo: string;
    branch: string | null;
    headSha: string | null;
    at: string;
}

/**
 * The write side. Kept separate from the flattener so the wire-format parsing stays testable
 * without a database.
 */
export interface TelemetryStore {
    insertMetrics(rows: MetricRow[]): Promise<number>;
    recordBranch(report: SessionBranchReport, orgId: string): Promise<void>;
}

/**
 * WHERE THE ORG COMES FROM — the credential verified at the ingest boundary, never the report's
 * repo. A report's `repo` is caller-controlled payload, and matching its owner against the
 * installation orgs let any caller write telemetry into another organization by naming its
 * repository (CWE-862). The route now records with `orgOf(request)`: the attempt's org for the
 * runner's job-id + lease-token pair, the membership's org for the laptop plugin's personal
 * bearer. `metric_point` keeps no org of its own — a datapoint's organization is still resolved
 * through `session_branch`, exactly as its repo is.
 */
export function createPostgresStore({ sql }: { sql: Sql }): TelemetryStore {
    return {
        async insertMetrics(rows) {
            if (!rows.length) return 0;

            const payload = rows.map((row) => ({
                agent: row.agent,
                metric: row.metric,
                field: row.field,
                session_id: row.sessionId,
                value: row.value,
                temporality: row.temporality,
                start_time: row.startTime ? new Date(row.startTime) : null,
                time: new Date(row.time),
                attrs: row.attrs,
            }));

            // DO NOTHING, never DO UPDATE. OTLP delivery is at-least-once, so an identical
            // retry must be a no-op; an update would move received_at and destroy the only
            // way to tell a retry from a genuine second export.
            const inserted = await sql`
                insert into metric_point ${sql(payload)}
                on conflict do nothing
            `;
            return inserted.count;
        },

        async recordBranch(report, orgId) {
            const { agent, sessionId, repo, branch, headSha, at } = report;
            const when = new Date(at);
            // Widen the interval rather than overwrite it: each report is one sample of a
            // branch that was held for some span, and the span is what the attribution join
            // intersects against.
            await sql`
                insert into session_branch (org_id, agent, session_id, repo, branch, head_sha, first_seen, last_seen, samples)
                values (${orgId}, ${agent}, ${sessionId}, ${repo}, ${branch}, ${headSha}, ${when}, ${when}, 1)
                on conflict (org_id, agent, session_id, repo, branch) do update
                    set first_seen = least(session_branch.first_seen, excluded.first_seen),
                        last_seen  = greatest(session_branch.last_seen, excluded.last_seen),
                        head_sha   = coalesce(excluded.head_sha, session_branch.head_sha),
                        samples    = session_branch.samples + 1
            `;
        },
    };
}
