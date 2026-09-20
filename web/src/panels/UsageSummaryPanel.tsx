import type { TelemetryStats } from '@factory-ai/core';
import type { StatsPayload } from '../api/useStats.js';
import { duration, exactInt, num, pct, tokens } from '../format.js';
import { selectionText } from '../dashboardSummary.js';

/**
 * The metric summary: five measures in four visual groups, hierarchy first — Sessions and
 * Token usage lead, Active time and Edit acceptance support. Every figure speaks for the
 * payload it rendered from: the Sessions line names the rendered selection, never the
 * requested one, and never repeats the repository names the page header already carries.
 *
 * Null is unmeasured: the value renders as an em dash with a short Not measured note. A
 * measured zero is a real value and renders as 0.
 */
export function UsageSummaryPanel({ telemetry, meta }: { telemetry: TelemetryStats; meta: StatsPayload['meta'] }) {
    const t = telemetry.totals;
    const ea = t.editAcceptance;
    // The acceptance copy keeps the measured denominator visible and never invents one:
    // ratio present → "A of D measured..."; acceptances unmeasured with decisions measured →
    // name the decisions without a fabricated count; nothing measured → Not measured.
    const editNote =
        ea.ratio !== null
            ? `${exactInt(ea.accepted)} of ${exactInt(ea.decisions)} measured edit decisions accepted`
            : ea.accepted === null && ea.decisions !== null
              ? `${exactInt(ea.decisions)} edit decisions measured, accepted count not recorded`
              : ea.accepted !== null
                ? `${exactInt(ea.decisions)} measured edit decisions`
                : 'Not measured';
    return (
        <section className="usage-summary">
            <h2>
                Usage summary
                {meta.telemetry.source === 'fixture' ? <span className="badge">synthetic fixture</span> : null}
            </h2>
            <div className="usage-groups">
                <div className="usage-group">
                    <strong>{num(t.sessions, 0)}</strong>
                    <span>Sessions</span>
                    <span className="muted">{selectionText(meta.range, meta.scope)}</span>
                </div>
                <div className="usage-group usage-tokens">
                    <span className="usage-label">Token usage</span>
                    <div className="usage-measures">
                        <div className="usage-measure">
                            <strong>{tokens(t.tokens.input)}</strong>
                            <span>Input</span>
                            <span className="muted">
                                {t.tokens.cacheRead === null ? 'Not measured' : `${tokens(t.tokens.cacheRead)} read from cache`}
                            </span>
                        </div>
                        <div className="usage-measure">
                            <strong>{tokens(t.tokens.output)}</strong>
                            <span>Output</span>
                            <span className="muted">
                                {t.tokens.cacheCreation === null
                                    ? 'Not measured'
                                    : `${tokens(t.tokens.cacheCreation)} written to cache`}
                            </span>
                        </div>
                    </div>
                </div>
                <div className="usage-group">
                    <strong>{duration(t.activeHours)}</strong>
                    <span>Active time</span>
                    <span className="muted">
                        {t.activeHours === null ? 'Not measured' : `Across ${num(t.sessions, 0)} sessions · idle time excluded`}
                    </span>
                </div>
                <div className="usage-group">
                    <strong>{pct(ea.ratio)}</strong>
                    <span>Edit acceptance</span>
                    <span className="muted">{editNote}</span>
                </div>
            </div>
        </section>
    );
}
