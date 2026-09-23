import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { Job } from '../src/api/useJobs.js';
import { TaskComposer } from '../src/panels/TaskComposer.js';
import { TaskDetail } from '../src/panels/TaskDetail.js';
import { TaskHeader } from '../src/panels/TaskHeader.js';
import type { WorkflowParamChoice } from '../src/task-composer.js';

/**
 * The same contract the other panel suites pin: props in, markup out, and no DOM — `useEffect`
 * never runs under renderToStaticMarkup, so the hooks are exercised by the pages that own them and
 * this suite exercises what the reader actually sees.
 */
export const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

export function job(overrides: Partial<Job> = {}): Job {
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
        waitReason: null,
        waitingSince: null,
        waitTerminalReason: null,
        ...overrides,
    };
}

export interface ComposerArgs {
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

export const renderComposer = ({
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

export interface DetailArgs {
    /** One task or a whole follow-up chain — the page hands the polled thread over as-is. */
    jobs?: Job[] | null;
    error?: string | null;
    actionError?: string | null;
    sending?: boolean;
}

export const renderDetail = ({ jobs = [job()], error = null, actionError = null, sending = false }: DetailArgs = {}) =>
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

export interface HeaderArgs {
    jobs?: Job[] | null;
    stoppingId?: string | null;
    doneId?: string | null;
}

export const renderHeader = ({ jobs = [job()], stoppingId = null, doneId = null }: HeaderArgs = {}) =>
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
