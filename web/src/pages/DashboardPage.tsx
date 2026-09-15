import { useShell } from '../components/AppShell.js';
import { Limitations } from '../components/Limitations.js';
import { RangeSelector } from '../components/RangeSelector.js';
import { ScopeToggle } from '../components/ScopeToggle.js';
import { StatusBanner } from '../components/StatusBanner.js';
import { AiUsagePanel } from '../panels/AiUsagePanel.js';
import { ByUserPanel } from '../panels/ByUserPanel.js';
import { DataQualityPanel } from '../panels/DataQualityPanel.js';
import { TaskUsagePanel } from '../panels/TaskUsagePanel.js';
import { TokenUsagePanel } from '../panels/TokenUsagePanel.js';

/**
 * The dashboard. The scope toggle sits beside the range selector but renders ONLY when the
 * session reports a signed-in user: under AUTH_MODE=none there is no "me", and a disabled
 * control advertising a filter the server cannot answer is worse than its absence.
 */
export function DashboardPage() {
    const { data, range, setRange, scope, setScope, session, progress, error } = useShell();

    return (
        <>
            <main>
                <div className="dashboard-controls">
                    <RangeSelector range={range} onChange={setRange} />
                    {session ? <ScopeToggle scope={scope} onChange={setScope} /> : null}
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
                        <DataQualityPanel meta={data.meta} />
                        <Limitations />
                    </>
                ) : null}
            </main>
        </>
    );
}
