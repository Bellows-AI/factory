import type { RangeSelection, ScopeSelection } from './RangeSelector.js';
import type { StatsPayload } from '../api/useStats.js';
import { RangeSelector } from './RangeSelector.js';
import { ScopeToggle } from './ScopeToggle.js';
import { Icon } from './Icon.js';
import { countRepos } from '../dashboardSummary.js';
import { relativeTime, timestamp } from '../format.js';

/**
 * The freshness stamp: the last successful response's timestamp — not the wall clock, not the
 * telemetry store's inner timestamp — with the precise stamp revealed on hover and keyboard focus.
 * The refresh glyph stands for the automatic poll; it is decorative, never a control.
 */
function Freshness({ data, now }: { data: StatsPayload | null; now: Date }) {
    if (!data) return <span className="updated-at">Not updated yet</span>;
    return (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: this focusable wrapper is the keyboard path to the revealed timestamp — the stamp must reach keyboard focus, and there is no interactive element to host it on
        <span tabIndex={0} className="updated-at" title={timestamp(data.meta.fetchedAt)}>
            <Icon name="refresh" />
            Updated {relativeTime(data.meta.fetchedAt, now)}
            <time className="updated-at-full" dateTime={data.meta.fetchedAt}>
                {timestamp(data.meta.fetchedAt)}
            </time>
        </span>
    );
}

/**
 * The analytics toolbar: one panel carrying Range, Scope, the repository coverage and the
 * freshness stamp — and, below it, the rendered-data summary sentence.
 *
 * The toolbar owns no fetching and no stats request state: it renders the selection it is handed
 * and reports changes upward. Repository coverage is informational text (what the figures
 * combine), not a filter — there is no picker, no query parameter, no local selection here. The
 * exact repository names stay in the page header, which is the place that interprets them.
 */
export function AnalyticsToolbar({
    range,
    onRangeChange,
    scope,
    onScopeChange,
    hasPersonalScope,
    data,
    now,
    summary,
}: {
    range: RangeSelection;
    onRangeChange: (next: RangeSelection) => void;
    scope: ScopeSelection;
    onScopeChange: (next: ScopeSelection) => void;
    /** Whether a signed-in member's own scope exists (GitHub mode). Open mode has no "me". */
    hasPersonalScope: boolean;
    /** The last successful payload, or null before the first read — when coverage is unknown
     * rather than empty (claiming "no repositories configured" would invent a fact). */
    data: StatsPayload | null;
    /** The page's one clock tick, for the relative freshness copy. */
    now: Date;
    /** The rendered-data sentence from payload meta, or null before the first successful read. */
    summary: string | null;
}) {
    return (
        <>
            <div className="analytics-toolbar">
                <RangeSelector range={range} onChange={onRangeChange} />
                {hasPersonalScope ? (
                    <ScopeToggle scope={scope} onChange={onScopeChange} />
                ) : (
                    // AUTH_MODE=none has no personal scope, so a Me option could never work. The
                    // selected scope still shows, as the read-only value it is.
                    <div className="toolbar-group">
                        <span className="toolbar-label">Scope</span>
                        <span className="toolbar-value">Organization</span>
                    </div>
                )}
                {/* Coverage is a fact about the figures, so the dot only lights once it is known. */}
                <p className="toolbar-coverage">
                    {data ? (
                        <>
                            <span className="toolbar-coverage-dot" aria-hidden="true" />
                            {countRepos(data.meta.telemetry.repoFilter)}
                        </>
                    ) : (
                        '—'
                    )}
                </p>
                <Freshness data={data} now={now} />
            </div>
            {/* Mounted from the start, empty before the first payload: some screen readers
                ignore content inserted into a live region that did not already exist, and the
                first "Updating to …" transition is exactly what must be announced. */}
            <p className="analytics-summary" aria-live="polite">
                {summary ?? ''}
            </p>
        </>
    );
}
