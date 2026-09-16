import type { JobRun, SessionRollup, TaskUsageDistribution, TaskUsageStats } from './types.js';

export interface TaskUsageOptions {
    /**
     * Only sessions the hook tagged with one of these repos, and only runs queued against
     * them, are counted — the same repo scope every other figure on the page applies, so the
     * task panel cannot include a task the totals above it exclude.
     */
    repos?: readonly string[];
    /**
     * Scopes the distributions to the caller: only sessions whose landed user matches and
     * only runs the caller queued are counted, so the task set narrows to the caller's tasks.
     * Sessions without attribution contribute to no task in any scope.
     */
    user?: { id: string };
}

/**
 * A task's billable tokens: input + output, the only pair the dashboard ever sums (the four
 * token types are never collapsed, and cache reads do not count toward a task total). Null
 * when the session measured neither — a contributor absent, not a zero.
 */
function billableTokens(session: SessionRollup): number | null {
    const { input, output } = session.tokens;
    if (input === null && output === null) return null;
    return (input ?? 0) + (output ?? 0);
}

/**
 * Nearest-rank percentile over the ascending sort: the ceil(p·N)-th value, 1-indexed. Chosen
 * because it recomputes by hand — the independent suites restate these figures without a
 * percentile library, and a linear-interpolation median would not survive that.
 */
function distribution(values: number[]): TaskUsageDistribution {
    if (values.length === 0) return { avg: null, p50: null, p95: null, tasks: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const rank = (p: number) => sorted[Math.ceil(p * sorted.length) - 1] as number;
    return {
        avg: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
        p50: rank(0.5),
        p95: rank(0.95),
        tasks: sorted.length,
    };
}

/**
 * What a task costs, as four distributions over the job threads in scope: tokens per task
 * (input + output over the attributed sessions), job turns per task (run rows — the board's
 * own count), agent turns per task (the runs' close-time counts, summed), and wall clock per
 * task (the execution time the board banked for those runs).
 *
 * The caller range-filters BOTH inputs first — sessions through the overlap rule, runs
 * through `filterJobRuns` — so this function sees only what the selected range keeps. A task
 * enters the statistics when either input still carries it.
 *
 * Pure, like every aggregation in core. The fetch lives in the server; only the arithmetic
 * lives here.
 */
export function taskUsageStats(
    sessions: readonly SessionRollup[],
    runs: readonly JobRun[],
    options: TaskUsageOptions = {}
): TaskUsageStats {
    const { repos, user } = options;
    const inRepoScope = (name: string | null) => name !== null && (repos === undefined || repos.includes(name));

    // The repo filter mirrors telemetryStats' bucket-don't-drop rule — here there is nothing to
    // bucket (the panels above carry the exclusion counts), so out-of-repo inputs simply fall
    // out of every distribution.
    const visibleSessions = sessions.filter(
        (s) => inRepoScope(s.repo) && (user === undefined || (s.user !== null && s.user.id === user.id))
    );
    const visibleRuns = runs.filter(
        (r) => inRepoScope(r.repo) && (user === undefined || (r.createdBy !== null && r.createdBy === user.id))
    );

    // The task set: a session attributed to the thread, or a run in it — either one puts the
    // task in scope. Sessions with no task (null taskKey) belong to no thread and no figure.
    const tasks = new Set<string>();
    for (const session of visibleSessions) {
        if (session.taskKey !== null) tasks.add(session.taskKey);
    }
    for (const run of visibleRuns) tasks.add(run.rootJobId);

    // Tokens: summed over each task's sessions, null contributors skipped — but a task whose
    // sessions measured nothing at all is EXCLUDED from the distribution, never counted as a
    // zero-total task.
    const tokenLists = new Map<string, (number | null)[]>();
    for (const session of visibleSessions) {
        if (session.taskKey === null) continue;
        const list = tokenLists.get(session.taskKey);
        if (list) list.push(billableTokens(session));
        else tokenLists.set(session.taskKey, [billableTokens(session)]);
    }
    const tokenValues: number[] = [];
    for (const task of tasks) {
        const total = (tokenLists.get(task) ?? []).reduce<number | null>(
            (acc, v) => (v === null ? acc : (acc ?? 0) + v),
            null
        );
        if (total !== null) tokenValues.push(total);
    }

    // Job turns: one run row, one job turn. Every task in scope counts, including one whose
    // runs all fell outside the range — it got here through its sessions, and its zero is
    // real (no run of this task was queued inside the range).
    const jobTurnCounts = new Map<string, number>();
    for (const run of visibleRuns) {
        jobTurnCounts.set(run.rootJobId, (jobTurnCounts.get(run.rootJobId) ?? 0) + 1);
    }
    const jobTurnValues: number[] = [...tasks].map((task) => jobTurnCounts.get(task) ?? 0);

    // Agent turns: the sum of the runs' stored counts. A task with any unmeasured in-range
    // run is excluded from THIS distribution only — a partial sum presented as a total is a
    // quiet undercount — while its tokens and job turns still count in theirs.
    const agentTurns = new Map<string, { sum: number; unmeasured: boolean }>();
    for (const run of visibleRuns) {
        const entry = agentTurns.get(run.rootJobId) ?? { sum: 0, unmeasured: false };
        if (run.agentTurns === null) entry.unmeasured = true;
        else entry.sum += run.agentTurns;
        agentTurns.set(run.rootJobId, entry);
    }
    const agentTurnValues: number[] = [];
    for (const task of tasks) {
        const entry = agentTurns.get(task);
        if (entry?.unmeasured) continue;
        // No in-range run banks zero conversation within the range — measured, not missing.
        agentTurnValues.push(entry?.sum ?? 0);
    }

    // Wall clock: the execution time the board banked, summed over the task's in-range runs.
    // The same exclude-don't-zero shape as agent turns — one never-executed (null) run would
    // make any sum a quiet undercount, so the task leaves THIS distribution only. A task with
    // no in-range run banked nothing in the range, and that zero is a measurement.
    const wallClock = new Map<string, { sum: number; unmeasured: boolean }>();
    for (const run of visibleRuns) {
        const entry = wallClock.get(run.rootJobId) ?? { sum: 0, unmeasured: false };
        if (run.wallClockMs === null) entry.unmeasured = true;
        else entry.sum += run.wallClockMs;
        wallClock.set(run.rootJobId, entry);
    }
    const wallClockValues: number[] = [];
    for (const task of tasks) {
        const entry = wallClock.get(task);
        if (entry?.unmeasured) continue;
        wallClockValues.push(entry?.sum ?? 0);
    }

    return {
        tokensPerTask: distribution(tokenValues),
        jobTurnsPerTask: distribution(jobTurnValues),
        agentTurnsPerTask: distribution(agentTurnValues),
        wallClockPerTask: distribution(wallClockValues),
    };
}
