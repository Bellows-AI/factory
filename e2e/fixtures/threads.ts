/**
 * Task threads shaped like the board's own `GET /api/jobs/:id/thread` payload — every field
 * `toJob()` (server/src/db/job-store-rows.ts) writes, in its order, spelled the way it spells
 * them (ISO stamps with milliseconds, the wait triple on every member of the thread, as
 * `threadOf()` in server/src/db/job-store-reads.ts reads it). The seed only writes succeeded
 * jobs, so every other state a spec needs lives here instead of in an ad-hoc `page.route` object.
 *
 * `task-detail.spec.ts` seeds `nullAuthorThread` into the real board and asserts the thread
 * route answers it back verbatim — that parity check holds `run()`'s field set, order and
 * spelling to the board. It seeds one member with no wait, so `thread()`'s chaining, clock sum
 * and wait copy rest on the reads cited above, not on the check. The type is copied rather than imported from web/src: a fixture that shares
 * the SPA's type drifts with the SPA, not with the server.
 *
 * Append-only after #278: lanes add fixtures, they never change an existing one.
 */
import type { Page } from '@playwright/test';

export type ThreadStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'stopped';

export interface ThreadUser {
    id: string;
    login: string;
    name: string | null;
    // Always null here: a URL would make the offline page request a remote image.
    avatarUrl: string | null;
}

export interface ThreadGate {
    name: string;
    status: 'running' | 'passed' | 'failed';
    exitCode: number | null;
    output: string | null;
}

export interface ThreadRuntime {
    cpuPercent: number | null;
    memUsedMb: number | null;
    memPercent: number | null;
    activity: string | null;
    sampledAt: string;
    contextTokens?: number | null;
    costUsd?: number | null;
}

export interface ThreadJob {
    id: string;
    command: string;
    status: ThreadStatus;
    attempts: number;
    maxAttempts: number;
    claimedBy: string | null;
    createdBy: string | null;
    author: ThreadUser | null;
    stoppedBy: ThreadUser | null;
    doneBy: ThreadUser | null;
    sessionId: string | null;
    exitCode: number | null;
    output: string | null;
    summary: string | null;
    // The structured terminal reason (issue #339); null on every fixture here — the seed writes
    // succeeded jobs, and a failed-with-kind run is a lane fixture's to add, never this file's
    // to retrofit.
    failureKind: string | null;
    gates: ThreadGate[] | null;
    runtime: ThreadRuntime | null;
    repo: string | null;
    executor: string | null;
    followUpTo: string | null;
    rootJobId: string;
    workflowNode: string | null;
    workflowName: string | null;
    /** The default workflow's bounded gate-repair round limit (#49), null unless the task set one. */
    defaultGateFixRounds: number | null;
    doneAt: string | null;
    cancelRequestedAt: string | null;
    workspacePath: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    wallClockMs: number | null;
    taskWallClockMs: number | null;
    waitReason: string | null;
    waitingSince: string | null;
    waitTerminalReason: string | null;
}

type Wait = Pick<ThreadJob, 'waitReason' | 'waitingSince' | 'waitTerminalReason'>;

/** The stand-in account AUTH_MODE=none attributes every action to (server/src/db/migrate.ts). */
export const LOCAL_AUTHOR: ThreadUser = {
    id: 'cccccccc-0000-4000-8000-000000000001',
    login: '__local__',
    name: 'Local',
    avatarUrl: null,
};

/** Someone else in the org — the task the viewer did not start. */
export const OTHER_AUTHOR: ThreadUser = {
    id: 'cccccccc-0000-4000-8000-000000000002',
    login: 'octo-reviewer',
    name: 'Octo Reviewer',
    avatarUrl: null,
};

const WORKER = 'e2e-worker';
const REPO = 'acme/widgets';
const REVIEW_WORKFLOW = 'github-review';

/** A thread parked on its review wait: open (no terminal reason), active since the publish. */
const OPEN_REVIEW_WAIT: Wait = {
    waitReason: 'review',
    waitingSince: '2026-09-01T12:30:00.000Z',
    waitTerminalReason: null,
};

const NO_WAIT: Wait = { waitReason: null, waitingSince: null, waitTerminalReason: null };

const publishLine = (branch: string, pr: number) =>
    `[driver] published ${branch} — https://github.com/${REPO}/pull/${pr}`;

/** A finished-run runtime: vitals cleared, the session's measured totals kept. */
const finishedRuntime = (sampledAt: string): ThreadRuntime => ({
    cpuPercent: null,
    memUsedMb: null,
    memPercent: null,
    activity: null,
    sampledAt,
    contextTokens: 30_433,
    costUsd: 0.01,
});

const liveRuntime = (activity: string, sampledAt: string): ThreadRuntime => ({
    cpuPercent: 12,
    memUsedMb: 300,
    memPercent: 2,
    activity,
    sampledAt,
});

type RunFields = Pick<ThreadJob, 'id' | 'command'> & Partial<Omit<ThreadJob, 'createdBy'>>;

/** One member, defaulting to a finished, succeeded, open run by the local author. The thread
 *  fields (`followUpTo`, `rootJobId`, `taskWallClockMs`, the wait) are `thread()`'s to set. */
function run(fields: RunFields): ThreadJob {
    const author = fields.author === undefined ? LOCAL_AUTHOR : fields.author;
    return {
        status: 'succeeded',
        attempts: 1,
        maxAttempts: 3,
        claimedBy: WORKER,
        stoppedBy: null,
        doneBy: null,
        sessionId: null,
        exitCode: 0,
        output: null,
        summary: null,
        failureKind: null,
        gates: null,
        runtime: null,
        repo: null,
        executor: 'main',
        followUpTo: null,
        rootJobId: fields.id,
        workflowNode: null,
        workflowName: null,
        defaultGateFixRounds: null,
        doneAt: null,
        cancelRequestedAt: null,
        workspacePath: null,
        createdAt: '2026-09-01T12:00:00.000Z',
        startedAt: '2026-09-01T12:00:01.000Z',
        finishedAt: '2026-09-01T12:30:00.000Z',
        wallClockMs: 1_799_000,
        taskWallClockMs: null,
        ...NO_WAIT,
        ...fields,
        author,
        createdBy: author?.id ?? null,
    };
}

/** Chain the runs (oldest first) the way `threadOf()` answers them: one root, each member the
 *  follow-up to the one before, the thread's clock and its wait carried on every member. */
function thread(runs: ThreadJob[], wait: Wait = NO_WAIT): ThreadJob[] {
    const root = runs[0]!.id;
    const clocks = runs.map((r) => r.wallClockMs).filter((ms): ms is number => ms !== null);
    const taskWallClockMs = clocks.length === 0 ? null : clocks.reduce((a, b) => a + b, 0);
    return runs.map((r, i) => ({
        ...r,
        followUpTo: i === 0 ? null : runs[i - 1]!.id,
        rootJobId: root,
        taskWallClockMs,
        ...wait,
    }));
}

/** The line the driver appends to a run's output when a gate fails it (driver/src/loop-run.ts). */
const gateFailedLine = (gate: ThreadGate) =>
    `[driver] gate "${gate.name}" failed (exit ${gate.exitCode})\n${gate.output}`;

const unfinished = { exitCode: null, finishedAt: null, wallClockMs: null } as const;

/** Queued, never claimed: no worker, no session, no clock. */
export const queuedThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000101',
        command: 'queued and waiting for a worker',
        status: 'queued',
        attempts: 0,
        claimedBy: null,
        startedAt: null,
        ...unfinished,
    }),
]);

/** Running, with a live activity line and an output tall enough to clip the live well. */
export const runningThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000102',
        command: 'watch me run',
        status: 'running',
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000102',
        output: `${Array.from({ length: 80 }, (_, i) => `step ${i + 1} ok`).join('\n')}\nstep 81 running`,
        runtime: liveRuntime('→ Bash npm test', '2026-09-01T12:02:00.000Z'),
        ...unfinished,
    }),
]);

/** Still running, a stop requested: the request stamps `cancelRequestedAt` and `stoppedBy`. */
export const stoppingThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000103',
        command: 'stop me while I run',
        status: 'running',
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000103',
        output: 'step 1 ok\nstep 2 running',
        runtime: liveRuntime('→ Bash npm run build', '2026-09-01T12:02:00.000Z'),
        stoppedBy: LOCAL_AUTHOR,
        cancelRequestedAt: '2026-09-01T12:02:30.000Z',
        ...unfinished,
    }),
]);

/** Stopped and settled: the park clears `cancelRequestedAt`, `stoppedBy` stays. */
export const stoppedThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000104',
        command: 'stopped halfway',
        status: 'stopped',
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000104',
        output: 'step 1 ok\nstep 2 interrupted',
        // The park hands back the attempt the claim took.
        attempts: 0,
        stoppedBy: LOCAL_AUTHOR,
        exitCode: null,
        finishedAt: '2026-09-01T12:03:00.000Z',
        wallClockMs: 179_000,
    }),
]);

const parkedRoot = run({
    id: 'aaaaaaaa-0000-4000-8000-000000000105',
    command: 'fix the flaky retry and open a PR',
    repo: REPO,
    workflowName: REVIEW_WORKFLOW,
    workflowNode: 'verify',
    sessionId: 'bbbbbbbb-0000-4000-8000-000000000105',
    summary: 'Fixed the retry and opened a pull request for review.',
    output: `retry fixed\n${publishLine('factory/flaky-retry', 12)}`,
    gates: [{ name: 'test', status: 'passed', exitCode: 0, output: 'all green' }],
    runtime: finishedRuntime('2026-09-01T12:29:00.000Z'),
});

/** Terminal and parked on its review wait: succeeded, published, open, never marked done. */
export const parkedReviewWaitThread = thread([parkedRoot], OPEN_REVIEW_WAIT);

/** The same parked thread after Mark done: done stamped, the wait fields untouched — done does
 *  not close the wait row the thread reads its wait from. */
export const parkedReviewWaitDoneThread = thread(
    [
        {
            ...parkedRoot,
            id: 'aaaaaaaa-0000-4000-8000-000000000106',
            sessionId: 'bbbbbbbb-0000-4000-8000-000000000106',
            doneAt: '2026-09-01T13:00:00.000Z',
            doneBy: LOCAL_AUTHOR,
        },
    ],
    OPEN_REVIEW_WAIT
);

/** A review event woke the parked thread: the continuation is queued on the review node, a fresh
 *  session, and the wait stays open until it completes. */
export const wokenContinuationThread = thread(
    [
        {
            ...parkedRoot,
            id: 'aaaaaaaa-0000-4000-8000-000000000107',
            sessionId: 'bbbbbbbb-0000-4000-8000-000000000107',
        },
        run({
            id: 'aaaaaaaa-0000-4000-8000-000000000108',
            command: 'react to review',
            status: 'queued',
            attempts: 0,
            claimedBy: null,
            repo: REPO,
            workflowName: REVIEW_WORKFLOW,
            workflowNode: 'review',
            createdAt: '2026-09-01T12:45:00.000Z',
            startedAt: null,
            ...unfinished,
        }),
    ],
    OPEN_REVIEW_WAIT
);

/** The user asked for a follow-up on a parked thread: it runs on the root's session, off the
 *  graph, and the wait stays open over it. */
export const followUpOverWaitThread = thread(
    [
        {
            ...parkedRoot,
            id: 'aaaaaaaa-0000-4000-8000-000000000109',
            sessionId: 'bbbbbbbb-0000-4000-8000-000000000109',
        },
        run({
            id: 'aaaaaaaa-0000-4000-8000-000000000110',
            command: 'also cover the timeout path',
            status: 'running',
            repo: REPO,
            workflowName: REVIEW_WORKFLOW,
            sessionId: 'bbbbbbbb-0000-4000-8000-000000000109',
            output: 'reading src/retry.ts',
            runtime: liveRuntime('→ Read src/retry.ts', '2026-09-01T12:50:30.000Z'),
            createdAt: '2026-09-01T12:50:00.000Z',
            startedAt: '2026-09-01T12:50:01.000Z',
            ...unfinished,
        }),
    ],
    OPEN_REVIEW_WAIT
);

const failedLintGate: ThreadGate = {
    name: 'lint',
    status: 'failed',
    exitCode: 1,
    output: `error:${'0123456789abcdef'.repeat(25)}`,
};

/** A gate failed the run: the first failing gate fails the job, so the gates before it passed,
 *  none ran after it, and nothing was published. Its output is one long unbroken line. */
export const failedGateThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000111',
        command: 'tighten the lint config',
        status: 'failed',
        exitCode: 1,
        repo: REPO,
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000111',
        summary: 'Tightened the lint config.',
        output: `lint config updated\n${gateFailedLine(failedLintGate)}`,
        gates: [
            { name: 'build', status: 'passed', exitCode: 0, output: 'built' },
            { name: 'test', status: 'passed', exitCode: 0, output: 'all green' },
            failedLintGate,
        ],
        runtime: finishedRuntime('2026-09-01T12:29:00.000Z'),
    }),
]);

/** The agent itself failed: a non-zero exit, no gates run, no response captured. */
export const agentFailedThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000112',
        command: 'migrate the config loader',
        status: 'failed',
        exitCode: 1,
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000112',
        output: 'reading config.ts\nError: agent exited with code 1',
        wallClockMs: 42_000,
        finishedAt: '2026-09-01T12:00:43.000Z',
    }),
]);

/** Succeeded and open, published to a pull request, with checks, a response and metadata. The
 *  command is long enough to wrap at a phone width. */
export const publishedThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000113',
        command: 'fix #177 please — rebuild the task detail layout and its outcome summary so it reads at every width',
        repo: REPO,
        exitCode: 0,
        summary: 'Rebuilt the task detail layout and outcome summary.',
        output: `hunk 1 applied\n${publishLine('fix/177', 9)}`,
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000113',
        gates: [{ name: 'test', status: 'passed', exitCode: 0, output: 'all green' }],
        runtime: finishedRuntime('2026-09-01T12:02:00.000Z'),
        wallClockMs: 1_800_000,
    }),
]);

/** Succeeded and marked done. */
export const doneThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000114',
        command: 'closed task',
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000114',
        doneAt: '2026-09-01T13:00:00.000Z',
        doneBy: LOCAL_AUTHOR,
    }),
]);

const nopeLintGate: ThreadGate = { name: 'lint', status: 'failed', exitCode: 1, output: 'nope' };

/** One follow-up: the root published, the follow-up's lint gate failed it. */
export const followUpThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000115',
        command: 'root command',
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000115',
        summary: 'First pass done.',
        output: publishLine('fix/1', 1),
    }),
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000116',
        command: 'follow-up command',
        status: 'failed',
        exitCode: 1,
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000116',
        summary: 'Adjustment applied.',
        output: gateFailedLine(nopeLintGate),
        gates: [nopeLintGate],
        createdAt: '2026-09-01T12:30:00.000Z',
        startedAt: '2026-09-01T12:30:01.000Z',
        finishedAt: '2026-09-01T12:45:00.000Z',
        wallClockMs: 899_000,
    }),
]);

/** Three runs: the root and two follow-ups, all succeeded, the last one published. */
export const multiFollowUpThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000117',
        command: 'add the export button',
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000117',
        summary: 'Added the export button.',
    }),
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000118',
        command: 'make it a CSV',
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000117',
        summary: 'Export now writes CSV.',
        createdAt: '2026-09-01T12:31:00.000Z',
        startedAt: '2026-09-01T12:31:01.000Z',
        finishedAt: '2026-09-01T12:40:00.000Z',
        wallClockMs: 539_000,
    }),
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000119',
        command: 'open a PR',
        repo: REPO,
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000117',
        summary: 'Opened the pull request.',
        output: publishLine('feat/export', 21),
        createdAt: '2026-09-01T12:41:00.000Z',
        startedAt: '2026-09-01T12:41:01.000Z',
        finishedAt: '2026-09-01T12:44:00.000Z',
        wallClockMs: 179_000,
    }),
]);

/** Succeeded with a session but no captured response: no summary, no output. */
export const missingSummaryThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000120',
        command: 'seed task',
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000120',
    }),
]);

/** Terminal with no session to resume — a follow-up cannot attach to it. */
export const sessionlessThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000121',
        command: 'sessionless task',
    }),
]);

/** Started by someone other than the viewer. */
export const otherAuthorThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000122',
        command: 'refactor the billing module',
        author: OTHER_AUTHOR,
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000122',
        summary: 'Split billing into invoices and payments.',
    }),
]);

/** A pre-accounts row: no author. Everything else it carries lives in the job table alone, which
 *  is what lets the parity check seed it into the real board. */
export const nullAuthorThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000123',
        command: 'a task from before accounts',
        author: null,
        repo: REPO,
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000123',
        summary: 'Bumped the dependency.',
        output: `bumped\n${publishLine('chore/bump', 33)}`,
        gates: [{ name: 'test', status: 'passed', exitCode: 0, output: 'all green' }],
        runtime: finishedRuntime('2026-09-01T12:29:00.000Z'),
    }),
]);

/**
 * The activity payload a mocked thread answers with (issue #339): empty buckets, so the page's
 * run-activity panel renders its muted state. The page fetches `GET /api/jobs/:id/activity`
 * beside its thread poll — a mocked thread must answer that too, or the real board 404s a task
 * id the fixture only names, and the console watcher fails the spec.
 */
export function mockedActivityOf(jobs: readonly ThreadJob[]): unknown {
    const head = jobs[jobs.length - 1] ?? null;
    return {
        jobId: head?.id ?? null,
        sessionId: head?.sessionId ?? null,
        from: head?.startedAt ?? null,
        to: head?.finishedAt ?? head?.startedAt ?? null,
        bucketMs: null,
        buckets: [],
    };
}

/** Answer every thread poll on the page with `jobs` — the rest of the page stays the real board's. */
export async function routeThread(page: Page, jobs: readonly ThreadJob[]): Promise<void> {
    await page.unroute('**/api/jobs/*/thread*');
    await page.route('**/api/jobs/*/thread*', (route) => route.fulfill({ json: { jobs } }));
    await page.unroute('**/api/jobs/*/activity');
    await page.route('**/api/jobs/*/activity', (route) => route.fulfill({ json: mockedActivityOf(jobs) }));
}

/** The same thread queued by `author` — every member, the way the board attributes a chain. Only
 *  the task's author is offered a follow-up (#281), so a spec that needs the composer re-authors
 *  a fixture to whoever is signed in. */
export function authoredBy(jobs: readonly ThreadJob[], author: ThreadUser | null): ThreadJob[] {
    return jobs.map((job) => ({ ...job, author, createdBy: author?.id ?? null }));
}

/** The signed-in account, as a thread author. Under AUTH_MODE=none this is the stand-in account,
 *  whose id the database mints — not `LOCAL_AUTHOR.id` — so it is read, never assumed. */
export async function sessionAuthor(page: Page): Promise<ThreadUser> {
    const response = await page.request.get('/api/auth/me');
    const me = (await response.json()) as { user: { id: string; login: string; name: string | null } };
    return { id: me.user.id, login: me.user.login, name: me.user.name, avatarUrl: null };
}

/** Published with a url no reader should open: the branch shows, the url is never a link. */
export const unsafePrUrlThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000124',
        command: 'publish somewhere odd',
        repo: REPO,
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000124',
        summary: 'Published the branch.',
        output: 'pushed\n[driver] published fix/odd — javascript:alert(1)',
    }),
]);

/** The parked task's first state, before it parked: the same id, still running, no wait yet. */
export const parkedReviewWaitRunningThread = thread([
    {
        ...parkedRoot,
        status: 'running',
        summary: null,
        output: 'reading src/retry.ts',
        gates: null,
        runtime: liveRuntime('→ Edit src/retry.ts', '2026-09-01T12:10:00.000Z'),
        ...unfinished,
    },
]);

/** `parkedReviewWaitThread` after Mark done, keeping its id so one task can be followed through
 *  every state — `parkedReviewWaitDoneThread` is the same state under an id of its own. */
export const parkedReviewWaitMarkedDoneThread = thread(
    [{ ...parkedRoot, doneAt: '2026-09-01T13:00:00.000Z', doneBy: LOCAL_AUTHOR }],
    OPEN_REVIEW_WAIT
);

/** `failedGateThread` after its author asked for another pass: the follow-up is queued on the
 *  root's session and repo, which is what the board gives a follow-up. */
export const failedGateFollowUpThread = thread([
    failedGateThread[0]!,
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000125',
        command: 'fix the lint failures and keep the stricter rules',
        status: 'queued',
        attempts: 0,
        claimedBy: null,
        repo: REPO,
        sessionId: failedGateThread[0]!.sessionId,
        createdAt: '2026-09-01T12:40:00.000Z',
        startedAt: null,
        ...unfinished,
    }),
]);

/** The inbox row the board would answer for `jobs`' thread — the root's identity, the head's state. */
export function taskSummaryOf(jobs: readonly ThreadJob[]) {
    const root = jobs[0]!;
    const head = jobs[jobs.length - 1]!;
    return {
        id: root.id,
        command: root.command,
        status: head.status,
        cancelRequestedAt: head.cancelRequestedAt,
        doneAt: head.doneAt,
        repo: head.repo,
        executor: head.executor,
        author: root.author,
        activity: null,
        summary: head.summary,
        waitReason: head.waitReason,
        waitingSince: head.waitingSince,
        waitTerminalReason: head.waitTerminalReason,
        createdAt: root.createdAt,
        activityAt: head.doneAt ?? head.finishedAt ?? head.createdAt,
    };
}

const LONG_REPO = `acme/${'very-long-repository-name-'.repeat(4)}`;
const LONG_BRANCH = `fix/${'an-unbroken-branch-name-'.repeat(6)}`;

/** Someone whose login and name never break — the byline must wrap or clip in its own row. */
const LONG_AUTHOR: ThreadUser = {
    id: 'cccccccc-0000-4000-8000-000000000003',
    login: 'a-contributor-with-an-unbroken-login-'.repeat(2),
    name: 'Averyveryverylongfirstnamewithoutanyspaces Andanequallylongsurname',
    avatarUrl: null,
};

const longGate: ThreadGate = {
    name: `integration-${'suite-'.repeat(12)}`,
    status: 'failed',
    exitCode: 1,
    output: `FAIL:${'x'.repeat(2_000)}`,
};

/** Every string the detail page renders is one unbroken run (issue 287): command, repository,
 *  author, summary, branch, gate name and a 2,000-character log line. The page must hold its
 *  width and let the log scroll inside its own well. */
export const longContentThread = thread([
    run({
        id: 'aaaaaaaa-0000-4000-8000-000000000126',
        command: 'refactor-'.repeat(24),
        status: 'failed',
        exitCode: 1,
        author: LONG_AUTHOR,
        repo: LONG_REPO,
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000126',
        summary: 'Unbroken'.repeat(30),
        output: [
            '0123456789'.repeat(200),
            `[driver] published ${LONG_BRANCH} — https://github.com/${LONG_REPO}/pull/42`,
            gateFailedLine(longGate),
        ].join('\n'),
        gates: [{ name: 'build', status: 'passed', exitCode: 0, output: 'built' }, longGate],
        runtime: finishedRuntime('2026-09-01T12:29:00.000Z'),
    }),
]);
