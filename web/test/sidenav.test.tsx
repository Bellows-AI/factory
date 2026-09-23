import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SideNav } from '../src/components/SideNav.js';
import type { TaskNavigation, TaskSummary } from '../src/api/useTasks.js';

/**
 * `MemoryRouter` rather than a browser router: this suite has no DOM, and a router that reads
 * `window.location` cannot run here. It is also the one router that exists under the same name in
 * both v6 and v7.
 */

const render = (path: string, navigation: TaskNavigation | null = null) =>
    renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
            <SideNav navigation={navigation} />
        </MemoryRouter>
    );

let seq = 0;
const UUID_SUFFIX_WIDTH = 12;
const summary = (over: Partial<TaskSummary> = {}): TaskSummary => {
    seq += 1;
    const id = over.id ?? `00000000-0000-4000-8000-${String(seq).padStart(UUID_SUFFIX_WIDTH, '0')}`;
    return {
        id,
        command: over.command ?? 'newer task',
        status: over.status ?? 'succeeded',
        cancelRequestedAt: over.cancelRequestedAt ?? null,
        doneAt: over.doneAt ?? null,
        repo: over.repo ?? 'acme/widgets',
        executor: over.executor ?? null,
        author: over.author ?? null,
        activity: over.activity ?? null,
        summary: over.summary ?? null,
        createdAt: over.createdAt ?? '2026-09-02T12:00:00.000Z',
        activityAt: over.activityAt ?? '2026-09-02T12:10:00.000Z',
    };
};

/** A running task overrides the finished default wholesale, so a bare `{ status: 'running' }` stays coherent. */
const running = (over: Partial<TaskSummary> = {}): Partial<TaskSummary> => ({
    status: 'running',
    ...over,
});

const navigation = (
    runningTasks: TaskSummary[],
    reviewTasks: TaskSummary[],
    counts?: TaskNavigation['counts']
): TaskNavigation => ({
    counts: counts ?? {
        running: runningTasks.length,
        review: reviewTasks.length,
        past: 0,
    },
    running: runningTasks,
    review: reviewTasks,
});

describe('SideNav', () => {
    it('links to every section', () => {
        const html = render('/');
        expect(html).toContain('href="/"');
        expect(html).toContain('href="/settings"');
        expect(html).toContain('href="/tasks"');
        expect(html).toContain('Dashboard');
        expect(html).toContain('Settings');
        expect(html).toContain('Tasks');
        // The old sections are gone: their pages live under the Settings tree now (#150).
        expect(html).not.toContain('href="/workspace"');
        expect(html).not.toContain('href="/env"');
    });

    it('orders the primary navigation Dashboard → Tasks → Settings', () => {
        // Observe → act → configure (#159): the report first, the work second, the
        // configuration last. Account is not here at all — it lives in the user menu.
        const html = render('/');
        expect(html.indexOf('href="/"')).toBeLessThan(html.indexOf('href="/tasks"'));
        expect(html.indexOf('href="/tasks"')).toBeLessThan(html.indexOf('href="/settings"'));
    });

    it('renders the Settings tree only inside the settings area', () => {
        const inside = render('/settings/workspace');
        expect(inside).toContain('href="/settings/organization"');
        expect(inside).toContain('href="/settings/workspace"');
        expect(inside).toContain('href="/settings/repos"');
        expect(inside).toContain('href="/settings/executors"');
        expect(inside).toContain('Organization');
        expect(inside).toContain('Repositories');
        expect(inside).toContain('Executors');
        // Off the settings area the tree is not polled, has no data and is not navigation for
        // anything in view — it renders nothing, the same reading that gates the task preview.
        const outside = render('/');
        expect(outside).not.toContain('href="/settings/organization"');
        expect(outside).not.toContain('href="/settings/repos"');
    });

    it('marks the current section for assistive technology, not only visually', () => {
        expect(render('/settings/workspace')).toContain('aria-current="page"');
    });

    it('marks exactly the parent Settings link on the overview itself (#180)', () => {
        // /settings is a real page now: the parent is current, no section is, and the tree still
        // expands so every section is one click away.
        const html = render('/settings');
        expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(1);
        expect(html).toContain('sidenav-link is-active');
        expect(html).not.toContain('sidenav-sublink is-active');
        expect(html).toContain('href="/settings/organization"');
        expect(html).toContain('href="/settings/executors"');
    });

    it('marks the current section visually on both levels, but only the leaf as the page', () => {
        // Tree semantics: the Settings link and the current section's link both LIGHT UP (two
        // is-active markers, parent first), while aria-current="page" belongs to the leaf alone —
        // a page has one current address, and the parent is only the open section of the tree.
        const html = render('/settings/executors');
        const active = html.match(/is-active/g) ?? [];
        expect(active).toHaveLength(2);
        expect(html.indexOf('sidenav-link is-active')).toBeLessThan(html.indexOf('sidenav-sublink is-active'));
        const current = html.match(/aria-current="page"/g) ?? [];
        expect(current).toHaveLength(1);
        // The parent says "not current" explicitly instead of claiming the page marker.
        expect(html).toContain('aria-current="false"');
    });

    it('does not treat "/" as the parent of every other route', () => {
        // Without `end`, the index link matches every path below it and the dashboard would look
        // active three sections into the settings tree — where two markers are already correct.
        const html = render('/settings/repos');
        const active = html.match(/is-active/g) ?? [];
        expect(active).toHaveLength(2);
        const dashboard = html.slice(html.indexOf('href="/"'), html.indexOf('</a>'));
        expect(dashboard).not.toContain('is-active');
    });
});

describe('SideNav task preview', () => {
    it('carries the org-wide counts as badges and the pinned New task above the rows', () => {
        const html = render(
            '/tasks',
            navigation([summary(running({ activity: '→ Bash npm test' }))], [summary(), summary()])
        );
        expect(html).toContain('Running (1)');
        expect(html).toContain('Need review (2)');
        // The pinned affordance renders before the rows and links to the composer's own route.
        expect(html.indexOf('New task')).toBeLessThan(html.indexOf('sidenav-task-title'));
        expect(html).toContain('href="/tasks/new"');
    });

    it('omits zero-valued count clauses, and says so on an empty organization', () => {
        const reviewOnly = render('/tasks', navigation([], [summary()]));
        expect(reviewOnly).toContain('Need review (1)');
        expect(reviewOnly).not.toContain('Running (');
        const empty = render('/tasks', navigation([], []));
        expect(empty).toContain('No tasks yet');
        expect(empty).not.toContain('New task');
    });

    it('holds five rows hard: running first, then the newest needs-review, never past', () => {
        const MINUTE_1 = 1;
        const MINUTE_2 = 2;
        const MINUTE_3 = 3;
        const MINUTE_4 = 4;
        const runningTasks = [MINUTE_1, MINUTE_2, MINUTE_3, MINUTE_4].map((i) =>
            summary(running({ activityAt: `2026-09-02T12:0${i}:00.000Z` }))
        );
        // The server serves review rows NEWEST first; the helper trusts that order.
        const reviewTasks = [MINUTE_4, MINUTE_3, MINUTE_2, MINUTE_1].map((i) =>
            summary({ status: 'failed', activityAt: `2026-09-02T12:1${i}:00.000Z`, command: `review task ${i}` })
        );
        const RUNNING_COUNT = 9;
        const REVIEW_COUNT = 20;
        const PAST_COUNT = 100;
        const html = render(
            '/tasks',
            navigation(runningTasks, reviewTasks, { running: RUNNING_COUNT, review: REVIEW_COUNT, past: PAST_COUNT })
        );
        const rows = html.match(/sidenav-task-title/g) ?? [];
        const MAX_PREVIEW_ROWS = 5;
        expect(rows).toHaveLength(MAX_PREVIEW_ROWS);
        // Three running first — the preview caps running at three — then the two newest review.
        expect(html).toContain('review task 4');
        expect(html).toContain('review task 3');
        expect(html).not.toContain('review task 2');
    });

    it('collapses what did not fit into a link to the filtered inbox', () => {
        const TASK_1 = 1;
        const TASK_2 = 2;
        const TASK_3 = 3;
        const reviewTasks = [TASK_1, TASK_2, TASK_3].map((i) =>
            summary({ status: 'failed', command: `review task ${i}` })
        );
        const REVIEW_COUNT = 15;
        const html = render('/tasks', navigation([], reviewTasks, { running: 0, review: REVIEW_COUNT, past: 0 }));
        expect(html).toContain('+12 more need review');
        expect(html).toContain('href="/tasks?state=review"');
        // And a "View all" way into the inbox beside it.
        expect(html).toContain('View all');
    });

    it('keeps the row of the task being viewed visible even when the slots exclude it', () => {
        const open = summary({
            id: '99999999-9999-4999-8999-999999999999',
            status: 'failed',
            command: 'the open task',
        });
        // Six review rows newest-first; the preview shows the first five.
        const TASK_1 = 1;
        const TASK_2 = 2;
        const TASK_3 = 3;
        const TASK_4 = 4;
        const TASK_5 = 5;
        const TASK_6 = 6;
        const reviewTasks = [TASK_6, TASK_5, TASK_4, TASK_3, TASK_2, TASK_1].map((i) =>
            summary({ status: 'failed', command: `review task ${i}` })
        );
        const REVIEW_COUNT_WITHOUT_OPEN = 6;
        const without = render(
            '/tasks',
            navigation([], reviewTasks, { running: 0, review: REVIEW_COUNT_WITHOUT_OPEN, past: 0 })
        );
        expect(without).not.toContain('the open task');
        expect(without).toContain('review task 2');
        // Open and outside the five (it is the oldest of seven): injected, and the last
        // non-active row evicted to make room.
        const REVIEW_COUNT_WITH_OPEN = 7;
        const full = render(
            `/tasks/${open.id}`,
            navigation([], [...reviewTasks, open], { running: 0, review: REVIEW_COUNT_WITH_OPEN, past: 0 })
        );
        expect(full).toContain('the open task');
        expect(full).not.toContain('review task 2');
        // An open task already in the preview changes nothing.
        const inside = render(`/tasks/${reviewTasks[2]!.id}`, navigation([], reviewTasks));
        expect(inside).toContain('review task 4');
        expect(full).toContain('+2 more need review');
    });

    it('marks the current task alongside the Tasks item, and nothing else', () => {
        const one = summary();
        const html = render(`/tasks/${one.id}`, navigation([], [one]));
        const active = html.match(/is-active/g) ?? [];
        expect(active).toHaveLength(2);
        expect(html.indexOf('sidenav-link is-active')).toBeLessThan(html.indexOf('sidenav-task is-active'));
    });

    it('shows no preview until there is one to show', () => {
        // Null is what the shell hands over off /tasks*, where the poll is not running: neither an
        // empty sentence nor dead links, just no list.
        const html = render('/', null);
        expect(html).not.toContain('sidenav-subitems');
        expect(html).not.toContain('sidenav-section');
        expect(html).not.toContain('No tasks yet');
    });
});

describe('SideNav status dots and live lines', () => {
    it('breathes a green dot beside a run that is going, with its activity line beneath', () => {
        const html = render('/tasks', navigation([summary(running({ activity: '→ Read src/x.ts' }))], []));
        expect(html).toContain('sidenav-dot sidenav-dot-running');
        expect(html).toContain('sidenav-task-summary');
        expect(html).toContain('→ Read src/x.ts');
    });

    it('keeps the live line out of parked and finished tasks', () => {
        const html = render(
            '/tasks',
            navigation([], [summary(), summary({ ...running(), status: 'standby' } as Partial<TaskSummary>)])
        );
        expect(html).not.toContain('sidenav-task-summary');
    });

    it('paints the states text-first: grey parked, red failed, green done, plain stopped', () => {
        const parked = render('/tasks', navigation([summary({ status: 'standby' })], []));
        expect(parked).toContain('sidenav-dot sidenav-dot-paused');
        const failed = render('/tasks', navigation([], [summary({ status: 'failed' })]));
        expect(failed).toContain('sidenav-dot sidenav-dot-failed');
        const done = render('/tasks', navigation([], [summary({ doneAt: '2026-09-02T13:00:00.000Z' })]));
        expect(done).toContain('sidenav-dot sidenav-dot-done');
        const stopped = render('/tasks', navigation([], [summary({ status: 'stopped' })]));
        expect(stopped).not.toContain('sidenav-dot ');
    });
});

describe('SideNav task authorship', () => {
    // The author line is WHO queued the task, resolved server-side. 'unknown' is the honest
    // rendering of a pre-accounts row — a fact, not a name invented for display.
    it('renders the author after the title, and unknown when there is none', () => {
        const author = { id: 'a', login: 'octocat', name: 'The Octocat', avatarUrl: null };
        const html = render('/tasks', navigation([], [summary({ author })]));
        expect(html).toContain('sidenav-task-author');
        expect(html).toContain('octocat');
        expect(html).not.toContain('The Octocat');

        const anonymous = render('/tasks', navigation([], [summary()]));
        expect(anonymous).toContain('unknown');
    });
});
