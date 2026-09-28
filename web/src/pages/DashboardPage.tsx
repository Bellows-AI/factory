import { useEffect, useState } from 'react';
import type { StatsPayload } from '../api/useStats.js';
import { useShell } from '../components/AppShell.js';
import { useCompletedJobs } from '../api/useCompletedJobs.js';
import { AnalyticsToolbar } from '../components/AnalyticsToolbar.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusBanner } from '../components/StatusBanner.js';
import { describeRepos } from '../format.js';
import { UsageSummaryPanel } from '../panels/UsageSummaryPanel.js';
import { ByUserPanel } from '../panels/ByUserPanel.js';
import { RecentTasksPanel } from '../panels/RecentTasksPanel.js';
import { TaskUsagePanel } from '../panels/TaskUsagePanel.js';
import { TokenUsagePanel } from '../panels/TokenUsagePanel.js';
import {
    analyticsState,
    emptyStateCopy,
    renderedSelection,
    requestedRange,
    selectionMismatch,
    selectionText,
    type AnalyticsState,
} from '../dashboardSummary.js';
import type { RangeSelection, ScopeSelection } from '../components/RangeSelector.js';

/**
 * The rendered-data sentence, speaking for the PAYLOAD. When the requested selection has moved
 * on from what rendered, the sentence keeps describing the visible figures and appends where the
 * next read is heading — the request state is never the headline. Split out of `DashboardPage`
 * so the page's own cognitive complexity stays low.
 */
function dashboardSummary(
    data: StatsPayload | null,
    range: RangeSelection,
    scope: ScopeSelection,
    now: Date
): string | null {
    if (!data) return null;
    if (!selectionMismatch(range, scope, data.meta)) return renderedSelection(data.meta);
    return `${renderedSelection(data.meta)} · Updating to ${selectionText(requestedRange(range, now), scope)}`;
}

/**
 * The telemetry panels, by the page-level analytics state: the full summary, the one empty
 * state (with per-task usage kept when the board measured tasks the telemetry window cannot
 * see), or nothing while telemetry itself is down. Split out of `DashboardPage` for the same
 * reason as `dashboardSummary`. Usage by user is not here: it pairs with Recent tasks below.
 */
function AnalyticsPanels({ data, state }: { data: StatsPayload; state: AnalyticsState }) {
    if (!data.telemetry) return null;
    if (state === 'ready') {
        return (
            <>
                <UsageSummaryPanel telemetry={data.telemetry} meta={data.meta} />
                <TokenUsagePanel telemetry={data.telemetry} meta={data.meta.telemetry} />
                <TaskUsagePanel tasks={data.tasks} meta={data.meta.telemetry} />
            </>
        );
    }
    // The one analytics empty state, replacing the dash-card chorus — with the rendered
    // selection named and exactly one next action. Per-task usage stays when the board measured
    // tasks the telemetry window cannot see.
    return (
        <>
            <section className="usage-empty">
                <h2>Nothing measured in this selection</h2>
                <p>{emptyStateCopy(data.telemetry, data.meta)}</p>
            </section>
            {state === 'partial' ? <TaskUsagePanel tasks={data.tasks} meta={data.meta.telemetry} /> : null}
        </>
    );
}

const CLOCK_TICK_MS = 60_000;

/**
 * The dashboard. The page header names the exact repos the figures combine, because that
 * describes THIS page's figures, not the app; the app bar stays chrome-only. The analytics
 * toolbar panel carries Range, Scope, the repository coverage and the freshness stamp, with the
 * rendered-data summary beneath it. The scope toggle renders ONLY when the session reports a signed-in
 * MEMBER: under AUTH_MODE=none there is no "me" — the session hook still resolves the
 * deployment's `__local__` stand-in, and a toggle for it would advertise a filter the server
 * answers with SCOPE_REQUIRES_USER. `session.mode` is the tell; open mode gets the read-only
 * Organization value inside the toolbar instead.
 *
 * The state model is decided ONCE here, above the panels: loading, updating-to,
 * error-without-data, error-with-last-good-data, the one empty analytics state, the partial
 * task-measurements state, and telemetry-disabled are each an explicit branch — no panel invents
 * its own zero/dash shell for a page-level condition.
 */

export function DashboardPage() {
    const { data, range, setRange, scope, setScope, session, progress, error } = useShell();
    // The board's own completed runs — a poll beside the stats one, not part of the stats
    // payload: this is jobs data, and the dashboard renders it even while telemetry is down.
    const completed = useCompletedJobs();

    // The page's ONE current-time tick: the relative "Updated N min ago" label refreshes from
    // this, once a minute. No per-row timers anywhere.
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const tick = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
        return () => window.clearInterval(tick);
    }, []);

    const summary = dashboardSummary(data, range, scope, now);
    const state = data && data.telemetry ? analyticsState(data.telemetry, data.tasks) : null;

    return (
        <>
            {/* One h1, from the page header primitive (issue 159), carrying the page's name and
                — once something has rendered — the exact repos the figures combine. Coverage
                stays visible, not tooltip-buried. */}
            <PageHeader title="Usage overview" description={data ? describeRepos(data.meta.repos) : undefined} />
            <div className="dashboard-controls">
                <AnalyticsToolbar
                    range={range}
                    onRangeChange={setRange}
                    scope={scope}
                    onScopeChange={setScope}
                    hasPersonalScope={session?.mode === 'github'}
                    data={data}
                    now={now}
                    summary={summary}
                />
            </div>
            <StatusBanner
                progress={progress}
                error={error}
                hasData={data !== null}
                lastGoodSelection={data ? renderedSelection(data.meta) : null}
                fetchedAt={data?.meta.fetchedAt ?? null}
                now={now}
            />
            {data && state !== null ? <AnalyticsPanels data={data} state={state} /> : null}
            {/* Side by side at ≥1200px, stacked below. Recent tasks sits outside the stats branch
                on purpose: completed jobs poll their own endpoint, so it is exactly the
                degraded-mode surface when the statistics read is cold or failing — hiding it
                behind `data` would hide it in the one state it exists for. */}
            <div className="two-up">
                {data?.telemetry && state === 'ready' ? (
                    <ByUserPanel telemetry={data.telemetry} meta={data.meta.telemetry} />
                ) : null}
                <RecentTasksPanel jobs={completed.jobs} error={completed.error} />
            </div>
        </>
    );
}
