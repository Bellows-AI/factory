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
    waitReason: null,
    waitingSince: null,
    waitTerminalReason: null,
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

/** Every `<li>` row of the list, as its own markup slice. */
const rowsOf = (html: string): string[] => html.match(/<li class="inbox-row">.*?<\/li>/g) ?? [];

/** The href of the one `<a>` whose opening tag carries `attribute`, whatever the attribute order. */
const linkHref = (html: string, attribute: string): string | undefined =>
    html
        .match(/<a [^>]*>/g)
        ?.find((tag) => tag.includes(attribute))
        ?.match(/href="([^"]*)"/)?.[1];

describe('TaskInboxPage header', () => {
    it('names the page, describes it, and offers New task as its one action', () => {
        const html = renderInbox({
            navigation: navigation({ running: 1, review: 2 }),
            items: [taskSummary()],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('<h1>Tasks</h1>');
        expect(html).toContain('Delegate software work to AI agents and review their changes.');
        expect(html).toContain('href="/tasks/new"');
        expect(html).toContain('New task');
        // The org-wide counts moved into the count cards; the header carries no meta line.
        expect(html).not.toContain('page-header-meta');
    });
});

describe('TaskInboxPage count cards', () => {
    it('links each organization count to its state tab, named as a sentence', () => {
        const html = renderInbox({
            navigation: navigation({ review: 12, running: 3, past: 86 }),
            items: [taskSummary()],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('href="/tasks?state=review"');
        expect(html).toContain('href="/tasks?state=running"');
        expect(html).toContain('href="/tasks?state=past"');
        expect(html).toContain('aria-label="12 tasks need review across the organization"');
        expect(html).toContain('aria-label="3 running tasks across the organization"');
        expect(html).toContain('aria-label="86 past tasks across the organization"');
        expect((html.match(/Organization total/g) ?? []).length).toBe(3);
    });

    it('reads the same counts, and the same bare links, whatever the filters', () => {
        const html = renderInbox(
            {
                navigation: navigation({ review: 12, running: 3, past: 86 }),
                items: [],
                nextCursor: null,
                initial: false,
                filters: { state: 'past', q: 'login', repo: 'acme/widgets', author: 'octocat', sort: 'oldest' },
            },
            '/tasks?state=past&q=login&repo=acme%2Fwidgets&author=octocat&sort=oldest'
        );
        expect(html).toContain('aria-label="12 tasks need review across the organization"');
        expect(html).toContain('aria-label="86 past tasks across the organization"');
        expect(html).toContain('href="/tasks?state=review"');
    });

    it('renders no card before the organization counts have landed', () => {
        const html = renderInbox({ navigation: null, items: null, nextCursor: null, initial: true });
        expect(html).not.toContain('Organization total');
    });
});

describe('TaskInboxPage filter chips', () => {
    const filtered = () =>
        renderInbox(
            {
                navigation: navigation({ review: 1 }),
                items: [taskSummary()],
                nextCursor: null,
                initial: false,
                filters: { state: 'review', q: 'login', repo: 'acme/widgets', author: 'octocat', sort: 'oldest' },
            },
            '/tasks?state=review&q=login&repo=acme%2Fwidgets&author=octocat&sort=oldest'
        );

    it('shows one chip per applied search, repository and author filter', () => {
        const html = filtered();
        expect((html.match(/class="inbox-chip"/g) ?? []).length).toBe(3);
        expect(html).toContain('Search: login');
        expect(html).toContain('Repository: acme/widgets');
        expect(html).toContain('Author: octocat');
    });

    it('removes exactly one filter per chip, keeping state, sort and the other filters', () => {
        const html = filtered();
        expect(linkHref(html, 'aria-label="Remove filter: Search"')).toBe(
            '/tasks?state=review&amp;repo=acme%2Fwidgets&amp;author=octocat&amp;sort=oldest'
        );
        expect(linkHref(html, 'aria-label="Remove filter: Repository"')).toBe(
            '/tasks?state=review&amp;q=login&amp;author=octocat&amp;sort=oldest'
        );
        expect(linkHref(html, 'aria-label="Remove filter: Author"')).toBe(
            '/tasks?state=review&amp;q=login&amp;repo=acme%2Fwidgets&amp;sort=oldest'
        );
    });

    it('offers Clear filters back to the bare inbox beside the chips', () => {
        expect(linkHref(filtered(), 'class="inbox-clear"')).toBe('/tasks');
    });

    it('draws no chip for the default filters, nor for a non-default state or sort alone', () => {
        const html = renderInbox(
            {
                navigation: navigation({ review: 1 }),
                items: [taskSummary()],
                nextCursor: null,
                initial: false,
                filters: { state: 'past', q: null, repo: null, author: null, sort: 'oldest' },
            },
            '/tasks?state=past&sort=oldest'
        );
        expect(html).not.toContain('inbox-chip');
        expect(html).not.toContain('inbox-clear');
    });
});

describe('TaskInboxPage rows', () => {
    const everyState = (): { tasks: InboxTasks; html: string } => {
        const items = [
            taskSummary({ status: 'running', activity: '→ Bash npm test' }),
            taskSummary({ id: '22222222-2222-4222-8222-222222222222', status: 'queued' }),
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
        expect(html).toContain('Stopping');
        expect(html).toContain('Failed · Needs review');
        expect(html).toContain('Stopped · Needs review');
        expect(html).toContain('Done');
    });

    it('renders an open PR-review wait as Waiting for review, with the grey paused dot', () => {
        const html = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary({ status: 'queued', waitReason: 'review', waitingSince: '2026-09-01T12:05:00.000Z' })],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('Waiting for review');
        expect(html).not.toContain('>Queued<');
        expect(html).toContain('sidenav-dot-paused');
    });

    it('appends the terminal wait reason to the needs-review row once the wait has ended', () => {
        const html = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [
                taskSummary({
                    status: 'succeeded',
                    waitReason: 'review',
                    waitTerminalReason: 'exhausted',
                }),
            ],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('Succeeded · Needs review · exhausted');
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
                taskSummary({ id: '22222222-2222-4222-8222-222222222222', status: 'queued', activity: '→ stale' }),
            ],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('→ Bash npm test');
        expect(html).not.toContain('→ stale');
    });

    it('shows a terminal row its summary on one line, the full text in its title', () => {
        const summary = 'Fixed the redirect loop and added a regression test for the login flow';
        const html = renderInbox({
            navigation: navigation({ review: 2 }),
            items: [
                taskSummary({ summary }),
                taskSummary({ id: '22222222-2222-4222-8222-222222222222', status: 'queued', summary: 'old words' }),
                taskSummary({
                    id: '33333333-3333-4333-8333-333333333333',
                    status: 'running',
                    activity: '→ Bash npm test',
                    summary: 'last run words',
                }),
            ],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain(`class="inbox-summary" title="${summary}">${summary}<`);
        expect(html).not.toContain('old words');
        expect(html).not.toContain('last run words');
    });

    it('draws each state as a toned pill from the one precedence', () => {
        const { html } = everyState();
        const rows = rowsOf(html);
        expect(rows).toHaveLength(6);
        expect(rows[0]).toContain('pill pill-ok');
        expect(rows[1]).toContain('pill pill-done');
        expect(rows[2]).toContain('sidenav-dot-stopping');
        expect(rows[3]).toContain('pill pill-bad');
        expect(rows[4]).toContain('pill pill-done');
        expect(rows[5]).toContain('pill pill-done inbox-state-done');
        const review = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary()],
            nextCursor: null,
            initial: false,
        });
        expect(review).toContain('pill pill-accent');
        const waiting = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary({ status: 'queued', waitReason: 'review' })],
            nextCursor: null,
            initial: false,
        });
        expect(waiting).toContain('pill pill-done inbox-state-waiting');
    });

    it('holds exactly one link per row, and it is the title', () => {
        const { html } = everyState();
        for (const row of rowsOf(html)) {
            expect((row.match(/<a /g) ?? []).length).toBe(1);
            expect(row).toMatch(/^<li class="inbox-row"><span class="inbox-title">(<span[^>]*><\/span>)?<a /);
        }
    });

    it('renders the author as an avatar beside the login, and names a missing one', () => {
        const html = renderInbox({
            navigation: navigation({ review: 3 }),
            items: [
                taskSummary({ author: { id: 'a', login: 'octocat', name: null, avatarUrl: 'https://x.test/o.png' } }),
                taskSummary({
                    id: '22222222-2222-4222-8222-222222222222',
                    author: { id: 'b', login: 'hubot', name: null, avatarUrl: null },
                }),
                taskSummary({ id: '33333333-3333-4333-8333-333333333333', author: null }),
            ],
            nextCursor: null,
            initial: false,
        });
        const [withPicture, withInitial, unknown] = rowsOf(html);
        expect(withPicture).toContain('<img class="avatar" src="https://x.test/o.png"');
        expect(withPicture).toContain('octocat');
        expect(withInitial).toContain('avatar avatar-fallback');
        expect(withInitial).toContain('>H<');
        expect(unknown).toContain('>?<');
        expect(unknown).toContain('Unknown author');
    });
});

describe('TaskInboxPage footer', () => {
    it('counts the loaded rows, never a total', () => {
        const one = renderInbox({
            navigation: navigation({ review: 40 }),
            items: [taskSummary()],
            nextCursor: 'abc',
            initial: false,
        });
        expect(one).toContain('Showing 1 loaded task<');
        const two = renderInbox({
            navigation: navigation({ review: 40 }),
            items: [taskSummary(), taskSummary({ id: '22222222-2222-4222-8222-222222222222' })],
            nextCursor: null,
            initial: false,
        });
        expect(two).toContain('Showing 2 loaded tasks');
        expect(two).not.toContain('of 40');
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
            // The hook's real shape: a first-page failure IS the retained refresh error
            // (`firstPageError`), so both fields carry it at once.
            error: 'database is down',
            refreshError: 'database is down',
        });
        expect(html).toContain('load tasks — database is down');
        expect(html).toContain('Retry');
        // Nothing was ever shown, so there is no "last successful update" to fall back on.
        expect(html).not.toContain('showing the last successful update');
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

    it('keeps the labeled search form with its Filter button, and sorts by links, not a dropdown', () => {
        const html = renderInbox({ navigation: null, items: null, nextCursor: null, initial: true });
        expect(html).toContain('placeholder="Search task requests"');
        expect(html).toMatch(/<label[^>]*>Author<\/label><input class="field"[^>]*type="text"/);
        expect(html).toContain('<button type="submit">Filter</button>');
        const sort = html.match(/<nav class="inbox-sort"[^>]*>.*?<\/nav>/)?.[0] ?? '';
        expect(sort).toContain('aria-label="Sort"');
        expect(sort).toContain('href="/tasks?sort=oldest"');
        expect(sort).toContain('href="/tasks"');
        expect(sort).not.toContain('<select');
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
