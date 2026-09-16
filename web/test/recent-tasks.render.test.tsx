import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Job } from '../src/api/useJobs.js';
import { RecentTasksPanel } from '../src/panels/RecentTasksPanel.js';

/**
 * A render smoke test, like the other panels: the null-not-zero contract must survive to the
 * markup, and the panel's fallback rule — the agent's words when there are some, the command
 * when there are not — is the part worth pinning.
 */

const job = (over: Partial<Job>): Job => ({
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing gates',
    status: 'succeeded',
    attempts: 1,
    maxAttempts: 3,
    claimedBy: null,
    createdBy: null,
    author: { id: 'u-alice', login: 'alice', name: 'Alice Doe', avatarUrl: 'https://example.com/alice.png' },
    stoppedBy: null,
    doneBy: null,
    sessionId: null,
    remoteSessionId: null,
    exitCode: 0,
    output: null,
    summary: null,
    gates: null,
    runtime: null,
    repo: 'Bellows-AI/factory',
    executor: null,
    followUpTo: null,
    rootJobId: '11111111-1111-4111-8111-111111111111',
    doneAt: null,
    cancelRequestedAt: null,
    workspacePath: null,
    createdAt: '2026-08-21T12:00:00.000Z',
    startedAt: '2026-08-21T12:00:01.000Z',
    finishedAt: '2026-08-21T12:20:00.000Z',
    wallClockMs: null,
    taskWallClockMs: null,
    ...over,
});

describe('recently completed panel', () => {
    it('renders the agent summary beside author, context, wall clock and the finish stamp', () => {
        const html = renderToStaticMarkup(
            <RecentTasksPanel
                jobs={[
                    job({
                        summary: 'Fixed the failing gates and pushed',
                        wallClockMs: 1_200_000,
                        runtime: { contextTokens: 90433, costUsd: 0.31, activity: null, sampledAt: '' },
                    }),
                ]}
                error={null}
            />
        );
        expect(html).toContain('Recently completed');
        expect(html).toContain('Fixed the failing gates and pushed');
        expect(html).toContain('Alice Doe');
        expect(html).toContain('90.4k');
        expect(html).toContain('20m');
        expect(html).not.toContain('NaN');
    });

    it('falls back to the command when the run left no summary', () => {
        const html = renderToStaticMarkup(
            <RecentTasksPanel
                jobs={[job({ summary: null, command: 'refactor the ingest path\nsecond line' })]}
                error={null}
            />
        );
        expect(html).toContain('refactor the ingest path');
        expect(html).not.toContain('second line');
    });

    it('renders unmeasured context and wall clock as em dashes, never zeros', () => {
        const html = renderToStaticMarkup(<RecentTasksPanel jobs={[job()]} error={null} />);
        expect(html).toContain('<td>—</td>');
        expect(html).not.toContain('<td>0</td>');
    });

    it('renders the empty state', () => {
        const html = renderToStaticMarkup(<RecentTasksPanel jobs={[]} error={null} />);
        expect(html).toContain('No completed tasks yet.');
    });

    it('renders a read failure as an alert instead of a blank section', () => {
        // The hook keeps the last good answer through a failed tick; the panel's own job is to
        // say the read failed rather than render nothing.
        const html = renderToStaticMarkup(<RecentTasksPanel jobs={null} error="connection refused" />);
        expect(html).toContain('connection refused');
    });
});
