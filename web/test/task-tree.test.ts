import { describe, expect, it } from 'vitest';
import type { Job } from '../src/api/useJobs.js';
import { chainHead, taskDotClass, taskSections, taskStatus, taskSummary, taskTitle } from '../src/task-tree.js';

/**
 * The task tree's model is pure — sections are computed from the poll's rows and nothing else —
 * so this suite pins the rules without a DOM or a router: which section a task belongs to, the
 * order inside each one, and the chain resolution the dot and the summary share.
 */

/** Timestamps on one clock, so tests can name "12:07" rather than spell ISO strings. */
const at = (minute: number): string => new Date(Date.UTC(2026, 8, 1, 12, minute)).toISOString();

let seq = 0;
const job = (id: string, overrides: Partial<Job> = {}): Job => ({
    id,
    command: `command ${id}`,
    status: 'succeeded',
    attempts: 1,
    author: null,
    stoppedBy: null,
    doneBy: null,
    exitCode: 0,
    output: null,
    repo: null,
    executor: null,
    followUpTo: null,
    // A root by default; a follow-up overrides both spine fields together.
    rootJobId: id,
    doneAt: null,
    cancelRequestedAt: null,
    workspacePath: null,
    createdAt: new Date(Date.UTC(2026, 8, 1, 12, 0, 0) + seq++ * 1000).toISOString(),
    startedAt: null,
    finishedAt: null,
    wallClockMs: null,
    taskWallClockMs: null,
    summary: null,
    sessionId: null,
    remoteSessionId: null,
    ...overrides,
});
const followUp = (id: string, rootId: string, overrides: Partial<Job> = {}): Job =>
    job(id, { followUpTo: rootId, rootJobId: rootId, ...overrides });
const sampled = (activity: string): Partial<Job> => ({
    status: 'running',
    runtime: { cpuPercent: 12, memUsedMb: 300, memPercent: null, activity, sampledAt: '2026-09-01T12:05:00.000Z' },
});

describe('taskSections', () => {
    it('sorts every status into one of the three sections', () => {
        // Non-terminal heads are live work; terminal heads without the user's verdict wait for
        // review; a stamped done_at is the only way into the past.
        for (const status of ['queued', 'running', 'standby'] as const) {
            const sections = taskSections([job('a', { status })]);
            expect(
                sections.running.map((entry) => entry.id),
                status
            ).toEqual(['a']);
            expect(sections.review, status).toHaveLength(0);
            expect(sections.past, status).toHaveLength(0);
        }
        for (const status of ['succeeded', 'failed', 'dead', 'stopped'] as const) {
            const sections = taskSections([job('a', { status })]);
            expect(
                sections.review.map((entry) => entry.id),
                status
            ).toEqual(['a']);
            expect(sections.running, status).toHaveLength(0);
            expect(sections.past, status).toHaveLength(0);
        }
        for (const status of ['succeeded', 'failed', 'dead', 'stopped'] as const) {
            const sections = taskSections([job('a', { status, doneAt: at(30) })]);
            expect(
                sections.past.map((entry) => entry.id),
                status
            ).toEqual(['a']);
            expect(sections.running, status).toHaveLength(0);
            expect(sections.review, status).toHaveLength(0);
        }
    });

    it('keeps a run with a stop in flight in Running — it is still moving until it parks', () => {
        const sections = taskSections([job('a', { status: 'running', cancelRequestedAt: at(30) })]);
        expect(sections.running).toHaveLength(1);
        expect(sections.review).toHaveLength(0);
    });

    it('lists thread roots only, and answers for the whole chain through the root', () => {
        const root = job('a', { status: 'running' });
        const child = followUp('b', 'a', { status: 'failed' });
        const sections = taskSections([child, root]);
        // One entry, keyed by the root's id — the follow-up is a row on the board, not a task —
        // and its section is the head's: the child's failed run is what waits for review.
        expect(sections.review.map((entry) => entry.id)).toEqual(['a']);
        expect(sections.review[0]!.status).toEqual({ status: 'failed', cancelRequestedAt: null, doneAt: null });
        expect(sections.running).toHaveLength(0);
    });

    it('lists nothing for a follow-up whose root is not in the polled window', () => {
        // A root absent from the list has no row to link to; it stays invisible, exactly as the
        // tree behaved before sections.
        const orphan = followUp('b', 'root-not-polled', { status: 'running' });
        const sections = taskSections([orphan]);
        expect(sections.running).toHaveLength(0);
        expect(sections.review).toHaveLength(0);
        expect(sections.past).toHaveLength(0);
    });

    it('resurrects a done task whose newest run is a queued follow-up', () => {
        // The root row carries the user's done verdict; the chain head does not — and the head is
        // what the section answers for, so the conversation moves back to Running.
        const root = job('a', { status: 'succeeded', doneAt: at(30) });
        const child = followUp('b', 'a', { status: 'queued', createdAt: at(40) });
        const sections = taskSections([root, child]);
        expect(sections.running.map((entry) => entry.id)).toEqual(['a']);
        expect(sections.running[0]!.status).toEqual({ status: 'queued', cancelRequestedAt: null, doneAt: null });
        expect(sections.review).toHaveLength(0);
        expect(sections.past).toHaveLength(0);
    });

    it('sorts Running newest activity first', () => {
        // startedAt is the activity key here, not createdAt: a task started late outranks one
        // queued early.
        const first = job('a', { status: 'running', startedAt: at(10) });
        const second = job('b', { status: 'running', startedAt: at(30) });
        const third = job('c', { status: 'running', startedAt: at(20) });
        const sections = taskSections([third, first, second]);
        expect(sections.running.map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
    });

    it('sorts Need review by when the task last changed, not by when it was created', () => {
        // The finished-earlier-created task finished LATER — max(createdAt, finishedAt) puts it on
        // top, because "the task you just finished reviewing work on" is what the section is for.
        const olderButLater = job('a', { status: 'succeeded', createdAt: at(0), finishedAt: at(60) });
        const newerButEarlier = job('b', { status: 'succeeded', createdAt: at(30), finishedAt: at(45) });
        const sections = taskSections([newerButEarlier, olderButLater]);
        expect(sections.review.map((entry) => entry.id)).toEqual(['a', 'b']);
    });

    it('breaks an equal activity key by id, so the order is deterministic', () => {
        const a = job('a', { status: 'running', createdAt: at(10) });
        const b = job('b', { status: 'running', createdAt: at(10) });
        const sections = taskSections([a, b]);
        expect(sections.running.map((entry) => entry.id)).toEqual(['b', 'a']);
    });

    it('answers an empty tree for a null or empty list', () => {
        for (const jobs of [null, []] as const) {
            const sections = taskSections(jobs);
            expect(sections.running).toHaveLength(0);
            expect(sections.review).toHaveLength(0);
            expect(sections.past).toHaveLength(0);
        }
    });

    it("resolves the entry's title, live summary and status from the chain head", () => {
        const running = taskSections([job('a', sampled('→ Read src/x.ts'))]).running[0]!;
        expect(running.id).toBe('a');
        expect(running.title).toBe('command a');
        expect(running.summary).toBe('→ Read src/x.ts');
        expect(running.status).toEqual({ status: 'running', cancelRequestedAt: null, doneAt: null });

        // A finished run's last activity line would lie about a run no longer going.
        const finished = taskSections([job('b', { status: 'failed', exitCode: 1 })]).review[0]!;
        expect(finished.summary).toBeNull();
        expect(finished.status).toEqual({ status: 'failed', cancelRequestedAt: null, doneAt: null });
    });
});

describe('chainHead', () => {
    it('answers the newest member of the thread, whichever row was asked for', () => {
        const chain = [job('a'), followUp('b', 'a'), followUp('c', 'a', { createdAt: at(30) })];
        expect(chainHead('a', chain)?.id).toBe('c');
        expect(chainHead('b', chain)?.id).toBe('c');
        expect(chainHead('c', chain)?.id).toBe('c');
    });

    it("breaks a createdAt tie by id, matching the board's own ordering", () => {
        const a = job('a', { createdAt: at(10) });
        const b = followUp('b', 'a', { createdAt: at(10) });
        expect(chainHead('a', [a, b])?.id).toBe('b');
    });

    it('ignores rows of other threads', () => {
        const mine = job('a', { createdAt: at(10) });
        const theirs = job('z', { createdAt: at(30) });
        expect(chainHead('a', [theirs, mine])?.id).toBe('a');
    });

    it('answers null for an id the list does not know, or a null list', () => {
        expect(chainHead('nope', [job('a')])).toBeNull();
        expect(chainHead('a', null)).toBeNull();
        expect(chainHead('a', [])).toBeNull();
    });
});

describe('taskDotClass', () => {
    const status = (overrides: Partial<Job>): ReturnType<typeof taskStatus> => taskStatus('a', [job('a', overrides)]);

    it('paints a going run green and breathing, and a stop in flight the same family', () => {
        expect(taskDotClass(status({ status: 'running' }))).toBe('sidenav-dot-running');
        expect(taskDotClass(status({ status: 'running', cancelRequestedAt: at(30) }))).toBe('sidenav-dot-stopping');
    });

    it('holds grey for work that has not started or is parked', () => {
        expect(taskDotClass(status({ status: 'queued' }))).toBe('sidenav-dot-paused');
        expect(taskDotClass(status({ status: 'standby' }))).toBe('sidenav-dot-paused');
    });

    it('paints a failed or dead run red', () => {
        expect(taskDotClass(status({ status: 'failed', exitCode: 1 }))).toBe('sidenav-dot-failed');
        expect(taskDotClass(status({ status: 'dead', exitCode: 1 }))).toBe('sidenav-dot-failed');
    });

    it("paints finished or done solid green, whatever the run's verdict was", () => {
        expect(taskDotClass(status({ status: 'succeeded' }))).toBe('sidenav-dot-done');
        expect(taskDotClass(status({ status: 'failed', exitCode: 1, doneAt: at(30) }))).toBe('sidenav-dot-done');
    });

    it('leaves a stopped task on the plain dot — the user ended that turn themselves', () => {
        expect(taskDotClass(status({ status: 'stopped', exitCode: 130 }))).toBe('');
    });
});

describe('taskTitle', () => {
    const jobRow: Job = {
        id: '11111111-1111-4111-8111-111111111111',
        command: 'fix the flaky login test',
        status: 'succeeded',
        attempts: 1,
        exitCode: 0,
        output: null,
        repo: null,
        executor: null,
        followUpTo: null,
        rootJobId: '11111111-1111-4111-8111-111111111111',
        doneAt: null,
        cancelRequestedAt: null,
        workspacePath: null,
        createdAt: '2026-09-01T12:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        wallClockMs: null,
        taskWallClockMs: null,
        summary: null,
        sessionId: null,
        remoteSessionId: null,
    };

    it('uses the command once the poll knows the task, and a short id before that', () => {
        expect(taskTitle(jobRow.id, [jobRow])).toBe('fix the flaky login test');
        expect(taskTitle(jobRow.id, null)).toBe('11111111');
        expect(taskTitle(jobRow.id, [])).toBe('11111111');
    });
});

describe('taskStatus', () => {
    it('answers the named run when it is its own thread root', () => {
        expect(taskStatus('a', [job('a', { status: 'running' })])).toEqual({
            status: 'running',
            cancelRequestedAt: null,
            doneAt: null,
        });
    });

    it('resolves ANY member to the newest run of the thread, like the detail page does', () => {
        // The thread, oldest first: root a, follow-up b, newest c — all sharing the served root.
        // `taskStatus` must answer c's state whether asked for the root or one of the follow-ups.
        const chain = [
            job('a'),
            followUp('b', 'a'),
            followUp('c', 'a', { status: 'running', cancelRequestedAt: '2026-09-01T13:00:00.000Z' }),
        ];
        const expected = { status: 'running', cancelRequestedAt: '2026-09-01T13:00:00.000Z', doneAt: null };
        expect(taskStatus('a', chain)).toEqual(expected);
        expect(taskStatus('b', chain)).toEqual(expected);
        expect(taskStatus('c', chain)).toEqual(expected);
    });

    it("picks the newest member of the thread regardless of the rows' order", () => {
        // The head is the member with the highest createdAt, not the first row — a shuffled list
        // answers the same task state. Timestamps explicit, so the shuffle cannot shade them.
        const newest = followUp('z', 'a', {
            status: 'failed',
            doneAt: '2026-09-01T14:00:00.000Z',
            createdAt: at(3),
        });
        const expected = { status: 'failed', cancelRequestedAt: null, doneAt: '2026-09-01T14:00:00.000Z' };
        expect(
            taskStatus('b', [newest, followUp('b', 'a', { createdAt: at(2) }), job('a', { createdAt: at(1) })])
        ).toEqual(expected);
        expect(
            taskStatus('b', [job('a', { createdAt: at(1) }), followUp('b', 'a', { createdAt: at(2) }), newest])
        ).toEqual(expected);
    });

    it('resolves a thread whose root row fell out of the poll window', () => {
        // The window holds only the newest turns, but each carries the served root, so the
        // conversation still resolves to its newest member.
        const window = [
            followUp('b', 'a'),
            followUp('c', 'a', { status: 'failed', doneAt: '2026-09-01T14:00:00.000Z' }),
        ];
        const expected = { status: 'failed', cancelRequestedAt: null, doneAt: '2026-09-01T14:00:00.000Z' };
        expect(taskStatus('b', window)).toEqual(expected);
        expect(taskStatus('c', window)).toEqual(expected);
    });

    it('answers the named run when it is the only member in the window', () => {
        expect(taskStatus('b', [followUp('b', 'a', { status: 'running' })])).toEqual({
            status: 'running',
            cancelRequestedAt: null,
            doneAt: null,
        });
    });

    it('answers nothing about a task the poll does not know', () => {
        expect(taskStatus('nope', [job('a')])).toEqual({ status: null, cancelRequestedAt: null, doneAt: null });
        expect(taskStatus('a', null)).toEqual({ status: null, cancelRequestedAt: null, doneAt: null });
        expect(taskStatus('a', [])).toEqual({ status: null, cancelRequestedAt: null, doneAt: null });
    });
});

describe('taskSummary', () => {
    it("answers the newest run's activity line while that run is running", () => {
        expect(taskSummary('a', [job('a', sampled('→ Read src/x.ts'))])).toBe('→ Read src/x.ts');
    });

    it("resolves ANY member to the head run's activity, the same run the status dot answers for", () => {
        // The thread, oldest first: root a, follow-up b (running, with an activity line).
        const chain = [job('a'), followUp('b', 'a', sampled('→ Bash npm test'))];
        expect(taskSummary('a', chain)).toBe('→ Bash npm test');
        expect(taskSummary('b', chain)).toBe('→ Bash npm test');
    });

    it('answers the head run, not an older run that happened to carry an activity line', () => {
        const chain = [job('a', sampled('→ superseded run still talking')), followUp('b', 'a', { status: 'running' })];
        expect(taskSummary('a', chain)).toBeNull();
    });

    it('stays silent once the head run is not going — a stale line beside a parked or finished verdict lies', () => {
        const stale = {
            cpuPercent: 12,
            memUsedMb: 300,
            memPercent: null,
            activity: '→ stale',
            sampledAt: '2026-09-01T12:05:00.000Z',
        };
        for (const status of ['queued', 'standby', 'succeeded', 'failed', 'dead'] as const) {
            expect(taskSummary('a', [job('a', { status, runtime: stale })]), status).toBeNull();
        }
    });

    it('stays silent when the newest run never sampled an activity line', () => {
        expect(taskSummary('a', [job('a', { status: 'running' })])).toBeNull();
        expect(
            taskSummary('a', [
                job('a', {
                    status: 'running',
                    runtime: {
                        cpuPercent: 12,
                        memUsedMb: 300,
                        memPercent: null,
                        activity: null,
                        sampledAt: '2026-09-01T12:05:00.000Z',
                    },
                }),
            ])
        ).toBeNull();
    });

    it('answers nothing about a task the poll does not know', () => {
        expect(taskSummary('nope', [job('a')])).toBeNull();
        expect(taskSummary('a', null)).toBeNull();
        expect(taskSummary('a', [])).toBeNull();
    });
});

describe('task authorship', () => {
    it('carries the ROOT row author into the entry, and null through', () => {
        const author = { id: 'a', login: 'octocat', name: null, avatarUrl: null };
        const root = job('root', { author });
        const child = followUp('kid', 'root', { author });
        const sections = taskSections([root, child]);
        // The author is a fact of the conversation, taken from its root row only.
        expect(sections.review.map((entry) => entry.author)).toEqual(['octocat']);
        expect(taskSections([job('anon')]).review.map((entry) => entry.author)).toEqual([null]);
    });
});
