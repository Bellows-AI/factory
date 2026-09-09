/**
 * Vendor metric name -> canonical field, in one table.
 *
 * This is the seam that keeps the feature from being Claude-specific. opencode and other
 * agents also speak OTLP but use their own metric names, so adding one is adding rows here —
 * not a schema change, not a type change. `agent` is a plain string for the same reason.
 *
 * An unmapped metric resolves to null and is stored anyway, so a new tool's data accumulates
 * before support for it is written.
 */

/** Fields the aggregation understands. Deliberately no cost field: see AGENTS.md. */
export type CanonicalField =
    | 'tokens_input'
    | 'tokens_output'
    | 'tokens_cacheRead'
    | 'tokens_cacheCreation'
    | 'lines_added'
    | 'lines_removed'
    | 'edits_accept'
    | 'edits_reject'
    | 'active_seconds'
    | 'commits'
    | 'pull_requests'
    | 'sessions';

interface Rule {
    /** Resolves the field, possibly using a datapoint attribute to disambiguate. */
    field: (attrs: Record<string, string>) => CanonicalField | null;
}

/** Resolves the field from one attribute, e.g. token.usage's `type`. */
const enumerated = (attr: string, values: Record<string, CanonicalField>): Rule => ({
    field: (attrs) => values[attrs[attr] ?? ''] ?? null,
});

/**
 * The opencode executor mirrors Claude Code's metric surface (via its OTLP plugin), so both
 * agents share the same disambiguating attribute values. One map, two prefixes.
 */
const TOKEN_TYPES = {
    input: 'tokens_input',
    output: 'tokens_output',
    cacheRead: 'tokens_cacheRead',
    cacheCreation: 'tokens_cacheCreation',
} as const satisfies Record<string, CanonicalField>;

const LINE_TYPES = {
    added: 'lines_added',
    removed: 'lines_removed',
} as const satisfies Record<string, CanonicalField>;

const EDIT_DECISIONS = {
    accept: 'edits_accept',
    reject: 'edits_reject',
} as const satisfies Record<string, CanonicalField>;

const RULES: Record<string, Rule> = {
    'claude_code.token.usage': enumerated('type', TOKEN_TYPES),
    'claude_code.lines_of_code.count': enumerated('type', LINE_TYPES),
    'claude_code.code_edit_tool.decision': enumerated('decision', EDIT_DECISIONS),
    'claude_code.active_time.total': { field: () => 'active_seconds' },
    'claude_code.commit.count': { field: () => 'commits' },
    'claude_code.pull_request.count': { field: () => 'pull_requests' },
    'claude_code.session.count': { field: () => 'sessions' },
    'opencode.token.usage': enumerated('type', TOKEN_TYPES),
    'opencode.lines_of_code.count': enumerated('type', LINE_TYPES),
    'opencode.tool.decision': enumerated('decision', EDIT_DECISIONS),
    'opencode.active_time.total': { field: () => 'active_seconds' },
    'opencode.commit.count': { field: () => 'commits' },
    'opencode.pull_request.count': { field: () => 'pull_requests' },
    'opencode.session.count': { field: () => 'sessions' },
};

/** The agent that produced a metric, from its name prefix. */
export function agentOf(metric: string): string {
    if (metric.startsWith('claude_code.')) return 'claude-code';
    if (metric.startsWith('opencode.')) return 'opencode';
    return 'unknown';
}

export function canonicalField(
    metric: string,
    attrs: Record<string, string>,
): CanonicalField | null {
    return RULES[metric]?.field(attrs) ?? null;
}
