import { describe, expect, it } from 'vitest';
import { filterJobRuns, filterTelemetryInput } from '../src/range.js';
import type { DateRange } from '../src/range.js';
import { taskUsageStats } from '../src/task-usage.js';
import type { JobRun, SessionRollup, TokenTotals } from '../src/types.js';

const NOW = new Date('2026-08-21T12:00:00.000Z');

const ALICE = { id: 'u-alice', login: 'alice', name: 'Alice', avatarUrl: null };
const BOB = { id: 'u-bob', login: 'bob', name: null, avatarUrl: null };

const T = (input: number | null, output: number | null): TokenTotals => ({
    input,
    output,
    cacheRead: null,
    cacheCreation: null,
});

const DEFAULT_SESSION_OUTPUT_TOKENS = 5;

function session(over: Partial<SessionRollup>): SessionRollup {
    return {
        sessionId: 's',
        agent: 'claude-code',
        repo: 'o/r',
        user: null,
        taskKey: null,
        firstSeen: '2026-08-20T00:00:00.000Z',
        lastSeen: '2026-08-20T01:00:00.000Z',
        tokens: T(10, DEFAULT_SESSION_OUTPUT_TOKENS),
        linesAdded: 1,
        linesRemoved: 0,
        editsAccepted: 1,
        editsRejected: 0,
        activeSeconds: 60,
        commits: 0,
        ...over,
    };
}

function run(over: Partial<JobRun>): JobRun {
    return {
        rootJobId: 't1',
        repo: 'o/r',
        createdBy: ALICE.id,
        createdAt: '2026-08-20T00:00:00.000Z',
        agentTurns: 0,
        wallClockMs: 60_000,
        ...over,
    };
}

// The spec's 1k/2k/3k scenario: three tasks, three sessions, hand-checkable percentiles.
const TASK_1K_INPUT_TOKENS = 600;
const TASK_1K_OUTPUT_TOKENS = 400;
const TASK_2K_INPUT_TOKENS = 1200;
const TASK_2K_OUTPUT_TOKENS = 800;
const TASK_3K_INPUT_TOKENS = 2400;
const TASK_3K_OUTPUT_TOKENS = 600;
const threeTasks = [
    session({
        sessionId: 'a',
        taskKey: 't1',
        tokens: T(TASK_1K_INPUT_TOKENS, TASK_1K_OUTPUT_TOKENS),
        firstSeen: '2026-08-20T01:00:00Z',
        lastSeen: '2026-08-20T01:10:00Z',
    }),
    session({
        sessionId: 'b',
        taskKey: 't2',
        tokens: T(TASK_2K_INPUT_TOKENS, TASK_2K_OUTPUT_TOKENS),
        firstSeen: '2026-08-20T02:00:00Z',
        lastSeen: '2026-08-20T02:10:00Z',
    }),
    session({
        sessionId: 'c',
        taskKey: 't3',
        tokens: T(TASK_3K_INPUT_TOKENS, TASK_3K_OUTPUT_TOKENS),
        firstSeen: '2026-08-20T03:00:00Z',
        lastSeen: '2026-08-20T03:10:00Z',
    }),
];

describe('tokens per task', () => {
    it('reports avg 2k, p50 2k and p95 3k over the 1k/2k/3k scenario', () => {
        const stats = taskUsageStats(threeTasks, []);
        expect(stats.tokensPerTask).toEqual({ avg: 2000, p50: 2000, p95: 3000, tasks: 3 });
    });

    it('excludes a task with no measured tokens rather than counting it as zero', () => {
        // t2's sessions are all-null: an unmapped agent, or a session with no token rows.
        const stats = taskUsageStats(
            [
                threeTasks[0] as SessionRollup,
                threeTasks[2] as SessionRollup,
                session({ sessionId: 'd', taskKey: 't2', tokens: T(null, null) }),
            ],
            []
        );
        // Nearest-rank median of two values is the lower one: ceil(0.5·2) = 1st of the sort.
        expect(stats.tokensPerTask).toEqual({ avg: 2000, p50: 1000, p95: 3000, tasks: 2 });
    });

    it('sums input and output only, never cache reads', () => {
        const INPUT_TOKENS = 100;
        const OUTPUT_TOKENS = 50;
        const stats = taskUsageStats(
            [
                session({
                    taskKey: 't1',
                    tokens: { input: INPUT_TOKENS, output: OUTPUT_TOKENS, cacheRead: 999_999, cacheCreation: 888_888 },
                }),
            ],
            []
        );
        expect(stats.tokensPerTask.p50).toBe(INPUT_TOKENS + OUTPUT_TOKENS);
    });

    it('answers null figures, not zeros, when no task carries measured tokens', () => {
        const stats = taskUsageStats([], []);
        expect(stats.tokensPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
        expect(stats.jobTurnsPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
        expect(stats.agentTurnsPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
    });
});

describe('job turns per task', () => {
    it('counts every run row once — a first run and two follow-ups are three job turns', () => {
        const stats = taskUsageStats(
            [session({ sessionId: 'a', taskKey: 't1' })],
            [
                run({ rootJobId: 't1', createdAt: '2026-08-18T00:00:00Z' }),
                run({ rootJobId: 't1', createdAt: '2026-08-19T00:00:00Z' }),
                run({ rootJobId: 't1', createdAt: '2026-08-20T00:00:00Z' }),
            ]
        );
        expect(stats.jobTurnsPerTask).toEqual({ avg: 3, p50: 3, p95: 3, tasks: 1 });
    });

    it('counts a task in scope via session overlap even when all its runs fall outside the range', () => {
        // The range filter has already run: the session survived, the run did not. The task
        // still enters — with a real zero (no run of it was queued inside the range).
        const stats = taskUsageStats([session({ sessionId: 'a', taskKey: 't1' })], []);
        expect(stats.jobTurnsPerTask).toEqual({ avg: 0, p50: 0, p95: 0, tasks: 1 });
        expect(stats.tokensPerTask.tasks).toBe(1);
        expect(stats.agentTurnsPerTask.tasks).toBe(1);
        expect(stats.agentTurnsPerTask.p50).toBe(0);
    });
});

describe('agent turns per task', () => {
    it('sums the runs stored counts — a first run of 9 and a follow-up of 4 enter as 13', () => {
        const stats = taskUsageStats(
            [session({ sessionId: 'a', taskKey: 't1' })],
            [
                run({ rootJobId: 't1', createdAt: '2026-08-19T00:00:00Z', agentTurns: 9 }),
                run({ rootJobId: 't1', createdAt: '2026-08-20T00:00:00Z', agentTurns: 4 }),
            ]
        );
        expect(stats.agentTurnsPerTask).toEqual({ avg: 13, p50: 13, p95: 13, tasks: 1 });
    });

    it('excludes a task with any unmeasured run from the turn distribution only', () => {
        // One measured run (7 turns), one unmeasured (null — the close-time read failed). A
        // partial sum presented as a total is a quiet undercount, so the task drops out of
        // THIS figure — while its tokens and job turns still count in theirs.
        const MEASURED_TOKENS = 500;
        const stats = taskUsageStats(
            [session({ sessionId: 'a', taskKey: 't1', tokens: T(MEASURED_TOKENS, MEASURED_TOKENS) })],
            [
                run({ rootJobId: 't1', createdAt: '2026-08-19T00:00:00Z', agentTurns: 7 }),
                run({ rootJobId: 't1', createdAt: '2026-08-20T00:00:00Z', agentTurns: null }),
            ]
        );
        expect(stats.agentTurnsPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
        expect(stats.tokensPerTask.tasks).toBe(1);
        expect(stats.jobTurnsPerTask).toEqual({ avg: 2, p50: 2, p95: 2, tasks: 1 });
    });

    it('stores a genuine zero when the root conversation took no assistant response', () => {
        const stats = taskUsageStats(
            [session({ sessionId: 'a', taskKey: 't1' })],
            [run({ rootJobId: 't1', agentTurns: 0 })]
        );
        expect(stats.agentTurnsPerTask).toEqual({ avg: 0, p50: 0, p95: 0, tasks: 1 });
    });
});

describe('range interaction', () => {
    // A two-day range; frozen `now` so the boundary scenarios are deterministic.
    const range: DateRange = {
        preset: 'custom',
        from: '2026-08-19T00:00:00.000Z',
        to: '2026-08-21T00:00:00.000Z',
    };

    it('includes a task whose session straddles the range start', () => {
        // Started before the range, last seen inside it — the session-overlap rule keeps the
        // session, and with it the task.
        const input = {
            sessions: [
                session({
                    sessionId: 'straddles',
                    taskKey: 't1',
                    firstSeen: '2026-08-18T23:00:00.000Z',
                    lastSeen: '2026-08-19T02:00:00.000Z',
                }),
            ],
            coverage: { from: null, to: null },
        };
        const runs = [run({ rootJobId: 't1', createdAt: '2026-08-18T12:00:00Z', agentTurns: 5 })];
        const stats = taskUsageStats(filterTelemetryInput(input, range).sessions, filterJobRuns(runs, range));
        expect(stats.tokensPerTask.tasks).toBe(1);
        expect(stats.jobTurnsPerTask).toEqual({ avg: 0, p50: 0, p95: 0, tasks: 1 });
        // The run fell outside the range, so its turns are not in range either.
        expect(stats.agentTurnsPerTask).toEqual({ avg: 0, p50: 0, p95: 0, tasks: 1 });
    });

    it('includes a task known only through a run queued in the range', () => {
        // No telemetry session ever survived for this thread (the plugin was off); the run row
        // alone puts the task in scope for the turn figures.
        const stats = taskUsageStats([], [run({ rootJobId: 't9', createdAt: '2026-08-20T08:00:00Z', agentTurns: 11 })]);
        expect(stats.jobTurnsPerTask).toEqual({ avg: 1, p50: 1, p95: 1, tasks: 1 });
        expect(stats.agentTurnsPerTask).toEqual({ avg: 11, p50: 11, p95: 11, tasks: 1 });
        // No attributed session carries measured tokens: excluded, not zeroed.
        expect(stats.tokensPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
    });

    it('keeps out a run queued after the range and a session that ended before it', () => {
        const input = {
            sessions: [
                session({
                    sessionId: 'old',
                    taskKey: 't1',
                    firstSeen: '2026-08-10T00:00:00Z',
                    lastSeen: '2026-08-10T01:00:00Z',
                }),
            ],
            coverage: { from: null, to: null },
        };
        const runs = [run({ rootJobId: 't2', createdAt: '2026-08-21T01:00:00Z' })];
        const stats = taskUsageStats(filterTelemetryInput(input, range).sessions, filterJobRuns(runs, range));
        expect(stats.tokensPerTask.tasks).toBe(0);
        expect(stats.jobTurnsPerTask.tasks).toBe(0);
    });
});

describe('caller scope', () => {
    it("narrowes the task set to the caller's tasks", () => {
        const ALICE_AGENT_TURNS = 3;
        const stats = taskUsageStats(
            [
                session({ sessionId: 'a', taskKey: 't1', user: ALICE }),
                session({ sessionId: 'b', taskKey: 't2', user: BOB }),
            ],
            [
                run({ rootJobId: 't1', createdBy: ALICE.id, agentTurns: ALICE_AGENT_TURNS }),
                run({ rootJobId: 't2', createdBy: BOB.id, agentTurns: 4 }),
            ],
            { user: { id: ALICE.id } }
        );
        expect(stats.tokensPerTask).toEqual({ avg: 15, p50: 15, p95: 15, tasks: 1 });
        expect(stats.jobTurnsPerTask.tasks).toBe(1);
        expect(stats.agentTurnsPerTask.p50).toBe(ALICE_AGENT_TURNS);
    });

    it('leaves sessions without attribution out of every scope', () => {
        const ANON_TOKENS = 1000;
        const stats = taskUsageStats(
            [session({ sessionId: 'anon', taskKey: 't1', tokens: T(ANON_TOKENS, ANON_TOKENS) })],
            [run({ rootJobId: 't1', createdBy: null, agentTurns: 5 })],
            { user: { id: ALICE.id } }
        );
        expect(stats.tokensPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
        expect(stats.jobTurnsPerTask.tasks).toBe(0);
        // Org scope keeps the same figures visible.
        const org = taskUsageStats(
            [session({ sessionId: 'anon', taskKey: 't1', tokens: T(ANON_TOKENS, ANON_TOKENS) })],
            [run({ rootJobId: 't1', createdBy: null, agentTurns: 5 })]
        );
        expect(org.tokensPerTask.p50).toBe(ANON_TOKENS + ANON_TOKENS);
    });
});

describe('repo scope', () => {
    it('excludes out-of-repo sessions and runs from every distribution', () => {
        // The totals above the task panel bucket other-repo work out; the panel must not
        // quietly include what the page just excluded.
        const INSCOPE_TOKENS = 1000;
        const OTHER_REPO_TOKENS = 500;
        const stats = taskUsageStats(
            [
                session({ sessionId: 'a', taskKey: 't1', tokens: T(INSCOPE_TOKENS, INSCOPE_TOKENS) }),
                session({
                    sessionId: 'b',
                    taskKey: 't2',
                    tokens: T(OTHER_REPO_TOKENS, OTHER_REPO_TOKENS),
                    repo: 'other/repo',
                }),
            ],
            [run({ rootJobId: 't1', agentTurns: 3 }), run({ rootJobId: 't2', agentTurns: 4, repo: 'other/repo' })],
            { repos: ['o/r'] }
        );
        expect(stats.tokensPerTask).toEqual({ avg: 2000, p50: 2000, p95: 2000, tasks: 1 });
        expect(stats.agentTurnsPerTask).toEqual({ avg: 3, p50: 3, p95: 3, tasks: 1 });
        // A null-repo input is out the same way: it never reached the totals either.
        const unlabeled = taskUsageStats([session({ sessionId: 'c', taskKey: 't3', repo: null })], [], {
            repos: ['o/r'],
        });
        expect(unlabeled.tokensPerTask.tasks).toBe(0);
    });
});

describe('wall clock per task', () => {
    it('sums the runs banked wall clock per thread, as a distribution over tasks', () => {
        const stats = taskUsageStats(
            [],
            [
                run({ rootJobId: 't1', wallClockMs: 60_000 }),
                run({ rootJobId: 't1', wallClockMs: 30_000 }),
                run({ rootJobId: 't2', wallClockMs: 200_000 }),
            ]
        );
        // Nearest-rank over [90_000, 200_000]: p50 is the 1st of the sort, p95 the 2nd.
        expect(stats.wallClockPerTask).toEqual({ avg: 145_000, p50: 90_000, p95: 200_000, tasks: 2 });
    });

    it('excludes a task with any unmeasured run from this distribution only', () => {
        // t2's run never executed (null wall clock = never ran, not zero); both tasks carry a
        // measured session, so both count in tokens while only t1 counts in wall clock.
        const MEASURED_TOKENS = 1000;
        const stats = taskUsageStats(
            [
                session({ sessionId: 'a', taskKey: 't1', tokens: T(MEASURED_TOKENS, MEASURED_TOKENS) }),
                session({ sessionId: 'b', taskKey: 't2', tokens: T(MEASURED_TOKENS, MEASURED_TOKENS) }),
            ],
            [run({ rootJobId: 't1', wallClockMs: 60_000 }), run({ rootJobId: 't2', wallClockMs: null })]
        );
        expect(stats.wallClockPerTask).toEqual({ avg: 60_000, p50: 60_000, p95: 60_000, tasks: 1 });
        expect(stats.tokensPerTask.tasks).toBe(2);
    });

    it('counts a task with no in-range run as zero banked time, not missing', () => {
        // The task entered through its sessions; no run of it was queued in the range, so zero
        // execution time in-range is what was measured.
        const stats = taskUsageStats([session({ sessionId: 'a', taskKey: 't1' })], []);
        expect(stats.wallClockPerTask).toEqual({ avg: 0, p50: 0, p95: 0, tasks: 1 });
    });

    it('answers null figures, not zeros, when no task is measured', () => {
        const stats = taskUsageStats([], []);
        expect(stats.wallClockPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
    });
});

describe('payload hygiene', () => {
    it('exposes no monetary field anywhere', () => {
        // Cost is deliberately out of scope (docs/metrics.md). This stops it returning via a
        // "small addition" to the new block.
        const stats = taskUsageStats(threeTasks, [run({ agentTurns: 3 })]);
        const keys: string[] = [];
        const walk = (value: unknown) => {
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) {
                    keys.push(k.toLowerCase());
                    walk(v);
                }
            }
        };
        walk(stats);
        for (const forbidden of ['cost', 'usd', 'price', 'dollars']) {
            expect(keys).not.toContain(forbidden);
        }
    });
});
