import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { removeDialogBody, removeDialogTitle, TaskRemoveDialog } from '../src/components/TaskRemoveDialog.js';
import { FORBIDDEN, job, renderHeader } from './tasks-fixtures.js';

describe('the task page header', () => {
    /**
     * The page-level head of `/tasks/:id`: the task's name as the page's one `h1`, its status,
     * wall clock and live activity in the meta slots, and every action the task can take in the
     * actions slot — lifted out of the conversation panel (#159).
     */

    it("names the task after its opening command, as the page's one h1", () => {
        const html = renderHeader({ jobs: [job()] });
        expect(html.match(/<h1/g)?.length).toBe(1);
        expect(html).toContain('<h1>fix the flaky login test</h1>');

        // A multi-line command is prose; the header carries its first line, the turn carries it all.
        const multiline = renderHeader({ jobs: [job({ command: 'first line\nsecond line' })] });
        expect(multiline).toContain('<h1>first line</h1>');
        expect(multiline).not.toContain('second line');
    });

    it('keeps the plain Tasks heading while nothing is loaded', () => {
        // No task yet, so there is nothing to name — the detail poll has not landed.
        const html = renderHeader({ jobs: null });
        expect(html).toContain('<h1>Tasks</h1>');
        expect(html).not.toContain('>Stop run<');
        expect(html).not.toContain('>Mark done<');
        expect(html).not.toContain('More task actions');
    });

    it('shows the status beside the title as the shared label in its tone', () => {
        const html = renderHeader({ jobs: [job()] });
        expect(html).toContain('page-header-meta');
        expect(html).toMatch(/<span class="pill pill-accent" aria-live="polite">.*Succeeded · Needs review<\/span>/);
        expect(renderHeader({ jobs: [job({ status: 'failed' })] })).toMatch(
            /<span class="pill pill-bad" aria-live="polite">.*Failed · Needs review<\/span>/
        );
        expect(renderHeader({ jobs: [job({ status: 'stopped' })] })).toContain('Stopped · Needs review');
        const running = renderHeader({ jobs: [job({ status: 'running', finishedAt: null, exitCode: null })] });
        expect(running).toMatch(
            /<span class="pill pill-ok" aria-live="polite"><span class="sidenav-dot sidenav-dot-running"/
        );
    });

    it('reads Done — not Waiting for review — once a parked wait is marked done', () => {
        const html = renderHeader({
            jobs: [
                job({
                    waitReason: 'review',
                    waitingSince: '2026-09-01T12:30:00.000Z',
                    doneAt: '2026-09-01T13:00:00.000Z',
                }),
            ],
        });
        expect(html).toMatch(/<span class="pill pill-done task-pill-done" aria-live="polite">.*Done<\/span>/);
        expect(html).not.toContain('Waiting for review');
    });

    it('names the task #id · Opened … by login · repo', () => {
        const author = { id: 'a', login: 'octocat', name: 'Octo Cat', avatarUrl: null };
        const html = renderHeader({ jobs: [job({ author, repo: 'acme/web' })] });
        expect(html).toContain('page-header-description');
        expect(html).toContain('title="11111111-1111-4111-8111-111111111111">#11111111<');
        expect(html).toContain('<time dateTime="2026-09-01T12:00:00.000Z"');
        expect(html).toContain('<span class="avatar avatar-fallback" aria-hidden="true">O</span>octocat');
        expect(html).toContain('acme/web');

        // A pre-accounts row says so; no repository, no repository segment.
        const bare = renderHeader({ jobs: [job()] });
        expect(bare).toContain('<span class="task-opened-by">unknown</span>');
        expect(bare).not.toContain('acme/web');
    });

    it('adds a Verification failed pill while the newest run has a failed gate', () => {
        const gates = [{ name: 'lint', status: 'failed' as const, exitCode: 1, output: 'nope' }];
        expect(renderHeader({ jobs: [job({ gates })] })).toContain('Verification failed');
        expect(renderHeader({ jobs: [job()] })).not.toContain('Verification failed');
    });

    it('shows Waiting for review instead of the raw status while a PR-review wait is open', () => {
        const html = renderHeader({
            jobs: [
                job({
                    status: 'queued',
                    waitReason: 'review',
                    exitCode: null,
                    finishedAt: null,
                    startedAt: null,
                    output: null,
                }),
            ],
        });
        expect(html).toMatch(
            /<span class="pill pill-done task-pill-wait" aria-live="polite">.*Waiting for review<\/span>/
        );
        expect(html).not.toContain('>queued<');
    });

    it('preserves Stop run while waiting, with copy explaining it cancels automation but not the PR', () => {
        const html = renderHeader({
            jobs: [
                job({
                    status: 'queued',
                    waitReason: 'review',
                    exitCode: null,
                    finishedAt: null,
                    startedAt: null,
                    output: null,
                }),
            ],
        });
        expect(html).toContain('>Stop run<');
        expect(html).toMatch(/cancels remaining automation/i);
        expect(html).toMatch(/not close|does not close/i);
    });

    /** The action matrix: stoppable = queued/running, done = the one primary, closed = text. */
    it('offers Stop run on every state a stop can land on — queued, running', () => {
        // The board accepts queued stops, not just a moving run.
        for (const status of ['queued', 'running'] as const) {
            const html = renderHeader({
                jobs: [job({ status, exitCode: null, finishedAt: null, startedAt: null, output: null })],
            });
            expect(html, status).toContain('>Stop run<');
            expect(html, status).toContain('chat-stop');
        }
        for (const status of ['succeeded', 'failed', 'dead', 'stopped'] as const) {
            const html = renderHeader({ jobs: [job({ status })] });
            expect(html, status).not.toContain('>Stop run<');
            expect(html, status).not.toContain('Stopping…');
        }
    });

    it('says Stopping, not Stop run, once the stop request has landed but the run has not parked', () => {
        // The board settles the stop at the worker's next heartbeat: pending is not terminal, so
        // the pending state is a disabled, busy control, never one that looks clickable again.
        const html = renderHeader({
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
        expect(html).not.toContain('>Stop run<');
        // A run in flight cannot be removed yet: the board refuses with TASK_RUNNING.
        expect(html).not.toContain('More task actions');
    });

    it('says Stopping while the stop request itself is in flight, and cannot be re-clicked', () => {
        const task = job({ status: 'running', exitCode: null, finishedAt: null, startedAt: null, output: null });
        const html = renderHeader({ jobs: [task], stoppingId: task.id });
        expect(html).toContain('Stopping…');
        expect(html).not.toContain('>Stop run<');
        const LOOKBEHIND_CHARS = 300;
        const stop = html.slice(html.indexOf('Stopping…') - LOOKBEHIND_CHARS, html.indexOf('Stopping…'));
        expect(stop).toContain('disabled');
    });
});

describe('the task page header — Mark done, overflow and meta', () => {
    it('offers Mark done as the one primary action on an open task', () => {
        const open = renderHeader({ jobs: [job()] });
        expect(open).toContain('>Mark done<');
        const LOOKBEHIND_CHARS = 300;
        const doneButton = open.slice(open.indexOf('>Mark done<') - LOOKBEHIND_CHARS, open.indexOf('>Mark done<'));
        expect(doneButton).toContain('class="primary"');
        // Failed, dead and stopped are open too until somebody closes them; a failure the viewer
        // cannot follow up (another member's) offers Mark done as its primary.
        const other = { loading: false, id: 'someone-else' };
        for (const status of ['failed', 'dead', 'stopped'] as const) {
            expect(renderHeader({ jobs: [job({ status })], viewer: other }), status).toContain('>Mark done<');
        }

        const done = renderHeader({ jobs: [job({ doneAt: '2026-09-01T13:00:00.000Z' })] });
        expect(done).not.toContain('>Mark done<');

        // Done is unrelated to sessions and stays available for a run without one.
        const sessionless = renderHeader({ jobs: [job({ sessionId: null })] });
        expect(sessionless).toContain('>Mark done<');
    });

    it('labels an in-flight Mark done and disables it', () => {
        const task = job();
        const html = renderHeader({ jobs: [task], doneId: task.id });
        expect(html).toContain('Marking done…');
        expect(html).not.toContain('>Mark done<');
        const LOOKBEHIND_CHARS = 300;
        const done = html.slice(html.indexOf('Marking done…') - LOOKBEHIND_CHARS, html.indexOf('Marking done…'));
        expect(done).toContain('disabled');
    });

    it('shows closure attribution as status text, never a disabled control', () => {
        const author = { id: 'a', login: 'octocat', name: null, avatarUrl: null };
        const attributed = renderHeader({ jobs: [job({ doneAt: '2026-09-01T13:00:00.000Z', doneBy: author })] });
        expect(attributed).toContain('Closed by octocat · <time dateTime="2026-09-01T13:00:00.000Z"');
        expect(attributed).not.toContain('disabled');

        // No actor recorded — pre-accounts row — still says the closure out loud.
        const plain = renderHeader({ jobs: [job({ doneAt: '2026-09-01T13:00:00.000Z' })] });
        expect(plain).toContain('Closed · <time dateTime="2026-09-01T13:00:00.000Z"');
        expect(plain).not.toContain('disabled');
        expect(plain).not.toContain('>Mark done<');
    });

    it('keeps Remove task out of the main action row, behind More task actions', () => {
        for (const status of ['queued', 'succeeded', 'failed', 'dead', 'stopped'] as const) {
            const html = renderHeader({ jobs: [job({ status })] });
            expect(html, status).toContain('More task actions');
            // The destructive item lives in the anchored menu, which only the client renders;
            // the server-rendered action row must carry no Remove control of its own.
            expect(html, status).not.toContain('>Remove task<');
            expect(html, status).not.toContain('>Remove<');
            // The overflow trigger is a secondary control — the page's one primary is Mark done.
            const at = html.indexOf('More task actions');
            const trigger = html.slice(html.lastIndexOf('<button', at), at);
            expect(trigger, status).not.toContain('primary');
        }
    });

    it('hides More task actions while any member of the thread is running', () => {
        const moving = { exitCode: null, finishedAt: null, startedAt: null, output: null };
        expect(renderHeader({ jobs: [job({ status: 'running', ...moving })] })).not.toContain('More task actions');

        // A follow-up still going closes the whole thread's menu — the removal would race the run.
        const root = job({ status: 'stopped' });
        const child = {
            ...job({ status: 'running', ...moving }),
            id: '44444444-4444-4444-8444-444444444444',
            followUpTo: root.id,
            rootJobId: root.id,
        };
        expect(renderHeader({ jobs: [root, child] })).not.toContain('More task actions');

        // Queued members do not block it: the board has no run to refuse.
        const queued = {
            ...job({ status: 'queued', ...moving }),
            id: '44444444-4444-4444-8444-444444444444',
            followUpTo: root.id,
            rootJobId: root.id,
        };
        expect(renderHeader({ jobs: [root, queued] })).toContain('More task actions');
    });

    it('renders the actions on the newest run only — history runs grow none', () => {
        const root = job({ command: 'first command' });
        const child = {
            ...job({ command: 'second command', status: 'stopped' }),
            id: '44444444-4444-4444-8444-444444444444',
            followUpTo: root.id,
            rootJobId: root.id,
        };
        const html = renderHeader({ jobs: [root, child] });
        expect(html.match(/>Mark done</g)).toHaveLength(1);
        expect(html.match(/More task actions/g)).toHaveLength(1);
        expect(html).not.toContain('>Stop run<');
    });

    it('renders no empty action wrapper in any state', () => {
        for (const status of ['queued', 'running', 'succeeded', 'failed', 'dead', 'stopped'] as const) {
            const html = renderHeader({ jobs: [job({ status })] });
            expect(html, status).not.toContain('<div class="task-actions"></div>');
        }
    });

    it('shows the overall wall clock in the meta, and a dash where nothing is measurable', () => {
        const timed = renderHeader({ jobs: [job({ taskWallClockMs: 5_400_000 })] });
        expect(timed).toContain('1.5h');

        const untimed = renderHeader({ jobs: [job()] });
        expect(untimed).toContain('—');
    });

    it('shows the live activity line in the meta while the newest run is going', () => {
        // Same line the sidebar's "Task" row and the sidenav read — page level now (#159).
        const runtime = {
            cpuPercent: 12,
            memUsedMb: 300,
            memPercent: null,
            activity: '→ Bash npm test',
            sampledAt: '2026-09-01T12:02:00.000Z',
        };
        const html = renderHeader({ jobs: [job({ status: 'running', runtime })] });
        expect(html).toContain('task-summary');
        expect(html).toContain('→ Bash npm test');

        // Not on a task whose newest run is not going.
        const quiet = renderHeader({ jobs: [job()] });
        expect(quiet).not.toContain('task-summary');
    });

    it('never emits a placeholder value', () => {
        const html = renderHeader({
            jobs: [job({ taskWallClockMs: null, output: null, exitCode: null, finishedAt: null, startedAt: null })],
        });
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});

describe('the task page header — the action matrix (plan §3.2)', () => {
    const me = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', login: 'me', name: null, avatarUrl: null };
    const other = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', login: 'kim', name: null, avatarUrl: null };
    const viewer = { loading: false, id: me.id };
    const moving = { exitCode: null, finishedAt: null, output: null };
    const wait = { waitReason: 'review', waitingSince: '2026-09-01T12:30:00.000Z' };
    const failedGate = [{ name: 'lint', status: 'failed' as const, exitCode: 1, output: 'nope' }];
    const MARK_DONE_COPY = 'Closes this task in Bellows. Does not merge or close the pull request.';
    const PARKED_COPY = 'No executor is running. The workflow is waiting for review.';
    /** The primary button's markup: the one `class="primary"` button in the row. */
    const primaryOf = (html: string) => html.match(/<button type="button" class="primary"[^>]*>([^<]*)</)?.[1] ?? null;

    it('queued: Stop run, with Remove in More and no Mark done', () => {
        const html = renderHeader({ jobs: [job({ status: 'queued', startedAt: null, ...moving })], viewer });
        expect(html).toContain('>Stop run<');
        expect(primaryOf(html)).toBeNull();
        expect(html).toContain('More task actions');
    });

    it('running: Stop run, and no More while a member runs', () => {
        const html = renderHeader({ jobs: [job({ status: 'running', ...moving })], viewer });
        expect(html).toContain('>Stop run<');
        expect(html).not.toContain('More task actions');
    });

    it('running with a stop requested: one disabled, busy Stopping… button', () => {
        const html = renderHeader({
            jobs: [job({ status: 'running', cancelRequestedAt: '2026-09-01T12:01:00.000Z', ...moving })],
            viewer,
        });
        expect(html).toContain(
            '<button type="button" class="chat-resume chat-stop" disabled="" aria-busy="true">Stopping…</button>'
        );
        expect(html).not.toContain('>Stop run<');
        expect(html).not.toContain('More task actions');
    });

    it('terminal with an open wait: Mark done and the parked copy, never Stop run', () => {
        for (const status of ['succeeded', 'failed'] as const) {
            const html = renderHeader({ jobs: [job({ status, author: me, ...wait })], viewer });
            // A failure parked on its review wait is the wait's to settle — no Ask for another pass.
            expect(primaryOf(html), status).toBe('Mark done');
            expect(html, status).toContain(PARKED_COPY);
            expect(html, status).not.toContain('>Stop run<');
            expect(html, status).toContain('More task actions');
        }
    });

    it('succeeded with no wait: Mark done, with what it does and does not do', () => {
        const html = renderHeader({ jobs: [job({ author: me })], viewer });
        expect(primaryOf(html)).toBe('Mark done');
        expect(html).toContain(MARK_DONE_COPY);
        expect(html).not.toContain(PARKED_COPY);
        const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
        expect(describedBy).toBeDefined();
        expect(html).toContain(`id="${describedBy}">${MARK_DONE_COPY}`);
    });

    it('failed, dead or verification failed, and eligible: Ask for another pass, Mark done moves to More', () => {
        const cases = [
            job({ status: 'failed', author: me }),
            job({ status: 'dead', author: me }),
            job({ author: me, gates: failedGate }),
            job({ status: 'failed', author: me, sessionId: null }),
        ];
        for (const latest of cases) {
            const html = renderHeader({ jobs: [latest], viewer });
            expect(primaryOf(html), latest.status).toBe('Ask for another pass');
            expect(html, latest.status).not.toContain(MARK_DONE_COPY);
            expect(html, latest.status).toContain('More task actions');
        }
    });

    it('failed and not eligible: Mark done — another member, or a session still loading', () => {
        const refusals = [
            { jobs: [job({ status: 'failed', author: other })], viewer },
            { jobs: [job({ status: 'failed', author: me })], viewer: { loading: true, id: null } },
        ];
        for (const args of refusals) {
            const html = renderHeader(args);
            expect(primaryOf(html)).toBe('Mark done');
            expect(html).not.toContain('Ask for another pass');
        }
    });

    it('stopped: Mark done', () => {
        expect(primaryOf(renderHeader({ jobs: [job({ status: 'stopped', author: me })], viewer }))).toBe('Mark done');
    });

    it('done, whatever the wait: no primary, the closure, and Remove in More', () => {
        const html = renderHeader({
            jobs: [job({ status: 'failed', author: me, doneAt: '2026-09-01T13:00:00.000Z', doneBy: me, ...wait })],
            viewer,
        });
        expect(primaryOf(html)).toBeNull();
        expect(html).toContain('Closed by me');
        expect(html).not.toContain(PARKED_COPY);
        expect(html).toContain('More task actions');
    });

    it('Stop, Mark done and Remove carry no author restriction', () => {
        const stranger = { loading: false, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
        expect(
            renderHeader({ jobs: [job({ status: 'running', author: other, ...moving })], viewer: stranger })
        ).toContain('>Stop run<');
        const done = renderHeader({ jobs: [job({ author: other })], viewer: stranger });
        expect(primaryOf(done)).toBe('Mark done');
        expect(done).toContain('More task actions');
    });
});

describe('TaskRemoveDialog', () => {
    /**
     * The remove confirmation is a Headless UI Dialog, so it portals — and `renderToStaticMarkup`
     * does not render portals: an open dialog server-renders as Headless' placeholder span, the
     * same posture the mobile drawer's suite pins. The in-dialog contracts (initial focus, Escape,
     * backdrop, focus restoration, the live error) are a real browser's to assert —
     * e2e/task-detail.spec.ts owns them. What a static render CAN hold is the copy the dialog
     * renders: the helpers below are the component's source of truth, exported pure.
     */
    const renderDialog = (over: { open?: boolean } = {}) =>
        renderToStaticMarkup(
            <TaskRemoveDialog
                open={over.open ?? true}
                command="fix the flaky login test"
                runCount={2}
                removing={false}
                error={null}
                onClose={() => {}}
                onConfirm={() => {}}
            />
        );

    it('server-renders a placeholder until the client mounts, open or closed', () => {
        expect(renderDialog()).toContain('<span hidden');
        expect(renderDialog({ open: false })).toContain('<span hidden');
    });

    it('names the task in the title \u2014 the root command\u2019s first line, whatever the prose', () => {
        expect(removeDialogTitle('fix the flaky login test')).toBe('Remove \u201Cfix the flaky login test\u201D?');
        expect(removeDialogTitle('first line\nsecond line')).toBe('Remove \u201Cfirst line\u201D?');
    });

    it('states every consequence in the body, with the thread\u2019s real run count', () => {
        const RUN_COUNT = 3;
        const body = removeDialogBody(RUN_COUNT);
        expect(body).toContain('permanently deletes all 3 runs');
        expect(body).toContain('their transcript');
        expect(body).toContain('worktree will be queued for deletion');
        expect(body).toContain('Published branches and pull requests are not deleted');
        expect(body).toContain('cannot be undone');
        // The count is the thread's length, not a decoration: one run reads as one.
        expect(removeDialogBody(1)).toContain('deletes all 1 runs');
    });
});

describe('the remove flow', () => {
    /** The `window.confirm` path is the thing this dialog replaces — it must be gone outright. */
    it('carries no window.confirm anywhere in the task actions', () => {
        const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
        expect(read('../src/pages/TaskDetailPage.tsx')).not.toContain('window.confirm');
        expect(read('../src/panels/TaskHeader.tsx')).not.toContain('window.confirm');
    });
});
