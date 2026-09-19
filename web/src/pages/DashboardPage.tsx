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
 */
export function DashboardPage() {
    const { data, range, setRange, scope, setScope, session, progress, error } = useShell();
    // The board's own completed runs — a poll beside the stats one, not part of the stats
    // payload: this is jobs data, and the dashboard renders it even while telemetry is down.
    const completed = useCompletedJobs();

    return (
        <>
            <div className="dashboard-controls">
                <RangeSelector range={range} onChange={setRange} />
                {session?.mode === 'github' ? <ScopeToggle scope={scope} onChange={setScope} /> : null}
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
