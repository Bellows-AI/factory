import type { FetchState } from '../api/useStats.js';

export function StatusBanner({
    progress,
    error,
    hasData,
}: {
    progress: FetchState | null;
    error: string | null;
    hasData: boolean;
}) {
    if (error) {
        return (
            <p className="status error">
                {error}
                {hasData ? ' — showing the last successful fetch below.' : ''}
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
