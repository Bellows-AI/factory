import type { ReactNode } from 'react';
import type { TelemetryMeta } from '../api/useStats.js';

/**
 * The shared shell for every telemetry panel, so all four degrade identically.
 *
 * 'unreachable' renders the frame with a reason and no numbers, rather than dashes: a dash
 * means "measured, unavailable", and nothing was measured here. The 'fixture' badge is loud
 * because synthetic token counts sitting beside real PR numbers is precisely the
 * invented-number problem. `blurb` is optional: a panel may lead with its chart or table and
 * put its explanation after it (caption, disclosure) instead of a paragraph up top.
 */
export function TelemetryFrame({
    title,
    blurb,
    meta,
    children,
}: {
    title: string;
    blurb?: ReactNode;
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
            {blurb ? <p className="muted">{blurb}</p> : null}
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
