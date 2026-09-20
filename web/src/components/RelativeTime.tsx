import { relativeTime, taskTime } from '../format.js';

/**
 * A stamp as how long ago it happened, with the precise UTC time on hover/focus via the
 * `title` — the relative label answers "how fresh", the title answers "exactly when". The
 * `now` default keeps the call sites short; tests and any future ticker inject it.
 */
export function RelativeTime({ at, now = new Date() }: { at: string | null | undefined; now?: Date | undefined }) {
    const label = relativeTime(at, now);
    if (label === '—') return <>—</>;
    return (
        <time dateTime={at as string} title={taskTime(at)}>
            {label}
        </time>
    );
}
