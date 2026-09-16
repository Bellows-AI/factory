import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isTerminal, type Job, type RuntimeVitals } from '../src/api/useJobs.js';
import { runDuration, taskTime, wallClock } from '../src/format.js';
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
        author: null,
        stoppedBy: null,
        doneBy: null,
        exitCode: 0,
        output: null,
        repo: null,
        executor: null,
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
    workflows?: readonly { id: string; name: string; scope: 'org' | 'user' | 'repo' }[] | null;
    actionError?: string | null;
    sending?: boolean;
}

const renderComposer = ({
    repos = [{ owner: 'acme', name: 'web' }],
    workspaceError = null,
    executors = [],
    workflows = null,
    actionError = null,
    sending = false,
}: ComposerArgs = {}) =>
    renderToStaticMarkup(
        <TaskComposer
            repos={repos}
            workspaceError={workspaceError}
            onRetryWorkspace={() => {}}
            executors={executors}
            workflows={workflows}
            actionError={actionError}
            sending={sending}
            onSend={async () => null}
        />
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
        <TaskDetail
            jobs={jobs}
            error={error}
            actionError={actionError}
            sending={sending}
            onFollowUp={async () => null}
            onStop={async () => {}}
            onRemove={async () => {}}
            onDone={async () => {}}
        />
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

    it("shows the board's refusal in place", () => {
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

    it('hides the workflow select on a board that serves no workflows', () => {
        // The no-workflow byte-identity, rendered: the composer is exactly what it was.
        const html = renderComposer({ workflows: null });
        expect(html).not.toContain('Workflow');
    });

    it('offers the workflow dropdown beside repo and executor, unchosen by default', () => {
        const html = renderComposer({
            workflows: [
                { id: 'w1', name: 'fix-issue', scope: 'org' },
                { id: 'w2', name: 'mine', scope: 'user' },
            ],
        });
        expect(html).toContain('Workflow');
        expect(html).toContain('>— none —<');
        expect(html).toContain('fix-issue');
        expect(html).toContain('mine');
        // Unchosen means the BOARD decides its default; the select's value is the empty option.
        expect(html).toContain('<option value="" selected="">— none —</option>');
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

    it('labels history turns with their workflow node, and stays quiet without one', () => {
        // A workflow thread's rows read as the graph they walked: the node sits beside the status
        // pill on every HISTORY turn that carries one, and a turn without one renders as before.
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
        expect(html).toContain('class="pill">implement</span>');
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

    it('shows who queued the task in the status sidebar, honestly unknown for a pre-accounts row', () => {
        const author = { id: 'a', login: 'octocat', name: 'The Octocat', avatarUrl: 'https://x/a.png' };
        expect(renderDetail({ jobs: [job({ author })] })).toContain('Queued by');
        expect(renderDetail({ jobs: [job({ author })] })).toContain('The Octocat');
        expect(renderDetail({ jobs: [job({ author })] })).toContain('https://x/a.png');

        const unknown = renderDetail({ jobs: [job()] });
        expect(unknown).toContain('Queued by');
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

    it('a stopped task has ended the turn: composer, Done, Remove — and never Resume', () => {
        // Stopping is a verdict, not a park: the turn is over, the conversation stays open for an
        // adjustment, and there is no picking the run back up.
        const html = renderDetail({ jobs: [job({ status: 'stopped' })] });
        expect(html).toContain('<textarea');
        expect(html).toContain('>Done<');
        expect(html).toContain('>Remove<');
        expect(html).not.toContain('Resume');
    });

    it('offers Done and a follow-up composer on a finished task, and neither on a moving one', () => {
        // The run ending is not the task ending: these two exist exactly for the gap between "the
        // executor stopped" and "I am satisfied".
        const finished = renderDetail({ jobs: [job()] });
        expect(finished).toContain('>Done<');
        expect(finished).toContain('<textarea');
        expect(finished).toContain('>Send<');
        for (const status of ['queued', 'running', 'standby'] as const) {
            const moving = renderDetail({
                jobs: [job({ status, exitCode: null, finishedAt: null, startedAt: null, output: null })],
            });
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

    it('offers Stop on the run that is going, and nothing the moment it is not', () => {
        const running = renderDetail({
            jobs: [job({ status: 'running', exitCode: null, finishedAt: null, startedAt: null, output: null })],
        });
        expect(running).toContain('>Stop<');
        for (const status of ['queued', 'standby', 'succeeded', 'failed', 'dead'] as const) {
            const html = renderDetail({ jobs: [job({ status })] });
            expect(html, status).not.toContain('>Stop<');
            expect(html, status).not.toContain('Stopping…');
        }
    });

    it('says Stopping, not Stop, once the stop request has landed but the run has not parked', () => {
        const html = renderDetail({
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
        expect(html).not.toContain('>Stop<');
        // A run in flight cannot be removed yet: the board refuses with TASK_RUNNING.
        expect(html).not.toContain('>Remove<');
    });

    it('offers Remove on anything not running — queued, parked, finished or dead — and never on one that is', () => {
        for (const status of ['queued', 'standby', 'succeeded', 'failed', 'dead'] as const) {
            const html = renderDetail({ jobs: [job({ status })] });
            expect(html, status).toContain('>Remove<');
        }
        const running = renderDetail({
            jobs: [job({ status: 'running', exitCode: null, finishedAt: null, startedAt: null, output: null })],
        });
        expect(running).not.toContain('>Remove<');
    });

    it('keeps the thread actions on the newest run only — history runs render no Remove of their own', () => {
        const root = job({ command: 'first command' });
        const child = {
            ...job({ command: 'second command', status: 'failed' }),
            id: '44444444-4444-4444-8444-444444444444',
            followUpTo: root.id,
            rootJobId: root.id,
        };
        const html = renderDetail({ jobs: [root, child] });
        expect(html.match(/>Remove</g)).toHaveLength(1);
        expect(html).not.toContain('>Stop<');
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
            rootJobId: root.id,
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

    /**
     * The task's live summary — what the agent is doing right now — at the top of the view while
     * the newest run is going. Fed by the same `runtime.activity` the sidebar's "Task" row reads,
     * so the two places a task is met (left nav, view top) say the same thing.
     */
    describe('summary', () => {
        const activity = '→ Bash npm test';
        const runtime = {
            cpuPercent: 12,
            memUsedMb: 300,
            memPercent: null,
            activity,
            sampledAt: '2026-09-01T12:02:00.000Z',
        };

        it("shows the running task's summary at the top of the view", () => {
            const html = renderDetail({ jobs: [job({ status: 'running', runtime })] });
            expect(html).toContain('task-summary');
            expect(html).toContain(activity);
        });

        it('shows it for the whole chain, from the newest run forward', () => {
            const root = job({ command: 'first command' });
            const child = {
                ...job({ status: 'running', runtime }),
                id: '44444444-4444-4444-8444-444444444444',
                followUpTo: root.id,
                rootJobId: root.id,
            };
            const html = renderDetail({ jobs: [root, child] });
            expect(html).toContain('task-summary');
            expect(html).toContain(activity);
        });

        it('shows no summary once the newest run is not going', () => {
            for (const status of ['queued', 'standby', 'succeeded', 'failed', 'dead'] as const) {
                const html = renderDetail({ jobs: [job({ status, runtime })] });
                expect(html, status).not.toContain('task-summary');
            }
        });

        it('shows no summary until the driver samples an activity line', () => {
            const html = renderDetail({ jobs: [job({ status: 'running', runtime: { ...runtime, activity: null } })] });
            expect(html).not.toContain('task-summary');
        });
    });

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
         * task head's `<h2>` repeats the root command above the thread, and a first-occurrence
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

    /**
     * The status sidebar: one column beside the conversation, fed by the NEWEST run — the same
     * run the composer and Done verdict belong to. Everything it shows is either what the board
     * reports or a blank where nothing was; nothing is inferred.
     */
    describe('sidebar', () => {
        const runtime = {
            cpuPercent: 12,
            memUsedMb: 300,
            memPercent: 2,
            activity: '→ Bash npm test',
            sampledAt: '2026-09-01T12:02:00.000Z',
        };

        it('renders a status sidebar fed by the newest run', () => {
            const html = renderDetail({ jobs: [job({ executor: 'main' })] });
            expect(html).toContain('task-side');
            expect(html).toContain('<h2>Status</h2>');
            expect(html).toContain('<h2>Connections</h2>');
            expect(html).toContain('<span class="pill">succeeded</span>');
            expect(html).toContain('<span class="pill">main</span>');
        });

        it('shows the workspace directory the board reports, and blank when there is none', () => {
            const named = renderDetail({ jobs: [job({ workspacePath: 'org-1/user-2' })] });
            expect(named).toContain('<dt>Workspace</dt><dd>org-1/user-2</dd>');
            expect(renderDetail({ jobs: [job()] })).toContain('<dt>Workspace</dt><dd></dd>');
        });

        /**
         * The thread's context and cost (issue #60): Context is the newest CLOSED turn's scrape —
         * a follow-up resumes the same session, so the last turn's count IS the conversation's
         * final context, and summing would double-count the shared prefix. Cost is the sum of
         * every turn's scraped cost, where zero-dollar turns contribute nothing.
         */
        it('shows the thread context — the newest closed turn, never a sum', () => {
            const closed = { ...runtime, contextTokens: 30433, costUsd: 0.1 };
            const running = {
                cpuPercent: 12,
                memUsedMb: 300,
                memPercent: null,
                activity: null,
                sampledAt: '2026-09-01T12:02:00.000Z',
            };
            const root = job({ command: 'first command', runtime: closed });
            const html = renderDetail({
                jobs: [
                    root,
                    {
                        ...job({ command: 'second command', status: 'running', runtime: running }),
                        id: '44444444-4444-4444-8444-444444444444',
                        followUpTo: root.id,
                        rootJobId: root.id,
                    },
                ],
            });
            // The newest turn is running and carries no scrape; the last CLOSED turn's count is
            // the conversation's final context.
            expect(html).toContain('<dt>Context</dt><dd>30,433 tok</dd>');
        });

        it('shows the whole chain as the Cost row, once it costs something', () => {
            const root = job({ command: 'first command', runtime: { ...runtime, contextTokens: 1000, costUsd: 0.1 } });
            const html = renderDetail({
                jobs: [
                    root,
                    {
                        ...job({
                            command: 'second command',
                            runtime: { ...runtime, contextTokens: 90433, costUsd: 0.21 },
                        }),
                        id: '44444444-4444-4444-8444-444444444444',
                        followUpTo: root.id,
                        rootJobId: root.id,
                    },
                ],
            });
            expect(html).toContain('<dt>Cost</dt><dd>$0.3100</dd>');
            // Context is NOT summed: the last turn's count IS the conversation's final context.
            expect(html).toContain('<dt>Context</dt><dd>90,433 tok</dd>');
        });

        it('stays silent about a thread that cost nothing, and about one nothing scraped', () => {
            const free = renderDetail({
                jobs: [job({ runtime: { ...runtime, contextTokens: 1200, costUsd: 0 } })],
            });
            expect(free).toContain('<dt>Context</dt><dd>1,200 tok</dd>');
            expect(free).toContain('<dt>Cost</dt><dd></dd>');
            expect(free).not.toContain('$0.0000');

            expect(renderDetail({ jobs: [job()] })).toContain('<dt>Context</dt><dd></dd>');
            expect(renderDetail({ jobs: [job()] })).toContain('<dt>Cost</dt><dd></dd>');
        });

        /**
         * The attempt's declared services and their states (issue #60) — the "did db come up"
         * answer, from the newest attempt only: a fleet is attempt-scoped on the driver side, and
         * an older attempt's is long gone.
         */
        it('lists the newest attempt\u2019s services with their states', () => {
            const html = renderDetail({
                jobs: [
                    job({
                        status: 'running',
                        runtime: { ...runtime, services: [{ name: 'db', image: 'postgres:16', state: 'running' }] },
                    }),
                ],
            });
            expect(html).toContain('<h2>Services</h2>');
            expect(html).toContain('<dt>db</dt><dd>running</dd>');
        });

        it('renders nothing about services when the attempt declared none, and nothing from older attempts', () => {
            expect(renderDetail({ jobs: [job()] })).not.toContain('Services</h2>');
            expect(renderDetail({ jobs: [job({ runtime: { ...runtime, services: [] } })] })).not.toContain(
                'Services</h2>'
            );

            const root = job({
                command: 'first command',
                runtime: { ...runtime, services: [{ name: 'db', image: 'postgres:16', state: 'running' }] },
            });
            const html = renderDetail({
                jobs: [
                    root,
                    {
                        ...job({ command: 'second command' }),
                        id: '44444444-4444-4444-8444-444444444444',
                        followUpTo: root.id,
                        rootJobId: root.id,
                    },
                ],
            });
            expect(html).not.toContain('Services</h2>');
            expect(html).not.toContain('<dt>db</dt>');
        });

        it('shows the running time of a finished run, and nothing before it starts or while parked', () => {
            // 12:00:01 -> 12:04:00, the factory job's span.
            expect(renderDetail({ jobs: [job()] })).toContain('<dt>Running time</dt><dd>4m</dd>');
            // A queued job has no attempt yet, and a parked one is not running: either way a
            // ticking clock would lie.
            const queued = renderDetail({ jobs: [job({ status: 'queued', startedAt: null, finishedAt: null })] });
            expect(queued).toContain('<dt>Running time</dt><dd></dd>');
            const parked = renderDetail({ jobs: [job({ status: 'standby' })] });
            expect(parked).toContain('<dt>Running time</dt><dd></dd>');
        });

        it('shows the current task while the run is going, and nothing once it is not', () => {
            const live = renderDetail({ jobs: [job({ status: 'running', runtime })] });
            expect(live).toContain('<dt>Task</dt><dd>→ Bash npm test</dd>');
            expect(renderDetail({ jobs: [job({ runtime })] })).toContain('<dt>Task</dt><dd></dd>');
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

        it('renders blanks for a thread with no issue and no PR', () => {
            const html = renderDetail({ jobs: [job()] });
            expect(html).toContain('<dt>Issue</dt><dd></dd>');
            expect(html).toContain('<dt>PR</dt><dd></dd>');
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

        it("keeps older runs' pills inline and moves only the newest run's to the sidebar", () => {
            const root = job({ command: 'first command' });
            const child = {
                ...job({ command: 'second command' }),
                id: '44444444-4444-4444-8444-444444444444',
                followUpTo: root.id,
                rootJobId: root.id,
            };
            const html = renderDetail({ jobs: [root, child] });
            const rootMeta = html.slice(html.indexOf('first command'), html.indexOf('chat-detail'));
            expect(rootMeta).toContain('<span class="pill');
            const childMeta = html.slice(
                html.indexOf('second command'),
                html.indexOf('chat-detail', html.indexOf('second command'))
            );
            expect(childMeta).not.toContain('<span class="pill');
        });

        it('never emits a placeholder value', () => {
            const html = renderDetail({
                jobs: [
                    job({
                        executor: null,
                        workspacePath: null,
                        output: null,
                        exitCode: null,
                        runtime: { ...runtime, activity: null, contextTokens: null, costUsd: null },
                    }),
                ],
            });
            for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
        });
    });
});

describe('the task head', () => {
    // The head region sits between the panel's heading and the first turn of the conversation —
    // slicing it keeps the placement assertions about the title, the controls and the clock from
    // matching text that merely also appears in a turn below.
    const head = (html: string): string => html.slice(html.indexOf('panel-head'), html.indexOf('chat-exchange'));
    /** One turn's meta line — where the controls used to live, and must no longer. */
    const meta = (html: string): string => html.slice(html.indexOf('msg-user'), html.indexOf('chat-detail'));

    it('names the task after its opening command', () => {
        const html = renderDetail({ jobs: [job()] });
        expect(html).toContain('<h2>Task - fix the flaky login test</h2>');

        // A multi-line command is prose; the head carries its first line, the turn carries it all.
        const multiline = renderDetail({ jobs: [job({ command: 'first line\nsecond line' })] });
        expect(multiline).toContain('<h2>Task - first line</h2>');
        expect(head(multiline)).not.toContain('second line');
    });

    it('keeps the plain Tasks heading while nothing is loaded', () => {
        // No task yet, so there is nothing to name — the detail poll has not landed.
        expect(renderDetail({ jobs: null })).toContain('<h2>Tasks</h2>');
    });

    it('keeps the controls in the panel head, out of the turn meta', () => {
        const running = renderDetail({
            jobs: [job({ status: 'running', startedAt: '2026-09-01T12:00:01.000Z', finishedAt: null, exitCode: null })],
        });
        expect(head(running)).toContain('>Stop<');
        expect(meta(running)).not.toContain('<button');

        const finished = renderDetail({ jobs: [job()] });
        expect(head(finished)).toContain('>Done<');
        expect(head(finished)).toContain('>Remove<');
        expect(meta(finished)).not.toContain('<button');
    });

    it('says Stopping in the panel head once the stop request has landed', () => {
        const html = renderDetail({
            jobs: [
                job({
                    status: 'running',
                    cancelRequestedAt: '2026-09-01T12:02:00.000Z',
                    startedAt: '2026-09-01T12:00:01.000Z',
                    finishedAt: null,
                    exitCode: null,
                }),
            ],
        });
        expect(head(html)).toContain('Stopping…');
        expect(head(html)).not.toContain('>Stop<');
    });

    it('shows the overall wall clock in the head, and a dash where nothing is measurable', () => {
        const timed = renderDetail({ jobs: [job({ taskWallClockMs: 5_400_000 })] });
        expect(head(timed)).toContain('1.5h');

        const untimed = renderDetail({ jobs: [job()] });
        expect(head(untimed)).toContain('—');
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
