import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { removeDialogTitle, removeDialogBody, TaskRemoveDialog } from '../src/components/TaskRemoveDialog.js';
import { isTerminal, type Job, type RuntimeVitals, type UseJobs } from '../src/api/useJobs.js';
import type { UseWorkspace } from '../src/api/useWorkspace.js';
import { runDuration, taskTime, wallClock } from '../src/format.js';
import {
    closureOf,
    gateCounts,
    issueUrl,
    newestTerminalExit,
    prNumber,
    publicationForRun,
    threadContextTokens,
    threadCostUsd,
    threadIssue,
    threadPublish,
} from '../src/task-outcome.js';
import { WorkflowParameterFields } from '../src/components/WorkflowParameterFields.js';
import { TaskComposer } from '../src/panels/TaskComposer.js';
import { TaskDetail } from '../src/panels/TaskDetail.js';
import { TaskHeader } from '../src/panels/TaskHeader.js';
import { TaskComposerPage } from '../src/pages/TaskComposerPage.js';
import { TaskDetailPage } from '../src/pages/TaskDetailPage.js';
import {
    type WorkflowParamChoice,
    clampedWorkflow,
    defaultWorkflowPayload,
    defaultWorkflowStepSummary,
    effectiveDefaultSteps,
    effectiveWorkflows,
    freshWorkflowDraft,
    humanizeParamName,
    markTouched,
    paramFieldVerdict,
    paramsComplete,
    paramValueMatches,
    preflightSentence,
    startBlocker,
    toggleDefaultStep,
    touchAll,
    valuesForWorkflow,
} from '../src/task-composer.js';

/**
 * The same contract the other panel suites pin: props in, markup out, and no DOM — `useEffect`
 * never runs under renderToStaticMarkup, so the hooks are exercised by the pages that own them and
 * this suite exercises what the reader actually sees.
 */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

function job(overrides: Partial<Job> = {}): Job {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        command: 'fix the flaky login test',
        status: 'succeeded',
        attempts: 1,
        author: null,
        stoppedBy: null,
        doneBy: null,
        exitCode: 0,
        output: null,
        repo: null,
        executor: null,
        workflowName: null,
        workflowNode: null,
        followUpTo: null,
        rootJobId: '11111111-1111-4111-8111-111111111111',
        doneAt: null,
        cancelRequestedAt: null,
        workspacePath: null,
        createdAt: '2026-09-01T12:00:00.000Z',
        startedAt: '2026-09-01T12:00:01.000Z',
        finishedAt: '2026-09-01T12:04:00.000Z',
        wallClockMs: null,
        taskWallClockMs: null,
        summary: null,
        // A finished claude-code run has a session by default here: the follow-up composer is
        // offered for exactly these, and the sessionless case has its own test below.
        sessionId: '33333333-3333-4333-8333-333333333333',
        remoteSessionId: null,
        ...overrides,
    };
}

interface ComposerArgs {
    repos?: { owner: string; name: string }[] | null;
    workspaceError?: string | null;
    executors?: { name: string; type: string }[];
    /** The workflow choices for the repo context; null hides the select (no workflows served). */
    workflows?:
        | readonly {
              id: string;
              name: string;
              scope: 'org' | 'user' | 'repo';
              params?: WorkflowParamChoice[];
          }[]
        | null;
    actionError?: string | null;
    sending?: boolean;
    /** The saved default-workflow step settings; null while they have not answered yet. */
    defaultWorkflowSettings?: { reviewReconciliation: boolean; mergeConflictAutofix: boolean } | null;
}

const renderComposer = ({
    repos = [{ owner: 'acme', name: 'web' }],
    workspaceError = null,
    executors = [{ name: 'main', type: 'claude-code' }],
    workflows = null,
    actionError = null,
    sending = false,
    defaultWorkflowSettings = null,
}: ComposerArgs = {}) =>
    // The Settings remediation is an SPA Link, so the panel needs a routing context to render.
    renderToStaticMarkup(
        <MemoryRouter>
            <TaskComposer
                repos={repos}
                workspaceError={workspaceError}
                onRetryWorkspace={() => {}}
                executors={executors}
                workflows={workflows}
                defaultWorkflowSettings={defaultWorkflowSettings}
                actionError={actionError}
                sending={sending}
                onSend={async () => null}
            />
        </MemoryRouter>
    );

interface DetailArgs {
    /** One task or a whole follow-up chain — the page hands the polled thread over as-is. */
    jobs?: Job[] | null;
    error?: string | null;
    actionError?: string | null;
    sending?: boolean;
}

const renderDetail = ({ jobs = [job()], error = null, actionError = null, sending = false }: DetailArgs = {}) =>
    renderToStaticMarkup(
        // The sessionless branch carries a router Link (Start a new task), so the panel renders
        // under a router the same way the page mounts it.
        <MemoryRouter>
            <TaskDetail
                jobs={jobs}
                error={error}
                actionError={actionError}
                sending={sending}
                onFollowUp={async () => null}
            />
        </MemoryRouter>
    );

interface HeaderArgs {
    jobs?: Job[] | null;
    stoppingId?: string | null;
    doneId?: string | null;
}

const renderHeader = ({ jobs = [job()], stoppingId = null, doneId = null }: HeaderArgs = {}) =>
    renderToStaticMarkup(
        <TaskHeader
            jobs={jobs}
            stoppingId={stoppingId}
            doneId={doneId}
            onStop={async () => {}}
            onDone={async () => {}}
            onRemoveRequest={() => {}}
        />
    );

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
        const start = html.slice(html.indexOf('>Start task<') - 200, html.indexOf('>Start task<'));
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
        expect(html).toContain('>Default workflow</button>');
    });

    describe('default-workflow step checkboxes (#208)', () => {
        const oneWorkflow = [{ id: 'w1', name: 'fix-issue', scope: 'org' as const }];

        it('shows both optional steps, initialized from the saved defaults, once they have answered', () => {
            const html = renderComposer({
                workflows: oneWorkflow,
                defaultWorkflowSettings: { reviewReconciliation: true, mergeConflictAutofix: false },
            });
            expect(html).toContain('Iterate on PR review comments');
            expect(html).toContain('Repair merge conflicts');
            const checkboxes = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
            expect(checkboxes).toHaveLength(2);
            expect(checkboxes[0]).toContain('checked=""');
            expect(checkboxes[1]).not.toContain('checked=""');
        });

        it('shows both steps on for the missing-row defaults', () => {
            const html = renderComposer({
                workflows: oneWorkflow,
                defaultWorkflowSettings: { reviewReconciliation: true, mergeConflictAutofix: true },
            });
            const checkboxes = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
            expect(checkboxes).toHaveLength(2);
            for (const box of checkboxes) expect(box).toContain('checked=""');
        });

        it('renders no checkboxes while the saved defaults have not answered yet', () => {
            const html = renderComposer({ workflows: oneWorkflow, defaultWorkflowSettings: null });
            expect(html).not.toContain('Iterate on PR review comments');
            expect(html).not.toContain('Repair merge conflicts');
        });

        it('renders no checkboxes on a board that serves no workflows at all', () => {
            // The same gate as the dropdown itself: a board without the feature renders exactly
            // the composer that came before it.
            const html = renderComposer({
                workflows: null,
                defaultWorkflowSettings: { reviewReconciliation: true, mergeConflictAutofix: true },
            });
            expect(html).not.toContain('Iterate on PR review comments');
            expect(html).not.toContain('Repair merge conflicts');
        });

        it('lists the final step set in the preflight sentence', () => {
            const html = renderComposer({
                workflows: oneWorkflow,
                defaultWorkflowSettings: { reviewReconciliation: true, mergeConflictAutofix: false },
            });
            expect(html).toContain(
                'Will run the default workflow: prompt, gates, publish, plus iterate on PR review comments.'
            );
        });
    });
});

describe('TaskDetail', () => {
    it('shows the command, status, executor and stamp of the task', () => {
        const html = renderDetail({ jobs: [job({ executor: 'main' })] });
        expect(html).toContain('fix the flaky login test');
        expect(html).toContain('succeeded');
        expect(html).toContain('main');
        expect(html).toContain('2026-09-01 12:00');
    });

    it('labels turns with their workflow node in the quiet footer, and stays quiet without one', () => {
        // A workflow thread's rows read as the graph they walked: the node sits in the footer of
        // every turn that carries one, and a turn without one renders as before.
        const html = renderDetail({
            jobs: [
                job({ workflowNode: 'implement' }),
                job({
                    id: '22222222-2222-4222-8222-222222222222',
                    status: 'running',
                    workflowNode: null,
                    sessionId: null,
                }),
            ],
        });
        expect(html).toContain('node implement');
        const second = html.slice(html.indexOf('second'), html.indexOf('</article>', html.indexOf('second')));
        expect(second).not.toContain('node ');
        const plain = renderDetail({ jobs: [job()] });
        expect(plain).not.toContain('class="pill">implement</span>');
    });

    it('names the actors behind the verdicts, and stays quiet when there are none', () => {
        const author = { id: 'a', login: 'octocat', name: null, avatarUrl: null };
        const stopper = { id: 'b', login: 'stopper', name: null, avatarUrl: null };
        const html = renderDetail({
            jobs: [
                job({ author, doneBy: author, doneAt: '2026-09-01T13:00:00.000Z' }),
                job({ id: '22222222-2222-4222-8222-222222222222', stoppedBy: stopper, status: 'stopped' }),
            ],
        });
        // The label follows the status: the stamp is the ask, only a row that settled stopped
        // may claim the stop landed. A run that finished on its own after somebody asked keeps
        // the ask as a request, never as a verdict.
        expect(html).toContain('stopped by stopper');
        expect(html).toContain('done by octocat');
        const requested = renderDetail({ jobs: [job({ author, stoppedBy: stopper, doneBy: author })] });
        expect(requested).toContain('stop requested by stopper');
        expect(requested).not.toContain('stopped by stopper');
        const plain = renderDetail({ jobs: [job()] });
        expect(plain).not.toContain('stopped by');
        expect(plain).not.toContain('stop requested by');
        expect(plain).not.toContain('done by');
    });

    it('shows who started the task in the outcome, honestly unknown for a pre-accounts row', () => {
        const author = { id: 'a', login: 'octocat', name: 'The Octocat', avatarUrl: 'https://x/a.png' };
        expect(renderDetail({ jobs: [job({ author })] })).toContain('Started by');
        expect(renderDetail({ jobs: [job({ author })] })).toContain('The Octocat');
        expect(renderDetail({ jobs: [job({ author })] })).toContain('https://x/a.png');

        const unknown = renderDetail({ jobs: [job()] });
        expect(unknown).toContain('Started by');
        expect(unknown).toContain('unknown');
    });

    it('renders the output as text, never as markup', () => {
        const html = renderDetail({ jobs: [job({ output: '<script>alert(1)</script>' })] });
        // Container output is arbitrary text; escaping it is the difference between a transcript
        // and a hole.
        expect(html).toContain('&lt;script&gt;');
        expect(html).not.toContain('<script>');
        expect(html).toContain('<pre');
    });

    it('claims nothing about a task or output that has not loaded', () => {
        // A finished task whose detail has not arrived must not read as one with no output —
        // that is a false statement about a run somebody is waiting on.
        expect(renderDetail({ jobs: null })).toMatch(/Loading the task/);
        const waiting = renderDetail({
            jobs: [job({ status: 'running', output: null, exitCode: null, finishedAt: null, startedAt: null })],
        });
        expect(waiting).toContain('Waiting for the executor');
        const empty = renderDetail({ jobs: [job({ output: null })] });
        expect(empty).toContain('finished without a captured agent response');
    });

    it('says so in place when the task could not be loaded', () => {
        const html = renderDetail({ jobs: null, error: 'Request failed (503)' });
        expect(html).toContain('Request failed (503)');
    });

    it('shows the exit code of a finished run', () => {
        const html = renderDetail({ jobs: [job({ status: 'failed', exitCode: 1 })] });
        expect(html).toContain('exit 1');
    });

    it('a stopped task has ended the turn: the composer stays open, and never Resume', () => {
        // Stopping is a verdict, not a park: the turn is over, the conversation stays open for an
        // adjustment, and there is no picking the run back up.
        const html = renderDetail({ jobs: [job({ status: 'stopped' })] });
        expect(html).toContain('<textarea');
        expect(html).not.toContain('Resume');
    });

    it('offers a follow-up composer on a finished task, and neither composer on a moving one', () => {
        // The run ending is not the task ending: these two exist exactly for the gap between "the
        // executor stopped" and "I am satisfied".
        const finished = renderDetail({ jobs: [job()] });
        expect(finished).toContain('<textarea');
        expect(finished).toContain('Send follow-up');
        for (const status of ['queued', 'running', 'standby'] as const) {
            const moving = renderDetail({
                jobs: [job({ status, exitCode: null, finishedAt: null, startedAt: null, output: null })],
            });
            expect(moving, status).not.toContain('<textarea');
        }
    });

    it("keeps the transcript clean of task actions — those are the page header's", () => {
        // The conversation panel carries no Stop/Done/Remove since the head lifted to the page;
        // its own composer's Send follow-up stays, of course.
        const finished = renderDetail({ jobs: [job()] });
        expect(finished).not.toContain('chat-resume');
        expect(finished).not.toContain('chat-stop');
        expect(finished).not.toContain('chat-remove');
        expect(finished).not.toContain('task-actions');
    });

    it('never offers the composer on a task the user has already marked done', () => {
        const html = renderDetail({ jobs: [job({ doneAt: '2026-09-01T13:00:00.000Z' })] });
        expect(html).not.toContain('<textarea');
        // The verdict is visible, not silently implied by the buttons' absence.
        expect(html).toContain('chat-done');
    });

    it('shows no follow-up composer on a run still going', () => {
        expect(
            renderDetail({
                jobs: [job({ status: 'running', exitCode: null, finishedAt: null, startedAt: null, output: null })],
            })
        ).not.toContain('<textarea');
    });

    it('disables the follow-up Send until text is typed', () => {
        const html = renderDetail({ jobs: [job()] });
        const send = html.slice(html.lastIndexOf('>Send<') - 200, html.lastIndexOf('>Send<'));
        expect(send).toContain('disabled');
    });

    /**
     * A follow-up continues the run's agent session, and the board refuses one for a run that
     * never reported a session — every opencode task, and a claude-code run whose driver died
     * before reporting — with 409 NO_SESSION. The composer must not be offered where it can only
     * ever fail; the page says why instead.
     */
    it('offers no follow-up composer on a run with no session to continue, and says why', () => {
        const html = renderDetail({ jobs: [job({ sessionId: null })] });
        expect(html).not.toContain('<textarea');
        expect(html).not.toContain('>Send<');
        expect(html).toContain('no agent session to continue');
    });

    /**
     * A follow-up is a new row on the board but NOT a new task here: the chain renders as one
     * conversation, oldest first, and the composer + Done verdict belong to the NEWEST run only —
     * older runs are history.
     */
    it('renders the follow-up chain as one conversation, with the newest run in charge', () => {
        const root = job({ command: 'fix the flaky login test' });
        const child = {
            ...job({ command: 'now tighten the retry logic' }),
            id: '44444444-4444-4444-8444-444444444444',
            followUpTo: root.id,
            rootJobId: root.id,
        };
        const html = renderDetail({ jobs: [root, child] });

        expect(html).toContain('fix the flaky login test');
        expect(html).toContain('now tighten the retry logic');
        // Both messages, in order.
        expect(html.indexOf('fix the flaky login test')).toBeLessThan(html.indexOf('now tighten the retry logic'));
        expect(html).toContain('<textarea');
    });

    it('never emits a placeholder value', () => {
        const html = renderDetail({
            jobs: [
                job({ executor: null, repo: null, output: null, exitCode: null, finishedAt: null, startedAt: null }),
            ],
        });
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    /**
     * The checks a run performed or is performing: a collapsible list per run, expandable to the
     * gate's output. Current/last ran only — the board stores exactly that, so the UI has no
     * history control to offer.
     */
    describe('checks', () => {
        const gates = [
            { name: 'test', status: 'passed' as const, exitCode: 0, output: 'all green' },
            { name: 'lint', status: 'failed' as const, exitCode: 1, output: '2 problems' },
        ];

        it('renders the checks list with a name and status per gate', () => {
            const html = renderDetail({ jobs: [job({ gates })] });
            expect(html).toContain('Checks');
            expect(html).toContain('test');
            expect(html).toContain('lint');
            expect(html).toContain('passed');
            expect(html).toContain('failed');
            expect(html).toContain('<details');
        });

        it('expands to the gate output, rendered as text', () => {
            const html = renderDetail({ jobs: [job({ gates })] });
            expect(html).toContain('2 problems');
            expect(html).toContain('<pre');
        });

        it('labels each summary count with its meaning and status color', () => {
            // "Checks 1 1 0" tells nobody which number is which; each count is labelled and wears
            // the same status class the per-gate pill does.
            const html = renderDetail({
                jobs: [
                    job({
                        gates: [...gates, { name: 'build', status: 'running' as const, exitCode: null, output: null }],
                    }),
                ],
            });
            // The gates summary is the first summary AFTER the outcome's own — anchor the slice
            // on the gates disclosure itself, not on the first summary in the page.
            const start = html.indexOf('chat-gates');
            const summary = html.slice(start, html.indexOf('</summary>', start));
            expect(summary).toContain('pill gate-passed');
            expect(summary).toContain('pill gate-failed');
            expect(summary).toContain('pill gate-running');
            expect(summary).toMatch(/1(<!-- -->)? passed/);
            expect(summary).toMatch(/1(<!-- -->)? failed/);
            expect(summary).toMatch(/1(<!-- -->)? running/);
        });

        it('renders no checks section for a run without gates', () => {
            expect(renderDetail({ jobs: [job()] })).not.toContain('Checks');
            expect(renderDetail({ jobs: [job({ gates: [] })] })).not.toContain('Checks');
        });

        it('never emits a placeholder value for a gate that has not exited', () => {
            const html = renderDetail({
                jobs: [job({ gates: [{ name: 'test', status: 'running', exitCode: null, output: null }] })],
            });
            for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
        });
    });

    /**
     * The attempt's sampled vitals — the "is it stuck or working" strip: CPU and memory, rendered
     * above the output while the run is going ONLY: the sample is a liveness signal, and a stale
     * "cpu 167%" beside a finished run's verdict lies about a run that is no longer going. The
     * activity line is the sidebar's "currently running task", the view's summary line and the
     * nav and tab summaries, and lives where the task is met.
     */
    describe('runtime', () => {
        const runtime = {
            cpuPercent: 93.4,
            memUsedMb: 544.2,
            memPercent: 7,
            activity: '→ Read src/x.ts',
            sampledAt: '2026-09-09T10:00:00.000Z',
        };

        it('renders cpu and memory above the output while the run is going', () => {
            const html = renderDetail({ jobs: [job({ status: 'running', runtime })] });
            expect(html).toMatch(/cpu (<!-- -->)?93(<!-- -->)?%/);
            expect(html).toMatch(/mem (<!-- -->)?544(<!-- -->)? MiB \((<!-- -->)?7(<!-- -->)?%\)/);
            expect(html).toContain('chat-runtime');
        });

        it('renders no strip once the run has ended, whatever it sampled last', () => {
            for (const status of ['succeeded', 'failed', 'dead', 'standby'] as const) {
                const html = renderDetail({ jobs: [job({ status, runtime })] });
                expect(html, status).not.toContain('chat-runtime');
            }
        });

        it('renders no strip until the driver has sampled one', () => {
            expect(renderDetail({ jobs: [job({ status: 'running' })] })).not.toContain('chat-runtime');
        });

        /**
         * A services-only sample — the vitals read failed, a metrics-server-less cluster for one
         * — carries no readable numbers: no pills at all beats pills that lie with zeros. The
         * board's key-wise merge OMITS the unreadable halves rather than storing nulls, so the
         * keys can be absent outright; the guard reads both the same.
         */
        it('renders no pills the sample could not read', () => {
            const servicesOnly = {
                memPercent: null,
                activity: '→ Read x',
                sampledAt: '2026-09-01T12:02:00.000Z',
                services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
            } as RuntimeVitals;
            const html = renderDetail({ jobs: [job({ status: 'running', runtime: servicesOnly })] });
            expect(html).not.toContain('chat-runtime');
            for (const token of FORBIDDEN) expect(html, token).not.toContain(token);

            const nulls = {
                ...servicesOnly,
                cpuPercent: null,
                memUsedMb: null,
            };
            expect(renderDetail({ jobs: [job({ status: 'running', runtime: nulls })] })).not.toContain('chat-runtime');
        });

        it('omits the percentage the sample does not carry', () => {
            const html = renderDetail({
                jobs: [job({ status: 'running', runtime: { ...runtime, memPercent: null } })],
            });
            expect(html).toMatch(/mem (<!-- -->)?544(<!-- -->)? MiB</);
        });

        it('never emits a placeholder value', () => {
            const html = renderDetail({
                jobs: [job({ status: 'running', runtime: { ...runtime, activity: null, memPercent: null } })],
            });
            for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
        });
    });

    /** The task's live summary moved to the page header's meta (#159). */
    /**
     * The per-turn close-time scrape — `ctx … tok · $…` — belongs to EVERY terminal turn,
     * including the newest: the scrape is written at close, so its absence is how a running turn
     * says "not yet", and a finished thread's last turn is usually the most relevant one to read
     * it on (issue #60).
     */
    describe('turn stats', () => {
        const scrape = (contextTokens: number, costUsd: number | null) => ({
            cpuPercent: 12,
            memUsedMb: 300,
            memPercent: null,
            activity: null,
            sampledAt: '2026-09-01T12:02:00.000Z',
            contextTokens,
            costUsd,
        });
        const child = (over: Partial<Job> = {}): Job => {
            const root = job({ command: 'first command' });
            return {
                ...job({ command: 'second command', ...over }),
                id: '44444444-4444-4444-8444-444444444444',
                followUpTo: root.id,
                rootJobId: root.id,
            };
        };
        /**
         * One turn's meta line: from its command paragraph to the next turn's. Anchored on the
         * turn's own `msg-user` paragraph, not the first occurrence of the command text — the
         * page header's `<h1>` repeats the root command above the thread, and a first-occurrence
         * slice would stop before the turn's meta ever rendered.
         */
        const turnMeta = (html: string, command: string): string => {
            const marker = `<p class="msg-user">${command}</p>`;
            const start = html.indexOf(marker);
            if (start === -1) return '';
            const next = html.indexOf('msg-user', start + marker.length);
            return html.slice(start, next === -1 ? undefined : next);
        };

        it('shows its own scrape on every terminal turn, including the newest', () => {
            const html = renderDetail({
                jobs: [
                    job({ command: 'first command', runtime: scrape(30000, 0.1) }),
                    child({ runtime: scrape(90433, 0.21) }),
                ],
            });
            const rootMeta = turnMeta(html, 'first command');
            expect(rootMeta).toContain('ctx 30,000 tok');
            expect(rootMeta).toContain('$0.1000');
            const childMeta = turnMeta(html, 'second command');
            expect(childMeta).toContain('ctx 90,433 tok');
            expect(childMeta).toContain('$0.2100');
        });

        it('shows no scrape on a turn that is still going', () => {
            const html = renderDetail({
                jobs: [
                    job({ command: 'first command', runtime: scrape(30000, 0.1) }),
                    child({
                        status: 'running',
                        runtime: {
                            cpuPercent: 12,
                            memUsedMb: 300,
                            memPercent: null,
                            activity: null,
                            sampledAt: '2026-09-01T12:02:00.000Z',
                        },
                    }),
                ],
            });
            expect(turnMeta(html, 'second command')).not.toContain('ctx');
        });

        it('shows ctx without money on a zero-dollar turn', () => {
            const html = renderDetail({ jobs: [job({ runtime: scrape(1200, 0) })] });
            expect(html).toContain('ctx 1,200 tok');
            expect(html).not.toContain('$0.0000');
        });
    });
    it('never emits a placeholder value', () => {
        const html = renderDetail({
            jobs: [
                job({
                    executor: null,
                    workspacePath: null,
                    output: null,
                    exitCode: null,
                    runtime: {
                        cpuPercent: 12,
                        memUsedMb: 300,
                        memPercent: 2,
                        activity: null,
                        sampledAt: '2026-09-01T12:02:00.000Z',
                        contextTokens: null,
                        costUsd: null,
                    },
                }),
            ],
        });
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});

describe('the task page header', () => {
    /**
     * The page-level head of `/tasks/:id`: the task's name as the page's one `h1`, its status,
     * wall clock and live activity in the meta slots, and every action the task can take in the
     * actions slot — lifted out of the conversation panel (#159).
     */

    it("names the task after its opening command, as the page's one h1", () => {
        const html = renderHeader({ jobs: [job()] });
        expect(html.match(/<h1/g)?.length).toBe(1);
        expect(html).toContain('<h1>fix the flaky login test</h1>');

        // A multi-line command is prose; the header carries its first line, the turn carries it all.
        const multiline = renderHeader({ jobs: [job({ command: 'first line\nsecond line' })] });
        expect(multiline).toContain('<h1>first line</h1>');
        expect(multiline).not.toContain('second line');
    });

    it('keeps the plain Tasks heading while nothing is loaded', () => {
        // No task yet, so there is nothing to name — the detail poll has not landed.
        const html = renderHeader({ jobs: null });
        expect(html).toContain('<h1>Tasks</h1>');
        expect(html).not.toContain('>Stop run<');
        expect(html).not.toContain('>Mark done<');
        expect(html).not.toContain('More task actions');
    });

    it('shows the status beside the title', () => {
        const html = renderHeader({ jobs: [job()] });
        expect(html).toContain('page-header-meta');
        expect(html).toContain('<span class="pill">succeeded</span>');
    });

    /** The action matrix: stoppable = queued/running/standby, done = the one primary, closed = text. */
    it('offers Stop run on every state a stop can land on — queued, running, standby', () => {
        // The board accepts queued and standby stops, not just a moving run.
        for (const status of ['queued', 'running', 'standby'] as const) {
            const html = renderHeader({
                jobs: [job({ status, exitCode: null, finishedAt: null, startedAt: null, output: null })],
            });
            expect(html, status).toContain('>Stop run<');
            expect(html, status).toContain('chat-stop');
        }
        for (const status of ['succeeded', 'failed', 'dead', 'stopped'] as const) {
            const html = renderHeader({ jobs: [job({ status })] });
            expect(html, status).not.toContain('>Stop run<');
            expect(html, status).not.toContain('Stopping…');
        }
    });

    it('says Stopping, not Stop run, once the stop request has landed but the run has not parked', () => {
        // The board settles the stop at the worker's next heartbeat: pending is not terminal, so
        // the pending state is a status pill, never a control that looks clickable again.
        const html = renderHeader({
            jobs: [
                job({
                    status: 'running',
                    cancelRequestedAt: '2026-09-01T12:01:00.000Z',
                    exitCode: null,
                    finishedAt: null,
                    startedAt: null,
                    output: null,
                }),
            ],
        });
        expect(html).toContain('Stopping…');
        expect(html).not.toContain('>Stop run<');
        // A run in flight cannot be removed yet: the board refuses with TASK_RUNNING.
        expect(html).not.toContain('More task actions');
    });

    it('says Stopping while the stop request itself is in flight, and cannot be re-clicked', () => {
        const task = job({ status: 'running', exitCode: null, finishedAt: null, startedAt: null, output: null });
        const html = renderHeader({ jobs: [task], stoppingId: task.id });
        expect(html).toContain('Stopping…');
        expect(html).not.toContain('>Stop run<');
        const stop = html.slice(html.indexOf('Stopping…') - 300, html.indexOf('Stopping…'));
        expect(stop).toContain('disabled');
    });

    it('offers Mark done as the one primary action on an open task', () => {
        const open = renderHeader({ jobs: [job()] });
        expect(open).toContain('>Mark done<');
        const doneButton = open.slice(open.indexOf('>Mark done<') - 300, open.indexOf('>Mark done<'));
        expect(doneButton).toContain('class="primary"');
        // Failed, dead and stopped are open too until somebody closes them.
        for (const status of ['failed', 'dead', 'stopped'] as const) {
            expect(renderHeader({ jobs: [job({ status })] }), status).toContain('>Mark done<');
        }

        const done = renderHeader({ jobs: [job({ doneAt: '2026-09-01T13:00:00.000Z' })] });
        expect(done).not.toContain('>Mark done<');

        // Done is unrelated to sessions and stays available for a run without one.
        const sessionless = renderHeader({ jobs: [job({ sessionId: null })] });
        expect(sessionless).toContain('>Mark done<');
    });

    it('labels an in-flight Mark done and disables it', () => {
        const task = job();
        const html = renderHeader({ jobs: [task], doneId: task.id });
        expect(html).toContain('Marking done…');
        expect(html).not.toContain('>Mark done<');
        const done = html.slice(html.indexOf('Marking done…') - 300, html.indexOf('Marking done…'));
        expect(done).toContain('disabled');
    });

    it('shows closure attribution as status text, never a disabled control', () => {
        const author = { id: 'a', login: 'octocat', name: null, avatarUrl: null };
        const attributed = renderHeader({ jobs: [job({ doneAt: '2026-09-01T13:00:00.000Z', doneBy: author })] });
        expect(attributed).toContain('Done by octocat');
        expect(attributed).toContain('chat-done');
        expect(attributed).not.toContain('disabled');

        // No actor recorded — pre-accounts row — still says the closure out loud.
        const plain = renderHeader({ jobs: [job({ doneAt: '2026-09-01T13:00:00.000Z' })] });
        expect(plain).toContain('Marked done');
        expect(plain).not.toContain('disabled');
        expect(plain).not.toContain('>Mark done<');
    });

    it('keeps Remove task out of the main action row, behind More task actions', () => {
        for (const status of ['queued', 'standby', 'succeeded', 'failed', 'dead', 'stopped'] as const) {
            const html = renderHeader({ jobs: [job({ status })] });
            expect(html, status).toContain('More task actions');
            // The destructive item lives in the anchored menu, which only the client renders;
            // the server-rendered action row must carry no Remove control of its own.
            expect(html, status).not.toContain('>Remove task<');
            expect(html, status).not.toContain('>Remove<');
            // The overflow trigger is a secondary control — the page's one primary is Mark done.
            const at = html.indexOf('More task actions');
            const trigger = html.slice(html.lastIndexOf('<button', at), at);
            expect(trigger, status).not.toContain('primary');
        }
    });

    it('hides More task actions while any member of the thread is running', () => {
        const moving = { exitCode: null, finishedAt: null, startedAt: null, output: null };
        expect(renderHeader({ jobs: [job({ status: 'running', ...moving })] })).not.toContain('More task actions');

        // A follow-up still going closes the whole thread's menu — the removal would race the run.
        const root = job({ status: 'stopped' });
        const child = {
            ...job({ status: 'running', ...moving }),
            id: '44444444-4444-4444-8444-444444444444',
            followUpTo: root.id,
            rootJobId: root.id,
        };
        expect(renderHeader({ jobs: [root, child] })).not.toContain('More task actions');

        // Queued and standby members do not block it: the board has no run to refuse.
        const queued = {
            ...job({ status: 'queued', ...moving }),
            id: '44444444-4444-4444-8444-444444444444',
            followUpTo: root.id,
            rootJobId: root.id,
        };
        expect(renderHeader({ jobs: [root, queued] })).toContain('More task actions');
    });

    it('renders the actions on the newest run only — history runs grow none', () => {
        const root = job({ command: 'first command' });
        const child = {
            ...job({ command: 'second command', status: 'failed' }),
            id: '44444444-4444-4444-8444-444444444444',
            followUpTo: root.id,
            rootJobId: root.id,
        };
        const html = renderHeader({ jobs: [root, child] });
        expect(html.match(/>Mark done</g)).toHaveLength(1);
        expect(html.match(/More task actions/g)).toHaveLength(1);
        expect(html).not.toContain('>Stop run<');
    });

    it('renders no empty action wrapper in any state', () => {
        for (const status of ['queued', 'running', 'standby', 'succeeded', 'failed', 'dead', 'stopped'] as const) {
            const html = renderHeader({ jobs: [job({ status })] });
            expect(html, status).not.toContain('<div class="task-actions"></div>');
        }
    });

    it('shows the overall wall clock in the meta, and a dash where nothing is measurable', () => {
        const timed = renderHeader({ jobs: [job({ taskWallClockMs: 5_400_000 })] });
        expect(timed).toContain('1.5h');

        const untimed = renderHeader({ jobs: [job()] });
        expect(untimed).toContain('—');
    });

    it('shows the live activity line in the meta while the newest run is going', () => {
        // Same line the sidebar's "Task" row and the sidenav read — page level now (#159).
        const runtime = {
            cpuPercent: 12,
            memUsedMb: 300,
            memPercent: null,
            activity: '→ Bash npm test',
            sampledAt: '2026-09-01T12:02:00.000Z',
        };
        const html = renderHeader({ jobs: [job({ status: 'running', runtime })] });
        expect(html).toContain('task-summary');
        expect(html).toContain('→ Bash npm test');

        // Not on a task whose newest run is not going.
        const quiet = renderHeader({ jobs: [job()] });
        expect(quiet).not.toContain('task-summary');
    });

    it('never emits a placeholder value', () => {
        const html = renderHeader({
            jobs: [job({ taskWallClockMs: null, output: null, exitCode: null, finishedAt: null, startedAt: null })],
        });
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});

describe('TaskRemoveDialog', () => {
    /**
     * The remove confirmation is a Headless UI Dialog, so it portals — and `renderToStaticMarkup`
     * does not render portals: an open dialog server-renders as Headless' placeholder span, the
     * same posture the mobile drawer's suite pins. The in-dialog contracts (initial focus, Escape,
     * backdrop, focus restoration, the live error) are a real browser's to assert —
     * e2e/task-detail.spec.ts owns them. What a static render CAN hold is the copy the dialog
     * renders: the helpers below are the component's source of truth, exported pure.
     */
    const renderDialog = (over: { open?: boolean } = {}) =>
        renderToStaticMarkup(
            <TaskRemoveDialog
                open={over.open ?? true}
                command="fix the flaky login test"
                runCount={2}
                removing={false}
                error={null}
                onClose={() => {}}
                onConfirm={() => {}}
            />
        );

    it('server-renders a placeholder until the client mounts, open or closed', () => {
        expect(renderDialog()).toContain('<span hidden');
        expect(renderDialog({ open: false })).toContain('<span hidden');
    });

    it('names the task in the title \u2014 the root command\u2019s first line, whatever the prose', () => {
        expect(removeDialogTitle('fix the flaky login test')).toBe('Remove \u201Cfix the flaky login test\u201D?');
        expect(removeDialogTitle('first line\nsecond line')).toBe('Remove \u201Cfirst line\u201D?');
    });

    it('states every consequence in the body, with the thread\u2019s real run count', () => {
        const body = removeDialogBody(3);
        expect(body).toContain('permanently deletes all 3 runs');
        expect(body).toContain('their transcript');
        expect(body).toContain('worktree will be queued for deletion');
        expect(body).toContain('Published branches and pull requests are not deleted');
        expect(body).toContain('cannot be undone');
        // The count is the thread's length, not a decoration: one run reads as one.
        expect(removeDialogBody(1)).toContain('deletes all 1 runs');
    });
});

describe('the remove flow', () => {
    /** The `window.confirm` path is the thing this dialog replaces — it must be gone outright. */
    it('carries no window.confirm anywhere in the task actions', () => {
        const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
        expect(read('../src/pages/TaskDetailPage.tsx')).not.toContain('window.confirm');
        expect(read('../src/panels/TaskHeader.tsx')).not.toContain('window.confirm');
    });
});

describe('isTerminal', () => {
    // This is what stops the detail poll: a finished job is never going to grow an output.
    it('is true for every status a worker or the board has finished with', () => {
        for (const status of ['succeeded', 'failed', 'dead', 'stopped'] as const) {
            expect(isTerminal(status), status).toBe(true);
        }
    });

    it('is false while the task can still move', () => {
        for (const status of ['queued', 'running', 'standby'] as const) {
            expect(isTerminal(status), status).toBe(false);
        }
    });
});

describe('taskTime', () => {
    // A chat's stamp carries the time of day; the date is there to disambiguate older threads.
    it('renders the UTC date and clock, and a dash for anything absent or unparseable', () => {
        expect(taskTime('2026-09-01T12:04:00.000Z')).toBe('2026-09-01 12:04');
        expect(taskTime(null)).toBe('—');
        expect(taskTime('not a date')).toBe('—');
    });
});

describe('runDuration', () => {
    // The sidebar's "running time": the newest attempt's clock. Pure — the caller decides what
    // "now" is, so the tests pin spans instead of sleeping.
    it('renders the span of a finished run at minute granularity', () => {
        expect(runDuration('2026-09-01T12:00:01.000Z', '2026-09-01T12:04:00.000Z')).toBe('4m');
    });

    it('renders a live run up to the now it is handed', () => {
        expect(runDuration('2026-09-01T12:00:00.000Z', null, new Date('2026-09-01T12:30:00.000Z'))).toBe('30m');
    });

    it('renders a dash before the run starts, and for absent or nonsense stamps', () => {
        expect(runDuration(null, null)).toBe('—');
        expect(runDuration('not a date', null)).toBe('—');
        expect(runDuration('2026-09-01T12:04:00.000Z', '2026-09-01T12:00:00.000Z')).toBe('—');
    });
});

describe('wallClock', () => {
    // The task head's clock: everything the board has banked for the task so far, plus the head
    // run's live in-flight segment while it is going. Pure — the caller decides what "now" is.
    it('renders the persisted total', () => {
        expect(wallClock(3_600_000, null)).toBe('1h');
        expect(wallClock(1_800_000, null)).toBe('30m');
    });

    it('renders a dash where nothing has been banked and nothing is going', () => {
        expect(wallClock(null, null)).toBe('—');
    });

    it('adds the live run to the banked total, and ticks a live run alone', () => {
        expect(wallClock(600_000, '2026-09-01T12:00:00.000Z', new Date('2026-09-01T12:05:00.000Z'))).toBe('15m');
        expect(wallClock(null, '2026-09-01T12:00:00.000Z', new Date('2026-09-01T12:30:00.000Z'))).toBe('30m');
    });

    it('a finished run adds nothing, and a nonsense or future start is ignored rather than negative', () => {
        expect(wallClock(600_000, null)).toBe('10m');
        expect(wallClock(600_000, 'not a date')).toBe('10m');
        expect(wallClock(null, '2026-09-01T12:00:00.000Z', new Date('2026-09-01T11:00:00.000Z'))).toBe('—');
    });
});

describe('thread derivations', () => {
    const base = job();
    const withCommand = (command: string, over: Partial<Job> = {}): Job => ({ ...base, command, ...over });
    /** A follow-up of `base`: the chain array is oldest first, so this is the newest run. */
    const followUp = (command: string, over: Partial<Job> = {}): Job => ({
        ...base,
        command,
        id: '44444444-4444-4444-8444-444444444444',
        followUpTo: base.id,
        rootJobId: base.id,
        ...over,
    });

    describe('threadIssue', () => {
        // The driver's publishPlan reads the same reference out of the command to name the branch
        // and close the issue from the PR — the sidebar shows the reader what the task is about.
        it('parses an issues/ URL and a bare #number', () => {
            expect(threadIssue([withCommand('fix https://github.com/o/r/issues/44 please')])).toBe(44);
            expect(threadIssue([withCommand('fix #44 please')])).toBe(44);
        });

        it('parses the /fix command forms — bare number, #number, and a full url after /fix', () => {
            expect(threadIssue([withCommand('/fix 100')])).toBe(100);
            expect(threadIssue([withCommand('/fix #44')])).toBe(44);
            expect(threadIssue([withCommand('/fix https://github.com/o/r/issues/44')])).toBe(44);
        });

        it('does not read an issue from a command that merely looks like /fix', () => {
            expect(threadIssue([withCommand('/fix-a 100')])).toBeNull();
        });

        it('prefers the /fix target over an incidental #mention', () => {
            expect(threadIssue([withCommand('/fix 44 but really #9')])).toBe(44);
        });

        it('rejects lookalike and impossible issue numbers', () => {
            expect(threadIssue([withCommand('/fix 44oops')])).toBeNull();
            expect(threadIssue([withCommand('see #44oops')])).toBeNull();
            expect(threadIssue([withCommand('/fix 0')])).toBeNull();
            expect(threadIssue([withCommand('/fix 99999999999999999999')])).toBeNull();
            expect(threadIssue([withCommand('fix #44.')])).toBe(44);
        });

        it('prefers the issues/ form over a bare #, like the driver does', () => {
            expect(threadIssue([withCommand('see #7, from issues/44')])).toBe(44);
        });

        it('reads the newest run first — the thread is one conversation', () => {
            expect(threadIssue([withCommand('fix #44'), followUp('also mentions #9')])).toBe(9);
        });

        it('answers null when no command names one', () => {
            expect(threadIssue([withCommand('tighten the retry logic')])).toBeNull();
        });
    });

    describe('threadPublish', () => {
        // The driver appends one line to the output when it publishes — the only place the board
        // carries a PR. The sidebar reads it; a structured field would be a follow-up.
        it('parses the published line into the branch and the PR url', () => {
            expect(
                threadPublish([
                    withCommand('x', { output: 'done\n[driver] published fix/44 — https://github.com/o/r/pull/9' }),
                ])
            ).toEqual({ branch: 'fix/44', url: 'https://github.com/o/r/pull/9' });
        });

        it('carries a null url when the publish pushed a branch without a PR', () => {
            expect(threadPublish([withCommand('x', { output: '[driver] published task/20260910' })])).toEqual({
                branch: 'task/20260910',
                url: null,
            });
        });

        it('reads the newest output first', () => {
            const root = withCommand('x', { output: '[driver] published fix/1 — https://github.com/o/r/pull/1' });
            expect(
                threadPublish([
                    root,
                    followUp('y', { output: '[driver] published fix/2 — https://github.com/o/r/pull/2' }),
                ])?.url
            ).toBe('https://github.com/o/r/pull/2');
        });

        it('answers null when nothing was published', () => {
            expect(threadPublish([withCommand('x', { output: 'no publish here' })])).toBeNull();
            expect(threadPublish([withCommand('x', { output: null })])).toBeNull();
        });

        it('ignores a marker the run echoed mid-line, and never links a non-http url', () => {
            // The agent's output is arbitrary text; only a whole line at a line boundary is the
            // driver's, and only an http(s) url may become a href.
            expect(
                threadPublish([withCommand('x', { output: 'the agent said [driver] published fake/1 — not-a-url' })])
            ).toBeNull();
            expect(
                threadPublish([withCommand('x', { output: '[driver] published fix/5 — javascript:alert(1)' })])
            ).toEqual({ branch: 'fix/5', url: 'javascript:alert(1)' });
        });
    });
});

describe('task outcome derivations', () => {
    // The outcome summary's raw material, as pure data — the panel formats, these decide. All
    // read the thread NEWEST first (the chain arrives oldest first), because the newest run is
    // the conversation's present tense.
    const base = job();
    const followUp = (over: Partial<Job> = {}): Job => ({
        ...base,
        id: '44444444-4444-4444-8444-444444444444',
        followUpTo: base.id,
        rootJobId: base.id,
        ...over,
    });

    describe('publicationForRun', () => {
        it('reads one anchored published line from a single row', () => {
            expect(
                publicationForRun({
                    ...base,
                    output: 'done\n[driver] published fix/44 — https://github.com/o/r/pull/9',
                })
            ).toEqual({
                branch: 'fix/44',
                url: 'https://github.com/o/r/pull/9',
            });
        });

        it('keeps a branch with no url, and answers null for a row without output', () => {
            expect(publicationForRun({ ...base, output: '[driver] published task/20260910' })).toEqual({
                branch: 'task/20260910',
                url: null,
            });
            expect(publicationForRun({ ...base, output: null })).toBeNull();
        });

        it('rejects a marker the run echoed mid-line', () => {
            expect(
                publicationForRun({ ...base, output: 'the agent said [driver] published fake/1 — not-a-url' })
            ).toBeNull();
        });
    });

    describe('prNumber', () => {
        it('reads the number a pull url names', () => {
            expect(prNumber('https://github.com/o/r/pull/9')).toBe(9);
            expect(prNumber('https://github.example.com/acme/widgets/pull/177')).toBe(177);
        });

        it('answers null for a url that names no pull request, or an impossible one', () => {
            expect(prNumber('https://github.com/o/r/pulls')).toBeNull();
            expect(prNumber('https://example.com/pr/9')).toBeNull();
            expect(prNumber('https://github.com/o/r/pull/0')).toBeNull();
            expect(prNumber('https://github.com/o/r/pull/99999999999999999999')).toBeNull();
        });
    });

    describe('threadContextTokens', () => {
        it('returns the newest closed turn count, never a sum', () => {
            // A follow-up resumes the same session: the last closed turn's count IS the
            // conversation's final context, and summing per-turn counts double-counts the prefix.
            const jobs = [
                { ...base, runtime: { ...(base.runtime as RuntimeVitals), contextTokens: 1000 } },
                followUp({ runtime: { ...(base.runtime as RuntimeVitals), contextTokens: 3000 } }),
            ];
            expect(threadContextTokens(jobs)).toBe(3000);
        });

        it('skips a running newest turn without a scrape and reads the older closed one', () => {
            const jobs = [
                { ...base, runtime: { ...(base.runtime as RuntimeVitals), contextTokens: 1000 } },
                followUp({ status: 'running', runtime: { ...(base.runtime as RuntimeVitals), contextTokens: null } }),
            ];
            expect(threadContextTokens(jobs)).toBe(1000);
        });

        it('answers null when nothing scraped', () => {
            expect(threadContextTokens([base])).toBeNull();
        });
    });

    describe('threadCostUsd', () => {
        it('sums positive per-turn costs once', () => {
            const jobs = [
                { ...base, runtime: { ...(base.runtime as RuntimeVitals), costUsd: 0.01 } },
                followUp({ runtime: { ...(base.runtime as RuntimeVitals), costUsd: 0.002 } }),
            ];
            expect(threadCostUsd(jobs)).toBe(0.012);
        });

        it('omits absent and zero costs entirely', () => {
            expect(threadCostUsd([base])).toBeNull();
            expect(
                threadCostUsd([{ ...base, runtime: { ...(base.runtime as RuntimeVitals), costUsd: 0 } }])
            ).toBeNull();
        });
    });

    describe('gateCounts', () => {
        it('counts passed, failed and running', () => {
            const gates = [
                { name: 'test', status: 'passed' as const, exitCode: 0, output: null },
                { name: 'lint', status: 'failed' as const, exitCode: 1, output: null },
                { name: 'build', status: 'running' as const, exitCode: null, output: null },
            ];
            expect(gateCounts(gates)).toEqual({ passed: 1, failed: 1, running: 1 });
        });

        it('answers all-zero for nothing declared', () => {
            expect(gateCounts(null)).toEqual({ passed: 0, failed: 0, running: 0 });
        });
    });

    describe('issueUrl', () => {
        it('builds only from a repository an owner/name slug can construct', () => {
            expect(issueUrl('acme/web', 44)).toBe('https://github.com/acme/web/issues/44');
            expect(issueUrl(null, 44)).toBeNull();
            expect(issueUrl('web', 44)).toBeNull();
            expect(issueUrl('acme/web', null)).toBeNull();
        });
    });

    describe('closureOf', () => {
        it('reads the newest run done attribution first', () => {
            expect(
                closureOf([base, followUp({ doneBy: { id: 'u', login: 'kim', name: null, avatarUrl: null } })])
            ).toEqual({
                kind: 'done',
                login: 'kim',
            });
        });

        it('reads a stop as stopped or requested by how the run settled', () => {
            expect(
                closureOf([
                    followUp({ status: 'stopped', stoppedBy: { id: 'u', login: 'kim', name: null, avatarUrl: null } }),
                ])
            ).toEqual({
                kind: 'stopped',
                login: 'kim',
            });
            expect(
                closureOf([followUp({ stoppedBy: { id: 'u', login: 'kim', name: null, avatarUrl: null } })])
            ).toEqual({
                kind: 'stop-requested',
                login: 'kim',
            });
        });

        it('answers null while nobody has closed anything', () => {
            expect(closureOf([base])).toBeNull();
        });
    });

    describe('newestTerminalExit', () => {
        it('reads the newest terminal run exit code, skipping runs without one', () => {
            expect(newestTerminalExit([base, followUp({ exitCode: null })])).toBe(0);
            expect(newestTerminalExit([base, followUp({ exitCode: 2 })])).toBe(2);
        });

        it('answers null while no run has settled', () => {
            expect(newestTerminalExit([followUp({ status: 'running' })])).toBeNull();
        });
    });
});

describe('TaskOutcome', () => {
    it('renders above the conversation in DOM order, as an expanded native disclosure', () => {
        const html = renderDetail({ jobs: [job()] });
        expect(html.indexOf('task-outcome')).toBeGreaterThan(-1);
        expect(html.indexOf('task-outcome')).toBeLessThan(html.indexOf('task-conversation'));
        expect(html).toMatch(/<details[^>]*class="task-outcome[^"]*"[^>]*open/);
        expect(html).toContain('<h2>Outcome</h2>');
        // The conversation names itself too: heading-by-heading navigation has to reach the
        // page's dominant panel, not just the summary beside it.
        expect(html).toMatch(/task-conversation[^>]*"[^>]*>[\s\S]{0,80}?<h2>Conversation<\/h2>/);
    });

    it('shows the current status, the closure attribution and the newest terminal exit', () => {
        const html = renderDetail({
            jobs: [
                job({ status: 'failed', exitCode: 1 }),
                job({
                    id: '22222222-2222-4222-8222-222222222222',
                    status: 'stopped',
                    exitCode: 0,
                    doneBy: { id: 'u', login: 'kim', name: null, avatarUrl: null },
                    stoppedBy: { id: 'u', login: 'lee', name: null, avatarUrl: null },
                }),
            ],
        });
        expect(html).toContain('stopped');
        expect(html).toContain('done by kim');
        expect(html).toContain('stopped by lee');
        expect(html).toContain('exit 0');
    });

    it('names the root author as Started by, unknown when nobody is recorded', () => {
        const author = { id: 'u', login: 'kim', name: 'Kim Doe', avatarUrl: null };
        expect(renderDetail({ jobs: [job({ author })] })).toContain('Started by');
        expect(renderDetail({ jobs: [job({ author })] })).toContain('Kim Doe');
        expect(renderDetail({ jobs: [job()] })).toContain('unknown');
    });

    it('carries the task wall clock under the em-dash convention', () => {
        const banked = renderDetail({ jobs: [job({ taskWallClockMs: 3_600_000 })] });
        expect(banked).toContain('1h');
        const unbanked = renderDetail({ jobs: [job()] });
        expect(unbanked).toContain('Wall clock');
    });

    it('renders repository, worktree, executor — omitting the absent rows', () => {
        const html = renderDetail({
            jobs: [
                job({
                    repo: 'acme/web',
                    workspacePath: 'repos/web',
                    executor: 'main',
                    workflowName: 'fix-issue',
                    workflowNode: 'implement',
                }),
            ],
        });
        expect(html).toContain('Repository');
        expect(html).toContain('acme/web');
        expect(html).toContain('<dt>Worktree</dt><dd>repos/web</dd>');
        expect(html).toContain('Executor');
        expect(html).toContain('main');
        expect(html).toContain('Workflow');
        expect(html).toContain('fix-issue');
        expect(html).toContain('Workflow node');
        expect(html).toContain('implement');

        const bare = renderDetail({ jobs: [job()] });
        expect(bare).not.toContain('Repository');
        expect(bare).not.toContain('Worktree');
        expect(bare).not.toContain('Workflow node');
        expect(bare).not.toContain('fix-issue');
    });

    it('names an absent executor selection explicitly', () => {
        expect(renderDetail({ jobs: [job()] })).toContain('No executor selected');
    });

    it('renders the frozen workflow name and the node as different concepts', () => {
        const html = renderDetail({ jobs: [job({ workflowName: 'fix-issue', workflowNode: 'implement' })] });
        const name = html.indexOf('fix-issue');
        const node = html.indexOf('implement');
        expect(name).toBeGreaterThan(-1);
        expect(node).toBeGreaterThan(-1);
        expect(name).not.toBe(node);
    });

    it('shows thread context and cost, and fabricates neither', () => {
        const measured = renderDetail({
            jobs: [
                job({
                    runtime: {
                        cpuPercent: null,
                        memUsedMb: null,
                        memPercent: null,
                        activity: null,
                        sampledAt: '2026-09-01T12:02:00.000Z',
                        contextTokens: 3000,
                        costUsd: 0.01,
                    },
                }),
            ],
        });
        expect(measured).toContain('3,000 tok');
        expect(measured).toContain('$0.0100');

        const bare = renderDetail({ jobs: [job()] });
        expect(bare).not.toContain('Context');
        expect(bare).not.toContain('Cost');
        expect(bare).not.toContain('0 tok');
        expect(bare).not.toContain('$0.00');
    });

    it('summarizes the NEWEST run gates only, with words carrying the meaning', () => {
        const gates = [
            { name: 'test', status: 'passed' as const, exitCode: 0, output: 'ok' },
            { name: 'lint', status: 'failed' as const, exitCode: 1, output: 'bad' },
            { name: 'build', status: 'running' as const, exitCode: null, output: null },
        ];
        const html = renderDetail({
            jobs: [job({ gates }), job({ id: '44444444-4444-4444-8444-444444444444', gates: null })],
        });
        expect(html).not.toContain('View checks');
        const counted = renderDetail({ jobs: [job({ gates })] });
        expect(counted).toContain('1 passed');
        expect(counted).toContain('1 failed');
        expect(counted).toContain('1 running');
        // Gate output stays on the run — the outcome's own slice never duplicates it.
        const outcome = counted.slice(counted.indexOf('task-outcome'), counted.indexOf('task-conversation'));
        expect(outcome).not.toContain('ok');
    });

    it('renders the published branch code-styled, linking only a safe url', () => {
        const linked = renderDetail({
            jobs: [job({ output: '[driver] published fix/44 — https://github.com/o/r/pull/9' })],
        });
        expect(linked).toContain('<code>fix/44</code>');
        // The link is a reference, not a command: the outcome's labeled row carries just the
        // number, the run's label-less publication line carries the full name.
        const outcome = linked.slice(linked.indexOf('task-outcome'), linked.indexOf('task-conversation'));
        expect(outcome).toContain('>#9</a>');
        expect(linked).toContain('Pull request #9');
        expect(linked).not.toContain('Open pull request');
        expect(linked).toContain('rel="noopener noreferrer"');
        expect(linked).not.toContain('PR state');

        const unsafe = renderDetail({
            jobs: [job({ output: '[driver] published fix/5 — javascript:alert(1)' })],
        });
        expect(unsafe).toContain('<code>fix/5</code>');
        expect(unsafe).not.toContain('<a href="javascript:');
    });

    it('links a publish url that names no number as Pull request, never a CTA verbatim', () => {
        const html = renderDetail({
            jobs: [job({ output: '[driver] published fix/6 — https://github.com/o/r/compare/main...fix/6' })],
        });
        expect(html).toContain('<a href="https://github.com/o/r/compare/main...fix/6"');
        expect(html).toContain('>Pull request</a>');
        expect(html).not.toContain('Pull request #');
        expect(html).not.toContain('Open pull request');
    });

    it('shows a branch without a url as the branch alone', () => {
        const html = renderDetail({ jobs: [job({ output: '[driver] published task/20260910' })] });
        expect(html).toContain('<code>task/20260910</code>');
        expect(html).not.toContain('Pull request');
    });

    it('links the issue only when the repository makes the url constructible', () => {
        const linked = renderDetail({ jobs: [job({ repo: 'acme/web', command: 'fix #44 please' })] });
        expect(linked).not.toContain('Open issue');
        expect(linked).toContain('href="https://github.com/acme/web/issues/44"');
        expect(linked).toContain('>#44</a>');
        const unlinked = renderDetail({ jobs: [job({ command: 'fix #44 please' })] });
        expect(unlinked).not.toContain('Open issue');
        expect(unlinked).toContain('#44');
    });

    it('renders the newest attempt services as last-reported states, collapsing past three', () => {
        const services = [
            { name: 'timescale', image: 'timescale', state: 'running' },
            { name: 'api', image: 'api', state: 'exited' },
            { name: 'web', image: 'web', state: 'running' },
        ];
        const html = renderDetail({
            jobs: [
                job({
                    runtime: {
                        cpuPercent: null,
                        memUsedMb: null,
                        memPercent: null,
                        activity: null,
                        sampledAt: '2026-09-01T12:02:00.000Z',
                        services,
                    },
                }),
            ],
        });
        expect(html).toContain('timescale');
        expect(html).toContain('exited');
        const more = renderDetail({
            jobs: [
                job({
                    runtime: {
                        cpuPercent: null,
                        memUsedMb: null,
                        memPercent: null,
                        activity: null,
                        sampledAt: '2026-09-01T12:02:00.000Z',
                        services: [...services, { name: 'db2', image: 'db2', state: 'running' }],
                    },
                }),
            ],
        });
        expect(more).toContain('and 1 more');
        // An older attempt's fleet is long gone — the outcome reads the newest attempt only.
        const stale = renderDetail({
            jobs: [
                job({
                    runtime: {
                        cpuPercent: null,
                        memUsedMb: null,
                        memPercent: null,
                        activity: null,
                        sampledAt: '2026-09-01T12:02:00.000Z',
                        services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
                    },
                }),
                job({ id: '22222222-2222-4222-8222-222222222222' }),
            ],
        });
        expect(stale).not.toContain('Services');
        expect(stale).not.toContain('<dt>db</dt>');
        expect(renderDetail({ jobs: [job()] })).not.toContain('Services');
    });

    it('never emits placeholder values anywhere in the outcome', () => {
        const html = renderDetail({
            jobs: [
                job({
                    author: { id: 'u', login: 'kim', name: null, avatarUrl: null },
                    gates: [{ name: 'test', status: 'passed', exitCode: 0, output: null }],
                    output: '[driver] published fix/44 — https://github.com/o/r/pull/9',
                    runtime: {
                        cpuPercent: null,
                        memUsedMb: null,
                        memPercent: null,
                        activity: null,
                        sampledAt: '2026-09-01T12:02:00.000Z',
                        contextTokens: 100,
                        costUsd: 0.5,
                    },
                    workflowName: 'fix-issue',
                    workflowNode: 'implement',
                    repo: 'acme/web',
                    workspacePath: 'repos/web',
                }),
            ],
        });
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});

describe('TaskRun', () => {
    const root = job({ command: 'first command' });
    const child = (over: Partial<Job> = {}): Job => ({
        ...job(),
        id: '44444444-4444-4444-8444-444444444444',
        followUpTo: root.id,
        rootJobId: root.id,
        command: 'second command',
        ...over,
    });
    /** One run's article slice — the markup between its marker and its close. */
    const articleOf = (html: string, marker: string): string => {
        const start = html.indexOf(marker);
        return html.slice(start, html.indexOf('</article>', start));
    };
    const runtime = (over: Partial<RuntimeVitals> = {}): RuntimeVitals => ({
        cpuPercent: null,
        memUsedMb: null,
        memPercent: null,
        activity: null,
        sampledAt: '2026-09-01T12:02:00.000Z',
        ...over,
    });

    it('labels the root run Request and every later run Follow-up, oldest first', () => {
        const html = renderDetail({ jobs: [root, child()] });
        expect(html.indexOf('>Request<')).toBeGreaterThan(-1);
        expect(html.indexOf('>Request<')).toBeLessThan(html.indexOf('>Follow-up<'));
        expect(html.match(/<article/g)?.length).toBe(2);
    });

    it('a running run with activity reads the activity sentence, not a verdict', () => {
        const html = articleOf(
            renderDetail({ jobs: [job({ status: 'running', runtime: runtime({ activity: '→ Bash npm test' }) })] }),
            'Agent activity'
        );
        expect(html).toContain('→ Bash npm test');
    });

    it('a running run with output renders it live and bounded, after the activity', () => {
        const html = articleOf(
            renderDetail({
                jobs: [
                    job({
                        status: 'running',
                        runtime: runtime({ activity: 'reading logs' }),
                        output: 'tail line\nnewer tail line',
                    }),
                ],
            }),
            'Agent activity'
        );
        expect(html).toContain('<pre class="chat-output"');
        expect(html).toContain('newer tail line');
        expect(html.indexOf('reading logs')).toBeLessThan(html.indexOf('<pre'));
    });

    it('a queued or running run without output is waiting for the executor', () => {
        expect(renderDetail({ jobs: [job({ status: 'queued', startedAt: null, finishedAt: null })] })).toContain(
            'Waiting for the executor…'
        );
        expect(renderDetail({ jobs: [job({ status: 'running', output: null })] })).toContain(
            'Waiting for the executor…'
        );
    });

    it('a terminal run renders its stored summary as flowing prose, the primary response', () => {
        const html = articleOf(renderDetail({ jobs: [job({ summary: 'Fixed the login retry.' })] }), 'Agent response');
        expect(html).toContain('run-summary');
        expect(html).toContain('Fixed the login retry.');
        expect(html).not.toContain('<pre');
    });

    it('a terminal run with summary and output shows the summary first, output collapsed', () => {
        const html = articleOf(
            renderDetail({ jobs: [job({ summary: 'Fixed the login retry.', output: 'raw lines' })] }),
            'Agent response'
        );
        expect(html.indexOf('Fixed the login retry.')).toBeLessThan(html.indexOf('View raw output'));
        const output = html.slice(html.indexOf('<details'));
        expect(output).toContain('run-output');
        expect(output).not.toMatch(/<details[^>]*open/);
    });

    it('a terminal run without a summary says so, and shows its output expanded', () => {
        const html = articleOf(renderDetail({ jobs: [job({ output: 'raw lines' })] }), 'Agent response');
        expect(html).toContain('No agent summary was captured.');
        expect(html.slice(html.indexOf('No agent summary'))).toMatch(/<details[^>]*open/);
        expect(html).toContain('raw lines');
    });

    it('a terminal run with neither summary nor output carries the explanatory copy', () => {
        expect(renderDetail({ jobs: [job({ output: null })] })).toContain(
            'This run finished without a captured agent response. Check its exit status and checks below.'
        );
    });

    it('keeps gates attached to the run that produced them', () => {
        const gates = [{ name: 'test', status: 'passed' as const, exitCode: 0, output: 'ok' }];
        const html = renderDetail({ jobs: [{ ...root, gates }, child()] });
        expect(articleOf(html, 'first command')).toContain('chat-gates');
        expect(articleOf(html, 'second command')).not.toContain('chat-gates');
    });

    it('renders the per-run publication beside its run checks, under a stable anchor', () => {
        const html = renderDetail({
            jobs: [
                job({ gates: [{ name: 'test', status: 'passed' as const, exitCode: 0, output: 'ok' }] }),
                child({ output: '[driver] published fix/2 — https://github.com/o/r/pull/2' }),
            ],
        });
        const second = articleOf(html, 'second command');
        expect(second).toContain('id="run-2-checks"');
        expect(second).toContain('tabindex="-1"');
        expect(second).toContain('run-publish');
        expect(second).toContain('<code>fix/2</code>');
        // The run's publication line has no label of its own, so the link says what it is.
        expect(second).toContain('Pull request #2');
        expect(second).toContain('<a href="https://github.com/o/r/pull/2"');
    });

    it('the outcome links View checks in run N only when the newest run has gates', () => {
        const gates = [{ name: 'test', status: 'passed' as const, exitCode: 0, output: 'ok' }];
        const linked = renderDetail({ jobs: [job({ gates })] });
        expect(linked).toContain('View checks in run 1');
        expect(linked).toContain('href="#run-1-checks"');
        expect(renderDetail({ jobs: [job(), child()] })).not.toContain('View checks');
    });

    it('metadata follows the work in markup order, and omits what the run does not carry', () => {
        const gates = [{ name: 'test', status: 'passed' as const, exitCode: 0, output: 'ok' }];
        const html = renderDetail({
            jobs: [
                job({
                    executor: 'main',
                    workflowName: 'fix-issue',
                    workflowNode: 'implement',
                    gates,
                    runtime: runtime({ contextTokens: 3000, costUsd: 0.01 }),
                }),
            ],
        });
        const article = articleOf(html, 'fix the flaky login test');
        const workAt = article.indexOf('run-work');
        const metaAt = article.indexOf('msg-meta', workAt);
        expect(workAt).toBeGreaterThan(-1);
        expect(metaAt).toBeGreaterThan(workAt);
        expect(article).toContain('workflow fix-issue');
        expect(article).toContain('node implement');
        expect(article).toContain('4m');
        expect(article).toContain('exit 0');
        expect(article).toContain('ctx 3,000 tok');
        expect(article).toContain('$0.0100');

        const bare = articleOf(renderDetail({ jobs: [job()] }), 'first command');
        expect(bare).not.toContain('workflow');
        expect(bare).not.toContain('node ');
        expect(bare).not.toContain('ctx');
    });

    it('carries the stop and done attributions, and the parked marker, in the footer', () => {
        const stopped = articleOf(
            renderDetail({
                jobs: [job({ status: 'stopped', stoppedBy: { id: 'u', login: 'lee', name: null, avatarUrl: null } })],
            }),
            'fix the flaky login test'
        );
        expect(stopped).toContain('stopped by lee');
        const requested = articleOf(
            renderDetail({
                jobs: [job({ status: 'running', stoppedBy: { id: 'u', login: 'lee', name: null, avatarUrl: null } })],
            }),
            'fix the flaky login test'
        );
        expect(requested).toContain('stop requested by lee');
        const done = articleOf(
            renderDetail({ jobs: [job({ doneBy: { id: 'u', login: 'kim', name: null, avatarUrl: null } })] }),
            'fix the flaky login test'
        );
        expect(done).toContain('done by kim');
        expect(articleOf(renderDetail({ jobs: [job({ status: 'standby' })] }), 'fix the flaky login test')).toContain(
            'parked'
        );
    });

    it('renders the prompt as prose with preserved line breaks, never as mono code', () => {
        const html = renderDetail({ jobs: [job({ command: 'line one\nline two' })] });
        const article = articleOf(html, 'msg-user');
        expect(article).toContain('msg-user');
        expect(article).not.toContain('<pre');
        expect(article).toContain('line two');
    });

    it('keeps summary and output as untrusted text', () => {
        const html = renderDetail({
            jobs: [job({ summary: '**bold** and <script>alert(1)</script>', output: '<script>alert(1)</script>' })],
        });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('output wells are keyboard scrollable, and the live well carries a label', () => {
        // A clipped well nobody can focus is a log nobody can read: the pre itself is the
        // focusable scroll target, and the live one — whose only visible label sits above it —
        // is named by its wrapping region.
        const live = renderDetail({
            jobs: [job({ status: 'running', output: 'tail', runtime: runtime({ activity: 'working' }) })],
        });
        expect(live).toMatch(/<section[^>]*class="run-well"[^>]*aria-label="Raw output"[^>]*>\s*<pre[^>]*tabindex="0"/);

        const finished = articleOf(
            renderDetail({
                jobs: [
                    job({
                        output: 'raw lines',
                        gates: [{ name: 'test', status: 'passed', exitCode: 0, output: 'gate log' }],
                    }),
                ],
            }),
            'Agent response'
        );
        expect(finished).toContain('tabindex="0"');
        expect(finished.match(/tabindex="0"/g)?.length).toBe(2);
    });
});

describe('follow-up composer', () => {
    it('labels the composer Ask for a follow-up, with its helper and the shortcut visible', () => {
        const html = renderDetail({ jobs: [job()] });
        expect(html).toContain('Ask for a follow-up');
        expect(html).toContain('The agent continues the same task, checkout, executor, and session.');
        expect(html).toContain('Ctrl/⌘ + Enter');
        expect(html).toMatch(/<label[^>]*for="follow-up-command"/);
        expect(html).toContain('id="follow-up-command"');
    });

    it('carries the placeholder and the send copy, including the sending state', () => {
        expect(renderDetail({ jobs: [job()] })).toContain('Describe the adjustment…');
        expect(renderDetail({ jobs: [job()] })).toContain('Send follow-up');
        expect(renderDetail({ jobs: [job()], sending: true })).toContain('Sending…');
    });

    it('a terminal open sessionless run explains itself and links Start a new task', () => {
        const html = renderDetail({ jobs: [job({ sessionId: null })] });
        expect(html).toContain('no agent session to continue');
        expect(html).toContain('href="/tasks/new"');
        expect(html).toContain('Start a new task');
        expect(html).not.toContain('Ask for a follow-up');
    });

    it('a closed task renders no composer and no sessionless note', () => {
        const html = renderDetail({ jobs: [job({ doneAt: '2026-09-01T13:00:00.000Z' })] });
        expect(html).not.toContain('Ask for a follow-up');
        expect(html).not.toContain('no agent session to continue');
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
        expect(html).toContain('>Default workflow</button>');
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
        const html = renderFields([plain], { notes: 'x'.repeat(513) }, { notes: true });
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

describe('composer params are scoped to the chosen workflow identity', () => {
    // The review's leak: `#12` typed for one workflow stays valid when a repo switch refetches
    // the list and a DIFFERENT same-named definition resolves — zero select interactions — and
    // Send launches the other process with the first one's issue. Values are stored against the
    // identity of the workflow they were typed for, and read back only while it is still chosen.
    const issue: WorkflowParamChoice = { name: 'issue', pattern: '#\\d+' };

    it('hands values back only while the workflow they were typed for is still chosen', () => {
        const stored = { workflowId: 'wf-repo-a', values: { issue: '#12' } };
        expect(valuesForWorkflow(stored, 'wf-repo-a')).toEqual({ issue: '#12' });
        // Repo B's same-named definition is a DIFFERENT row: the typed value must vanish from
        // the inputs and from the Send gate alike.
        expect(valuesForWorkflow(stored, 'wf-repo-b')).toEqual({});
        expect(paramsComplete([issue], valuesForWorkflow(stored, 'wf-repo-b'))).toBe(false);
    });

    it('answers empty when nothing is chosen, and stores nothing before any workflow is', () => {
        const stored = { workflowId: 'wf-1', values: { issue: '#12' } };
        expect(valuesForWorkflow(stored, null)).toEqual({});
        // The mount state: no workflow has ever been chosen, so nothing can leak anywhere.
        expect(valuesForWorkflow({ workflowId: null, values: {} }, 'wf-1')).toEqual({});
    });
});

describe('composer workflow draft resets on a repository change', () => {
    // The review's window: `useWorkflows` keeps the previous list while the new repository's
    // request is pending, the page hands that stale list straight through, and the chosen
    // workflow and its typed values survive the switch — Send can put repo A's workflow name and
    // A-typed values into a task stamped with repo B. The reset is keyed to the composer's own
    // repo state, so it covers every path a change arrives by: the member's select, the
    // autoselect, the clamp. Effects never run under renderToStaticMarkup, so what pins offline
    // is the exact state the reset leaves behind — the state Send reads through, with the stale
    // list's default still effective, which is exactly what is effective while the window is open.
    const issue: WorkflowParamChoice = { name: 'issue', pattern: '#\\d+' };

    it('resets to the mount shape — unchosen workflow, no stored values, no touched fields, no default-step overrides — so the mount run is a no-op', () => {
        expect(freshWorkflowDraft()).toEqual({
            workflow: '',
            storedParams: { workflowId: null, values: {} },
            paramTouched: {},
            defaultStepOverrides: {},
        });
    });

    it('sends no workflow name and hands no values back for whatever the stale list still declares', () => {
        const reset = freshWorkflowDraft();
        // An empty choice travels as null: the board resolves its default for the NEW repository.
        expect(reset.workflow).toBe('');
        // The values typed against the old list are gone for ANY effective id; with them gone, a
        // workflow that declares params leaves Send dark — the member picks again and retypes.
        expect(valuesForWorkflow(reset.storedParams, 'wf-stale-default')).toEqual({});
        expect(paramsComplete([issue], valuesForWorkflow(reset.storedParams, 'wf-stale-default'))).toBe(false);
    });
});

describe('effectiveWorkflows', () => {
    // A name is unique per SCOPE only, so the visible list can hold the same name at several
    // scopes. The Listbox row a member clicks must be the definition the launch resolves, and
    // `chosenWorkflow` resolves a name with the board's repo-over-user-over-org precedence — so
    // the options carry one row per effective name, at the winning scope.
    const choice = (id: string, scope: 'org' | 'user' | 'repo') => ({ id, name: 'fix-issue', scope });

    it('collapses a name offered at several scopes to its repo-scoped definition', () => {
        const list = [choice('w-org', 'org'), choice('w-user', 'user'), choice('w-repo', 'repo')];
        expect(effectiveWorkflows(list)).toEqual([choice('w-repo', 'repo')]);
    });

    it('keeps each name at its own scope when the scopes differ', () => {
        const list = [
            { id: 'w1', name: 'fix-issue', scope: 'repo' as const },
            { id: 'w2', name: 'triage', scope: 'org' as const },
        ];
        expect(effectiveWorkflows(list)).toEqual(list);
    });

    it('falls through to user, then org, when no higher scope offers the name', () => {
        expect(effectiveWorkflows([choice('w-org', 'org'), choice('w-user', 'user')])).toEqual([
            choice('w-user', 'user'),
        ]);
        expect(effectiveWorkflows([choice('w-org', 'org'), choice('w-org2', 'org')])).toEqual([choice('w-org', 'org')]);
    });

    it('emits the winners in the order the list offered their names', () => {
        const list = [
            { id: 'w1', name: 'triage', scope: 'org' as const },
            { id: 'w2', name: 'fix-issue', scope: 'org' as const },
            { id: 'w3', name: 'fix-issue', scope: 'repo' as const },
        ];
        expect(effectiveWorkflows(list).map((c) => c.id)).toEqual(['w1', 'w3']);
    });
});

describe('humanizeParamName', () => {
    // The fallback label: an identifier a prompt author wrote for the machine, said in words the
    // composer can show a member.
    it('splits on separators and capitalizes each word', () => {
        expect(humanizeParamName('issue')).toBe('Issue');
        expect(humanizeParamName('issue_number')).toBe('Issue number');
        expect(humanizeParamName('bug-url')).toBe('Bug url');
        expect(humanizeParamName('pr_title_prefix')).toBe('Pr title prefix');
    });
});

describe('paramFieldVerdict — the per-field plain-language state', () => {
    const issue: WorkflowParamChoice = { name: 'issue', pattern: '#\\d+' };
    const guided: WorkflowParamChoice = { name: 'issue', pattern: '#\\d+', description: 'Reference the issue.' };

    it('answers ok with no message for a value the board would accept', () => {
        expect(paramFieldVerdict(issue, ' #12 ', true)).toEqual({ kind: 'ok', message: null });
        expect(paramFieldVerdict({ name: 'notes' }, 'anything', false)).toEqual({ kind: 'ok', message: null });
    });

    it('says Required on an untouched empty field — a hint, not a failure', () => {
        expect(paramFieldVerdict(issue, undefined, false)).toEqual({ kind: 'untouched', message: null });
        expect(paramFieldVerdict(issue, '   ', false)).toEqual({ kind: 'untouched', message: null });
    });

    it('names a touched empty field as required, by its humanized label', () => {
        expect(paramFieldVerdict(issue, undefined, true)).toEqual({ kind: 'required', message: 'Issue is required.' });
        expect(paramFieldVerdict({ name: 'pr_title' }, '', true)).toEqual({
            kind: 'required',
            message: 'Pr title is required.',
        });
    });

    it('bounds the value at the length the board enforces', () => {
        expect(paramFieldVerdict(issue, 'x'.repeat(513), false).kind).toBe('too-long');
        expect(paramFieldVerdict(issue, 'x'.repeat(513), false).message).toBe('Issue must be 512 characters or fewer.');
        expect(paramFieldVerdict(issue, 'x'.repeat(512), false).kind).not.toBe('too-long');
    });

    it('reuses the author guidance as the mismatch error when the author wrote any', () => {
        expect(paramFieldVerdict(guided, 'nope', true)).toEqual({ kind: 'mismatch', message: 'Reference the issue.' });
    });

    it('falls back to plain-language mismatch copy that names the Format details', () => {
        expect(paramFieldVerdict(issue, 'nope', true)).toEqual({
            kind: 'mismatch',
            message: 'Issue does not match the required format. Open Format details for the technical rule.',
        });
    });

    it('blames the stored rule when the pattern itself cannot compile', () => {
        const verdict = paramFieldVerdict({ name: 'issue', pattern: '[' }, 'x', true);
        expect(verdict.kind).toBe('uncompilable');
        expect(verdict.message).toBe(
            "This workflow's format rule could not be checked. Ask an administrator to fix the workflow."
        );
    });

    it('never shows regex syntax in a message', () => {
        for (const value of [undefined, '', 'x'.repeat(513), 'nope']) {
            for (const touched of [false, true]) {
                const { message } = paramFieldVerdict(issue, value, touched);
                expect(message ?? '').not.toMatch(/\\d|\(\?:/);
            }
        }
    });

    it('agrees with the Send gate: every non-ok, non-untouched verdict is a value paramsComplete refuses', () => {
        const params = [issue, { name: 'notes' }];
        const values: Record<string, string> = { issue: '#12', notes: 'ok' };
        expect(paramsComplete(params, values)).toBe(true);
        for (const name of ['issue', 'notes'] as const) {
            for (const value of [undefined, '', '   ', 'x'.repeat(513), 'not matching']) {
                const verdict = paramFieldVerdict(params.find((param) => param.name === name)!, value, true);
                const broken = { ...values, [name]: value ?? '' };
                expect(verdict.kind === 'ok' || verdict.kind === 'untouched').toBe(paramsComplete(params, broken));
            }
        }
    });
});

describe('preflightSentence — what will actually run, before it runs', () => {
    it('says the repository, the executor and the workflow by their actual names', () => {
        expect(preflightSentence({ repo: 'acme/web', executor: 'main', workflow: 'fix-issue' })).toBe(
            'Will run in acme/web using main executor, with the fix-issue workflow.'
        );
    });

    it('says the prompt runs as written when no workflow is chosen', () => {
        expect(preflightSentence({ repo: 'acme/web', executor: 'main', workflow: null })).toBe(
            'Will run in acme/web using main executor. Your prompt will run as written.'
        );
    });

    it('states when execution is blocked on configuring an executor', () => {
        expect(preflightSentence({ repo: null, executor: null, workflow: null })).toBe(
            'Will run without a repository after you configure an executor. Your prompt will run as written.'
        );
        expect(preflightSentence({ repo: null, executor: 'heavy', workflow: 'triage' })).toBe(
            'Will run without a repository using heavy executor, with the triage workflow.'
        );
    });

    it('lists the final default-workflow step set once the saved settings have answered (#208)', () => {
        expect(
            preflightSentence({
                repo: 'acme/web',
                executor: 'main',
                workflow: null,
                defaultSteps: { reviewReconciliation: true, mergeConflictAutofix: false },
            })
        ).toBe(
            'Will run in acme/web using main executor. Will run the default workflow: prompt, gates, publish, plus iterate on PR review comments.'
        );
    });

    it('keeps the old raw-prompt sentence while the default-workflow settings have not answered yet', () => {
        // defaultSteps omitted entirely — the option existed before #208 and stays true today:
        // an unresolved default-workflow choice still runs the raw prompt at the wire.
        expect(preflightSentence({ repo: 'acme/web', executor: 'main', workflow: null })).toBe(
            'Will run in acme/web using main executor. Your prompt will run as written.'
        );
    });
});

describe('DefaultWorkflowSteps — the effective set, its toggle, and its summary (#208)', () => {
    const bothOn = { reviewReconciliation: true, mergeConflictAutofix: true };
    const bothOff = { reviewReconciliation: false, mergeConflictAutofix: false };

    it('answers null before the saved settings have loaded', () => {
        expect(effectiveDefaultSteps(null, {})).toBeNull();
    });

    it('reads the saved value straight through with no override', () => {
        expect(effectiveDefaultSteps(bothOn, {})).toEqual(bothOn);
        expect(effectiveDefaultSteps(bothOff, {})).toEqual(bothOff);
    });

    it('lets an explicit override invert either field independently, in either direction', () => {
        expect(effectiveDefaultSteps(bothOn, { reviewReconciliation: false })).toEqual({
            reviewReconciliation: false,
            mergeConflictAutofix: true,
        });
        expect(effectiveDefaultSteps(bothOff, { mergeConflictAutofix: true })).toEqual({
            reviewReconciliation: false,
            mergeConflictAutofix: true,
        });
    });

    it('toggles one field from its EFFECTIVE value, landing back on an explicit choice, not absence', () => {
        let overrides = toggleDefaultStep({}, 'reviewReconciliation', bothOn);
        expect(effectiveDefaultSteps(bothOn, overrides)).toEqual({
            reviewReconciliation: false,
            mergeConflictAutofix: true,
        });
        overrides = toggleDefaultStep(overrides, 'reviewReconciliation', bothOn);
        expect(effectiveDefaultSteps(bothOn, overrides)).toEqual(bothOn);
    });

    it('leaves the untouched field alone when the other toggles', () => {
        const overrides = toggleDefaultStep({}, 'mergeConflictAutofix', bothOn);
        expect(overrides).toEqual({ mergeConflictAutofix: false });
    });

    it('sends the default-workflow pair only when Default workflow is chosen', () => {
        expect(defaultWorkflowPayload('', bothOn)).toEqual(bothOn);
        expect(defaultWorkflowPayload('fix-issue', bothOn)).toBeNull();
        expect(defaultWorkflowPayload('', null)).toBeNull();
    });

    it('summarizes the final step set, omitting steps that are off', () => {
        expect(defaultWorkflowStepSummary(bothOn)).toBe(
            'prompt, gates, publish, plus iterate on PR review comments and repair merge conflicts'
        );
        expect(defaultWorkflowStepSummary(bothOff)).toBe('prompt, gates, publish');
        expect(defaultWorkflowStepSummary({ reviewReconciliation: true, mergeConflictAutofix: false })).toBe(
            'prompt, gates, publish, plus iterate on PR review comments'
        );
        expect(defaultWorkflowStepSummary({ reviewReconciliation: false, mergeConflictAutofix: true })).toBe(
            'prompt, gates, publish, plus repair merge conflicts'
        );
    });
});

describe('startBlocker — the one reason Start is dark, in precedence order', () => {
    it('answers null only when nothing blocks the launch', () => {
        expect(
            startBlocker({ sending: false, executorMissing: false, promptEmpty: false, paramsInvalid: false })
        ).toBeNull();
    });

    it('puts the in-flight queue first, so a second click cannot double-send', () => {
        expect(startBlocker({ sending: true, executorMissing: true, promptEmpty: true, paramsInvalid: true })).toBe(
            'in-flight'
        );
    });

    it('requires an executor before the prompt and workflow details', () => {
        expect(startBlocker({ sending: false, executorMissing: true, promptEmpty: true, paramsInvalid: true })).toBe(
            'missing-executor'
        );
        expect(startBlocker({ sending: false, executorMissing: false, promptEmpty: true, paramsInvalid: true })).toBe(
            'empty-prompt'
        );
        expect(startBlocker({ sending: false, executorMissing: false, promptEmpty: false, paramsInvalid: true })).toBe(
            'invalid-params'
        );
    });
});

describe('the parameter touched-state model', () => {
    it('marks one field touched without disturbing the others', () => {
        expect(markTouched({}, 'issue')).toEqual({ issue: true });
        expect(markTouched({ notes: true }, 'issue')).toEqual({ notes: true, issue: true });
    });

    it('marks every field touched at once, for an invalid keyboard submission', () => {
        expect(touchAll(['issue', 'notes'])).toEqual({ issue: true, notes: true });
        expect(touchAll([])).toEqual({});
    });
});

// ---------------------------------------------------------------------------
// The task inbox at /tasks (#158): rows, page states, URL filters. The page
// reads the published context through `useTasksPage`, so the harness mounts it
// under an Outlet context carrying the poll fake and a workspace fake — the
// same two-level shape the shell and the layout publish in the real tree.
// ---------------------------------------------------------------------------

import { Outlet, MemoryRouter, Route, Routes } from 'react-router-dom';
import type { TaskNavigation, UseTasks } from '../src/api/useTasks.js';
import { TaskInboxPage } from '../src/pages/TaskInboxPage.js';

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
