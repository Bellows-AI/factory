import { useEffect, useState } from 'react';
import type { StatsPayload } from '../api/useStats.js';
import { useShell } from '../components/AppShell.js';
import { useCompletedJobs } from '../api/useCompletedJobs.js';
import { AnalyticsToolbar } from '../components/AnalyticsToolbar.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusBanner } from '../components/StatusBanner.js';
import { describeRepos, relativeTime, timestamp } from '../format.js';
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
 * The header's freshness stamp: the last successful response's timestamp — not the wall clock,
 * not the telemetry store's inner timestamp — with the precise stamp revealed on hover and
 * keyboard focus. Split out of `DashboardPage` so the header's ternary does not add to the
 * page's own cognitive complexity.
 */
function DashboardFreshness({ data, now }: { data: StatsPayload | null; now: Date }) {
    if (!data) return <span className="muted">Not updated yet</span>;
    return (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: this focusable wrapper is the keyboard path to the revealed timestamp — the stamp must reach keyboard focus, and there is no interactive element to host it on
        <span tabIndex={0} className="updated-at" title={timestamp(data.meta.fetchedAt)}>
            Updated {relativeTime(data.meta.fetchedAt, now)}
            <time className="updated-at-full" dateTime={data.meta.fetchedAt}>
                {timestamp(data.meta.fetchedAt)}
            </time>
        </span>
    );
}

/**
 * The rendered-data sentence, speaking for the PAYLOAD. When the requested selection has moved
 * on from what rendered, the sentence keeps describing the visible figures and appends where the
 * next read is heading — the request state is never the headline. Split out of `DashboardPage`
 * for the same reason as `DashboardFreshness`.
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
 * reason as `DashboardFreshness`.
 */
function AnalyticsPanels({ data, state }: { data: StatsPayload; state: AnalyticsState }) {
    if (!data.telemetry) return null;
    if (state === 'ready') {
        return (
            <>
                <UsageSummaryPanel telemetry={data.telemetry} meta={data.meta} />
                <TokenUsagePanel telemetry={data.telemetry} meta={data.meta.telemetry} />
                <TaskUsagePanel tasks={data.tasks} meta={data.meta.telemetry} />
                <ByUserPanel telemetry={data.telemetry} meta={data.meta.telemetry} />
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
 * The dashboard. The page header owns the telemetry chrome — exact repo coverage and the
 * freshness stamp — because those describe THIS page's figures, not the app; the app bar stays
 * chrome-only. The analytics toolbar carries the labeled Range / Scope / Repositories groups and
 * the rendered-data summary. The scope toggle renders ONLY when the session reports a signed-in
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
            <PageHeader
                title="Usage overview"
                description={data ? describeRepos(data.meta.repos) : undefined}
                meta={<DashboardFreshness data={data} now={now} />}
            />
            <div className="dashboard-controls">
                <AnalyticsToolbar
                    range={range}
                    onRangeChange={setRange}
                    scope={scope}
                    onScopeChange={setScope}
                    hasPersonalScope={session?.mode === 'github'}
                    repoFilter={data ? data.meta.telemetry.repoFilter : null}
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
            {/* Outside the stats branch on purpose: completed jobs poll their own endpoint,
                    so the recent-tasks view is exactly the degraded-mode surface when the
                    statistics read is cold or failing — hiding it behind `data` would hide it
                    in the one state it exists for. */}
            <RecentTasksPanel jobs={completed.jobs} error={completed.error} />
        </>
    );
}
