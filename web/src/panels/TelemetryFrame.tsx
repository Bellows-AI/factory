import type { ReactNode } from 'react';
import type { TelemetryMeta } from '../api/useStats.js';

/**
 * The shared shell for every telemetry panel, so all four degrade identically.
 *
 * 'unreachable' renders the frame with a reason and no numbers, rather than dashes: a dash
 * means "measured, unavailable", and nothing was measured here. The 'fixture' badge is loud
 * because synthetic token counts sitting beside real PR numbers is precisely the
 * invented-number problem the limitations panel exists to warn about.
 */
export function TelemetryFrame({
    title,
    blurb,
    meta,
    children,
}: {
    title: string;
    blurb: ReactNode;
    meta: TelemetryMeta;
    children: ReactNode;
}) {
    const broken = meta.status === 'unreachable';
    return (
        <section className={broken ? 'panel bad' : 'panel'}>
            <h2>
                {title}
                {meta.source === 'fixture' ? <span className="badge">synthetic fixture</span> : null}
            </h2>
            <p className="muted">{blurb}</p>
            {broken ? (
                <p className="alert">
                    Telemetry unavailable — {meta.reason ?? 'the telemetry store could not be read'}.
                </p>
            ) : (
                children
            )}
        </section>
    );
}
