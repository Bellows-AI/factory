import { BarChart } from '../charts/BarChart.js';
import type { JobActivity } from '../api/useJobActivity.js';

/**
 * The run-activity panel (issue 339): the head run's tokens and edits over its own wall clock,
 * from the board's activity route. A steady bar means working; a flat line means stuck — the
 * "was it making progress" answer a timeout verdict alone cannot give. Props in, markup out:
 * the fetch is the page's (`useJobActivity`), this panel draws what it is handed, and a run the
 * pipeline holds nothing about renders one quiet sentence, never a fabricated zero line.
 */

/** Where the UTC clock lives in an ISO 8601 stamp: the date ends at 10, the clock is 11–16. */
const ISO_DATE_END = 10;
const ISO_CLOCK_START = 11;
const ISO_CLOCK_END = 16;
const MS_PER_MINUTE = 60_000;

/** The abbreviated axis label: the bucket's UTC clock time. The tooltip carries the full stamp. */
const clockOf = (iso: string): string => iso.slice(ISO_CLOCK_START, ISO_CLOCK_END);

/** The tooltip's full bucket stamp: UTC date and clock, the format every other chart labels in. */
const fullStampOf = (iso: string): string =>
    `${iso.slice(0, ISO_DATE_END)} ${iso.slice(ISO_CLOCK_START, ISO_CLOCK_END)} UTC`;

export function TaskActivity({ payload, live }: { payload: JobActivity | null; live: boolean }) {
    const buckets = payload?.buckets ?? [];
    if (buckets.length === 0) {
        return (
            <section className="panel task-activity">
                <div className="panel-head">
                    <h2>Run activity</h2>
                </div>
                <p className="muted">No telemetry for this run.</p>
            </section>
        );
    }
    // The bucket width is the route's choice, scaled to the run's length — the accessible name
    // says the width actually served, never a hardcoded one.
    const minutes = payload?.bucketMs != null ? Math.round(payload.bucketMs / MS_PER_MINUTE) : null;
    const span = minutes === null ? '' : `, in ${minutes}-minute buckets`;
    return (
        <section className="panel task-activity">
            <div className="panel-head">
                <h2>Run activity</h2>
            </div>
            <BarChart
                ariaLabel={`Tokens processed and edits made over the run's wall clock${span}`}
                labels={buckets.map((bucket) => clockOf(bucket.start))}
                bucketLabels={buckets.map((bucket) => fullStampOf(bucket.start))}
                // The last bucket of a still-running run is in progress, not quiet — the hatch
                // says so, the way the range charts mark the current period.
                partial={buckets.map((_, i) => live && i === buckets.length - 1)}
                series={[
                    {
                        id: 'tokens',
                        label: 'Tokens',
                        values: buckets.map((bucket) => bucket.tokens),
                        className: 'bar-primary',
                    },
                ]}
                line={{ id: 'edits', label: 'Edits', values: buckets.map((bucket) => bucket.edits) }}
                leftAxisLabel="Tokens"
            />
        </section>
    );
}
