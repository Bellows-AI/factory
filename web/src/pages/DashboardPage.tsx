import { useEffect, useState } from 'react';
import { resolveRange } from '@factory-ai/core';
import { useShell } from '../components/AppShell.js';
import { useCompletedJobs } from '../api/useCompletedJobs.js';
import { AnalyticsToolbar } from '../components/AnalyticsToolbar.js';
import { StatusBanner } from '../components/StatusBanner.js';
import { UsageSummaryPanel } from '../panels/UsageSummaryPanel.js';
import { ByUserPanel } from '../panels/ByUserPanel.js';
import { RecentTasksPanel } from '../panels/RecentTasksPanel.js';
import { TaskUsagePanel } from '../panels/TaskUsagePanel.js';
import { TokenUsagePanel } from '../panels/TokenUsagePanel.js';
import { preciseTimestamp, relativeTime } from '../format.js';
import {
    analyticsState,
    emptyStateCopy,
    renderedSelection,
    selectionMismatch,
    selectionText,
} from '../dashboardSummary.js';

/**
 * The dashboard. The scope toggle renders ONLY when the session reports a signed-in MEMBER:
 * under AUTH_MODE=none there is no "me" — the session hook still resolves the deployment's
 * `__local__` stand-in, and a toggle for it would advertise a filter the server answers with
 * SCOPE_REQUIRES_USER. `session.mode` is the tell; open mode gets the read-only Organization
 * value inside the toolbar instead.
 *
 * The state model is decided ONCE here, above the panels: loading, refresh-in-place,
 * updating-to, error-without-data, error-with-last-good-data, the one empty analytics state,
 * the partial task-measurements state, and telemetry-disabled are each an explicit branch —
 * no panel invents its own zero/dash shell for a page-level condition.
 */

/**
 * Names every repo rather than reporting a count. "3 repositories combined" hides which three,
 * and the figures on this page are only interpretable if you know what went into them.
 */
export function describeRepos(repos: { owner: string; name: string }[]): string {
    if (!repos.length) return 'no repositories configured';
    const owners = new Set(repos.map((r) => r.owner));
    // One owner is the common case, so repeating it on every entry is noise.
    if (owners.size === 1 && repos.length > 1) {
        return `${[...owners][0]}/{${repos.map((r) => r.name).join(', ')}}`;
    }
    return repos.map((r) => `${r.owner}/${r.name}`).join(', ');
}

export function DashboardPage() {
    const { data, range, setRange, scope, setScope, session, refreshing, refresh, progress, error } = useShell();
    // The board's own completed runs — a poll beside the stats one, not part of the stats
    // payload: this is jobs data, and the dashboard renders it even while telemetry is down.
    const completed = useCompletedJobs();

    // The page's ONE current-time tick: the relative "Updated N min ago" label refreshes from
    // this, once a minute. No per-row timers anywhere.
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const tick = window.setInterval(() => setNow(new Date()), 60_000);
        return () => window.clearInterval(tick);
    }, []);

    // The rendered-data sentence speaks for the PAYLOAD. When the requested selection has
    // moved on from what rendered, the sentence keeps describing the visible figures and
    // appends where the next read is heading — the request state is never the headline.
    const summary = data
        ? selectionMismatch(range, scope, data.meta)
            ? `${renderedSelection(data.meta)} · Updating to ${selectionText(
                  resolveRange(range.preset, now, { from: range.from || null, to: range.to || null }),
                  scope
              )}`
            : renderedSelection(data.meta)
        : null;

    const state = data && data.telemetry ? analyticsState(data.telemetry, data.tasks) : null;

    return (
        <>
            {/* One h1, carrying the page's name and — once something has rendered — the exact
                repos the figures combine. Coverage stays visible, not tooltip-buried. */}
            <h1>{data ? `${describeRepos(data.meta.repos)} — AI usage telemetry` : 'AI usage telemetry'}</h1>
            <div className="dashboard-controls">
                <AnalyticsToolbar
                    range={range}
                    onRangeChange={setRange}
                    scope={scope}
                    onScopeChange={setScope}
                    hasPersonalScope={session?.mode === 'github'}
                    repoFilter={data?.meta.telemetry.repoFilter ?? []}
                    summary={summary}
                />
                {data ? (
                    // Freshness reads the LAST SUCCESSFUL response's stamp — not the wall clock,
                    // not the telemetry store's inner timestamp. The precise stamp is real text
                    // revealed on hover and keyboard focus (and `dateTime` for assistive tech);
                    // a native title is only the pointer's convenience, never the only copy.
                    <span
                        // biome-ignore lint/a11y/noNoninteractiveTabindex: this focusable wrapper is the keyboard path to the revealed timestamp — the stamp must reach keyboard focus, and there is no interactive element to host it on
                        tabIndex={0}
                        className="updated-at"
                        title={preciseTimestamp(data.meta.fetchedAt)}
                    >
                        Updated {relativeTime(data.meta.fetchedAt, now)}
                        <time className="updated-at-full" dateTime={data.meta.fetchedAt}>
                            {preciseTimestamp(data.meta.fetchedAt)}
                        </time>
                    </span>
                ) : (
                    <span className="muted">Not updated yet</span>
                )}
                {/* The only action on the stats read. */}
                <button type="button" onClick={refresh} disabled={refreshing}>
                    {refreshing ? 'Refreshing…' : 'Refresh'}
                </button>
            </div>
            <StatusBanner
                progress={progress}
                error={error}
                hasData={data !== null}
                lastGoodSelection={data ? renderedSelection(data.meta) : null}
                fetchedAt={data?.meta.fetchedAt ?? null}
                now={now}
            />
            {data && data.telemetry ? (
                state === 'ready' ? (
                    <>
                        <UsageSummaryPanel telemetry={data.telemetry} meta={data.meta} />
                        <TokenUsagePanel telemetry={data.telemetry} meta={data.meta.telemetry} />
                        <TaskUsagePanel tasks={data.tasks} meta={data.meta.telemetry} />
                        <ByUserPanel telemetry={data.telemetry} meta={data.meta.telemetry} />
                    </>
                ) : (
                    // The one analytics empty state, replacing the dash-card chorus — with the
                    // rendered selection named and exactly one next action. Per-task usage stays
                    // when the board measured tasks the telemetry window cannot see.
                    <>
                        <section className="usage-empty">
                            <h2>Nothing measured in this selection</h2>
                            <p>{emptyStateCopy(data.telemetry, data.meta)}</p>
                        </section>
                        {state === 'partial' ? <TaskUsagePanel tasks={data.tasks} meta={data.meta.telemetry} /> : null}
                    </>
                )
            ) : null}
            {/* Outside the stats branch on purpose: completed jobs poll their own endpoint,
                    so the recent-tasks view is exactly the degraded-mode surface when the
                    statistics read is cold or failing — hiding it behind `data` would hide it
                    in the one state it exists for. */}
            <RecentTasksPanel jobs={completed.jobs} error={completed.error} />
        </>
    );
}
