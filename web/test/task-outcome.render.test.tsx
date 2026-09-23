import { describe, expect, it } from 'vitest';
import { FORBIDDEN, job, renderDetail } from './tasks-fixtures.js';

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
});

describe('TaskOutcome — gates, publication and services', () => {
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
});

describe('TaskOutcome — services and the placeholder sweep', () => {
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
