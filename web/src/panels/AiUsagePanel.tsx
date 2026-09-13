import type { TelemetryStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../api/useStats.js';
import { Card } from '../components/Card.js';
import { duration, num, pct, tokens } from '../format.js';

export function AiUsagePanel({
    telemetry,
    meta,
}: {
    telemetry: TelemetryStats;
    meta: TelemetryMeta;
}) {
    const t = telemetry.totals;
    return (
        <section className="cards">
            <Card
                value={tokens(t.tokens.input)}
                label="input tokens"
                note={`${tokens(t.tokens.cacheRead)} read from cache`}
            />
            <Card
                value={tokens(t.tokens.output)}
                label="output tokens"
                note={`${tokens(t.tokens.cacheCreation)} cache writes`}
            />
            <Card
                value={num(t.sessions, 0)}
                label="agent sessions"
                note={meta.source === 'fixture' ? 'synthetic fixture data' : meta.repoFilter.join(', ')}
            />
            <Card
                value={duration(t.activeHours)}
                label="active session time"
                note="excludes idle time"
            />
            <Card
                value={pct(t.acceptRatio)}
                label="file edits accepted"
                // A leading em dash reads as a broken value rather than a missing one, and
                // backfilled sessions have no line counts at all.
                note={
                    t.linesAdded === null
                        ? 'lines written not recorded'
                        : `${num(t.linesAdded, 0)} lines written`
                }
            />
        </section>
    );
}
