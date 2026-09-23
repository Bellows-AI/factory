import { describe, expect, it } from 'vitest';
import type { Job, RuntimeVitals } from '../src/api/useJobs.js';
import { job, renderDetail } from './tasks-fixtures.js';

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
