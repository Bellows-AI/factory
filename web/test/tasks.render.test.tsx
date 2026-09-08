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
    /** One task or a whole follow-up chain — the page hands the polled thread over as-is. */
    jobs?: Job[] | null;
    error?: string | null;
    actionError?: string | null;
    sending?: boolean;
}

const renderDetail = ({
    jobs = [job()],
    error = null,
    actionError = null,
    sending = false,
}: DetailArgs = {}) =>
    renderToStaticMarkup(
        <TaskDetail
            jobs={jobs}
            error={error}
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

    // A member who configured executors means their tasks to run on one: the FIRST is the
    // default, and `none` stays available for a deliberate unlabelled run.
    it('preselects the first configured executor, and none only when there is none', () => {
        const one = renderComposer({ repos: [], executors: [{ name: 'main', type: 'claude' }] });
        expect(one).toContain('<option value="main" selected');

        const two = renderComposer({
            repos: [],
            executors: [
                { name: 'main', type: 'claude' },
                { name: 'heavy', type: 'claude' },
            ],
        });
        expect(two).toContain('<option value="main" selected');
        expect(two).not.toContain('<option value="heavy" selected');

        const empty = renderComposer({ repos: [], executors: [] });
        // Only the `none` options exist, and the executor one is the one selected.
        expect(empty).toContain('<option value="" selected');
        expect(empty).not.toContain('<option value="main"');
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
        const html = renderDetail({ jobs: [job({ executor: 'main' })] });
        expect(html).toContain('fix the flaky login test');
        expect(html).toContain('succeeded');
        expect(html).toContain('main');
        expect(html).toContain('2026-09-01 12:00');
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
        const waiting = renderDetail({ jobs: [job({ status: 'running', output: null, exitCode: null, finishedAt: null, startedAt: null })] });
        expect(waiting).toContain('Waiting for the executor');
        const empty = renderDetail({ jobs: [job({ output: null })] });
        expect(empty).toContain('No output recorded');
    });

    it('says so in place when the task could not be loaded', () => {
        const html = renderDetail({ jobs: null, error: 'Request failed (503)' });
        expect(html).toContain('Request failed (503)');
    });

    it('shows the exit code of a finished run', () => {
        const html = renderDetail({ jobs: [job({ status: 'failed', exitCode: 1 })] });
        expect(html).toContain('exit 1');
    });

    it('offers Resume only on a standby task', () => {
        const parked = renderDetail({ jobs: [job({ status: 'standby' })] });
        expect(parked).toContain('Resume');
        const running = renderDetail({ jobs: [job({ status: 'running' })] });
        expect(running).not.toContain('Resume');
    });

    it('offers Done and a follow-up composer on a finished task, and neither on a moving one', () => {
        // The run ending is not the task ending: these two exist exactly for the gap between "the
        // executor stopped" and "I am satisfied".
        const finished = renderDetail({ jobs: [job()] });
        expect(finished).toContain('>Done<');
        expect(finished).toContain('<textarea');
        expect(finished).toContain('>Send<');
        for (const status of ['queued', 'running', 'standby'] as const) {
            const moving = renderDetail({ jobs: [job({ status, exitCode: null, finishedAt: null, startedAt: null, output: null })] });
            expect(moving, status).not.toContain('>Done<');
            expect(moving, status).not.toContain('<textarea');
        }
    });

    it('never offers them on a task the user has already marked done', () => {
        const html = renderDetail({ jobs: [job({ doneAt: '2026-09-01T13:00:00.000Z' })] });
        expect(html).not.toContain('>Done<');
        expect(html).not.toContain('<textarea');
        // The verdict is visible, not silently implied by the buttons' absence.
        expect(html).toContain('chat-done');
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
        // The done verdict is unrelated to sessions and stays available.
        expect(html).toContain('>Done<');
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
        };
        const html = renderDetail({ jobs: [root, child] });

        expect(html).toContain('fix the flaky login test');
        expect(html).toContain('now tighten the retry logic');
        // Both messages, in order.
        expect(html.indexOf('fix the flaky login test')).toBeLessThan(html.indexOf('now tighten the retry logic'));
        // One Done button, on the newest run only.
        expect(html.match(/>Done</g)).toHaveLength(1);
        expect(html).toContain('<textarea');
    });

    it('never emits a placeholder value', () => {
        const html = renderDetail({
            jobs: [job({ executor: null, repo: null, output: null, exitCode: null, finishedAt: null, startedAt: null })],
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
