import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { UseJobs } from '../src/api/useJobs.js';
import type { UseWorkspace } from '../src/api/useWorkspace.js';
import { WorkflowParameterFields } from '../src/components/WorkflowParameterFields.js';
import { TaskComposerPage } from '../src/pages/TaskComposerPage.js';
import { TaskDetailPage } from '../src/pages/TaskDetailPage.js';
import { type WorkflowParamChoice, clampedWorkflow, paramsComplete, paramValueMatches } from '../src/task-composer.js';
import { FORBIDDEN, renderComposer } from './tasks-fixtures.js';

describe('the tasks pages', () => {
    /**
     * Page-level renders through a real route tree: the pages read the tasks poll and the
     * workspace poll from the area's outlet context, both stubbed idle — effects never fire
     * under renderToStaticMarkup, so the loading posture is what a static render can see. The
     * point here is the page headings: one h1 per page, no competing inner title.
     */
    const fakeTasks = {
        jobs: null,
        error: null,
        queue: async () => ({ id: null, error: null }),
        followUp: async () => ({ error: null }),
        stop: async () => null,
        remove: async () => null,
        markDone: async () => null,
    } as unknown as UseJobs;
    const idleWorkspace = {
        data: null,
        loading: true,
        error: null,
        saving: false,
        save: async () => null,
        saveExecutors: async () => null,
        listExecutorConfigs: async () => null,
    } as unknown as UseWorkspace;

    function TasksArea() {
        return <Outlet context={{ tasks: fakeTasks, workspace: idleWorkspace }} />;
    }

    const renderPage = (path: string) =>
        renderToStaticMarkup(
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route element={<TasksArea />}>
                        <Route path="tasks">
                            <Route index element={<TaskComposerPage />} />
                            <Route path=":id" element={<TaskDetailPage />} />
                        </Route>
                    </Route>
                </Routes>
            </MemoryRouter>
        );

    it('the composer page names itself "New task" under the Tasks eyebrow, once', () => {
        const html = renderPage('/tasks');
        expect(html.match(/<h1/g)?.length).toBe(1);
        expect(html).toContain('<h1>New task</h1>');
        expect(html).toContain('page-header-eyebrow');
        expect(html).not.toContain('<h2>Tasks</h2>');
    });

    it('the detail page keeps the plain Tasks heading until the thread lands', () => {
        const html = renderPage('/tasks/22222222-2222-4222-8222-222222222222');
        expect(html.match(/<h1/g)?.length).toBe(1);
        expect(html).toContain('<h1>Tasks</h1>');
    });
});

describe('TaskComposer', () => {
    it('waits for the workspace before offering a repository choice', () => {
        // "Not known yet" and "known empty" are different sentences: an unreachable workspace must
        // not read as a member who never picked anything, and there is nothing to type into yet.
        const html = renderComposer({ repos: null });
        expect(html).toMatch(/Loading your workspace/);
        expect(html).not.toContain('<textarea');
    });

    it('says so, with a way back in, when the workspace could not be loaded', () => {
        const html = renderComposer({ repos: null, workspaceError: 'Request failed (503)' });
        expect(html).toContain('Request failed (503)');
        expect(html).toContain('Retry');
    });

    it('offers one repository option per selection plus none, first repository selected by default', () => {
        // The tabs are gone; the composer stamps the task with a repo instead. The default is the
        // FIRST selected repository — a member who picked repositories means their tasks to be
        // stamped with one, not with nothing — and `none` stays available for a deliberate
        // unlabelled run, in product words. Same rule, and same default, as the executor select.
        const html = renderComposer({
            repos: [
                { owner: 'acme', name: 'web' },
                { owner: 'acme', name: 'api' },
            ],
        });
        // The Listbox server-renders the trigger only — the options are client-side — so the
        // trigger's text is the selected repository, and the visible label names the control.
        const repoTrigger = html.slice(html.indexOf('Repository'), html.indexOf('Executor'));
        expect(repoTrigger).toContain('>acme/web</button>');
        expect(repoTrigger).not.toContain('acme/api');
        const none = renderComposer({ repos: [] });
        const noneTrigger = none.slice(none.indexOf('Repository'), none.indexOf('Executor'));
        expect(noneTrigger).toContain('>No repository</button>');
    });

    // A task always runs through a configured profile. The first is selected initially; with no
    // profiles the composer names the missing requirement and cannot start.
    it('preselects the first configured executor and blocks when there is none', () => {
        const trigger = (html: string) => html.slice(html.indexOf('Executor'), html.indexOf('>Start task<'));

        const one = renderComposer({ repos: [], executors: [{ name: 'main', type: 'claude' }] });
        expect(trigger(one)).toContain('>main</button>');

        const two = renderComposer({
            repos: [],
            executors: [
                { name: 'main', type: 'claude' },
                { name: 'heavy', type: 'claude' },
            ],
        });
        expect(trigger(two)).toContain('>main</button>');

        const empty = renderComposer({ repos: [], executors: [] });
        expect(trigger(empty)).toContain('>No executor configured</button>');
        expect(empty).toContain('Add an executor in');
        expect(empty).toContain('href="/settings/executors"');
        expect(empty).toContain('Configure an executor in Settings to continue.');
        expect(empty).toContain('disabled');
    });

    it('keeps the composer reachable when no repository is selected, and says where to fix that', () => {
        // A member with nothing picked can still queue: the task simply carries no repo. The
        // remediation is a pointer at Settings, never a blocker — an absent repository is a
        // valid way to run.
        const html = renderComposer({ repos: [] });
        expect(html).toContain('<textarea');
        expect(html).toContain('>Start task<');
        expect(html).toContain('Select repositories in');
        expect(html).toContain('href="/settings/repositories"');
        expect(html).toContain('to run against a codebase');
        // aria-label, not aria-labelledby: the ListboxButton's label context overrides a
        // labelledby that points outside it, so each select carries its name directly (issue 190).
        // The workflow select renders only once a workflows list exists, so this render carries one.
        const withWorkflows = renderComposer({
            repos: [],
            workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org' }],
        });
        expect(withWorkflows).toContain('aria-label="Repository"');
        expect(withWorkflows).toContain('aria-label="Executor"');
        expect(withWorkflows).toContain('aria-label="Reusable workflow"');
    });
});

describe('TaskComposer — the prompt and the launch', () => {
    it('asks what the agent should do, and shows the example without prefilling it', () => {
        const html = renderComposer({});
        expect(html).toContain('What should the agent do?');
        expect(html).toContain(
            'Include the outcome you want, relevant files or issue, and checks the agent should run.'
        );
        expect(html).toContain(
            'placeholder="Example: Fix issue #123, update the affected tests, and run the relevant checks."'
        );
        // The example is the placeholder, never the value: an empty textarea carries no text.
        expect(html).not.toContain('>Example: Fix issue #123');
    });

    it('says what will run before anything runs', () => {
        // The preflight sentence, from the ACTUAL choices — this render knows no repository, one
        // executor, no workflow, and it says exactly that much and no more.
        const html = renderComposer({ repos: [], executors: [{ name: 'main', type: 'claude' }] });
        expect(html).toContain('Will run without a repository using main executor. Your prompt will run as written.');

        const chosen = renderComposer({
            repos: [{ owner: 'acme', name: 'web' }],
            executors: [{ name: 'main', type: 'claude' }],
            workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org' }],
        });
        expect(chosen).toContain('Will run in acme/web using main executor');
    });

    it('disables Start until a command is typed, and says what is missing', () => {
        // The composer starts empty, which is exactly the state a fresh render has — and a dark
        // button with no reason on screen is a task that cannot start.
        const html = renderComposer({});
        const LOOKBEHIND_CHARS = 200;
        const start = html.slice(html.indexOf('>Start task<') - LOOKBEHIND_CHARS, html.indexOf('>Start task<'));
        expect(start).toContain('disabled');
        expect(html).toContain('Describe the task to continue.');
    });

    it('labels the launch and its shortcut, and the in-flight state too', () => {
        const idle = renderComposer({});
        expect(idle).toContain('>Start task</button>');
        expect(idle).toContain('<kbd');
        const busy = renderComposer({ sending: true });
        expect(busy).toContain('>Starting…</button>');
        expect(busy).toContain('Starting the task…');
    });

    it("shows the board's refusal in place, as an alert, with the draft intact", () => {
        const html = renderComposer({ actionError: 'Could not queue the task (503)' });
        expect(html).toContain('Could not queue the task (503)');
        expect(html).toContain('role="alert"');
        expect(html).toContain('<textarea');
    });

    it('never emits a placeholder value', () => {
        const html = renderComposer({
            repos: [{ owner: 'acme', name: 'web' }],
            executors: [{ name: 'main', type: 'claude' }],
            actionError: null,
        });
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('hides the workflow select on a board that serves no workflows', () => {
        // The no-workflow byte-identity, rendered: the composer is exactly what it was.
        const html = renderComposer({ workflows: null });
        expect(html).not.toContain('Workflow');
    });

    it('runs the raw prompt when no workflow is chosen: no params, no gate', () => {
        // An unnamed task resolves NO workflow — the member's words are the whole command. A
        // parametrized workflow sitting in the list must not reach into an unchosen composer.
        const html = renderComposer({
            repos: [],
            workflows: [
                {
                    id: 'w1',
                    name: 'fix-issue',
                    scope: 'org',
                    params: [{ name: 'issue', pattern: '#\\d+' }],
                },
            ],
        });
        expect(html).toContain('<textarea');
        expect(html).not.toContain('needs:');
        expect(html).not.toContain('composer-param');
    });

    it('offers the workflow dropdown beside repo and executor, unchosen by default', () => {
        const html = renderComposer({
            workflows: [
                { id: 'w1', name: 'fix-issue', scope: 'org' },
                { id: 'w2', name: 'mine', scope: 'user' },
            ],
        });
        expect(html).toContain('Reusable workflow');
        expect(html).toContain('A workflow can turn this request into a repeatable multi-step process.');
        // Unchosen means NO process: the trigger reads the empty option's label. The offered
        // names are client-side; e2e/composer.spec.ts drives the real dropdown.
        expect(html).toContain('>No workflow — run prompt as written</button>');
    });
});

describe('composer parameters', () => {
    /** The fixture mirrors the seeded fix-issue declaration the API now serves. */
    const parammed = [
        {
            id: 'wf-1',
            name: 'fix-issue',
            scope: 'org' as const,
            params: [{ name: 'issue', pattern: '#\\d+' }],
        },
    ];

    it('renders no parameter inputs while no workflow is chosen', () => {
        // An unchosen workflow means NO process: the member's words run verbatim, so nothing
        // param-shaped may sit in the markup before the member picks a process by name.
        const html = renderComposer({ workflows: parammed });
        expect(html).not.toContain('composer-param');
        // The dropdown renders unchosen; the offered names are client-side, and e2e covers the
        // real dropdown.
        expect(html).toContain('>No workflow — run prompt as written</button>');
    });
});

describe('composer param validation — the client mirror of the board check', () => {
    const issue: WorkflowParamChoice = { name: 'issue', pattern: '#\\d+' };
    const free: WorkflowParamChoice = { name: 'notes' };

    it('accepts when every declared param is present and full-matches its pattern', () => {
        expect(paramsComplete([issue, free], { issue: '#42', notes: 'login page' })).toBe(true);
        expect(paramsComplete([], {})).toBe(true);
    });

    it('refuses a missing, empty or whitespace value', () => {
        expect(paramsComplete([issue], {})).toBe(false);
        expect(paramsComplete([issue], { issue: '' })).toBe(false);
        expect(paramsComplete([issue], { issue: '   ' })).toBe(false);
    });

    it('refuses a value that does not fully match the declared pattern', () => {
        // Same refusals the server makes: a bare number without the '#', a prefixed one, a
        // trailing word — a partial match is a guess, and a guess is what this feature removes.
        expect(paramsComplete([issue], { issue: '42' })).toBe(false);
        expect(paramsComplete([issue], { issue: 'x#42' })).toBe(false);
        expect(paramsComplete([issue], { issue: '#42 trailing' })).toBe(false);
    });

    it('accepts any non-empty value when the param declares no pattern', () => {
        expect(paramsComplete([free], { notes: 'anything at all' })).toBe(true);
    });

    it('answers false for a pattern the client cannot compile — the board decides', () => {
        expect(paramValueMatches({ name: 'x', pattern: '[' }, 'y')).toBe(false);
    });
});

describe('the workflow choice is clamped to the choices the list offers', () => {
    // A repository switch refetches the list for the new context, and a chosen name the answered
    // list no longer offers must not survive in state: its parameter inputs vanish, the vacuous
    // param gate lights Send, and the launch carries a name the board refuses with
    // UNKNOWN_WORKFLOW. The same clamp rule the executor and repository selects already live by.
    const list = [
        { id: 'w1', name: 'fix-issue', scope: 'org' as const },
        { id: 'w2', name: 'triage', scope: 'repo' as const },
    ];

    it('resets a chosen name the answered list does not offer back to unchosen', () => {
        expect(clampedWorkflow('fix-issue', [])).toBe('');
        expect(clampedWorkflow('triage', [list[0]!])).toBe('');
    });

    it('keeps a name the list still offers, and holds off while the fetch is in flight', () => {
        expect(clampedWorkflow('fix-issue', list)).toBe('fix-issue');
        // `null` is "not answered yet" — it says nothing about the new context, so a choice
        // survives the wait and is judged the moment the list lands.
        expect(clampedWorkflow('fix-issue', null)).toBe('fix-issue');
        expect(clampedWorkflow('', list)).toBe('');
    });
});

describe('the workflow parameter fields', () => {
    // The chosen workflow's declared parameters: one labelled input each, plain-language states,
    // and the raw rule locked inside Format details. Touched state is a prop — the composer owns
    // it, the fields render it — so every state a keystroke or a blur can produce is renderable
    // here without a DOM.
    const issue: WorkflowParamChoice = {
        name: 'issue',
        pattern: '#\\d+',
        description: 'The issue to fix, as #123 or a full issues URL.',
        example: '#123',
    };
    const plain: WorkflowParamChoice = { name: 'notes' };
    const renderFields = (
        params: WorkflowParamChoice[],
        values: Record<string, string> = {},
        touched: Record<string, boolean> = {}
    ) =>
        renderToStaticMarkup(
            <WorkflowParameterFields
                params={params}
                values={values}
                touched={touched}
                onInput={() => {}}
                onBlur={() => {}}
            />
        );

    it('labels each field with the humanized name and pairs it by id', () => {
        const html = renderFields([plain]);
        expect(html).toContain('>Notes</label>');
        expect(html).toContain('for="composer-param-notes"');
        expect(html).toContain('id="composer-param-notes"');
    });

    it('renders the author description and example where a member meets them', () => {
        // The guidance Slice C 1/4 serves: the description beside the field, the example as the
        // placeholder the empty input shows — never a prefill.
        const html = renderFields([issue]);
        expect(html).toContain('id="composer-param-issue-helper"');
        expect(html).toContain('The issue to fix, as #123 or a full issues URL.');
        expect(html).toContain('placeholder="Example: #123"');
        expect(html).not.toContain('>Example: #123<');
    });

    it('says Required on an untouched empty field without painting it failed', () => {
        const html = renderFields([plain]);
        expect(html).toContain('placeholder="Required"');
        expect(html).not.toContain('aria-invalid');
        expect(html).not.toContain('-error');
    });

    it('tells a touched empty field it is required, by name, as an error', () => {
        const html = renderFields([plain], {}, { notes: true });
        expect(html).toContain('aria-invalid="true"');
        expect(html).toContain('aria-describedby="composer-param-notes-error"');
        expect(html).toContain('id="composer-param-notes-error"');
        expect(html).toContain('Notes is required.');
    });

    it('rejects an over-length value in words, not in bytes', () => {
        const OVER_LIMIT_LENGTH = 513;
        const html = renderFields([plain], { notes: 'x'.repeat(OVER_LIMIT_LENGTH) }, { notes: true });
        expect(html).toContain('Notes must be 512 characters or fewer.');
    });

    it('reuses the author guidance as the mismatch error when it exists', () => {
        const html = renderFields([issue], { issue: 'not an issue' }, { issue: true });
        expect(html).toContain('The issue to fix, as #123 or a full issues URL.');
        expect(html).not.toContain('does not match the required format');
    });

    it('falls back to plain-language mismatch copy with no guidance to reuse', () => {
        const bare: WorkflowParamChoice = { name: 'issue', pattern: '#\\d+' };
        const html = renderFields([bare], { issue: 'not an issue' }, { issue: true });
        expect(html).toContain('Issue does not match the required format. Open Format details for the technical rule.');
    });

    it('blames the stored rule, not the member, when the pattern cannot compile', () => {
        const broken: WorkflowParamChoice = { name: 'issue', pattern: '[' };
        const html = renderFields([broken], { issue: 'whatever' }, { issue: true });
        // Apostrophe-free fragment: React escapes the quote, and the sentence is the pin, not its encoding.
        expect(html).toContain('could not be checked. Ask an administrator to fix the workflow.');
    });

    it('shows the raw pattern only inside Format details, never in a title or an error', () => {
        const html = renderFields([issue], { issue: 'not an issue' }, { issue: true });
        expect(html).toContain('<summary>Format details</summary>');
        expect(html).toContain('<code>#\\d+</code>');
        expect(html).not.toContain('title=');
        // Once per render, and only inside the disclosure: the count is the pin.
        expect(html.split('#\\d+').length - 1).toBe(1);
    });

    it('gives two invalid fields two distinct error descriptions', () => {
        const html = renderFields([plain, issue], {}, { notes: true, issue: true });
        // The plain field has no helper, so its description is the error alone; the guided one
        // lists its helper first and its error second — both unique per field.
        expect(html).toContain('aria-describedby="composer-param-notes-error"');
        expect(html).toContain('composer-param-issue-helper composer-param-issue-error');
        expect(html).toContain('Notes is required.');
        expect(html).toContain('Issue is required.');
    });

    it('carries no error state once every value validates', () => {
        const html = renderFields([issue], { issue: '#12' }, { issue: true });
        expect(html).not.toContain('aria-invalid');
        expect(html).not.toContain('-error"');
    });

    it('never emits a placeholder value', () => {
        const html = renderFields([issue], { issue: '#12' }, { issue: true });
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});
