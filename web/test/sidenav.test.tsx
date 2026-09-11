import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { RepoPickerDialog } from '../src/components/RepoPickerDialog.js';
import { SideNav } from '../src/components/SideNav.js';
import type { Job } from '../src/api/useJobs.js';
import type { TaskGroup, TaskTabs } from '../src/tabs.js';

/**
 * `MemoryRouter` rather than a browser router: this suite has no DOM, and a router that reads
 * `window.location` cannot run here. It is also the one router that exists under the same name in
 * both v6 and v7.
 */

/** A fixed group arrangement — the sidenav is a pure function of what it is handed. */
function tabsFixture(groups: TaskGroup[], activeId = groups[0]!.id): TaskTabs {
    return {
        groups,
        active: groups.find((group) => group.id === activeId) ?? groups[0]!,
        activateGroup: () => {},
        createGroup: () => {},
        removeTab: () => {},
    };
}

const render = (path: string, tasks: readonly Job[] | null = null, tabs: TaskTabs = tabsFixture([{ id: '1', tabs: [] }])) =>
    renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
            <SideNav tasks={tasks} tabs={tabs} />
        </MemoryRouter>,
    );

function job(overrides: Partial<Job> = {}): Job {
    return {
        id: '22222222-2222-4222-8222-222222222222',
        command: 'newer task',
        status: 'succeeded',
        attempts: 1,
        exitCode: 0,
        output: null,
        repo: null,
        executor: null,
        followUpTo: null,
        doneAt: null,
        cancelRequestedAt: null,
        workspacePath: null,
        createdAt: '2026-09-02T12:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        sessionId: null,
        remoteSessionId: null,
        ...overrides,
    };
}

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
    it('lists the recent tasks under the Tasks item, newest first, each linking to its detail view', () => {
        // The API serves newest first and the nav reads top-down, so no reversal happens here —
        // the deliberate inverse of the chat's reading order.
        const newer = job();
        const older = job({
            id: '33333333-3333-4333-8333-333333333333',
            command: 'older task',
            createdAt: '2026-09-01T12:00:00.000Z',
        });
        const html = render('/tasks', [newer, older]);
        expect(html).toContain('sidenav-subitems');
        expect(html).toContain('href="/tasks/22222222-2222-4222-8222-222222222222"');
        expect(html).toContain('href="/tasks/33333333-3333-4333-8333-333333333333"');
        expect(html.indexOf('newer task')).toBeLessThan(html.indexOf('older task'));
    });

    it('renders the task groups as the tree\'s top level, labelled by number', () => {
        const html = render('/tasks', [job()], tabsFixture([{ id: '1', tabs: [] }, { id: '2', tabs: [] }]));
        expect(html).toContain('Group 1');
        expect(html).toContain('Group 2');
        // A group is a heading the member clicks to focus it, not a link the router follows, so
        // every group acts on the tab arrangement instead of navigating to the same URL.
        expect(html).toContain('sidenav-group');
        expect(html).not.toMatch(/<a[^>]*>Group 1<\/a>/);
    });

    it('opens a way to create the next group, numbered automatically', () => {
        const html = render('/tasks', [job()], tabsFixture([{ id: '1', tabs: [] }, { id: '2', tabs: [] }]));
        expect(html).toContain('+ Group');
        expect(html).toContain('sidenav-add-group');
    });

    it('nests a group\'s tabs under it and marks the selected group', () => {
        const task = job();
        const html = render(
            `/tasks/${task.id}`,
            [task],
            tabsFixture([{ id: '1', tabs: [task.id] }], '1'),
        );
        // The section, the group heading and the group's tab carry the current marker, in that
        // order — the group's class reads like the section's so the tree's selection is uniform.
        const active = html.match(/is-active/g) ?? [];
        expect(active).toHaveLength(3);
        expect(html.indexOf('sidenav-link is-active')).toBeLessThan(html.indexOf('sidenav-group is-active'));
        expect(html.indexOf('sidenav-group is-active')).toBeLessThan(html.indexOf('sidenav-task is-active'));
        const current = html.match(/aria-current="page"/g) ?? [];
        expect(current).toHaveLength(2);
        expect(html).toContain('sidenav-group is-active');
        expect(html).toContain('aria-pressed="true"');
    });

    it('keeps a tabbed task out of Recent, and leaves the work-in-progress ones in it', () => {
        const open = job({ id: '11111111-1111-4111-8111-111111111111', command: 'open task' });
        const loose = job({ id: '33333333-3333-4333-8333-333333333333', command: 'loose task' });
        const html = render('/tasks', [open, loose], tabsFixture([{ id: '1', tabs: [open.id] }]));
        const recent = html.slice(html.indexOf('Recent'));
        expect(recent).toContain('loose task');
        expect(recent).not.toContain('open task');
        expect(html).toContain('href="/tasks/11111111-1111-4111-8111-111111111111"');
    });

    it('marks the open task as current alongside its section and group', () => {
        // Tree semantics: the section, the selected group heading and the current task are all
        // marked, and nothing else is.
        const html = render('/tasks/22222222-2222-4222-8222-222222222222', [job()]);
        const active = html.match(/is-active/g) ?? [];
        expect(active).toHaveLength(3);
        const current = html.match(/aria-current="page"/g) ?? [];
        expect(current).toHaveLength(2);
        expect(html).toContain('href="/workspace"'); // sanity: the other sections are present
    });

    it('says so when there are no tasks yet', () => {
        expect(render('/tasks', [])).toContain('No tasks yet');
    });

    it('keeps the group tree and its controls when there are no tasks yet', () => {
        // Groups are tab state, not task state: a fresh board already has Group 1, so hiding it
        // for want of tasks would also hide the only way to create or focus a group.
        const html = render('/tasks', [], tabsFixture([{ id: '1', tabs: [] }]));
        expect(html).toContain('sidenav-group');
        expect(html).toContain('+ Group');
        expect(html).toContain('sidenav-add-group');
    });

    it('shows no task tree until there is one to show', () => {
        // Null is what the shell hands over off /tasks*, where the list is not polled: neither an
        // empty sentence nor dead links, just no list.
        const html = render('/', null);
        expect(html).not.toContain('sidenav-subitems');
        expect(html).not.toContain('sidenav-group');
        expect(html).not.toContain('No tasks yet');
        expect(html).not.toContain('href="/tasks/22222222-2222-4222-8222-222222222222"');
    });
});

describe('SideNav status dots', () => {
    it('blinks a green dot beside a run that is going', () => {
        const html = render('/tasks', [job({ status: 'running', exitCode: null, finishedAt: null, startedAt: null })], tabsFixture([{ id: '1', tabs: [job().id] }]));
        expect(html).toContain('sidenav-dot sidenav-dot-running');
    });

    it('holds grey for a parked run, and the same grey while a stop request is in flight', () => {
        const parked = render('/tasks', [job({ status: 'standby', exitCode: null, finishedAt: null, startedAt: null, output: null })], tabsFixture([{ id: '1', tabs: [job().id] }]));
        expect(parked).toContain('sidenav-dot sidenav-dot-paused');
        const stopping = render(
            '/tasks',
            [job({ status: 'running', cancelRequestedAt: '2026-09-02T12:01:00.000Z', exitCode: null, finishedAt: null, startedAt: null, output: null })],
            tabsFixture([{ id: '1', tabs: [job().id] }]),
        );
        expect(stopping).toContain('sidenav-dot sidenav-dot-stopping');
    });

    it('paints a failed or dead run red', () => {
        for (const status of ['failed', 'dead'] as const) {
            const html = render('/tasks', [job({ status, exitCode: 1 })], tabsFixture([{ id: '1', tabs: [job().id] }]));
            expect(html, status).toContain('sidenav-dot sidenav-dot-failed');
        }
    });

    it('paints a finished or done task solid green', () => {
        const finished = render('/tasks', [job()], tabsFixture([{ id: '1', tabs: [job().id] }]));
        expect(finished).toContain('sidenav-dot sidenav-dot-done');
        const done = render(
            '/tasks',
            [job({ doneAt: '2026-09-02T13:00:00.000Z', exitCode: 1, status: 'failed' })],
            tabsFixture([{ id: '1', tabs: [job().id] }]),
        );
        expect(done).toContain('sidenav-dot sidenav-dot-done');
    });

    it('answers for the whole thread, not the row under the cursor: a follow-up\'s state is the task\'s', () => {
        const root = job();
        const child = { ...job({ status: 'running', exitCode: null, finishedAt: null, startedAt: null, output: null }), id: '33333333-3333-4333-8333-333333333333', followUpTo: root.id };
        const html = render('/tasks', [root, child]);
        // The root stays in Recent (its tab is not open), and its dot wears the child's live state.
        const rootEntry = html.slice(html.indexOf('newer task'), html.indexOf('</a>', html.indexOf('newer task')));
        expect(rootEntry).toContain('sidenav-dot sidenav-dot-running');
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
            <RepoPickerDialog
                open={open}
                selected={[]}
                onClose={() => {}}
                onSave={async () => null}
                saving={false}
            />,
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

    it('uses no form, because the CSP sends form-action \'none\'', () => {
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
