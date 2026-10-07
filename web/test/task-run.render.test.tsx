import { describe, expect, it } from 'vitest';
import type { Job, RuntimeVitals } from '../src/api/useJobs.js';
import { job, question, renderDetail } from './tasks-fixtures.js';

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

    it('names each finished run’s response and keeps its raw output behind one disclosure per run', () => {
        const html = renderDetail({
            jobs: [
                { ...root, summary: 'first answer', output: 'first log' },
                child({ summary: 'second answer', output: 'second log' }),
            ],
        });
        expect(html.match(/<details class="run-output"(?! open)/g)?.length).toBe(2);
        expect(html.match(/View raw output/g)?.length).toBe(2);
        expect(html).toContain('Agent response · Run 1');
        expect(html).toContain('Agent response · Run 2');
        expect(html).toContain('second answer');
    });

    it('a live run offers the same disclosure, expanded, beside its activity', () => {
        const live = articleOf(
            renderDetail({
                jobs: [job({ status: 'running', output: 'tail', runtime: runtime({ activity: '→ Bash npm test' }) })],
            }),
            'Agent activity'
        );
        expect(live).toMatch(/<details class="run-output" open="">/);
        expect(live).toContain('View raw output');
        expect(live.indexOf('→ Bash npm test')).toBeLessThan(live.indexOf('View raw output'));
    });

    it('a live follow-up collapses independently of the finished run before it', () => {
        const html = renderDetail({
            jobs: [
                { ...root, summary: 'first answer', output: 'first log' },
                child({ status: 'running', output: 'second log' }),
            ],
        });
        const [first, second] = html.split('<article').slice(1);
        expect(first).not.toMatch(/<details[^>]*open/);
        expect(second).toMatch(/<details class="run-output" open="">/);
    });

    it('a live run without output keeps the waiting message and offers no disclosure', () => {
        const html = articleOf(renderDetail({ jobs: [job({ status: 'queued', output: null })] }), 'Agent activity');
        expect(html).toContain('Waiting for the executor…');
        expect(html).not.toContain('View raw output');
    });

    it('keeps status and failure metadata after the response and its output', () => {
        const html = articleOf(
            renderDetail({ jobs: [job({ status: 'failed', exitCode: 2, output: 'raw lines' })] }),
            '<article'
        );
        expect(html.indexOf('</details>')).toBeLessThan(html.indexOf('exit 2'));
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
});

describe('TaskRun — gates, publication and metadata', () => {
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

    it('carries no gates or publication of its own — those are the task panels', () => {
        const gates = [{ name: 'test', status: 'passed' as const, exitCode: 0, output: 'ok' }];
        const html = renderDetail({
            jobs: [{ ...root, gates }, child({ output: '[driver] published fix/2 — https://github.com/o/r/pull/2' })],
        });
        for (const marker of ['first command', 'second command']) {
            const article = articleOf(html, marker);
            expect(article, marker).not.toContain('chat-gate-list');
            expect(article, marker).not.toContain('Pull request');
        }
    });

    it('the outcome links View checks only when the newest run has gates', () => {
        const gates = [{ name: 'test', status: 'passed' as const, exitCode: 0, output: 'ok' }];
        const linked = renderDetail({ jobs: [job({ gates })] });
        expect(linked).toContain('>View checks</a>');
        expect(linked).toContain('href="#task-verification"');
        expect(linked).toContain('id="task-verification"');
        expect(renderDetail({ jobs: [{ ...root, gates }, child()] })).not.toContain('View checks');
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
        const responseAt = article.indexOf('Agent response');
        const metaAt = article.indexOf('msg-meta', responseAt);
        expect(responseAt).toBeGreaterThan(-1);
        expect(metaAt).toBeGreaterThan(responseAt);
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
});

describe('TaskRun — footer attribution, prompt and output wells', () => {
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

    it('carries the stop and done attributions in the footer', () => {
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
        // The run's own raw output well; the gate's well is Verification's, outside the article.
        expect(finished.match(/tabindex="0"/g)?.length).toBe(1);
    });
});

describe('TaskRun — failure kind (issue #339)', () => {
    const articleOf = (html: string, marker: string): string => {
        const start = html.indexOf(marker);
        return html.slice(start, html.indexOf('</article>', start));
    };

    it('a failed run with a structured kind renders the named bad pill', () => {
        const html = articleOf(
            renderDetail({ jobs: [job({ status: 'failed', exitCode: null, failureKind: 'timeout' })] }),
            'fix the flaky login test'
        );
        expect(html).toMatch(/<span class="pill pill-bad">timed out<\/span>/);
    });

    it('a run without a kind renders no failure pill', () => {
        const html = articleOf(renderDetail({ jobs: [job()] }), 'fix the flaky login test');
        expect(html).not.toContain('pill-bad');
    });
});

describe('TaskRun — questions (issue #534)', () => {
    const articleOf = (html: string, marker: string): string => {
        const start = html.indexOf(marker);
        return html.slice(start, html.indexOf('</article>', start));
    };

    it('renders a run’s questions after its response and before its raw output, in askedAt order', () => {
        const later = question({
            id: 'toolu_02',
            askedAt: '2026-09-01T12:03:00.000Z',
            questions: [{ question: 'Second ask?', header: 'Two', multiSelect: false, options: [{ label: 'Yes' }] }],
        });
        const earlier = question({ status: 'answered', answerable: false, answers: { 'Which database?': 'SQLite' } });
        const html = articleOf(
            renderDetail({
                jobs: [job({ summary: 'the answer', output: 'the log', questions: [later, earlier] })],
            }),
            'fix the flaky login test'
        );
        const order = ['the answer', 'Which database?', 'Second ask?', 'View raw output'].map((text) =>
            html.indexOf(text)
        );
        expect(order.every((at) => at > -1)).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('a live run’s question sits after its activity line and before its raw output', () => {
        const html = articleOf(
            renderDetail({
                jobs: [
                    job({
                        status: 'running',
                        finishedAt: null,
                        exitCode: null,
                        output: 'tail',
                        runtime: {
                            cpuPercent: null,
                            memUsedMb: null,
                            memPercent: null,
                            activity: 'asking a question',
                            sampledAt: '2026-09-01T12:02:00.000Z',
                        },
                        questions: [question()],
                    }),
                ],
            }),
            'fix the flaky login test'
        );
        expect(html.indexOf('asking a question')).toBeLessThan(html.indexOf('Which database?'));
        expect(html.indexOf('Which database?')).toBeLessThan(html.indexOf('View raw output'));
        expect(html).toContain('Claude is waiting for your answer');
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

    it('a terminal open sessionless run still offers the composer', () => {
        const html = renderDetail({ jobs: [job({ sessionId: null })] });
        expect(html).toContain('Ask for a follow-up');
    });

    it('a closed task renders no composer', () => {
        const html = renderDetail({ jobs: [job({ doneAt: '2026-09-01T13:00:00.000Z' })] });
        expect(html).not.toContain('Ask for a follow-up');
    });
});
