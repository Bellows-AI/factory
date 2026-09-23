import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { Job } from '../src/api/useJobs.js';
import { RecentTasksPanel } from '../src/panels/RecentTasksPanel.js';

/**
 * A render smoke test for the dashboard's Task board section: the task's identity is the ROOT
 * COMMAND's first line — the agent's closing summary is outcome text, not identity — linked to
 * the task page, the finish stamp is relative with the precise time on hover/focus, a failed
 * poll keeps the last good rows beside its alert, and the null-not-zero contract survives to
 * the markup.
 */

const NOW = new Date('2026-08-21T14:00:00.000Z');

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
    finishedAt: '2026-08-21T13:40:00.000Z',
    wallClockMs: null,
    taskWallClockMs: null,
    waitReason: null,
    waitingSince: null,
    waitTerminalReason: null,
    ...over,
});

const render = (jobs: Job[] | null, error: string | null) =>
    renderToStaticMarkup(
        <MemoryRouter>
            <RecentTasksPanel jobs={jobs} error={error} now={NOW} />
        </MemoryRouter>
    );

describe('the task board section', () => {
    it('carries the Task board heading and the one-sentence scope note', () => {
        const html = render([job({})], null);
        expect(html).toContain('Task board');
        expect(html).toContain('Latest finished tasks from the board; analytics range and scope do not filter this');
        // The old multi-sentence explanation is gone.
        expect(html).not.toContain('closing words');
    });

    it('titles the row from the root command and links it to the task page', () => {
        const html = render(
            [job({ summary: 'Fixed the failing gates and pushed', command: 'fix the failing gates' })],
            null
        );
        expect(html).toContain('href="/tasks/11111111-1111-4111-8111-111111111111"');
        expect(html).toContain('fix the failing gates');
        // The agent's summary is outcome text, never the task's identity.
        expect(html).not.toContain('Fixed the failing gates and pushed');
    });

    it('uses the first NON-empty command line and stops there', () => {
        const html = render([job({ command: '\n  \nrefactor the ingest path\nsecond line' })], null);
        expect(html).toContain('refactor the ingest path');
        expect(html).not.toContain('second line');
    });

    it('renders the finish stamp relative, with the precise UTC time on hover/focus', () => {
        const html = render([job({ finishedAt: '2026-08-21T13:40:00.000Z' })], null);
        expect(html).toContain('20m ago');
        expect(html).toContain('dateTime="2026-08-21T13:40:00.000Z"');
        expect(html).toContain('title="2026-08-21 13:40"');
    });

    it('renders the thread wall clock, not the head run’s own slice', () => {
        // One row per task (issue 124): the row carries the head run's own banked clock beside the
        // thread total, and the panel shows the thread figure — what the task view's head clock
        // shows.
        const html = render([job({ wallClockMs: 300_000, taskWallClockMs: 1_200_000 })], null);
        expect(html).toContain('20m');
        expect(html).not.toContain('5m');
    });

    it('renders unmeasured context and wall clock as em dashes, never zeros', () => {
        const html = render([job()], null);
        expect(html).toMatch(/<td[^>]*>—<\/td>/);
        expect(html).not.toContain('<td>0</td>');
        expect(html).not.toContain('NaN');
    });

    it('links to the full task list after the table', () => {
        const html = render([job()], null);
        expect(html).toContain('href="/tasks"');
        expect(html).toContain('View all tasks');
    });

    it('keeps the last good rows on screen beside the failure alert', () => {
        // The hook survives a failed tick with the previous answer intact; the panel's job is to
        // say the read failed AND keep the rows — not to blank the section.
        const html = render([job({ id: '22222222-2222-4222-8222-222222222222' })], 'connection refused');
        expect(html).toContain('The board could not be read — connection refused');
        expect(html).toContain('fix the failing gates');
        expect(html).toContain('href="/tasks/22222222-2222-4222-8222-222222222222"');
    });

    it('renders a cold read failure as an alert instead of a blank section', () => {
        const html = render(null, 'connection refused');
        expect(html).toContain('connection refused');
        expect(html).not.toContain('View all tasks');
    });

    it('renders the empty state', () => {
        const html = render([], null);
        expect(html).toContain('No completed tasks yet.');
    });

    it('renders a loading state before the first answer', () => {
        expect(render(null, null)).toContain('Loading…');
    });
});
