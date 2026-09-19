import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { RepoPickerDialog } from '../src/components/RepoPickerDialog.js';
import { SideNav } from '../src/components/SideNav.js';
import type { Job } from '../src/api/useJobs.js';

/**
 * `MemoryRouter` rather than a browser router: this suite has no DOM, and a router that reads
 * `window.location` cannot run here. It is also the one router that exists under the same name in
 * both v6 and v7.
 */

const render = (path: string, tasks: readonly Job[] | null = null) =>
    renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
            <SideNav tasks={tasks} />
        </MemoryRouter>
    );

function job(overrides: Partial<Job> = {}): Job {
    // A root by default; overriding the id keeps it one — a follow-up overrides both spine fields
    // together, as the chain tests below do.
    const id = overrides.id ?? '22222222-2222-4222-8222-222222222222';
    return {
        id,
        command: 'newer task',
        status: 'succeeded',
        attempts: 1,
        author: null,
        stoppedBy: null,
        doneBy: null,
        exitCode: 0,
        output: null,
        summary: null,
        repo: null,
        executor: null,
        followUpTo: null,
        rootJobId: id,
        doneAt: null,
        cancelRequestedAt: null,
        workspacePath: null,
        createdAt: '2026-09-02T12:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        wallClockMs: null,
        taskWallClockMs: null,
        sessionId: null,
        remoteSessionId: null,
        ...overrides,
    };
}

/** A running job overrides the finished default wholesale, so a bare `{ status: 'running' }` stays coherent. */
const running = (overrides: Partial<Job> = {}): Partial<Job> => ({
    status: 'running',
    exitCode: null,
    finishedAt: null,
    startedAt: null,
    output: null,
    ...overrides,
});

/** The markup of one section: from its header to the next section's header (or the end). */
const section = (html: string, header: string, next?: string): string =>
    html.slice(html.indexOf(header), next === undefined ? undefined : html.indexOf(next));

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
        // anything in view — it renders nothing, the same reading that gates the task tree.
        const outside = render('/');
        expect(outside).not.toContain('href="/settings/organization"');
        expect(outside).not.toContain('href="/settings/repos"');
    });

    it('marks the current section for assistive technology, not only visually', () => {
        expect(render('/settings/workspace')).toContain('aria-current="page"');
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

describe('SideNav task tree', () => {
    it('renders the three status sections in order, each header carrying its count', () => {
        const html = render('/tasks', [
            job(running()),
            job({ id: '33333333-3333-4333-8333-333333333333', command: 'first done', status: 'failed', exitCode: 1 }),
            job({ id: '44444444-4444-4444-8444-444444444444', command: 'second done' }),
            job({
                id: '55555555-5555-4555-8555-555555555555',
                command: 'old task',
                doneAt: '2026-09-02T13:00:00.000Z',
            }),
        ]);
        expect(html).toContain('Running (1)');
        expect(html).toContain('Need review (2)');
        expect(html).toContain('Past tasks (1)');
        expect(html.indexOf('Running (')).toBeLessThan(html.indexOf('Need review ('));
        expect(html.indexOf('Need review (')).toBeLessThan(html.indexOf('Past tasks ('));
    });

    it('puts each task under its own section and nowhere else', () => {
        const html = render('/tasks', [
            job(running()),
            job({ id: '33333333-3333-4333-8333-333333333333', command: 'finished task' }),
        ]);
        const runningSection = section(html, 'Running (', 'Need review (');
        expect(runningSection).toContain('newer task');
        expect(runningSection).not.toContain('finished task');
        const reviewSection = section(html, 'Need review (', 'Past tasks (');
        expect(reviewSection).toContain('finished task');
        expect(reviewSection).not.toContain('newer task');
    });

    it('orders each section newest activity first, every row linking to its detail view', () => {
        // The API serves newest first and the sections re-sort on the same key, so a task that
        // just finished moves to the TOP of Need review — the inverse of the chat's reading order.
        const newer = job(running({ startedAt: '2026-09-02T12:30:00.000Z' }));
        const older = job({
            id: '33333333-3333-4333-8333-333333333333',
            command: 'older task',
            status: 'running',
            startedAt: '2026-09-02T12:10:00.000Z',
        });
        const html = render('/tasks', [older, newer]);
        expect(html).toContain('href="/tasks/22222222-2222-4222-8222-222222222222"');
        expect(html).toContain('href="/tasks/33333333-3333-4333-8333-333333333333"');
        expect(html.indexOf('newer task')).toBeLessThan(html.indexOf('older task'));
    });

    it('pins New task above the running rows, itself no task row', () => {
        // The affordance is rendered outside the sorted rows, so the activity ordering can never
        // slide a task above it — and it carries no dot, because it is not a task.
        const html = render('/tasks', [
            job(running()),
            job({
                id: '33333333-3333-4333-8333-333333333333',
                command: 'older task',
                status: 'running',
                createdAt: '2026-09-02T11:00:00.000Z',
                startedAt: '2026-09-02T11:00:00.000Z',
            }),
        ]);
        const runningSection = section(html, 'Running (', 'Need review (');
        expect(runningSection).toContain('href="/tasks"');
        expect(runningSection.indexOf('New task')).toBeLessThan(runningSection.indexOf('newer task'));
        expect(runningSection.indexOf('newer task')).toBeLessThan(runningSection.indexOf('older task'));
        const button = runningSection.slice(runningSection.indexOf('sidenav-newtask'), runningSection.indexOf('</a>'));
        expect(button).not.toContain('sidenav-dot');
    });

    it('marks New task active only on the composer page itself', () => {
        // `end`: on a task's detail page the link stays quiet — the tree's own markers speak there.
        const composer = render('/tasks', [job()]);
        expect(composer).toContain('sidenav-newtask is-active');
        const detail = render('/tasks/22222222-2222-4222-8222-222222222222', [job()]);
        expect(detail).toContain('sidenav-newtask');
        expect(detail).not.toContain('sidenav-newtask is-active');
    });

    it('collapses Past tasks by default behind a labelled toggle', () => {
        // `renderToStaticMarkup` pins only the initial render, so the collapsed state is what this
        // suite can assert — the toggle's click behaviour is the browser's, like the dialog's.
        const html = render('/tasks', [job({ doneAt: '2026-09-02T13:00:00.000Z' })]);
        expect(html).toContain('Past tasks (1)');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('hidden=""');
    });

    it('marks the current task alongside its section, and nothing else', () => {
        // Tree semantics: the Tasks link and the current task row carry the marker, in that order.
        const html = render('/tasks/22222222-2222-4222-8222-222222222222', [job()]);
        const active = html.match(/is-active/g) ?? [];
        expect(active).toHaveLength(2);
        expect(html.indexOf('sidenav-link is-active')).toBeLessThan(html.indexOf('sidenav-task is-active'));
        const current = html.match(/aria-current="page"/g) ?? [];
        expect(current).toHaveLength(2);
        expect(html).toContain('href="/settings"'); // sanity: the other sections are present
    });

    it('says so when there are no tasks yet', () => {
        const html = render('/tasks', []);
        expect(html).toContain('No tasks yet');
        expect(html).not.toContain('sidenav-section');
    });

    it('answers per section when the board has tasks but a section is empty', () => {
        const html = render('/tasks', [job(running())]);
        expect(section(html, 'Need review (', 'Past tasks (')).toContain('Nothing to review');
        expect(section(html, 'Past tasks (')).toContain('No past tasks');
    });

    it('shows no task tree until there is one to show', () => {
        // Null is what the shell hands over off /tasks*, where the list is not polled: neither an
        // empty sentence nor dead links, just no list.
        const html = render('/', null);
        expect(html).not.toContain('sidenav-subitems');
        expect(html).not.toContain('sidenav-section');
        expect(html).not.toContain('No tasks yet');
        expect(html).not.toContain('href="/tasks/22222222-2222-4222-8222-222222222222"');
    });
});

describe('SideNav status dots', () => {
    it('breathes a green dot beside a run that is going', () => {
        const html = render('/tasks', [job(running())]);
        expect(section(html, 'Running (', 'Need review (')).toContain('sidenav-dot sidenav-dot-running');
    });

    it('holds grey for a parked run, and the same grey while a stop request is in flight', () => {
        const parked = render('/tasks', [job({ ...running(), status: 'standby' })]);
        expect(section(parked, 'Running (', 'Need review (')).toContain('sidenav-dot sidenav-dot-paused');
        const stopping = render('/tasks', [job(running({ cancelRequestedAt: '2026-09-02T12:01:00.000Z' }))]);
        expect(section(stopping, 'Running (', 'Need review (')).toContain('sidenav-dot sidenav-dot-stopping');
    });

    it('paints a failed or dead run red, still waiting for review', () => {
        for (const status of ['failed', 'dead'] as const) {
            const html = render('/tasks', [job({ status, exitCode: 1 })]);
            expect(section(html, 'Need review (', 'Past tasks ('), status).toContain('sidenav-dot sidenav-dot-failed');
        }
    });

    it('paints a finished or done task solid green', () => {
        // Finished but unreviewed sits in Need review; a done task sits in the collapsed Past
        // list — the row stays in the markup behind the toggle, so the dot is still assertable.
        const finished = render('/tasks', [job()]);
        expect(section(finished, 'Need review (', 'Past tasks (')).toContain('sidenav-dot sidenav-dot-done');
        const done = render('/tasks', [job({ doneAt: '2026-09-02T13:00:00.000Z', exitCode: 1, status: 'failed' })]);
        expect(section(done, 'Past tasks (')).toContain('sidenav-dot sidenav-dot-done');
    });

    it('leaves a stopped task on the plain dot', () => {
        // The user ended that turn themselves — neither a failure's red nor a done task's green says that.
        const html = render('/tasks', [job({ status: 'stopped', exitCode: 130 })]);
        const reviewSection = section(html, 'Need review (', 'Past tasks (');
        expect(reviewSection).toContain('newer task');
        expect(reviewSection).not.toContain('sidenav-dot ');
    });

    it("answers for the whole thread, not the row under the cursor: a follow-up's state is the task's", () => {
        const root = job();
        const child = {
            ...job(running()),
            id: '33333333-3333-4333-8333-333333333333',
            followUpTo: root.id,
            rootJobId: root.id,
        };
        const html = render('/tasks', [root, child]);
        // The root lands in Running (the head — the child — is going), wearing the child's live dot.
        const runningSection = section(html, 'Running (', 'Need review (');
        expect(runningSection).toContain('newer task');
        expect(runningSection).toContain('sidenav-dot sidenav-dot-running');
        expect(section(html, 'Need review (', 'Past tasks (')).not.toContain('newer task');
    });
});

describe('SideNav task summary', () => {
    const active = (activity: string): Partial<Job> => ({
        ...running(),
        runtime: { cpuPercent: 42, memUsedMb: 200, memPercent: null, activity, sampledAt: '2026-09-02T12:00:01.000Z' },
    });

    it("shows the running task's summary under its name in the tree", () => {
        const task = job(active('→ Read src/x.ts'));
        const html = render(`/tasks/${task.id}`, [task]);
        expect(section(html, 'Running (', 'Need review (')).toContain('sidenav-task-summary');
        expect(html).toContain('→ Read src/x.ts');
    });

    it('keeps it out of a parked or finished task', () => {
        const finished = render('/tasks', [job()]);
        expect(finished).not.toContain('sidenav-task-summary');
        const parked = render('/tasks', [job({ ...active('→ stale'), status: 'standby' })]);
        expect(parked).not.toContain('sidenav-task-summary');
    });

    it('answers for the whole thread, not the row under the cursor', () => {
        const root = job();
        const child = {
            ...job(active('→ Bash npm test')),
            id: '33333333-3333-4333-8333-333333333333',
            followUpTo: root.id,
            rootJobId: root.id,
        };
        const html = render('/tasks', [root, child]);
        const rootEntry = html.slice(html.indexOf('newer task'), html.indexOf('</a>', html.indexOf('newer task')));
        expect(rootEntry).toContain('sidenav-task-summary');
        expect(rootEntry).toContain('→ Bash npm test');
    });
});

describe('RepoPickerDialog', () => {
    /*
     * The Headless UI Dialog portals its content, and renderToStaticMarkup does not render
     * portals — an open dialog server-renders as Headless' placeholder span, nothing more.
     * The in-dialog contracts therefore moved rather than died: the selection logic is the pure
     * `nextChosen` and the disabled-until-loaded guard the pure `saveDisabled`, both in
     * repo-picker.test.ts, and the empty state, the way out and the form-action 'none' trap are
     * e2e/workspace.spec.ts's, where a real browser mounts the portal. What is left to assert
     * here is that boundary itself: the component still server-renders without crashing, whatever
     * it mounts to.
     */
    const render = (open: boolean) =>
        renderToStaticMarkup(
            <RepoPickerDialog open={open} selected={[]} onClose={() => {}} onSave={async () => null} saving={false} />
        );

    it('renders a placeholder until the client mounts, open or closed', () => {
        // Portal content is a client-only concern: SSR emits the presence span, and the browser
        // fills the rest in after mount.
        for (const open of [false, true]) {
            expect(render(open)).toContain('<span hidden');
        }
    });
});

describe('task authorship', () => {
    // The author line is WHO queued the task, resolved server-side. 'unknown' is the honest
    // rendering of a pre-accounts row — a fact, not a name invented for display.
    it('renders the author after the title, and unknown when there is none', () => {
        const author = { id: 'a', login: 'octocat', name: 'The Octocat', avatarUrl: null };
        const html = render('/tasks', [job({ author })]);
        expect(html).toContain('sidenav-task-author');
        expect(html).toContain('octocat');
        expect(html).not.toContain('The Octocat');

        const anonymous = render('/tasks', [job()]);
        expect(anonymous).toContain('unknown');
    });
});
