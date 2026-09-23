/**
 * The workflow definition grammar: types, the strict validator, and the prompt-template
 * interpolation. Pure — no I/O, no imports — so the offline suite pins every rule in it, and the
 * store, the engine and the claim's publish read all speak one grammar (docs/workflows.md).
 *
 * The grammar is deliberately closed. A node is an `agent` node and nothing else: checkout/sync,
 * gates and publish are driver machinery the graph references by OUTCOME (`gate-failed`, a
 * `publish: true` node), never nodes with containers. An edge rule is a terminal verdict, the
 * gate-failure fact, or an exact output-tail marker — nothing the board does not already store on
 * its own rows. Unknown keys are refused with named errors: a pasted foreign pipeline fails loudly
 * instead of silently doing nothing.
 */

/** The size cap of a definition, in JSON characters — the same body-limit discipline as commands. */
export const DEFINITION_LIMIT = 16_384;

/**
 * The size cap of a COMPILED definition — after block nodes are expanded into their low-level
 * subgraphs (workflow-blocks/index.ts). Wider than DEFINITION_LIMIT because one authored block
 * reference can expand into many nodes and edges; still bounded, because the expanded graph is
 * exactly what freezes onto a root job's snapshot.
 */
export const EXPANDED_DEFINITION_LIMIT = 65_536;

/**
 * The command a substituted prompt may reach: the board refuses an insert past the cap rather than
 * handing the driver a command it cannot report against (routes/jobs.ts enforces the same number
 * on every create).
 */
export const COMMAND_LIMIT = 16_384;

/**
 * Each substituted output tail's share of the command cap. Interpolation bounds every tail
 * independently and hard-truncates with a visible marker — a workflow that chains five outputs
 * stays a command, not a transcript.
 */
export const INTERP_TAIL_LIMIT = 4_096;

/** The truncation marker appended when a tail is cut. Part of the output contract, never silent. */
export const TRUNCATION_MARKER = '\n[…truncated by the board]';

/** A node name is a lowercase identifier the placeholders can reference: `{{fetch-issue.output}}`. */
export const NODE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A parameter name obeys the same identifier rule a node name does: it is referenced by the
 * `{{param.NAME}}` placeholder in any node's prompt.
 */
export const PARAM_NAME = NODE_NAME;

/** A parameter's pattern is a regex SOURCE, bounded where author content crosses into RegExp. */
export const PATTERN_LIMIT = 256;

/** Bounded author guidance: the composer renders it beside the input, so it stays a sentence. */
export const PARAM_DESCRIPTION_LIMIT = 160;
export const PARAM_EXAMPLE_LIMIT = 120;

/** The character cap on one parameter value — bounded author content, like everything interpolated. */
export const PARAM_VALUE_LIMIT = 512;

/** A block reference: `namespace/block-name`, each segment the same lowercase-hyphenated shape. */
export const BLOCK_USES = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const BLOCK_USES_LIMIT = 128;

/** At most this many `with` keys — generic bounding; a block's own configSchema is the real shape. */
export const BLOCK_WITH_MAX_KEYS = 16;

/** A `with` config key: camelCase, like `maxRounds` in the grammar's own example — not NODE_NAME's
 *  lowercase-hyphenated shape, which is a display identifier, not a config field name. */
export const BLOCK_CONFIG_KEY = /^[a-z][a-zA-Z0-9]{0,63}$/;

/** A marker is a fixed string the node's block must emit as its final line. Bounded, non-empty. */
export const MARKER_LIMIT = 256;

/** An edge's loop bound: far past any real loop count, and the ceiling `BAD_BOUND` enforces. */
export const MAX_EDGE_BOUND = 1_000;

/** A workflow name: human-chosen, unique per scope; the row check restates this at the boundary. */
export const WORKFLOW_NAME = /^.{1,100}$/;

/** A repo scope segment obeys the checkout-directory rules, the same ones `repoReason` enforces. */
export const SCOPE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** One node of the graph. `kind` is closed on `agent` — see the module comment. */
export interface WorkflowNode {
    name: string;
    kind: 'agent';
    /**
     * What a claim of this node resumes. `resume` carries the thread's primary session from insert
     * (the session of the thread's first `resume` run); `fresh` claims with none and mints its own
     * — fresh eyes for a review, one worktree, N sessions.
     */
    session: 'resume' | 'fresh';
    /**
     * The prompt template the board interpolates at row-insert time. Placeholders:
     * `{{nodeName.output}}` — the named node's most recent stored output tail — and
     * `{{gate.name}}` / `{{gate.output}}` — the completed run's first failed gate, for gate-fix
     * blocks. Anything else in `{{...}}` is refused by the validator.
     */
    prompt: string;
    /**
     * Whether the driver's gates run for this node's run. Default true, matching today; a
     * fresh-eyes review may opt out — it must not fail the thread on a gate it did not touch.
     */
    gates?: boolean;
    /**
     * Whether the driver publishes after this node's succeeded gated run. Default false: a
     * mid-loop review success never pushes. Exactly the nodes that say `publish: true` — the
     * graph's exit — get the flag on their claim.
     */
    publish?: boolean;
}

/** A block config value: a bounded JSON scalar — workflow-schema.ts knows no block's real shape. */
export type BlockConfigValue = string | number | boolean;

/**
 * A reference to a board-owned, allowlisted block (issue #204) — the authored alternative to an
 * inline `agent` node. `uses` names a reserved block id (`namespace/block-name`); the registry
 * under `server/src/db/workflow-blocks/` owns which ids exist, their config shape, availability
 * and expansion — this module stays registry-unaware and validates structural shape only. `with`
 * is generically bounded here (scalar values, a conservative key count); a block's own
 * `configSchema` enforces its real types and ranges at compile time.
 */
export interface BlockNode {
    name: string;
    kind: 'block';
    uses: string;
    with?: Record<string, BlockConfigValue>;
}

/** A node as AUTHORED: either an inline `agent` node or a `block` reference. Never mixed. */
export type AuthoredWorkflowNode = WorkflowNode | BlockNode;

/**
 * A definition as AUTHORED — what a member POSTs. Distinct from `WorkflowDefinition` (the
 * low-level, agent-only shape `workflow-engine.ts`, `job-store.ts` and `routes/jobs.ts` already
 * depend on): a block node never reaches those files. `workflow-blocks/index.ts`'s
 * `compileDefinition` turns one of these into a `WorkflowDefinition` before it is ever stored.
 */
export interface AuthoredWorkflowDefinition {
    entry: string;
    nodes: AuthoredWorkflowNode[];
    edges: WorkflowEdge[];
    params: WorkflowParam[];
}

/**
 * An edge's transition rule. A string is a terminal verdict (`succeeded` / `failed`) or the
 * `gate-failed` fact (derived from the run's stored gate results, never parsed from prose); an
 * object is an exact output-tail marker match — the completed run's final line must equal it.
 */
export type EdgeRule = 'succeeded' | 'failed' | 'gate-failed' | { marker: string };

export interface WorkflowEdge {
    from: string;
    to: string;
    when: EdgeRule;
    /**
     * Maximum traversals of this edge: the thread must not already hold `max` rows for `to` when
     * the rule matches. Derived from the audit trail at transition time; absent means the author
     * allows the edge to fire unboundedly.
     */
    max?: number;
}

/**
 * One declared workflow parameter. Every declared param is REQUIRED on launch: `POST /api/jobs`
 * refuses a task whose body does not carry a valid value for each (routes/jobs.ts,
 * `BAD_WORKFLOW_PARAMS`) — a parametrized workflow must never launch on a guess.
 */
export interface WorkflowParam {
    /** A lowercase identifier the prompts reference: `{{param.issue}}`. Unique in the graph. */
    name: string;
    /**
     * Optional regex SOURCE the value must fully match (`^(?:source)$` — authors write a bare
     * shape, never anchors). Absent means any non-empty bounded string.
     */
    pattern?: string;
    /**
     * Optional plain-language guidance the composer shows beside the input. Presentation only —
     * it never participates in interpolation or launch validation. Trimmed, non-empty, at most
     * 160 characters.
     */
    description?: string;
    /**
     * Optional valid example the composer may hint with. Presentation only, like `description`.
     * Trimmed, non-empty, at most 120 characters.
     */
    example?: string;
}

export interface WorkflowDefinition {
    /**
     * The node a thread's first run walks. Optional in the JSON (the first declared node is the
     * entry), always resolved on the stored value.
     */
    entry: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    /**
     * The required launch parameters. Optional in the JSON (normalized to [] by the validator),
     * always resolved on the stored value.
     */
    params: WorkflowParam[];
}

/** Why a definition was refused. The code is the API's name for it; the message names the culprit. */
export interface DefinitionRefusal {
    code:
        | 'BAD_DEFINITION'
        | 'UNKNOWN_KEY'
        | 'BAD_NODES'
        | 'BAD_NODE'
        | 'DUPLICATE_NODE'
        | 'BAD_EDGES'
        | 'UNKNOWN_NODE'
        | 'BAD_RULE'
        | 'BAD_BOUND'
        | 'BAD_PARAMS'
        | 'UNKNOWN_PLACEHOLDER'
        | 'NO_PUBLISH_PATH'
        | 'TOO_LARGE';
    message: string;
}

export type DefinitionCheck =
    | { ok: true; definition: AuthoredWorkflowDefinition }
    | { ok: false; refusal: DefinitionRefusal };

/** Validates the tail-marker contract: the run's final non-empty line must equal the marker. */
export function tailMatches(output: string | null, marker: string): boolean {
    if (output === null) return false;
    const lines = output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    const last = lines[lines.length - 1];
    return last !== undefined && last === marker.trim();
}

// The strict validator and every section parser it composes: split out to
// workflow-schema-validate.ts (AGENTS.md's file-length budget), re-exported here so every
// existing import of `./workflow-schema.js` keeps resolving the same name.
export { validateDefinition } from './workflow-schema-validate.js';

/** A named node of a definition, or undefined. */
export function nodeOf(definition: WorkflowDefinition, name: string): WorkflowNode | undefined {
    return definition.nodes.find((node) => node.name === name);
}

/** Whether the named node is a publish node — the claim's flag reads this, per row. */
export function isPublishNode(definition: WorkflowDefinition, name: string): boolean {
    return nodeOf(definition, name)?.publish === true;
}

/**
 * Hard-truncates an output tail to its share of the command cap, with a visible marker — never a
 * silent cut. Exported so the interpolation tests pin the exact bytes.
 */
export function boundedTail(output: string, limit = INTERP_TAIL_LIMIT): string {
    if (output.length <= limit) return output;
    return output.slice(0, limit) + TRUNCATION_MARKER;
}

export interface InterpolationContext {
    /** The named node's most recent stored output tail, or '' when the node has not run yet. */
    nodeOutput: (name: string) => string;
    /** The completed run's first failed gate's name and output tail; '' when gates passed. */
    gateName: string;
    gateOutput: string;
    /** The thread's frozen parameter value, or '' when the name was never declared. */
    param: (name: string) => string;
    /** The thread root's command — for a workflow thread, the interpolated entry prompt. */
    command: string;
}

/**
 * Fills a node's prompt template at row-insert time. Unknown placeholders would be a validator
 * bug (the snapshot is validated) — a throw is the honest answer, never a silent empty string.
 *
 * `{{command}}` is the one UNBOUNDED substitution: it is the member's own words, already capped
 * at the boundary that accepted them, and a silent 4 KiB cut mid-sentence would mangle the very
 * text the route let through — the caller's post-interpolation command cap is the guard instead.
 */
export function interpolate(template: string, context: InterpolationContext): string {
    return template.replace(/\{\{([^{}]+)\}\}/g, (whole, raw: string) => {
        const spec = raw.trim();
        const paramRef = /^param\.([a-z0-9-]+)$/.exec(spec);
        if (paramRef) return boundedTail(context.param(paramRef[1]!));
        if (spec === 'command') return context.command;
        if (spec === 'gate.name') return boundedTail(context.gateName);
        if (spec === 'gate.output') return boundedTail(context.gateOutput);
        const nodeRef = /^([a-z0-9-]+)\.output$/.exec(spec);
        if (nodeRef) return boundedTail(context.nodeOutput(nodeRef[1]!));
        throw new Error(`unknown workflow placeholder "${whole}"`);
    });
}

/** The launch parameter values a client sends beside the command: a plain object of strings. */
export type ParamValues = Record<string, string>;

/** Why a launch's parameter values were refused. The route surfaces it as `400 BAD_WORKFLOW_PARAMS`. */
export type ParamValuesCheck =
    | { ok: true; values: ParamValues }
    | { ok: false; refusal: { code: 'BAD_WORKFLOW_PARAMS'; message: string } };

const refuseParams = (message: string): ParamValuesCheck => ({
    ok: false,
    refusal: { code: 'BAD_WORKFLOW_PARAMS', message },
});

/** One declared param's value against `checkWorkflowParams`'s rules, in isolation. */
function checkWorkflowParamValue(
    declared: WorkflowParam,
    value: unknown
): { ok: true; value: string } | { ok: false; message: string } {
    if (value === undefined) {
        return { ok: false, message: `missing required workflow parameter "${declared.name}"` };
    }
    if (typeof value !== 'string') {
        return { ok: false, message: `workflow parameter "${declared.name}" must be a string` };
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return { ok: false, message: `workflow parameter "${declared.name}" must be a non-empty string` };
    }
    if (trimmed.length > PARAM_VALUE_LIMIT) {
        return { ok: false, message: `workflow parameter "${declared.name}" exceeds ${PARAM_VALUE_LIMIT} characters` };
    }
    if (declared.pattern !== undefined && !new RegExp(`^(?:${declared.pattern})$`).test(trimmed)) {
        return { ok: false, message: `workflow parameter "${declared.name}" must match ${declared.pattern}` };
    }
    return { ok: true, value: trimmed };
}

/**
 * Validates the `workflowParams` body field against the resolved definition's declarations. Every
 * declared param is required; unknown keys are refused (a typo must never read as "already
 * covered"); values are bounded strings, trimmed, and full-matched against the declared pattern.
 * Pure — the route calls it at the resolution point, and the composer mirrors it client-side.
 */
export function checkWorkflowParams(definition: WorkflowDefinition, raw: unknown): ParamValuesCheck {
    if (raw === undefined || raw === null) raw = {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return refuseParams('workflowParams must be an object of string values');
    }
    const body = raw as Record<string, unknown>;
    const values: ParamValues = {};
    for (const declared of definition.params) {
        const checked = checkWorkflowParamValue(declared, body[declared.name]);
        if (!checked.ok) return refuseParams(checked.message);
        values[declared.name] = checked.value;
    }
    for (const key of Object.keys(body)) {
        if (!definition.params.some((p) => p.name === key)) {
            return refuseParams(`unknown workflow parameter "${key}"`);
        }
    }
    return { ok: true, values };
}
