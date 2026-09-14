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
        exitCode: 0,
        output: null,
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
        expect(html).toContain('href="/workspace"');
        expect(html).toContain('href="/tasks"');
        expect(html).toContain('Dashboard');
        expect(html).toContain('Workspace');
        expect(html).toContain('Tasks');
    });

    it('marks the current section for assistive technology, not only visually', () => {
        expect(render('/workspace')).toContain('aria-current="page"');
    });

    it('does not treat "/" as the parent of every other route', () => {
        // Without `end`, the index link matches every path below it and both entries look active.
        const html = render('/workspace');
        const active = html.match(/is-active/g) ?? [];
        expect(active).toHaveLength(1);
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
        expect(html).toContain('href="/workspace"'); // sanity: the other sections are present
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
    it('blinks a green dot beside a run that is going', () => {
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
     * `useEffect` does not run under renderToStaticMarkup, so `showModal()` is never called here.
     * That means modality, the focus trap, focus restoration and Escape are NOT covered by this
     * suite — they are the browser's behaviour, and they belong in e2e/workspace.spec.ts. What is
     * covered is the markup, including the two things that fail silently if they regress.
     */
    const render = (open: boolean) =>
        renderToStaticMarkup(
            <RepoPickerDialog open={open} selected={[]} onClose={() => {}} onSave={async () => null} saving={false} />
        );

    it('disables Save until the installation list has actually loaded', () => {
        /*
         * The body of the PUT is the WHOLE selection, so saving against a list that has not
         * arrived is how somebody loses every checkout they had. This used to be worse than a
         * missing guard: `save()` built its payload by FILTERING the installation list, so an
         * empty list produced an empty payload — one click deselected everything.
         *
         * `useRepos` does not fetch under renderToStaticMarkup (no effects), so this render is
         * exactly the not-yet-loaded state.
         */
        const html = render(true);
        const save = html.slice(html.indexOf('Save') - 200, html.indexOf('Save'));
        expect(save).toContain('disabled');
    });

    it('renders a dialog element without the `open` attribute', () => {
        // `<dialog open>` is the NON-modal mode: no top layer, no backdrop, no focus trap. Modality
        // has to come from showModal(), which is why the attribute must never be set here.
        const html = render(true);
        expect(html).toContain('<dialog');
        expect(html).not.toMatch(/<dialog[^>]*\sopen/);
    });

    it("uses no form, because the CSP sends form-action 'none'", () => {
        // The same trap that makes LoginGate an anchor rather than a form. A `method="dialog"` form
        // would look correct and be blocked by the header set in server/src/app.ts.
        const html = render(true);
        expect(html).not.toContain('method="dialog"');
        expect(html).not.toContain('<form');
    });

    it('says the App is installed nowhere rather than showing an empty list', () => {
        // An empty picker and an unreachable GitHub look identical otherwise, and only one of them
        // is something the reader can act on.
        expect(render(true)).toContain('not installed on any repositories');
    });

    it('offers a way out, because this is not a hard gate', () => {
        // If the App is installed nowhere, a non-dismissible dialog is a bricked application with
        // no route to the docs — and the dashboard's figures are readable without a selection.
        expect(render(true)).toContain('Not now');
    });
});
