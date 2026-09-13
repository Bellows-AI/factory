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

export interface SessionRollup {
    sessionId: string;
    agent: string;
    /** Resolved from the hook, not from telemetry. null means the hook never reported. */
    repo: string | null;
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

export interface TelemetryWeekPoint {
    week: string;
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
    weekly: TelemetryWeekPoint[];
    coverage: { from: string | null; to: string | null };
}
