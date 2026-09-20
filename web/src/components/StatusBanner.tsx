import type { FetchState } from '../api/useStats.js';
import { updatedAgo } from '../format.js';

/**
 * The page-level status region — every load, refresh, staleness and error state of the stats
 * read, as visible text. Color never carries these states alone, and no metric shell is ever
 * rendered underneath a state that has no figures.
 */
export function StatusBanner({
    progress,
    error,
    hasData,
    lastGoodSelection,
    fetchedAt,
    now,
}: {
    progress: FetchState | null;
    error: string | null;
    hasData: boolean;
    /** The rendered selection, named so a stale page says exactly what is still on screen. */
    lastGoodSelection: string | null;
    fetchedAt: string | null;
    now: Date;
}) {
    if (error) {
        return (
            <p className="status error">
                {error}
                {hasData && lastGoodSelection
                    ? ` — showing the last successful read (${lastGoodSelection}), fetched ${updatedAgo(fetchedAt, now)}.`
                    : ' — nothing has rendered yet. Check the telemetry store, then Refresh.'}
            </p>
        );
    }
    if (!progress) return null;
    return (
        <p className="status">
            {progress.state === 'loading' ? 'Preparing telemetry…' : 'Waiting for telemetry…'}
            {hasData ? '' : ' (the first read waits for the database)'}
        </p>
    );
}
