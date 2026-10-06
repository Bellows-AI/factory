import { describe, expect, it } from 'vitest';
import type { Job, RuntimeVitals } from '../src/api/useJobs.js';
import { FORBIDDEN, job, renderDetail } from './tasks-fixtures.js';

describe('TaskDetail — run activity (issue #339)', () => {
    const activity = {
        jobId: '11111111-1111-4111-8111-111111111111',
        sessionId: '33333333-3333-4333-8333-333333333333',
        from: '2026-09-22T20:46:16.000Z',
        to: '2026-09-22T22:46:16.000Z',
        bucketMs: 900_000,
        buckets: [{ start: '2026-09-22T21:00:00.000Z', tokens: 2_500_000, edits: 3 }],
    };

    it('renders the head run’s activity chart between the conversation and the panels', () => {
        const html = renderDetail({ jobs: [job()], activity, live: false });
        expect(html).toContain('Run activity');
        expect(html).toMatch(/data-series="tokens"/);
        // The chart follows the conversation and precedes the follow-up slot.
        expect(html.indexOf('Run activity')).toBeGreaterThan(html.indexOf('</article>'));
    });

    it('says so in place when the run has no telemetry to chart', () => {
        const html = renderDetail({ jobs: [job()] });
        expect(html).toContain('No telemetry for this run.');
        // No chart in the activity panel itself — the page's other icons are not the chart's.
        const panel = html.slice(html.indexOf('task-activity'), html.indexOf('task-follow-up'));
        expect(panel).not.toContain('<svg');
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
});

describe('TaskDetail — the follow-up composer states', () => {
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
        for (const status of ['queued', 'running'] as const) {
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
        const LOOKBEHIND_CHARS = 200;
        const at = html.lastIndexOf('>Send follow-up<');
        const send = html.slice(at - LOOKBEHIND_CHARS, at);
        expect(send).toContain('disabled');
    });

    /**
     * Only done or removed closes a task: a run that never reported a session — an opencode task,
     * an agent-less workflow step — still takes a follow-up, which the board starts fresh.
     */
    it('offers the follow-up composer on a run with no session to continue', () => {
        const html = renderDetail({ jobs: [job({ sessionId: null })] });
        expect(html).toContain('<textarea');
        expect(html).not.toContain('no agent session to continue');
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
});

/**
 * The checks a run performed or is performing: a collapsible list per run, expandable to the
 * gate's output. Current/last ran only — the board stores exactly that, so the UI has no
 * history control to offer.
 */
describe('TaskDetail — checks', () => {
    const gates = [
        { name: 'test', status: 'passed' as const, exitCode: 0, output: 'all green' },
        { name: 'lint', status: 'failed' as const, exitCode: 1, output: '2 problems' },
    ];

    it("renders the newest run's verification with a name and status per gate", () => {
        const html = renderDetail({ jobs: [job({ gates })] });
        expect(html).toContain('<h2>Verification</h2>');
        expect(html).toContain('id="task-verification"');
        expect(html).toContain('test');
        expect(html).toContain('lint');
        expect(html).toContain('<details');
    });

    it('draws only the counts that happened — "0 failed" is no news, and never a pill', () => {
        const html = renderDetail({ jobs: [job({ gates: [gates[0]!] })] });
        // Both count rows: the main column's Verification and the outcome rail's.
        expect(html.match(/<span class="pill pill-ok">1(<!-- -->)? (<!-- -->)?passed<\/span>/g)?.length).toBe(2);
        expect(html).not.toMatch(/>0(<!-- -->)? (<!-- -->)?(failed|running)</);
        expect(html).not.toContain('pill-bad');
    });

    it('opens failed gates and leaves passed ones collapsed', () => {
        const html = renderDetail({ jobs: [job({ gates })] });
        const at = (name: string) => html.lastIndexOf('<details', html.indexOf(`<span>${name}</span>`));
        expect(html.slice(at('lint'), at('lint') + 20)).toContain('<details open=""');
        expect(html.slice(at('test'), at('test') + 20)).not.toContain('open');
    });

    it('gives each gate output its own labelled, focusable, copyable mono well', () => {
        const html = renderDetail({ jobs: [job({ gates })] });
        expect(html).toContain('aria-label="Output of lint"');
        expect(html).toContain('<pre class="chat-output gate-output" tabindex="0">2 problems</pre>');
        expect(html).toContain('aria-label="Copy output of lint"');
    });

    it('labels each count with its meaning and status color, failed first', () => {
        const html = renderDetail({
            jobs: [
                job({
                    gates: [...gates, { name: 'build', status: 'running' as const, exitCode: null, output: null }],
                }),
            ],
        });
        const start = html.indexOf('task-verification-counts');
        const counts = html.slice(start, html.indexOf('</p>', start));
        expect(counts).toContain('pill pill-ok');
        expect(counts).toContain('pill pill-bad');
        expect(counts).toContain('pill pill-done');
        expect(counts.indexOf('failed')).toBeLessThan(counts.indexOf('passed'));
        expect(counts.indexOf('passed')).toBeLessThan(counts.indexOf('running'));
    });

    it('renders no verification for a run without gates', () => {
        expect(renderDetail({ jobs: [job()] })).not.toContain('Verification');
        expect(renderDetail({ jobs: [job({ gates: [] })] })).not.toContain('Verification');
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
describe('TaskDetail — runtime', () => {
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
        for (const status of ['succeeded', 'failed', 'dead', 'stopped'] as const) {
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
describe('TaskDetail — turn stats', () => {
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
        const ROOT_CONTEXT_TOKENS = 30_000;
        const ROOT_COST_USD = 0.1;
        const CHILD_CONTEXT_TOKENS = 90_433;
        const CHILD_COST_USD = 0.21;
        const html = renderDetail({
            jobs: [
                job({ command: 'first command', runtime: scrape(ROOT_CONTEXT_TOKENS, ROOT_COST_USD) }),
                child({ runtime: scrape(CHILD_CONTEXT_TOKENS, CHILD_COST_USD) }),
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
        const ROOT_CONTEXT_TOKENS = 30_000;
        const ROOT_COST_USD = 0.1;
        const html = renderDetail({
            jobs: [
                job({ command: 'first command', runtime: scrape(ROOT_CONTEXT_TOKENS, ROOT_COST_USD) }),
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
        const ZERO_DOLLAR_CONTEXT_TOKENS = 1_200;
        const html = renderDetail({ jobs: [job({ runtime: scrape(ZERO_DOLLAR_CONTEXT_TOKENS, 0) })] });
        expect(html).toContain('ctx 1,200 tok');
        expect(html).not.toContain('$0.0000');
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

/**
 * Who may continue a task (F3): the board refuses a follow-up from anyone but the account that
 * queued the row it is posted to, so the composer is offered to that account alone — and the
 * page says who can, rather than offering a control that can only fail.
 */
describe('TaskDetail — who may follow up', () => {
    const me = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', login: 'me', name: null, avatarUrl: null };
    const other = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', login: 'octo-reviewer', name: null, avatarUrl: null };
    const viewer = { loading: false, id: me.id };

    it('offers the composer on your own task', () => {
        const html = renderDetail({ jobs: [job({ author: me })], viewer });
        expect(html).toContain('<h2>Follow up</h2>');
        expect(html).toContain('<textarea');
    });

    it("names the author on another member's task, and offers no composer", () => {
        const html = renderDetail({ jobs: [job({ author: other })], viewer });
        expect(html).toContain('Only octo-reviewer can continue this session. You can still mark it done.');
        expect(html).not.toContain('<textarea');
    });

    it('says "the task author" when the row has none', () => {
        const html = renderDetail({ jobs: [job({ author: null })], viewer });
        expect(html).toContain('Only the task author can continue this session.');
        expect(html).not.toContain('<textarea');
        // A null author and a null viewer are the same nobody — the board's null-safe match.
        expect(renderDetail({ jobs: [job({ author: null })], viewer: { loading: false, id: null } })).toContain(
            '<textarea'
        );
    });

    it('refuses an authored task to a viewer with no session', () => {
        const html = renderDetail({ jobs: [job({ author: me })], viewer: { loading: false, id: null } });
        expect(html).toContain('Only me can continue this session.');
        expect(html).not.toContain('<textarea');
    });

    it('renders nothing while the session loads, so your own task never flashes a refusal', () => {
        for (const author of [me, other]) {
            const html = renderDetail({ jobs: [job({ author })], viewer: { loading: true, id: null } });
            expect(html, author.login).not.toContain('<textarea');
            expect(html, author.login).not.toContain('can continue this session');
            expect(html, author.login).not.toContain('Follow up');
        }
    });

    it('renders nothing on a closed task, even for another member', () => {
        const html = renderDetail({ jobs: [job({ author: other, doneAt: '2026-09-01T13:00:00.000Z' })], viewer });
        expect(html).not.toContain('can continue this session');
        expect(html).not.toContain('<textarea');
    });

    it("renders the server's 403 inside the composer, beside the draft", () => {
        const refusal = 'Only the account that queued the task can follow it up';
        const html = renderDetail({ jobs: [job({ author: me })], viewer, followUpError: refusal });
        const composer = html.slice(html.indexOf('class="composer"'));
        expect(composer).toContain(refusal);
        expect(composer.indexOf(refusal)).toBeLessThan(composer.indexOf('<textarea'));
    });

    it('keeps a stop or Mark done refusal above both columns, not in the composer', () => {
        const html = renderDetail({ jobs: [job({ author: me })], viewer, actionError: 'Task is running' });
        expect(html.indexOf('Task is running')).toBeLessThan(html.indexOf('task-layout'));
    });
});

describe('TaskDetail — main column', () => {
    const kim = { id: 'k', login: 'kim', name: null, avatarUrl: null };
    const lee = { id: 'l', login: 'lee', name: null, avatarUrl: null };
    const titlesOf = (html: string) =>
        [...html.matchAll(/<li class="task-history-item"><span>([^<]+)<\/span>/g)].map((m) => m[1]);

    it('lists recorded facts only, oldest first', () => {
        const wait = { waitReason: 'review', waitingSince: '2026-09-01T12:05:00.000Z' };
        const root = job(wait);
        const child = job({
            ...wait,
            id: '44444444-4444-4444-8444-444444444444',
            command: 'tighten it',
            createdAt: '2026-09-01T12:10:00.000Z',
            startedAt: '2026-09-01T12:10:01.000Z',
            finishedAt: '2026-09-01T12:20:00.000Z',
            doneAt: '2026-09-01T12:30:00.000Z',
            doneBy: kim,
        });
        const html = renderDetail({ jobs: [root, child] });
        expect(titlesOf(html)).toEqual([
            'Task created',
            'Run 1 started',
            'Run 1 succeeded',
            'Waiting for review',
            'Follow-up queued',
            'Run 2 started',
            'Run 2 succeeded',
            'Marked done by kim',
        ]);
        const history = html.slice(html.indexOf('task-history'), html.indexOf('</ol>'));
        const stamps = [...history.matchAll(/dateTime="([^"]+)"/g)].map((m) => Date.parse(m[1]!));
        expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
        expect(html).not.toMatch(/Implemented|Published PR|Published pull request/);
    });

    it('collapses the run history behind a disclosure counting the runs', () => {
        const html = renderDetail({ jobs: [job()] });
        expect(html).toMatch(/<details class="run-history"><summary><h2>Run history<\/h2>.*?1 run</);
        expect(html).not.toContain('<details class="run-history" open');
    });

    it('a queued run has only its queued fact; a stop names who asked', () => {
        const queued = renderDetail({
            jobs: [job({ status: 'queued', startedAt: null, finishedAt: null, exitCode: null })],
        });
        expect(titlesOf(queued)).toEqual(['Task created']);

        const stopped = renderDetail({
            jobs: [job({ status: 'stopped', cancelRequestedAt: '2026-09-01T12:02:00.000Z', stoppedBy: lee })],
        });
        expect(titlesOf(stopped)).toEqual(['Task created', 'Run 1 started', 'Stop requested by lee', 'Run 1 stopped']);
        expect(titlesOf(renderDetail({ jobs: [job({ status: 'dead' })] }))).toContain('Run 1 lost its worker');
    });

    it('keeps only the conversation and composer in the main column; every other panel is in the sidebar', () => {
        const runtime = {
            cpuPercent: null,
            memUsedMb: null,
            memPercent: null,
            activity: null,
            sampledAt: '2026-09-01T12:02:00.000Z',
            services: [{ name: 'db', image: 'postgres:16', state: 'exited' }],
        };
        const html = renderDetail({
            jobs: [
                job({
                    output: '[driver] published fix/2 — https://github.com/acme/web/pull/2',
                    gates: [{ name: 'test', status: 'passed', exitCode: 0, output: 'ok' }],
                    runtime,
                }),
            ],
        });
        const layout = html.slice(html.indexOf('task-layout'));
        const main = layout.slice(layout.indexOf('task-main'), layout.indexOf('task-support'));
        const support = layout.slice(layout.indexOf('task-support'));
        const orderIn = (region: string, headings: string[]) => {
            const order = headings.map((h) => region.indexOf(`<h2>${h}</h2>`));
            expect(order.every((at) => at >= 0)).toBe(true);
            expect(order).toEqual([...order].sort((a, b) => a - b));
        };
        orderIn(main, ['Conversation', 'Follow up']);
        orderIn(support, ['Services', 'Run history', 'Verification', 'Published work']);
        for (const heading of ['Run history', 'Verification', 'Services', 'Published work']) {
            expect(main).not.toContain(`<h2>${heading}</h2>`);
        }
        // The rail leads the DOM, so a narrow screen reads the summary first, the panels last.
        expect(html.indexOf('task-outcome')).toBeLessThan(html.indexOf('task-main'));
        expect(html.indexOf('task-main')).toBeLessThan(html.indexOf('task-support'));
    });

    it('publishes the branch as a copyable chip and links only a safe PR url', () => {
        const html = renderDetail({
            jobs: [job({ output: '[driver] published fix/2 — https://github.com/acme/web/pull/2' })],
        });
        const published = html.slice(html.indexOf('task-published'));
        expect(published).toContain('fix/2</code>');
        expect(published).toContain('aria-label="Copy branch name"');
        expect(published).toContain('href="https://github.com/acme/web/pull/2"');
        expect(published).toContain('Pull request #2');

        const unsafe = renderDetail({ jobs: [job({ output: '[driver] published fix/odd — javascript:alert(1)' })] });
        expect(unsafe).toContain('fix/odd</code>');
        expect(unsafe).not.toContain('href="javascript:');
    });
});
