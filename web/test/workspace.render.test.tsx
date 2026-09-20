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

const render = (repos: WorkspaceRepo[]) => renderToStaticMarkup(<WorkspaceReposPanel repos={repos} />);

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
    // The panel is the list itself plus the scope context (#183): the "My workspace" heading, the
    // guidance that says what an executor does and does not control, and the rows.
    const executor = (name: string, type: string, createdAt = '2026-09-01T00:00:00.000Z') => ({
        name,
        type,
        createdAt,
    });

    it('scopes the list under "My workspace" and carries the deployment guidance', () => {
        const html = renderToStaticMarkup(<WorkspaceExecutorsPanel executors={[]} onEdit={() => {}} />);
        expect(html).toContain('<h2>My workspace</h2>');
        expect(html).toContain('The deployment chooses the runner CLI and image');
        expect(html).toContain('does not switch the deployment between Claude Code and OpenCode');
    });

    it('says new tasks use the image default when the list is empty', () => {
        const html = renderToStaticMarkup(<WorkspaceExecutorsPanel executors={[]} onEdit={() => {}} />);
        expect(html).toContain('No personal executors configured');
        expect(html).toContain('use the deployment&#x27;s image default');
        expect(html).not.toContain('No executors configured');
    });

    it('renders a row per executor with its HUMAN type label, and never a placeholder value', () => {
        const html = renderToStaticMarkup(
            <WorkspaceExecutorsPanel
                executors={[executor('main', 'claude-code'), executor('oc', 'opencode')]}
                onEdit={() => {}}
            />
        );
        expect(html).toContain('Claude Code');
        expect(html).toContain('OpenCode');
        // The stored union value is for the API, not for the member.
        expect(html).not.toContain('claude-code');
        expect(html).not.toContain('No personal executors configured');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('marks only the first row as selected first — a fact about the composer, not a default', () => {
        const html = renderToStaticMarkup(
            <WorkspaceExecutorsPanel
                executors={[executor('main', 'claude-code'), executor('oc', 'opencode')]}
                onEdit={() => {}}
            />
        );
        expect(html.match(/Selected first on new tasks/g)?.length).toBe(1);
    });

    it('never carries a row config — the poll payload has none, and the type enforces it', () => {
        // WorkspaceExecutor has no config field; an excess property is a compile error, and the
        // render proves the summary path cannot leak one either.
        const html = renderToStaticMarkup(
            <WorkspaceExecutorsPanel executors={[executor('main', 'claude-code')]} onEdit={() => {}} />
        );
        expect(html).not.toContain('{');
    });

    it('uses the real table primitives, focusable wrapper included', () => {
        const html = renderToStaticMarkup(
            <WorkspaceExecutorsPanel executors={[executor('main', 'claude-code')]} onEdit={() => {}} />
        );
        expect(html).toContain('table-wrap');
        expect(html).toContain('<table class="data"');
        expect(html).toContain('scope="col"');
    });

    it('renders an Edit action per executor row', () => {
        const html = renderToStaticMarkup(
            <WorkspaceExecutorsPanel
                executors={[executor('main', 'claude-code'), executor('oc', 'opencode')]}
                onEdit={() => {}}
            />
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
