import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkspaceRepo } from '../src/api/useWorkspace.js';
import { pollDelay } from '../src/api/useWorkspace.js';
import { bytes, commitDate } from '../src/format.js';
import { WorkspaceExecutorsPanel } from '../src/panels/WorkspaceExecutorsPanel.js';
import { WorkspaceReposPanel } from '../src/panels/WorkspaceReposPanel.js';

/** The same contract panels.render.test.tsx pins: a null metric never leaks as a value. */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

function repo(overrides: Partial<WorkspaceRepo> = {}): WorkspaceRepo {
    return {
        owner: 'acme',
        name: 'web',
        status: 'ready',
        error: null,
        selectedAt: '2026-08-01T00:00:00.000Z',
        readyAt: '2026-08-01T00:05:00.000Z',
        branch: 'main',
        lastCommit: { sha: 'abc1234', at: '2026-08-20T09:00:00.000Z', headline: 'feat: x' },
        sizeBytes: 45_000_000,
        ...overrides,
    };
}

const render = (repos: WorkspaceRepo[]) =>
    renderToStaticMarkup(<WorkspaceReposPanel repos={repos} />);

describe('the workspace panel', () => {
    it('never emits a placeholder value for an absent metric', () => {
        const html = render([
            repo(),
            repo({ name: 'api', status: 'cloning', branch: null, lastCommit: null, sizeBytes: null }),
        ]);
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('renders a cloning repo with dashes, never with zeroes', () => {
        // A repository that has not cloned has no size and no branch. `0 B` would be a claim about
        // an empty repository rather than an absence of measurement.
        const html = render([repo({ status: 'cloning', branch: null, lastCommit: null, sizeBytes: null })]);
        expect(html).toContain('—');
        expect(html).not.toContain('0 B');
    });

    it('carries a failed clone\'s reason inline rather than only saying "failed"', () => {
        const html = render([repo({ status: 'failed', error: 'fatal: repository not found' })]);
        expect(html).toContain('failed');
        expect(html).toContain('fatal: repository not found');
    });

    it('renders one row per selected repository', () => {
        const html = render([repo(), repo({ name: 'api' })]);
        expect(html.match(/<tr/g)?.length).toBe(3); // header + two rows
    });
});

describe('the executors panel', () => {
    it('says "No executors configured" when the list is empty', () => {
        const html = renderToStaticMarkup(
            <WorkspaceExecutorsPanel executors={[]} onAdd={() => {}} onEdit={() => {}} />,
        );
        expect(html).toContain('No executors configured');
        expect(html).toContain('Add executor');
    });

    it('renders a row per executor with its type, and never a placeholder value', () => {
        const html = renderToStaticMarkup(
            <WorkspaceExecutorsPanel
                executors={[{ name: 'main', type: 'claude-code', createdAt: '2026-09-01T00:00:00.000Z' }]}
                onAdd={() => {}}
                onEdit={() => {}}
            />,
        );
        expect(html).toContain('main');
        expect(html).toContain('claude-code');
        expect(html).not.toContain('No executors configured');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('renders an Edit action per executor row', () => {
        const html = renderToStaticMarkup(
            <WorkspaceExecutorsPanel
                executors={[
                    { name: 'main', type: 'claude-code', createdAt: '2026-09-01T00:00:00.000Z' },
                    { name: 'oc', type: 'opencode', createdAt: '2026-09-02T00:00:00.000Z' },
                ]}
                onAdd={() => {}}
                onEdit={() => {}}
            />,
        );
        expect(html.match(/>Edit</g)?.length).toBe(2);
    });
});

describe('formatting', () => {
    it('renders an absent size as an em dash rather than zero', () => {
        expect(bytes(null)).toBe('—');
        expect(bytes(0)).toBe('0 B');
        // A decimal below 10 and none above it: "1.5 KB" is a useful distinction and "42.9 MB" is
        // false precision on a number that changes every time anybody runs a build.
        expect(bytes(1536)).toBe('1.5 KB');
        expect(bytes(45_000_000)).toBe('43 MB');
    });

    it('renders an absent or unparseable commit date as an em dash', () => {
        expect(commitDate(null)).toBe('—');
        expect(commitDate('not a date')).toBe('—');
        expect(commitDate('2026-08-20T09:00:00.000Z')).toBe('2026-08-20');
    });
});

describe('the poll back-off', () => {
    it('stays at two seconds while somebody is watching, then eases off', () => {
        // Pure, and tested as such: a static list refetched every two seconds forever is a query
        // per member per tick for a value that only changes when they act.
        expect(pollDelay(0)).toBe(2_000);
        expect(pollDelay(59_000)).toBe(2_000);
        expect(pollDelay(61_000)).toBe(5_000);
        expect(pollDelay(10 * 60_000)).toBe(15_000);
    });
});
