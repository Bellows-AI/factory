import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { UseJobs } from '../src/api/useJobs.js';
import type { UseWorkspace } from '../src/api/useWorkspace.js';
import { type ComposerDraftInput, ComposerDraftProvider } from '../src/composer-draft.js';
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

    const renderPage = (path: string, sessionLoading = false) =>
        renderToStaticMarkup(
            <MemoryRouter initialEntries={[path]}>
                {/* The shell's draft store, as AppShell mounts it around the routed page. */}
                <ComposerDraftProvider session={null}>
                    <Routes>
                        <Route
                            element={
                                <Outlet context={{ tasks: fakeTasks, workspace: idleWorkspace, sessionLoading }} />
                            }
                        >
                            <Route path="tasks">
                                <Route index element={<TaskComposerPage />} />
                                <Route path=":id" element={<TaskDetailPage />} />
                            </Route>
                        </Route>
                    </Routes>
                </ComposerDraftProvider>
            </MemoryRouter>
        );

    it('holds the composer behind a skeleton until the session is known, so nothing restores early', () => {
        const html = renderPage('/tasks', true);
        expect(html).toContain('<h1>New task</h1>');
        expect(html).toContain('composer-skeleton');
        expect(html).toContain('aria-busy="true"');
        expect(html).not.toContain('<textarea');
        expect(html).not.toContain('Loading your workspace');
    });

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

    it('offers one repository option per selection, first repository selected by default', () => {
        // The composer stamps the task with a repo. The default is the FIRST selected repository —
        // a member who picked repositories means their tasks to be stamped with one, not with
        // nothing; with none selected the trigger asks for a selection (issue 263), as the
        // executor select does for its own empty list.
        const html = renderComposer({
            repos: [
                { owner: 'acme', name: 'web', status: 'ready' },
                { owner: 'acme', name: 'api', status: 'ready' },
            ],
        });
        // The Listbox server-renders the trigger only — the options are client-side — so the
        // trigger's text is the selected repository, and the visible label names the control.
        const repoTrigger = html.slice(html.indexOf('Repository'), html.indexOf('Executor'));
        expect(repoTrigger).toContain('>acme/web</span></button>');
        expect(repoTrigger).not.toContain('acme/api');
        const none = renderComposer({ repos: [] });
        const noneTrigger = none.slice(none.indexOf('Repository'), none.indexOf('Executor'));
        expect(noneTrigger).toContain('>Select a repository</span></button>');
    });

    // A task always runs through a configured profile. The first is selected initially; with no
    // profiles the composer names the missing requirement and cannot start.
    it('preselects the first configured executor and blocks when there is none', () => {
        const trigger = (html: string) => html.slice(html.indexOf('Executor'), html.indexOf('>Start task<'));

        const one = renderComposer({ repos: [], executors: [{ name: 'main', type: 'claude' }] });
        expect(trigger(one)).toContain('>main</span></button>');

        const two = renderComposer({
            repos: [],
            executors: [
                { name: 'main', type: 'claude' },
                { name: 'heavy', type: 'claude' },
            ],
        });
        expect(trigger(two)).toContain('>main</span></button>');

        const empty = renderComposer({ repos: [], executors: [] });
        expect(trigger(empty)).toContain('>No executor configured</span></button>');
        expect(empty).toContain('Add an executor in Settings');
        expect(empty).toContain('href="/settings/executors?return=/tasks/new"');
        expect(empty).toContain('No executor configured</p>');
        expect(empty).toContain('disabled');
    });

    it('preselects the poll-resolved default over the first row (issue 215, the preference by 391)', () => {
        const trigger = (html: string) => html.slice(html.indexOf('Executor'), html.indexOf('>Start task<'));

        const html = renderComposer({
            repos: [],
            executors: [
                { name: 'main', type: 'claude', scope: 'user' },
                { name: 'heavy', type: 'claude', scope: 'user' },
            ],
            defaultExecutor: { name: 'heavy', scope: 'user' },
        });
        expect(trigger(html)).toContain('>heavy</span></button>');
    });

    it('keeps the composer reachable when no repository is selected, and says where to fix that', () => {
        // A member with nothing picked still reaches the composer: the pointer at Settings sits
        // under the repository select, and the launch itself is blocked by the no-synced-repos
        // verdict (issue 263), tested below.
        const html = renderComposer({ repos: [] });
        expect(html).toContain('<textarea');
        expect(html).toContain('>Start task<');
        expect(html).toContain('Select repositories in');
        expect(html).toContain('href="/settings/repos?return=/tasks/new"');
        expect(html).not.toContain('/settings/repositories');
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
        expect(html).toContain('Include the outcome, relevant files or issue, and checks to run.');
        expect(html).toContain(
            'placeholder="Example: Fix issue #123, update the affected tests, and run the relevant checks."'
        );
        // The example is the placeholder, never the value: an empty textarea carries no text.
        expect(html).not.toContain('>Example: Fix issue #123');
    });

    it('says what will run before anything runs', () => {
        // The preflight sentence, from the ACTUAL choices — this render knows no repository, one
        // executor, no workflow, and it says exactly that much and no more (a launch needs a
        // repository, but the sentence only reports the choice).
        const html = renderComposer({ repos: [], executors: [{ name: 'main', type: 'claude' }] });
        expect(html).toContain('Will run without a repository using main executor. Your prompt will run as written.');

        const chosen = renderComposer({
            repos: [{ owner: 'acme', name: 'web', status: 'ready' }],
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
            repos: [{ owner: 'acme', name: 'web', status: 'ready' }],
            executors: [{ name: 'main', type: 'claude' }],
            actionError: null,
        });
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('hides the workflow select and its details step when no workflow list is given', () => {
        // No list, no process to pick: the selector and the workflow details section are absent,
        // and readiness takes step 3.
        const html = renderComposer({ workflows: null });
        expect(html).not.toContain('Reusable workflow');
        expect(html).not.toContain('composer-steps');
        expect(html.match(/class="composer-context-item"/g) ?? []).toHaveLength(2);
        expect(html).not.toContain('Workflow details');
        expect(html).not.toContain('Without a workflow, your prompt runs as written.');
        expect(html).toMatch(/3<\/span>[\s\S]*?Readiness/);
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
        // The default view stays terse — no repeated-explanation sentence beside a compact
        // control that already shows its own selected value.
        expect(html).not.toContain('A workflow can turn this request');
        // Unchosen means NO process: the trigger reads the empty option's label. The offered
        // names are client-side; e2e/composer.spec.ts drives the real dropdown.
        expect(html).toContain('>No workflow</span></button>');
    });

    it('gathers repository, executor and workflow as the three columns of the execution context', () => {
        const html = renderComposer({
            repos: [{ owner: 'acme', name: 'web', status: 'ready' }],
            executors: [{ name: 'main', type: 'claude' }],
            workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org' }],
        });
        expect(html).toContain('<h2>Execution context</h2>');
        expect(html).toContain('class="composer-context"');
        expect(html.match(/class="composer-context-item"/g) ?? []).toHaveLength(3);
        expect(html).not.toContain('composer-grid');
        expect(html).not.toContain('Run without a repository checkout.');
        expect(html).not.toContain('The selected executor type chooses');
        // The full value stays reachable off the truncated trigger through the title attribute,
        // beside the listbox itself and the preflight sentence.
        expect(html).toContain('title="acme/web"');
        expect(html).toContain('title="main"');
    });

    it('offers no workflow step controls: no checkboxes, no composer-steps, no default-workflow wording', () => {
        const html = renderComposer({ workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org' }] });
        expect(html).not.toMatch(/<input type="checkbox"/);
        expect(html).not.toContain('composer-steps');
        expect(html).not.toContain('Default workflow');
        expect(html).not.toContain('Optional steps');
        expect(html).toContain('Your prompt will run as written.');
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
        expect(html).toContain('>No workflow</span></button>');
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

describe('the redesigned composer (#280)', () => {
    const START = /<button type="button" class="primary"[^>]*>Start task<\/button>/;
    const startButton = (html: string) => html.match(START)?.[0] ?? '';

    it('lays the page out as four numbered sections, the step discs hidden from assistive tech', () => {
        const html = renderComposer({ workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org' }] });
        const discs = html.match(/<span class="composer-step" aria-hidden="true">\d<\/span>/g) ?? [];
        expect(discs).toEqual([1, 2, 3, 4].map((n) => `<span class="composer-step" aria-hidden="true">${n}</span>`));
        for (const title of ['What should the agent do?', 'Execution context', 'Workflow details', 'Readiness']) {
            expect(html).toContain(title);
        }
        // No attachment, mention or template affordances — none of them exist behind the UI.
        expect(html).not.toMatch(/attach|mention|template/i);
    });

    describe('the repository must be selected and synced (issue 263)', () => {
        const draft = (patch: Partial<ComposerDraftInput> = {}) => restoredDraft({ draft: 'fix it', ...patch });

        it('keeps Start clickable when nothing is synced, so it can open the dialog, and says why', () => {
            for (const status of ['queued', 'cloning', 'failed', 'purging'] as const) {
                const html = renderComposer({
                    repos: [{ owner: 'acme', name: 'web', status }],
                    restored: draft(),
                });
                expect(startButton(html), status).not.toContain('disabled=""');
                expect(html).toContain('No repos synced');
                expect(html).toContain(
                    'Go to the Repositories page to select and sync a repository before running a task.'
                );
                expect(html).toContain('href="/settings/repos?return=/tasks/new"');
            }
            const none = renderComposer({ repos: [], restored: draft() });
            expect(startButton(none)).not.toContain('disabled=""');
            expect(none).toContain('No repos synced');
        });

        it('does not claim "no repos synced" while the workspace is loading or failed', () => {
            for (const html of [
                renderComposer({ repos: null, restored: draft() }),
                renderComposer({ repos: null, workspaceError: 'Request failed (503)', restored: draft() }),
            ]) {
                expect(html).not.toContain('No repos synced');
                expect(html).not.toContain('>Start task<');
            }
        });

        it('requires a selection when another repository is synced', () => {
            const html = renderComposer({
                repos: [{ owner: 'acme', name: 'web', status: 'ready' }],
                restored: draft({ repo: '', repoTouched: true }),
            });
            expect(startButton(html)).toContain('disabled=""');
            expect(html).toContain('No repository selected');
            expect(html).not.toContain('No repos synced');
        });

        it('holds a chosen repository that is not ready, even though another is ready', () => {
            const html = renderComposer({
                repos: [
                    { owner: 'acme', name: 'web', status: 'ready' },
                    { owner: 'acme', name: 'api', status: 'cloning' },
                ],
                restored: draft({ repo: 'acme/api', workflowRepo: 'acme/api' }),
            });
            expect(startButton(html)).toContain('disabled=""');
            expect(html).toContain('Repository not synced');
            expect(html).toContain('acme/api is cloning');
        });

        it('starts against a selected, ready repository', () => {
            expect(startButton(renderComposer({ restored: draft() }))).not.toContain('disabled=""');
        });
    });

    it('offers an example only while the request is empty', () => {
        const empty = renderComposer({});
        expect(empty).toMatch(/<button type="button" class="composer-example">.*Try an example<\/button>/);
        const typed = renderComposer({ restored: restoredDraft({ draft: 'fix it' }) });
        expect(typed).toMatch(/<button type="button" class="composer-example" disabled="">.*Try an example<\/button>/);
    });

    it('counts the request against the board limit, and blocks it red past the limit', () => {
        const fresh = renderComposer({});
        expect(fresh).toContain('0 / 16,384');
        expect(fresh).not.toContain('composer-counter is-over');

        const over = renderComposer({ restored: restoredDraft({ draft: 'x'.repeat(16_385) }) });
        expect(over).toContain('16,385 / 16,384');
        expect(over).toContain('composer-counter is-over');
        expect(over).toContain('class="banner-bad"');
        expect(over).toContain('Request too long');
        expect(startButton(over)).toContain('disabled=""');
    });

    it('opens a fresh composer with no red banner: the empty prompt is quiet status text', () => {
        const html = renderComposer({});
        expect(html).not.toContain('banner-bad');
        expect(html).not.toContain('banner-info');
        expect(html).toContain('Describe the task to continue.');
        expect(startButton(html)).toContain('aria-describedby="composer-blocker"');
    });

    it('raises the missing executor as a red banner with the way to fix it, and points Start at it', () => {
        const html = renderComposer({ executors: [] });
        const banner = html.slice(html.indexOf('class="banner-bad"'));
        expect(banner).toContain('No executor configured');
        expect(banner).toContain('href="/settings/executors?return=/tasks/new"');
        expect(banner).toContain('Add an executor in Settings');
        expect(html).toContain('id="composer-readiness"');
        expect(startButton(html)).toContain('aria-describedby="composer-readiness"');
        expect(startButton(html)).toContain('disabled=""');
    });

    it('raises incomplete workflow details as a red banner', () => {
        const html = renderComposer({
            restored: restoredDraft({ draft: 'fix it', workflow: 'fix-issue' }),
            workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org', params: [{ name: 'issue', pattern: '#\\d+' }] }],
        });
        expect(html).toContain('class="banner-bad" id="composer-readiness"');
        expect(html).toContain('Complete the required workflow details to continue.');
    });

    it('labels the empty workflow option "No workflow" and explains it in words', () => {
        const html = renderComposer({ workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org' }] });
        expect(html).toContain('<span class="composer-context-value">No workflow</span>');
        expect(html).toContain('Without a workflow, your prompt runs as written.');
    });

    it('holds Start while a restored workflow waits for its list — its parameters are not known yet', () => {
        // Before the list answers, the chosen name declares nothing, so the empty-params gate
        // would pass vacuously and launch `fix-issue` without the `#12` the member typed.
        const html = renderComposer({
            workflows: null,
            restored: restoredDraft({
                draft: 'fix it',
                workflow: 'fix-issue',
                storedParams: { workflowId: 'w1', values: { issue: '#12' } },
            }),
        });
        expect(startButton(html)).toContain('disabled=""');
        expect(html).toContain('class="banner-info" id="composer-readiness"');
        expect(html).toContain('Loading the fix-issue workflow…');
        expect(html).not.toContain('needs no launch details');
        expect(html).not.toContain('banner-bad');
    });

    it('restores a held draft exactly: request, workflow, params and step overrides', () => {
        const html = renderComposer({
            repos: [
                { owner: 'acme', name: 'web', status: 'ready' },
                { owner: 'acme', name: 'api', status: 'ready' },
            ],
            executors: [
                { name: 'main', type: 'claude-code' },
                { name: 'heavy', type: 'claude-code' },
            ],
            workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org', params: [{ name: 'issue', pattern: '#\\d+' }] }],
            restored: restoredDraft({
                draft: 'fix the login crash',
                executor: 'heavy',
                repo: 'acme/api',
                repoTouched: true,
                workflowRepo: 'acme/api',
                workflow: 'fix-issue',
                storedParams: { workflowId: 'w1', values: { issue: '#12' } },
            }),
        });
        expect(html).toContain('>fix the login crash</textarea>');
        expect(html).toContain('title="heavy"');
        expect(html).toContain('title="acme/api"');
        expect(html).toContain('>fix-issue</span></button>');
        expect(html).toContain('value="#12"');
        expect(startButton(html)).not.toContain('disabled=""');
    });

    it('offers Discard draft only once the composer holds something a fresh one would not', () => {
        expect(renderComposer({})).not.toContain('Discard draft');
        expect(renderComposer({ restored: restoredDraft({ draft: 'fix it' }) })).toContain('>Discard draft</button>');
    });
});

/** A held draft for the default fixture lists (acme/web, main), with any field overridden. */
function restoredDraft(overrides: Partial<ComposerDraftInput>): ComposerDraftInput {
    return {
        draft: '',
        executor: 'main',
        repo: 'acme/web',
        repoTouched: false,
        workflowRepo: 'acme/web',
        workflow: '',
        storedParams: { workflowId: null, values: {} },
        paramTouched: {},
        ...overrides,
    };
}
