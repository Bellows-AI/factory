import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isTerminal, type Job } from '../src/api/useJobs.js';
import { taskTime } from '../src/format.js';
import { TaskComposer } from '../src/panels/TaskComposer.js';
import { TaskDetail } from '../src/panels/TaskDetail.js';

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
        exitCode: 0,
        output: null,
        repo: null,
        executor: null,
        followUpTo: null,
        doneAt: null,
        createdAt: '2026-09-01T12:00:00.000Z',
        startedAt: '2026-09-01T12:00:01.000Z',
        finishedAt: '2026-09-01T12:04:00.000Z',
        sessionId: null,
        remoteSessionId: null,
        ...overrides,
    };
}

interface ComposerArgs {
    repos?: { owner: string; name: string }[] | null;
    workspaceError?: string | null;
    executors?: { name: string; type: string }[];
    actionError?: string | null;
    sending?: boolean;
}

const renderComposer = ({
    repos = [{ owner: 'acme', name: 'web' }],
    workspaceError = null,
    executors = [],
    actionError = null,
    sending = false,
}: ComposerArgs = {}) =>
    renderToStaticMarkup(
        <TaskComposer
            repos={repos}
            workspaceError={workspaceError}
            onRetryWorkspace={() => {}}
            executors={executors}
            actionError={actionError}
            sending={sending}
            onSend={async () => null}
        />,
    );

interface DetailArgs {
    task?: Job | null;
    error?: string | null;
    executors?: { name: string; type: string }[];
    actionError?: string | null;
    sending?: boolean;
}

const renderDetail = ({
    task = job(),
    error = null,
    executors = [],
    actionError = null,
    sending = false,
}: DetailArgs = {}) =>
    renderToStaticMarkup(
        <TaskDetail
            task={task}
            error={error}
            executors={executors}
            actionError={actionError}
            sending={sending}
            onFollowUp={async () => null}
            onResume={async () => {}}
            onDone={async () => {}}
        />,
    );

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

    it('offers one repository option per selection plus none, none by default', () => {
        // The tabs are gone; the composer stamps the task with a repo instead, and the default is
        // no repository at all — the old All tab's exact semantics.
        const html = renderComposer({
            repos: [
                { owner: 'acme', name: 'web' },
                { owner: 'acme', name: 'api' },
            ],
        });
        expect(html).toContain('<option value="acme/web">');
        expect(html).toContain('<option value="acme/api">');
        expect(html).toContain('<option value="" selected');
    });

    it('keeps the composer reachable when no repository is selected', () => {
        // A member with nothing picked can still queue: the task simply carries no repo.
        const html = renderComposer({ repos: [] });
        expect(html).toContain('<textarea');
        expect(html).toContain('>Send<');
    });

    it('disables Send until a command is typed', () => {
        // The composer starts empty, which is exactly the state a fresh render has.
        const html = renderComposer({});
        const send = html.slice(html.indexOf('>Send<') - 200, html.indexOf('>Send<'));
        expect(send).toContain('disabled');
    });

    it('shows the board\'s refusal in place', () => {
        const html = renderComposer({ actionError: 'Could not queue the task (503)' });
        expect(html).toContain('Could not queue the task (503)');
    });

    it('never emits a placeholder value', () => {
        const html = renderComposer({
            repos: [{ owner: 'acme', name: 'web' }],
            executors: [{ name: 'main', type: 'claude' }],
            actionError: null,
        });
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});

describe('TaskDetail', () => {
    it('shows the command, status, executor and stamp of the task', () => {
        const html = renderDetail({ task: job({ executor: 'main' }) });
        expect(html).toContain('fix the flaky login test');
        expect(html).toContain('succeeded');
        expect(html).toContain('main');
        expect(html).toContain('2026-09-01 12:00');
    });

    it('renders the output as text, never as markup', () => {
        const html = renderDetail({ task: job({ output: '<script>alert(1)</script>' }) });
        // Container output is arbitrary text; escaping it is the difference between a transcript
        // and a hole.
        expect(html).toContain('&lt;script&gt;');
        expect(html).not.toContain('<script>');
        expect(html).toContain('<pre');
    });

    it('claims nothing about a task or output that has not loaded', () => {
        // A finished task whose detail has not arrived must not read as one with no output —
        // that is a false statement about a run somebody is waiting on.
        expect(renderDetail({ task: null })).toMatch(/Loading the task/);
        const waiting = renderDetail({ task: job({ status: 'running', output: null, exitCode: null, finishedAt: null, startedAt: null }) });
        expect(waiting).toContain('Waiting for the executor');
        const empty = renderDetail({ task: job({ output: null }) });
        expect(empty).toContain('No output recorded');
    });

    it('says so in place when the task could not be loaded', () => {
        const html = renderDetail({ task: null, error: 'Request failed (503)' });
        expect(html).toContain('Request failed (503)');
    });

    it('shows the exit code of a finished run', () => {
        const html = renderDetail({ task: job({ status: 'failed', exitCode: 1 }) });
        expect(html).toContain('exit 1');
    });

    it('offers Resume only on a standby task', () => {
        const parked = renderDetail({ task: job({ status: 'standby' }) });
        expect(parked).toContain('Resume');
        const running = renderDetail({ task: job({ status: 'running' }) });
        expect(running).not.toContain('Resume');
    });

    it('offers Done and a follow-up composer on a finished task, and neither on a moving one', () => {
        // The run ending is not the task ending: these two exist exactly for the gap between "the
        // executor stopped" and "I am satisfied".
        const finished = renderDetail({ task: job() });
        expect(finished).toContain('>Done<');
        expect(finished).toContain('<textarea');
        expect(finished).toContain('>Send<');
        for (const status of ['queued', 'running', 'standby'] as const) {
            const moving = renderDetail({ task: job({ status, exitCode: null, finishedAt: null, startedAt: null, output: null }) });
            expect(moving, status).not.toContain('>Done<');
            expect(moving, status).not.toContain('<textarea');
        }
    });

    it('never offers them on a task the user has already marked done', () => {
        const html = renderDetail({ task: job({ doneAt: '2026-09-01T13:00:00.000Z' }) });
        expect(html).not.toContain('>Done<');
        expect(html).not.toContain('<textarea');
        // The verdict is visible, not silently implied by the buttons' absence.
        expect(html).toContain('chat-done');
    });

    it('disables the follow-up Send until text is typed', () => {
        const html = renderDetail({ task: job() });
        const send = html.slice(html.lastIndexOf('>Send<') - 200, html.lastIndexOf('>Send<'));
        expect(send).toContain('disabled');
    });

    it('never emits a placeholder value', () => {
        const html = renderDetail({
            task: job({ executor: null, repo: null, output: null, exitCode: null, finishedAt: null, startedAt: null }),
            executors: [{ name: 'main', type: 'claude' }],
        });
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});

describe('isTerminal', () => {
    // This is what stops the detail poll: a finished job is never going to grow an output.
    it('is true for every status a worker or the board has finished with', () => {
        for (const status of ['succeeded', 'failed', 'dead'] as const) {
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
