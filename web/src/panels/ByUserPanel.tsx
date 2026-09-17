import type { TelemetryStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../api/useStats.js';
import { tokens } from '../format.js';
import { TelemetryFrame } from './TelemetryFrame.js';

/** Who the agent sessions belong to, one row per user the board's audit rows resolve to. */
export function ByUserPanel({ telemetry, meta }: { telemetry: TelemetryStats; meta: TelemetryMeta }) {
    const rows = telemetry.byUser;
    return (
        <TelemetryFrame
            title="Usage by user"
            blurb={
                <>
                    Sessions and tokens per user, resolved by joining each session to the board task it ran under. The
                    four token figures stay apart — a cache read is the same context counted again, not new tokens.
                </>
            }
            meta={meta}
        >
            {rows.length === 0 ? (
                <p className="muted">No attributed sessions in the coverage window yet.</p>
            ) : (
                <div className="chart-wrap">
                    <table className="by-user">
                        <thead>
                            <tr>
                                <th>User</th>
                                <th>Sessions</th>
                                <th>Input</th>
                                <th>Output</th>
                                <th>Cache read</th>
                                <th>Cache writes</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => (
                                <tr key={row.user.id}>
                                    <td>
                                        <span className="by-user-user">
                                            {row.user.avatarUrl !== null ? (
                                                <img className="task-avatar" src={row.user.avatarUrl} alt="" />
                                            ) : null}
                                            {row.user.name ?? row.user.login}
                                        </span>
                                    </td>
                                    <td>{row.sessions}</td>
                                    <td>{tokens(row.tokens.input)}</td>
                                    <td>{tokens(row.tokens.output)}</td>
                                    <td>{tokens(row.tokens.cacheRead)}</td>
                                    <td>{tokens(row.tokens.cacheCreation)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </TelemetryFrame>
    );
}
