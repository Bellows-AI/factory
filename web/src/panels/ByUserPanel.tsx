import type { TelemetryStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../api/useStats.js';
import { TelemetryFrame } from './TelemetryFrame.js';

/** Who the agent sessions belong to, one row per user the board's audit rows resolve to. */
export function ByUserPanel({ telemetry, meta }: { telemetry: TelemetryStats; meta: TelemetryMeta }) {
    const rows = telemetry.byUser;
    const billable = (t: { input: number | null; output: number | null }) => (t.input ?? 0) + (t.output ?? 0);
    return (
        <TelemetryFrame
            title="Usage by user"
            blurb={
                <>
                    Sessions and tokens per user, resolved by joining each session to the board task it ran under.
                    Sessions with no matching task stay unattributed and are counted, never guessed.
                </>
            }
            meta={meta}
        >
            {rows.length === 0 && telemetry.unattributedSessions === 0 ? (
                <p className="muted">No sessions in the coverage window yet.</p>
            ) : rows.length === 0 ? (
                <p className="muted">
                    {telemetry.unattributedSessions} session{telemetry.unattributedSessions === 1 ? '' : 's'} ran with
                    no matching board task, so none can be attributed to a user.
                </p>
            ) : (
                <div className="chart-wrap">
                    <table className="by-user">
                        <thead>
                            <tr>
                                <th>User</th>
                                <th>Sessions</th>
                                <th>Tokens (input + output)</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => (
                                <tr key={row.user.id}>
                                    <td>
                                        {row.user.avatarUrl !== null ? (
                                            <img className="task-avatar" src={row.user.avatarUrl} alt="" />
                                        ) : null}
                                        {row.user.name ?? row.user.login}
                                    </td>
                                    <td>{row.sessions}</td>
                                    <td>{billable(row.tokens).toLocaleString('en-US')}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {telemetry.unattributedSessions > 0 ? (
                        <p className="muted">
                            {telemetry.unattributedSessions} session{telemetry.unattributedSessions === 1 ? '' : 's'}{' '}
                            ran with no matching board task.
                        </p>
                    ) : null}
                </div>
            )}
        </TelemetryFrame>
    );
}
