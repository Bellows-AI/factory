import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { pollDelay } from '../src/api/useWorkspace.js';
import { bytes, commitDate } from '../src/format.js';
import { WorkspaceExecutorsPanel } from '../src/panels/WorkspaceExecutorsPanel.js';

/** The same contract panels.render.test.tsx pins: a null metric never leaks as a value. */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

/*
 * The checked-out-repository rows moved to the repositories page (issue 181); their contracts —
 * dashes for unmeasured facts, the failed reason inline, the checking posture — are pinned in
 * repository-setup.test.ts and repository-setup.render.test.tsx against the components that
 * render them now. What stays here is the executors panel and the workspace poll's own math.
 */

describe('the executors panel', () => {
    // The panel is the list itself plus the scope context (#183): the "My workspace" heading, the
    // guidance that says the type controls task execution, and the rows.
    const executor = (name: string, type: string, createdAt = '2026-09-01T00:00:00.000Z') => ({
        name,
        type,
        createdAt,
    });

    it('scopes the list under "My workspace" and carries task-routing guidance', () => {
        const html = renderToStaticMarkup(<WorkspaceExecutorsPanel executors={[]} onEdit={() => {}} />);
        expect(html).toContain('<h2>My workspace</h2>');
        expect(html).toContain('Each task runs with its selected executor');
        expect(html).toContain('type chooses Claude Code or OpenCode');
    });

    it('says an executor is required when the list is empty', () => {
        const html = renderToStaticMarkup(<WorkspaceExecutorsPanel executors={[]} onEdit={() => {}} />);
        expect(html).toContain('No personal executors configured');
        expect(html).toContain('Add one before starting a task');
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
        const BYTES_1_5_KB = 1536;
        expect(bytes(BYTES_1_5_KB)).toBe('1.5 KB');
        const BYTES_43_MB = 45_000_000;
        expect(bytes(BYTES_43_MB)).toBe('43 MB');
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
        const FAST_POLL_MS = 2_000;
        const MEDIUM_POLL_MS = 5_000;
        const SLOW_POLL_MS = 15_000;
        const JUST_UNDER_ONE_MINUTE_MS = 59_000;
        const JUST_OVER_ONE_MINUTE_MS = 61_000;
        const TEN_MINUTES_MS = 600_000;
        expect(pollDelay(0)).toBe(FAST_POLL_MS);
        expect(pollDelay(JUST_UNDER_ONE_MINUTE_MS)).toBe(FAST_POLL_MS);
        expect(pollDelay(JUST_OVER_ONE_MINUTE_MS)).toBe(MEDIUM_POLL_MS);
        expect(pollDelay(TEN_MINUTES_MS)).toBe(SLOW_POLL_MS);
    });
});
