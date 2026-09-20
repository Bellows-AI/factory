import type { RangeSelection, ScopeSelection } from './RangeSelector.js';
import { RangeSelector } from './RangeSelector.js';
import { ScopeToggle } from './ScopeToggle.js';
import { countRepos } from '../dashboardSummary.js';

/**
 * The analytics toolbar: three visibly labeled groups — Range, Scope, Repositories — and, below
 * them, the rendered-data summary sentence.
 *
 * The toolbar owns no fetching and no stats request state: it renders the selection it is handed
 * and reports changes upward. The Repositories group is read-only COVERAGE (what the figures
 * combine), not a filter — there is no picker, no query parameter, no local selection here. The
 * exact repository names stay in the page header, which is the place that interprets them.
 */
export function AnalyticsToolbar({
    range,
    onRangeChange,
    scope,
    onScopeChange,
    hasPersonalScope,
    repoFilter,
    summary,
}: {
    range: RangeSelection;
    onRangeChange: (next: RangeSelection) => void;
    scope: ScopeSelection;
    onScopeChange: (next: ScopeSelection) => void;
    /** Whether a signed-in member's own scope exists (GitHub mode). Open mode has no "me". */
    hasPersonalScope: boolean;
    repoFilter: readonly string[];
    /** The rendered-data sentence from payload meta, or null before the first successful read. */
    summary: string | null;
}) {
    return (
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
            <div className="toolbar-group">
                <span className="toolbar-label">Repositories</span>
                <span className="toolbar-value">{countRepos(repoFilter)}</span>
            </div>
            {summary ? (
                <p className="analytics-summary" aria-live="polite">
                    {summary}
                </p>
            ) : null}
        </div>
    );
}
