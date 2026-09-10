import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isTerminal, type Job } from '../src/api/useJobs.js';
import { runDuration, taskTime } from '../src/format.js';
import { threadIssue, threadPublish } from '../src/panels/TaskSide.js';
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
        workspacePath: null,
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

    it('offers one repository option per selection plus none, first repository selected by default', () => {
        // The tabs are gone; the composer stamps the task with a repo instead. The default is the
        // FIRST selected repository — a member who picked repositories means their tasks to be
        // stamped with one, not with nothing — and `none` stays available for a deliberate
        // unlabelled run. Same rule, and same default, as the executor select.
        const html = renderComposer({
            repos: [
                { owner: 'acme', name: 'web' },
                { owner: 'acme', name: 'api' },
            ],
        });
        expect(html).toContain('<option value="acme/web"');
        expect(html).toContain('<option value="acme/api">');
        expect(html).toContain('value="acme/web" selected');
        // The `none` option is still offered first — just not the selected one.
        const repoSelect = html.slice(html.indexOf('Repository'), html.indexOf('Executor'));
        expect(repoSelect).not.toContain('value="" selected');
        const none = renderComposer({ repos: [] });
        expect(none).toContain('<option value="" selected');
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

        it('labels each summary count with its meaning and status color', () => {
            // "Checks 1 1 0" tells nobody which number is which; each count is labelled and wears
            // the same status class the per-gate pill does.
            const html = renderDetail({ jobs: [job({ gates: [...gates, { name: 'build', status: 'running' as const, exitCode: null, output: null }] })] });
            const summary = html.slice(html.indexOf('Checks'), html.indexOf('</summary>'));
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
     * activity line is the sidebar's "currently running task" and lives there now.
     */
    describe('runtime', () => {
        const runtime = { cpuPercent: 93.4, memUsedMb: 544.2, memPercent: 7, activity: '→ Read src/x.ts', sampledAt: '2026-09-09T10:00:00.000Z' };

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

    /**
     * The status sidebar: one column beside the conversation, fed by the NEWEST run — the same
     * run the composer and Done verdict belong to. Everything it shows is either what the board
     * reports or an honest dash; nothing is inferred.
     */
    describe('sidebar', () => {
        const runtime = { cpuPercent: 12, memUsedMb: 300, memPercent: 2, activity: '→ Bash npm test', sampledAt: '2026-09-01T12:02:00.000Z' };

        it('renders a status sidebar fed by the newest run', () => {
            const html = renderDetail({ jobs: [job({ executor: 'main' })] });
            expect(html).toContain('task-side');
            expect(html).toContain('<h2>Status</h2>');
            expect(html).toContain('<h2>Connections</h2>');
            expect(html).toContain('<span class="pill">succeeded</span>');
            expect(html).toContain('<span class="pill">main</span>');
        });

        it('shows the workspace directory the board reports, and a dash when there is none', () => {
            const named = renderDetail({ jobs: [job({ workspacePath: 'org-1/user-2' })] });
            expect(named).toContain('<dt>Workspace</dt><dd>org-1/user-2</dd>');
            expect(renderDetail({ jobs: [job()] })).toContain('<dt>Workspace</dt><dd>—</dd>');
        });

        /**
         * The context the run reached rides the close-time scrape — where "died at 90k tokens" is
         * legible — and cost shows only once it is money.
         */
        it('shows the context the run reached, and its cost once it costs something', () => {
            const html = renderDetail({
                jobs: [job({ runtime: { ...runtime, contextTokens: 90433, costUsd: 0.31 } })],
            });
            expect(html).toContain('<dt>Context</dt><dd>90,433 tok</dd>');
            expect(html).toContain('<dt>Cost</dt><dd>$0.3100</dd>');

            const free = renderDetail({
                jobs: [job({ runtime: { ...runtime, contextTokens: 1200, costUsd: 0 } })],
            });
            expect(free).toContain('<dt>Context</dt><dd>1,200 tok</dd>');
            expect(free).not.toContain('$0.0000');
        });

        it('shows nothing where the runner scraped no context', () => {
            expect(renderDetail({ jobs: [job()] })).toContain('<dt>Context</dt><dd>—</dd>');
        });

        it('shows the running time of a finished run, and nothing before it starts or while parked', () => {
            // 12:00:01 -> 12:04:00, the factory job's span.
            expect(renderDetail({ jobs: [job()] })).toContain('<dt>Running time</dt><dd>4m</dd>');
            // A queued job has no attempt yet, and a parked one is not running: either way a
            // ticking clock would lie.
            const queued = renderDetail({ jobs: [job({ status: 'queued', startedAt: null, finishedAt: null })] });
            expect(queued).toContain('<dt>Running time</dt><dd>—</dd>');
            const parked = renderDetail({ jobs: [job({ status: 'standby' })] });
            expect(parked).toContain('<dt>Running time</dt><dd>—</dd>');
        });

        it('shows the current task while the run is going, and nothing once it is not', () => {
            const live = renderDetail({ jobs: [job({ status: 'running', runtime })] });
            expect(live).toContain('<dt>Task</dt><dd>→ Bash npm test</dd>');
            expect(renderDetail({ jobs: [job({ runtime })] })).toContain('<dt>Task</dt><dd>—</dd>');
            expect(renderDetail({ jobs: [job()] })).not.toContain('chat-activity');
        });

        it('shows the issue reference and the published PR of the thread', () => {
            const root = job({
                command: 'fix https://github.com/o/r/issues/44 please',
                output: 'done\n[driver] published fix/44 — https://github.com/o/r/pull/9',
            });
            const html = renderDetail({ jobs: [root] });
            expect(html).toContain('<dt>Issue</dt><dd>#44</dd>');
            expect(html).toContain('<a href="https://github.com/o/r/pull/9">fix/44</a>');
            // A url that is not http(s) stays text — nothing a run echoed becomes a handler href.
            const unsafe = renderDetail({
                jobs: [job({ output: 'done\n[driver] published fix/44 — javascript:alert(1)' })],
            });
            expect(unsafe).not.toContain('<a href="javascript:');
            expect(unsafe).toContain('fix/44');
        });

        it('shows dashes for a thread with no issue and no PR', () => {
            const html = renderDetail({ jobs: [job()] });
            expect(html).toContain('<dt>Issue</dt><dd>—</dd>');
            expect(html).toContain('<dt>PR</dt><dd>—</dd>');
        });

        it('shows a dash for the PR state, which nothing records on the job', () => {
            // The output line carries a url, not a state; inventing one would be a lie. A
            // structured PR source is a deliberate follow-up.
            const root = job({
                command: 'fix #44',
                output: 'done\n[driver] published fix/44 — https://github.com/o/r/pull/9',
            });
            expect(renderDetail({ jobs: [root] })).toContain('<dt>PR state</dt><dd>—</dd>');
        });

        it('keeps older runs\' pills inline and moves only the newest run\'s to the sidebar', () => {
            const root = job({ command: 'first command' });
            const child = { ...job({ command: 'second command' }), id: '44444444-4444-4444-8444-444444444444', followUpTo: root.id };
            const html = renderDetail({ jobs: [root, child] });
            const rootMeta = html.slice(html.indexOf('first command'), html.indexOf('chat-detail'));
            expect(rootMeta).toContain('<span class="pill');
            const childMeta = html.slice(html.indexOf('second command'), html.indexOf('chat-detail', html.indexOf('second command')));
            expect(childMeta).not.toContain('<span class="pill');
        });

        it('never emits a placeholder value', () => {
            const html = renderDetail({
                jobs: [job({ executor: null, workspacePath: null, output: null, exitCode: null, runtime: { ...runtime, activity: null, contextTokens: null, costUsd: null } })],
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

describe('thread derivations', () => {
    const base = job();
    const withCommand = (command: string, over: Partial<Job> = {}): Job => ({ ...base, command, ...over });
    /** A follow-up of `base`: the chain array is oldest first, so this is the newest run. */
    const followUp = (command: string, over: Partial<Job> = {}): Job => ({
        ...base,
        command,
        id: '44444444-4444-4444-8444-444444444444',
        followUpTo: base.id,
        ...over,
    });

    describe('threadIssue', () => {
        // The driver's publishPlan reads the same reference out of the command to name the branch
        // and close the issue from the PR — the sidebar shows the reader what the task is about.
        it('parses an issues/ URL and a bare #number', () => {
            expect(threadIssue([withCommand('fix https://github.com/o/r/issues/44 please')])).toBe(44);
            expect(threadIssue([withCommand('fix #44 please')])).toBe(44);
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
                threadPublish([withCommand('x', { output: 'done\n[driver] published fix/44 — https://github.com/o/r/pull/9' })]),
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
            expect(threadPublish([root, followUp('y', { output: '[driver] published fix/2 — https://github.com/o/r/pull/2' })])?.url).toBe(
                'https://github.com/o/r/pull/2',
            );
        });

        it('answers null when nothing was published', () => {
            expect(threadPublish([withCommand('x', { output: 'no publish here' })])).toBeNull();
            expect(threadPublish([withCommand('x', { output: null })])).toBeNull();
        });

        it('ignores a marker the run echoed mid-line, and never links a non-http url', () => {
            // The agent's output is arbitrary text; only a whole line at a line boundary is the
            // driver's, and only an http(s) url may become a href.
            expect(
                threadPublish([withCommand('x', { output: 'the agent said [driver] published fake/1 — not-a-url' })]),
            ).toBeNull();
            expect(
                threadPublish([withCommand('x', { output: '[driver] published fix/5 — javascript:alert(1)' })]),
            ).toEqual({ branch: 'fix/5', url: 'javascript:alert(1)' });
        });
    });
});
