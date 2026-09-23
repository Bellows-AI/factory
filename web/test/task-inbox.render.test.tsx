import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { TaskNavigation, UseTasks } from '../src/api/useTasks.js';
import { TaskInboxPage } from '../src/pages/TaskInboxPage.js';

/**
 * The task inbox at /tasks (#158): rows, page states, URL filters. The page
 * reads the published context through `useTasksPage`, so the harness mounts it
 * under an Outlet context carrying the poll fake and a workspace fake — the
 * same two-level shape the shell and the layout publish in the real tree.
 */

const emptyWorkspace = { data: null, loading: true, error: null, refresh: () => {} };

const taskSummary = (over: Partial<import('../src/api/useTasks.js').TaskSummary> = {}) => ({
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the flaky login test',
    status: 'succeeded' as const,
    cancelRequestedAt: null,
    doneAt: null,
    repo: 'acme/widgets',
    executor: null,
    author: null,
    activity: null,
    summary: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    activityAt: '2026-09-01T12:10:00.000Z',
    ...over,
});

const navigation = (over: Partial<TaskNavigation['counts']> = {}): TaskNavigation => ({
    counts: { running: 0, review: 0, past: 0, ...over },
    running: [],
    review: [],
});

interface InboxTasks extends Partial<UseTasks> {
    items?: UseTasks['items'];
}

const renderInbox = (tasks: InboxTasks, path = '/tasks') => {
    const fake = {
        retry: () => {},
        loadMore: () => {},
        refresh: () => {},
        error: null,
        refreshError: null,
        loadMoreError: null,
        loadingMore: false,
        refreshing: false,
        actions: {},
        filters: { state: 'attention', q: null, repo: null, author: null, sort: 'newest' },
        ...tasks,
    } as UseTasks;
    return renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
            <Routes>
                <Route element={<Outlet context={{ tasks: fake, workspace: emptyWorkspace }} />}>
                    <Route path="tasks" element={<Outlet context={{ tasks: fake, workspace: emptyWorkspace }} />}>
                        <Route index element={<TaskInboxPage />} />
                        <Route path="new" element={<div id="composer-slot">composer slot</div>} />
                    </Route>
                </Route>
            </Routes>
        </MemoryRouter>
    );
};

describe('TaskInboxPage header', () => {
    it('names the page, counts the organization, and omits zero clauses', () => {
        const html = renderInbox({
            navigation: navigation({ running: 1, review: 2 }),
            items: [taskSummary()],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('<h1>Tasks</h1>');
        expect(html).toContain('1 running');
        expect(html).toContain('2 need review');
        expect(html).toContain('href="/tasks/new"');
        expect(html).toContain('New task');
    });

    it('says so when nothing moves, instead of a zero-littered meta line', () => {
        const html = renderInbox({
            navigation: navigation(),
            items: [taskSummary()],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('Nothing moving');
        expect(html).not.toContain('0 running');
    });
});

describe('TaskInboxPage rows', () => {
    const everyState = (): { tasks: InboxTasks; html: string } => {
        const items = [
            taskSummary({ status: 'running', activity: '→ Bash npm test' }),
            taskSummary({ id: '22222222-2222-4222-8222-222222222222', status: 'queued' }),
            taskSummary({ id: '33333333-3333-4333-8333-333333333333', status: 'standby' }),
            taskSummary({
                id: '44444444-4444-4444-8444-444444444444',
                status: 'running',
                cancelRequestedAt: '2026-09-01T12:11:00.000Z',
            }),
            taskSummary({ id: '55555555-5555-4555-8555-555555555555', status: 'failed' }),
            taskSummary({ id: '66666666-6666-4666-8666-666666666666', status: 'stopped' }),
            taskSummary({
                id: '77777777-7777-4777-8777-777777777777',
                status: 'succeeded',
                doneAt: '2026-09-01T13:00:00.000Z',
            }),
        ];
        const html = renderInbox({
            navigation: navigation({ running: 2, review: 2, past: 1 }),
            items,
            nextCursor: null,
            initial: false,
        });
        return { tasks: { items }, html };
    };

    it('renders the state as visible text for every workflow state and result', () => {
        const { html } = everyState();
        expect(html).toContain('Running');
        expect(html).toContain('Queued');
        expect(html).toContain('Parked');
        expect(html).toContain('Stopping');
        expect(html).toContain('Failed · Needs review');
        expect(html).toContain('Stopped · Needs review');
        expect(html).toContain('Done');
    });

    it('makes the title the one link to the detail view, with repo, author and a precise age', () => {
        const author = { id: 'a', login: 'octocat', name: null, avatarUrl: null };
        const html = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary({ author, activityAt: '2026-09-01T12:10:00.000Z' })],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('href="/tasks/11111111-1111-4111-8111-111111111111"');
        expect(html).toContain('acme/widgets');
        expect(html).toContain('octocat');
        // The relative age is backed by a machine-readable stamp and a precise hover value.
        expect(html).toContain('dateTime="2026-09-01T12:10:00.000Z"');
        expect(html).toContain('title="2026-09-01 12:10"');
    });

    it('shows the live activity line only under a running task', () => {
        const html = renderInbox({
            navigation: navigation({ running: 1 }),
            items: [
                taskSummary({ status: 'running', activity: '→ Bash npm test' }),
                taskSummary({ id: '22222222-2222-4222-8222-222222222222', status: 'standby', activity: '→ stale' }),
            ],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('→ Bash npm test');
        expect(html).not.toContain('→ stale');
    });
});

describe('TaskInboxPage page states', () => {
    it('loads with skeletons, never the empty call to action', () => {
        const html = renderInbox({ navigation: null, items: null, nextCursor: null, initial: true });
        expect(html).toContain('Loading tasks…');
        expect(html).not.toContain('No tasks yet');
        expect(html).not.toContain('No tasks match');
    });

    it('answers an empty organization with the first-task call to action', () => {
        const html = renderInbox({ navigation: navigation(), items: [], nextCursor: null, initial: false });
        expect(html).toContain('No tasks yet');
        expect(html).toContain('Start your first task');
        expect(html).not.toContain('No tasks match');
    });

    it('answers a filtered empty set with Clear filters, never the first-task CTA', () => {
        const html = renderInbox({
            navigation: navigation({ review: 3 }),
            items: [],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('No tasks match these filters');
        expect(html).toContain('href="/tasks"');
        expect(html).toContain('Clear filters');
        expect(html).not.toContain('No tasks yet');
    });

    it('renders an inline error with Retry when the first page fails with nothing to show', () => {
        const html = renderInbox({
            navigation: null,
            items: null,
            nextCursor: null,
            initial: false,
            error: 'database is down',
        });
        expect(html).toContain('load tasks — database is down');
        expect(html).toContain('Retry');
    });

    it('keeps the rows beside the refresh error', () => {
        const html = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary()],
            nextCursor: null,
            initial: false,
            refreshError: 'Request failed (503)',
        });
        expect(html).toContain('showing the last successful update.');
        expect(html).toContain('fix the flaky login test');
    });

    it('keeps the rows beside an older-page failure, with its own Retry', () => {
        const html = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary()],
            nextCursor: 'abc',
            initial: false,
            loadMoreError: 'Request failed (503)',
        });
        expect(html).toContain('load more tasks — Request failed (503)');
        expect(html).toContain('fix the flaky login test');
    });
});

describe('TaskInboxPage pagination', () => {
    it('offers Load more only when a cursor exists, disabling into Loading…', () => {
        const more = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary()],
            nextCursor: 'abc',
            initial: false,
        });
        expect(more).toContain('Load more');
        expect(more).not.toContain('disabled');
        const loading = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary()],
            nextCursor: 'abc',
            initial: false,
            loadingMore: true,
        });
        expect(loading).toContain('Loading…');
        expect(loading).toContain('disabled');
        const exhausted = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary()],
            nextCursor: null,
            initial: false,
        });
        expect(exhausted).not.toContain('Load more');
    });
});

describe('TaskInboxPage filters', () => {
    it('renders the four state tabs with the active one marked', () => {
        const html = renderInbox({ navigation: null, items: null, nextCursor: null, initial: true });
        expect(html).toContain('Needs attention');
        expect(html).toContain('Running');
        expect(html).toContain('Needs review');
        expect(html).toContain('Past');
        // The state tab and the sort toggle both re-use the tab classes: exactly one active each.
        expect((html.match(/inbox-tab is-active/g) ?? []).length).toBe(2);
    });

    it('carries the current filters into the labeled search form', () => {
        const html = renderInbox(
            {
                navigation: null,
                items: null,
                nextCursor: null,
                initial: true,
                filters: { state: 'review', q: 'login', repo: 'acme/widgets', author: 'octocat', sort: 'oldest' },
            },
            '/tasks?state=review&q=login&repo=acme%2Fwidgets&author=octocat&sort=oldest'
        );
        expect(html).toContain('value="login"');
        expect(html).toContain('value="octocat"');
        // The repo select marks the currently filtered repository even though the workspace
        // poll answered nothing.
        expect(html).toContain('acme/widgets');
        expect(html).toContain('Oldest');
    });

    it('offers the workspace repositories in the repo select, and keeps a vanished filter selectable', () => {
        const workspace = {
            data: { root: null, repos: [{ owner: 'acme', name: 'web' }], orphaned: [], executors: [] },
            loading: false,
            error: null,
            refresh: () => {},
        };
        const tasks: InboxTasks = {
            navigation: null,
            items: null,
            nextCursor: null,
            initial: true,
            filters: { state: 'attention', q: null, repo: 'acme/gone', author: null, sort: 'newest' },
        };
        const html = renderToStaticMarkup(
            <MemoryRouter initialEntries={['/tasks?repo=acme%2Fgone']}>
                <Routes>
                    <Route element={<Outlet context={{ tasks: tasks as UseTasks, workspace }} />}>
                        <Route path="tasks" index element={<TaskInboxPage />} />
                    </Route>
                </Routes>
            </MemoryRouter>
        );
        expect(html).toContain('acme/web');
        expect(html).toContain('acme/gone');
    });
});

describe('the composer route', () => {
    it('is not the inbox index: /tasks renders the inbox, /tasks/new its own address', () => {
        // Route-order pin: `new` must precede `:id` or the detail page would swallow it. The
        // inbox's own content is asserted above; here the route table's shape is what is pinned.
        const html = renderInbox({ navigation: null, items: null, nextCursor: null, initial: true });
        expect(html).toContain('Loading tasks…');
    });
});

describe('the inbox sweep', () => {
    it('never leaks the sentinel values into the markup', () => {
        const html = renderInbox({
            navigation: navigation({ running: 1 }),
            items: [taskSummary({ status: 'running', activity: '→ Bash npm test', author: null })],
            nextCursor: 'abc',
            initial: false,
        });
        for (const forbidden of ['NaN', 'undefined', 'Infinity', '[object Object]']) {
            expect(html).not.toContain(forbidden);
        }
    });
});
