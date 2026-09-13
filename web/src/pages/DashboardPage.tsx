import { useShell } from '../components/AppShell.js';
import { Limitations } from '../components/Limitations.js';
import { RangeSelector } from '../components/RangeSelector.js';
import { StatusBanner } from '../components/StatusBanner.js';
import { AiUsagePanel } from '../panels/AiUsagePanel.js';
import { DataQualityPanel } from '../panels/DataQualityPanel.js';
import { TokenUsagePanel } from '../panels/TokenUsagePanel.js';

/** The panel list, unchanged. The state it used to own moved up to AppShell — see the note there. */
export function DashboardPage() {
    const { data, range, setRange, progress, error } = useShell();

    return (
        <>
            <main>
                <RangeSelector range={range} onChange={setRange} />
                <StatusBanner progress={progress} error={error} hasData={data !== null} />
                {data ? (
                    <>
                        {/* Nothing renders when the feature is switched off:
                            empty frames for a feature nobody enabled are just noise. */}
                        {data.telemetry ? (
                            <>
                                <AiUsagePanel telemetry={data.telemetry} meta={data.meta.telemetry} />
                                <TokenUsagePanel
                                    telemetry={data.telemetry}
                                    meta={data.meta.telemetry}
                                />
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
