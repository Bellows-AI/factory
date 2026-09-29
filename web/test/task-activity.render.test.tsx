import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JobActivity } from '../src/api/useJobActivity.js';
import { FORBIDDEN } from './tasks-fixtures.js';
import { TaskActivity } from '../src/panels/TaskActivity.js';

/**
 * The run-activity panel (issue #339): the head run's tokens and edits over its wall clock, from
 * `GET /api/jobs/:id/activity`. Props in, markup out — the hook is the page's, the panel renders
 * what it is handed, and the reader sees a steady bar for a working run and a flat line for a
 * stuck one.
 */

const payload = (over: Partial<JobActivity> = {}): JobActivity => ({
    jobId: '11111111-1111-4111-8111-111111111111',
    sessionId: '33333333-3333-4333-8333-333333333333',
    from: '2026-09-22T20:46:16.000Z',
    to: '2026-09-22T22:46:16.000Z',
    bucketMs: 900_000,
    buckets: [
        { start: '2026-09-22T20:45:00.000Z', tokens: 2_500_000, edits: 3 },
        { start: '2026-09-22T21:00:00.000Z', tokens: 1_200_000, edits: 0 },
        { start: '2026-09-22T21:15:00.000Z', tokens: 0, edits: 0 },
    ],
    ...over,
});

describe('TaskActivity', () => {
    it('renders the run activity panel with a tokens bar series and an edits line', () => {
        const html = renderToStaticMarkup(<TaskActivity payload={payload()} live={false} />);
        expect(html).toContain('Run activity');
        expect(html).toMatch(/data-series="tokens"/);
        expect(html).toContain('polyline');
        expect(html).toContain('aria-label');
        for (const forbidden of FORBIDDEN) expect(html, forbidden).not.toContain(forbidden);
    });

    it('hatches the last bucket while the run is still going', () => {
        const html = renderToStaticMarkup(<TaskActivity payload={payload()} live={true} />);
        expect(html).toContain('bar-partial');
    });

    it('renders the muted empty state, and no chart, when the run has no telemetry', () => {
        const html = renderToStaticMarkup(<TaskActivity payload={null} live={false} />);
        expect(html).toContain('No telemetry for this run.');
        expect(html).not.toContain('<svg');
        const empty = renderToStaticMarkup(<TaskActivity payload={payload({ buckets: [] })} live={false} />);
        expect(empty).toContain('No telemetry for this run.');
        expect(empty).not.toContain('<svg');
    });
});
