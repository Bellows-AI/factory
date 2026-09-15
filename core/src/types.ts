/**
 * Telemetry from AI coding agents, scoped to the repos this deployment reports on.
 *
 * There is deliberately no monetary field anywhere below. Prices and cache discounts
 * change, and a dollar figure invites precision these totals cannot support.
 */

/**
 * The entity that owns a set of repos and partitions all stored history.
 *
 * `id` and `name` are separate fields because they are different kinds of thing: the id is a KEY —
 * it leads every org-owned primary key and travels back to the server as `?org=` — and the name is
 * only ever a label. Collapsing them is the `{ totalCount, nodes }` mistake in miniature: one
 * field standing in for two values a call site must never confuse.
 */
export interface Organization {
    readonly id: string;
    readonly name: string;
}

export interface OrganizationMeta {
    /**
     * 'config'    — one org, defined by ORG_ID/ORG_NAME. `available` is exactly `[current]`.
     * 'directory' — orgs come from a user directory; `available` is this caller's memberships.
     *
     * A discriminant rather than an inference from `available.length > 1`, because those are
     * different facts. A directory user who belongs to one org today can be given a second
     * tomorrow with no deploy; a control disabled by list length would be inert for the wrong
     * reason and correct only by accident.
     */
    readonly mode: 'config' | 'directory';
    readonly current: Organization;
    /**
     * Never empty, and always contains `current`. Length 1 is the common case, not a special case —
     * which is what lets the selector be one component with no mode-specific branch.
     */
    readonly available: readonly Organization[];
}

/**
 * The four types are never summed into one figure: a long cached conversation would
 * count the same context repeatedly. Where one number is needed it is input + output.
 */
export interface TokenTotals {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheCreation: number | null;
}

/**
 * A person, resolved at read time from the store's own audit rows (never denormalised:
 * logins and display names go stale, joins do not). `name` and `avatarUrl` are optional
 * labels the source may not have; `login` is the display fallback.
 */
export interface UserRef {
    id: string;
    login: string;
    name: string | null;
    avatarUrl: string | null;
}

export interface SessionRollup {
    sessionId: string;
    agent: string;
    /** Resolved from the hook, not from telemetry. null means the hook never reported. */
    repo: string | null;
    /**
     * Who queued the board task this session belongs to, resolved by joining the telemetry
     * rows to the job audit rows on session id. null means no matching task exists — a local
     * dev run, a backfilled transcript, a job that died before reporting its session. The
     * telemetry tables carry no identity themselves (the collector strips it on purpose);
     * attribution is a read-side join, so this stays null rather than guessed.
     */
    user: UserRef | null;
    /**
     * The job thread the session's board task belongs to — the `root_job_id` of the job rows
     * that resolved `user`, resolved by the same read-side join. null means no matching task
     * exists, exactly as for `user`: a removed thread, a local dev run, a backfilled
     * transcript. It is a key into the board's own rows, never a label.
     */
    taskKey: string | null;
    firstSeen: string;
    lastSeen: string;
    tokens: TokenTotals;
    linesAdded: number | null;
    linesRemoved: number | null;
    editsAccepted: number | null;
    editsRejected: number | null;
    activeSeconds: number | null;
    commits: number | null;
}

export interface TelemetryInput {
    /** Every session in the store, unfiltered. telemetryStats() applies the repo filter. */
    sessions: SessionRollup[];
    coverage: { from: string | null; to: string | null };
}

/**
 * One bucket of the usage series, a day or an ISO week — `series.granularity` names which.
 * Bucketing happens in core, never in the database (`time_bucket()`), so the seeding and the
 * partial flag behave identically over every source.
 */
export interface TelemetryPoint {
    /** The bucket's UTC start: midnight of the day, or the ISO week's Monday, as YYYY-MM-DD. */
    start: string;
    sessions: number;
    tokens: TokenTotals;
    linesAdded: number;
    linesRemoved: number;
    partial: boolean;
}

export interface TelemetryStats {
    totals: {
        sessions: number;
        tokens: TokenTotals;
        activeHours: number | null;
        linesAdded: number | null;
        linesRemoved: number | null;
        acceptRatio: number | null;
    };
    /** Sessions the hook attributed to a different repo. */
    otherRepoSessions: number;
    /** Sessions with telemetry but no hook data — the plugin is missing, or failing. */
    sessionsWithoutHook: number;
    /** Per-user rollup over the in-scope sessions that carry a user. */
    byUser: readonly { user: UserRef; sessions: number; tokens: TokenTotals }[];
    /**
     * In-scope sessions with no user — telemetry exists but no board task matches the session
     * id. Distinct from `sessionsWithoutHook`, which counts sessions with no repo at all.
     */
    unattributedSessions: number;
    /** The usage series, bucketed by the granularity the window span chose. */
    series: { granularity: 'day' | 'week'; points: TelemetryPoint[] };
    coverage: { from: string | null; to: string | null };
}

/**
 * One run of the board: a job row. "Job turn" in the dashboard's terminology — a task's first
 * run or a follow-up, the member delivering one prompt. The four fields are exactly what the
 * task statistics read; anything more belongs to the board's own API, not this payload.
 */
export interface JobRun {
    /** The thread root this run belongs to (`job.root_job_id`) — the task key. */
    rootJobId: string;
    /** Who queued the run (`job.created_by`). null on rows that predate attribution. */
    createdBy: string | null;
    /** When the run was queued — the instant range selection keys on. */
    createdAt: string;
    /**
     * Assistant response cycles counted in the run's root conversation at close, reported by
     * the executor's own session records. null is UNMEASURED — the read failed, the run was
     * killed first, or the mode keeps no record — and never means zero. A genuine
     * zero-response run reports 0.
     */
    agentTurns: number | null;
}

/** One distribution of per-task figures: the spread of what a task cost, over the tasks measured. */
export interface TaskUsageDistribution {
    avg: number | null;
    /** Nearest-rank median over tasks sorted ascending, so the figures recompute by hand. */
    p50: number | null;
    p95: number | null;
    /**
     * How many tasks this distribution was computed over. A p95 over five tasks must render
     * beside its count, never masquerade as a settled statistic.
     */
    tasks: number;
}

/**
 * What a task costs, as distributions over the job threads in scope. The three figures are
 * measured differently and never conflated: tokens sum over attributed sessions, job turns
 * count the board's own run rows, agent turns sum the close-time counts of those runs. Every
 * figure degrades to null (with `tasks` 0) when nothing was measured — never to zero.
 */
export interface TaskUsageStats {
    /** Input + output per task. Tasks with no measured tokens are excluded, not zeroed. */
    tokensPerTask: TaskUsageDistribution;
    /** Runs per task — job rows queued in the range, every run and follow-up counted once. */
    jobTurnsPerTask: TaskUsageDistribution;
    /**
     * Agent turns per task — the sum of the runs' stored counts. A task with any unmeasured
     * in-range run is excluded from THIS distribution only, never summed partially.
     */
    agentTurnsPerTask: TaskUsageDistribution;
}
