import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isTerminal, type Job } from '../src/api/useJobs.js';
import { taskTime } from '../src/format.js';
import { TasksPanel } from '../src/panels/TasksPanel.js';

/**
 * The same contract the other panel suites pin: props in, markup out, and no DOM — `useEffect`
 * never runs under renderToStaticMarkup, so the hooks are exercised by the page that owns them and
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
        createdAt: '2026-09-01T12:00:00.000Z',
        startedAt: '2026-09-01T12:00:01.000Z',
        finishedAt: '2026-09-01T12:04:00.000Z',
        sessionId: null,
        remoteSessionId: null,
        ...overrides,
    };
}

interface RenderArgs {
    repos?: { owner: string; name: string }[] | null;
    workspaceError?: string | null;
    executors?: { name: string; type: string }[];
    repo?: string | null;
    jobs?: Job[] | null;
    detail?: Job | null;
    detailError?: string | null;
    selectedId?: string | null;
}

const render = ({
    repos = [{ owner: 'acme', name: 'web' }],
    workspaceError = null,
    executors = [],
    repo = null,
    jobs = [],
    detail = null,
    detailError = null,
    selectedId = null,
}: RenderArgs = {}) =>
    renderToStaticMarkup(
        <TasksPanel
            repos={repos}
            workspaceError={workspaceError}
            onRetryWorkspace={() => {}}
            executors={executors}
            repo={repo}
            onRepo={() => {}}
            jobs={jobs}
            detail={detail}
            detailError={detailError}
            selectedId={selectedId}
            onSelect={() => {}}
            onResume={async () => {}}
            onSend={async () => null}
            sending={false}
        />,
    );

describe('TasksPanel', () => {
    it('renders an All tab plus one per selected repository, marking the active one', () => {
        const html = render({
            repos: [
                { owner: 'acme', name: 'web' },
                { owner: 'acme', name: 'api' },
            ],
            repo: 'acme/api',
        });
        expect(html).toContain('>All</button>');
        expect(html).toContain('acme/web');
        expect(html).toContain('acme/api');
        // Exactly one tab carries the marker, and it is the active one.
        const active = html.match(/class="tab is-active"[^>]*>([^<]*)</g) ?? [];
        expect(active).toHaveLength(1);
        expect(active[0]).toContain('acme/api');
    });

    it('renders one exchange per job, oldest first', () => {
        // The API returns newest first; a chat reads top-down, oldest at the top.
        const newer = job({ id: '22222222-2222-4222-8222-222222222222', command: 'newer task', createdAt: '2026-09-02T12:00:00.000Z' });
        const older = job({ id: '33333333-3333-4333-8333-333333333333', command: 'older task', createdAt: '2026-09-01T12:00:00.000Z' });
        const html = render({ jobs: [newer, older] });
        expect(html.indexOf('older task')).toBeLessThan(html.indexOf('newer task'));
        expect(html).toContain('succeeded');
    });

    it('names the executor of a task, and nothing when it has none', () => {
        const labelled = render({ jobs: [job({ executor: 'main' })] });
        expect(labelled).toContain('main');
        const bare = render({ jobs: [job()] });
        expect(bare).not.toContain('undefined');
    });

    it('renders the executor output as text, never as markup', () => {
        const html = render({
            jobs: [job()],
            selectedId: '11111111-1111-4111-8111-111111111111',
            detail: job({ output: '<script>alert(1)</script>' }),
        });
        // Container output is arbitrary text; escaping it is the difference between a transcript
        // and a hole.
        expect(html).toContain('&lt;script&gt;');
        expect(html).not.toContain('<script>');
        expect(html).toContain('<pre');
    });

    it('claims nothing about an output that has not loaded yet', () => {
        // A finished task whose detail has not arrived must not read as one with no output —
        // that is a false statement about a run somebody is waiting on.
        const html = render({
            jobs: [job()],
            selectedId: '11111111-1111-4111-8111-111111111111',
        });
        expect(html).toContain('Loading output');
        expect(html).not.toContain('No output recorded');
    });

    it('says so in place when the output could not be loaded', () => {
        const html = render({
            jobs: [job()],
            selectedId: '11111111-1111-4111-8111-111111111111',
            detailError: 'Request failed (503)',
        });
        expect(html).toContain('Request failed (503)');
    });

    it('shows the exit code of a finished run', () => {
        const html = render({ jobs: [job({ status: 'failed', exitCode: 1 })] });
        expect(html).toContain('exit 1');
    });

    it('offers Resume only on a standby job', () => {
        const parked = render({ jobs: [job({ status: 'standby' })] });
        expect(parked).toContain('Resume');
        const running = render({ jobs: [job({ status: 'running' })] });
        expect(running).not.toContain('Resume');
    });

    it('never emits a placeholder value', () => {
        const html = render({
            repos: [{ owner: 'acme', name: 'web' }],
            jobs: [
                job({ executor: null, repo: null, output: null, exitCode: null, finishedAt: null, startedAt: null }),
                job({ status: 'standby', exitCode: null }),
            ],
        });
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('shows an empty-state sentence when the tab has no jobs', () => {
        const html = render({ jobs: [] });
        expect(html).toMatch(/No tasks/);
    });

    it('keeps the All thread and composer reachable when no repository is selected', () => {
        // A deselected repository must not take its jobs with it: repo-less tasks stay on All.
        const html = render({ repos: [], jobs: [job({ status: 'standby', command: 'resume me without a repo' })] });
        expect(html).toContain('>All</button>');
        expect(html).toContain('<textarea');
        expect(html).toContain('>Send<');
        expect(html).toContain('resume me without a repo');
        expect(html).toContain('Resume');
        expect(html).not.toMatch(/Select repositories/);
    });

    it('does not blame the selection for a workspace that has not answered', () => {
        // "Not known yet" and "known empty" are different sentences: an unreachable workspace must
        // not read as a member who never picked anything.
        expect(render({ repos: null })).toMatch(/Loading your workspace/);
    });

    it('says so, with a way back in, when the workspace could not be loaded', () => {
        const html = render({ repos: null, workspaceError: 'Request failed (503)' });
        expect(html).toContain('Request failed (503)');
        expect(html).toContain('Retry');
        expect(html).not.toMatch(/Select repositories/);
    });

    it('disables Send until a command is typed', () => {
        // The composer starts empty, which is exactly the state a fresh render has.
        const html = render({});
        const send = html.slice(html.indexOf('>Send<') - 200, html.indexOf('>Send<'));
        expect(send).toContain('disabled');
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
