import { useShell } from '../components/AppShell.js';
import { useCompletedJobs } from '../api/useCompletedJobs.js';
import { RangeSelector } from '../components/RangeSelector.js';
import { ScopeToggle } from '../components/ScopeToggle.js';
import { StatusBanner } from '../components/StatusBanner.js';
import { AiUsagePanel } from '../panels/AiUsagePanel.js';
import { ByUserPanel } from '../panels/ByUserPanel.js';
import { RecentTasksPanel } from '../panels/RecentTasksPanel.js';
import { TaskUsagePanel } from '../panels/TaskUsagePanel.js';
import { TokenUsagePanel } from '../panels/TokenUsagePanel.js';

/**
 * The dashboard. The scope toggle sits beside the range selector but renders ONLY when the
 * session reports a signed-in MEMBER: under AUTH_MODE=none there is no "me" — the session hook
 * still resolves the deployment's `__local__` stand-in, and a toggle for it would advertise a
 * filter the server answers with SCOPE_REQUIRES_USER. `session.mode` is the tell.
 *
 * The telemetry chrome the old global topbar carried (issue 160) lives here now: the repo
 * coverage, the freshness timestamp and the Refresh action describe THESE figures, so they ride
 * with the page whose figures they are, and the app bar stays chrome-only.
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

    return (
        <>
            <p className="muted">{data ? `${describeRepos(data.meta.repos)} — AI usage telemetry` : 'loading…'}</p>
            <div className="dashboard-controls">
                <RangeSelector range={range} onChange={setRange} />
                {session?.mode === 'github' ? <ScopeToggle scope={scope} onChange={setScope} /> : null}
                <span className="muted">
                    {data ? `data as of ${new Date(data.meta.fetchedAt).toLocaleString()}` : ''}
                </span>
                {/* The only action on the stats read, moved with the caption it belongs to. */}
                <button type="button" onClick={refresh} disabled={refreshing}>
                    {refreshing ? 'Refreshing…' : 'Refresh'}
                </button>
            </div>
            <StatusBanner progress={progress} error={error} hasData={data !== null} />
            {data ? (
                <>
                    {/* Nothing renders when the feature is switched off:
                            empty frames for a feature nobody enabled are just noise. */}
                    {data.telemetry ? (
                        <>
                            <AiUsagePanel telemetry={data.telemetry} meta={data.meta.telemetry} />
                            <TokenUsagePanel telemetry={data.telemetry} meta={data.meta.telemetry} />
                            <TaskUsagePanel tasks={data.tasks} meta={data.meta.telemetry} />
                            <ByUserPanel telemetry={data.telemetry} meta={data.meta.telemetry} />
                        </>
                    ) : null}
                </>
            ) : null}
            {/* Outside the stats branch on purpose: completed jobs poll their own endpoint,
                    so the recent-tasks view is exactly the degraded-mode surface when the
                    statistics read is cold or failing — hiding it behind `data` would hide it
                    in the one state it exists for. */}
            <RecentTasksPanel jobs={completed.jobs} error={completed.error} />
        </>
    );
}
