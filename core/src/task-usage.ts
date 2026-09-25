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

const P50 = 0.5;
const P95 = 0.95;

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
        p50: rank(P50),
        p95: rank(P95),
        tasks: sorted.length,
    };
}

/**
 * Tokens: summed over each task's sessions, null contributors skipped — but a task whose
 * sessions measured nothing at all is EXCLUDED from the distribution, never counted as a
 * zero-total task.
 */
function computeTokenValues(sessions: readonly SessionRollup[], tasks: ReadonlySet<string>): number[] {
    const tokenLists = new Map<string, (number | null)[]>();
    for (const session of sessions) {
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
    return tokenValues;
}

/**
 * Job turns: one run row, one job turn. Every task in scope counts, including one whose
 * runs all fell outside the range — it got here through its sessions, and its zero is
 * real (no run of this task was queued inside the range).
 */
function computeJobTurnValues(runs: readonly JobRun[], tasks: ReadonlySet<string>): number[] {
    const jobTurnCounts = new Map<string, number>();
    for (const run of runs) {
        jobTurnCounts.set(run.rootJobId, (jobTurnCounts.get(run.rootJobId) ?? 0) + 1);
    }
    return [...tasks].map((task) => jobTurnCounts.get(task) ?? 0);
}

/**
 * Shared shape behind agent turns and wall clock: sum a per-run measurement onto its task,
 * but a task with any unmeasured (null) in-range run is excluded from THIS distribution only —
 * a partial sum presented as a total is a quiet undercount. A task with no in-range run banked
 * nothing in the range, and that zero is a measurement, not a missing value.
 */
function sumMeasuredPerTask(
    runs: readonly JobRun[],
    tasks: ReadonlySet<string>,
    getValue: (run: JobRun) => number | null
): number[] {
    const sums = new Map<string, { sum: number; unmeasured: boolean }>();
    for (const run of runs) {
        const entry = sums.get(run.rootJobId) ?? { sum: 0, unmeasured: false };
        const value = getValue(run);
        if (value === null) entry.unmeasured = true;
        else entry.sum += value;
        sums.set(run.rootJobId, entry);
    }
    const values: number[] = [];
    for (const task of tasks) {
        const entry = sums.get(task);
        if (entry?.unmeasured) continue;
        values.push(entry?.sum ?? 0);
    }
    return values;
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

    return {
        tokensPerTask: distribution(computeTokenValues(visibleSessions, tasks)),
        jobTurnsPerTask: distribution(computeJobTurnValues(visibleRuns, tasks)),
        agentTurnsPerTask: distribution(sumMeasuredPerTask(visibleRuns, tasks, (r) => r.agentTurns)),
        wallClockPerTask: distribution(sumMeasuredPerTask(visibleRuns, tasks, (r) => r.wallClockMs)),
    };
}
