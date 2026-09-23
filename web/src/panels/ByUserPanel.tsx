import type { TelemetryStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../api/useStats.js';
import type { DataTableColumn } from '../components/DataTable.js';
import { DataTable } from '../components/DataTable.js';
import { tokens } from '../format.js';
import { TelemetryFrame } from './TelemetryFrame.js';

/**
 * One user's rollup as the table renders it — the view model in front of `TelemetryStats.byUser`
 * (which is unchanged). `newTokens` applies core's null-aware sum to input + output only: cache
 * is the same context counted again, never new tokens, and a partially measured group keeps its
 * measured side rather than reading as unmeasured or as zero.
 */
export interface ByUserRow {
    id: string;
    name: string;
    avatarUrl: string | null;
    sessions: number;
    newTokens: number | null;
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    /** New tokens as a share of the largest measured total IN THE RENDERED ROWS, 0–100. */
    barPct: number;
}

const BAR_PCT_MULTIPLIER = 100;

export function byUserRows(byUser: TelemetryStats['byUser']): ByUserRow[] {
    const rows = byUser.map(({ user, sessions, tokens: t }) => ({
        id: user.id,
        name: user.name ?? user.login,
        avatarUrl: user.avatarUrl,
        sessions,
        newTokens: t.input === null && t.output === null ? null : (t.input ?? 0) + (t.output ?? 0),
        input: t.input,
        output: t.output,
        cacheRead: t.cacheRead,
        cacheWrite: t.cacheCreation,
    }));
    let max = 0;
    for (const row of rows) max = Math.max(max, row.newTokens ?? 0);
    return rows.map((row) => ({
        ...row,
        barPct: row.newTokens === null || max === 0 ? 0 : Math.round((row.newTokens / max) * BAR_PCT_MULTIPLIER),
    }));
}

const columns: DataTableColumn<ByUserRow>[] = [
    {
        key: 'name',
        label: 'User',
        cell: (row) => (
            <span className="by-user-user">
                {row.avatarUrl !== null ? <img className="task-avatar" src={row.avatarUrl} alt="" /> : null}
                {row.name}
            </span>
        ),
        sortValue: (row) => row.name,
    },
    { key: 'sessions', label: 'Sessions', cell: (row) => row.sessions, sortValue: (row) => row.sessions, align: 'end' },
    {
        key: 'newTokens',
        label: 'New tokens',
        align: 'end',
        sortValue: (row) => row.newTokens,
        name: (row) => (row.newTokens === null ? undefined : `${row.newTokens.toLocaleString('en-US')} new tokens`),
        cell: (row) => (
            <>
                {tokens(row.newTokens)}
                {/* Width is decoration; the exact total is the cell's accessible name. An
                    unmeasured user gets the dash alone — no bar for a figure that does not exist. */}
                {row.newTokens !== null ? (
                    <span className="usage-track" aria-hidden="true">
                        <span className="usage-bar" style={{ width: `${row.barPct}%` }} />
                    </span>
                ) : null}
            </>
        ),
    },
    { key: 'input', label: 'Input', align: 'end', cell: (row) => tokens(row.input), sortValue: (row) => row.input },
    { key: 'output', label: 'Output', align: 'end', cell: (row) => tokens(row.output), sortValue: (row) => row.output },
    {
        key: 'cacheRead',
        label: 'Cache read',
        align: 'end',
        cell: (row) => tokens(row.cacheRead),
        sortValue: (row) => row.cacheRead,
    },
    {
        key: 'cacheWrite',
        label: 'Cache write',
        align: 'end',
        cell: (row) => tokens(row.cacheWrite),
        sortValue: (row) => row.cacheWrite,
    },
];

/** Who the agent sessions belong to, one row per user the board's audit rows resolve to. */
export function ByUserPanel({ telemetry, meta }: { telemetry: TelemetryStats; meta: TelemetryMeta }) {
    return (
        <TelemetryFrame
            title="Usage by user"
            titleId="usage-by-user-heading"
            blurb={
                <>
                    Sessions and tokens per user, resolved by joining each session to the board task it ran under. The
                    four token figures stay apart — a cache read is the same context counted again, not new tokens. The
                    New tokens bar compares each user with the largest total shown.
                </>
            }
            meta={meta}
        >
            <DataTable
                labelledBy="usage-by-user-heading"
                columns={columns}
                rows={byUserRows(telemetry.byUser)}
                rowKey={(row) => row.id}
                initialSort={{ key: 'newTokens', direction: 'descending' }}
                empty={<p className="muted">No attributed sessions in the coverage window yet.</p>}
            />
        </TelemetryFrame>
    );
}
