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

import { isSafePattern } from './workflow-pattern.js';

/** The size cap of a definition, in JSON characters — the same body-limit discipline as commands. */
export const DEFINITION_LIMIT = 16_384;

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
const NODE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A parameter name obeys the same identifier rule a node name does: it is referenced by the
 * `{{param.NAME}}` placeholder in any node's prompt.
 */
const PARAM_NAME = NODE_NAME;

/** A parameter's pattern is a regex SOURCE, bounded where author content crosses into RegExp. */
const PATTERN_LIMIT = 256;

/** Bounded author guidance: the composer renders it beside the input, so it stays a sentence. */
export const PARAM_DESCRIPTION_LIMIT = 160;
export const PARAM_EXAMPLE_LIMIT = 120;

/** The character cap on one parameter value — bounded author content, like everything interpolated. */
export const PARAM_VALUE_LIMIT = 512;

/** A marker is a fixed string the node's block must emit as its final line. Bounded, non-empty. */
const MARKER_LIMIT = 256;

/** An edge's loop bound: far past any real loop count, and the ceiling `BAD_BOUND` enforces. */
const MAX_EDGE_BOUND = 1_000;

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

export type DefinitionCheck = { ok: true; definition: WorkflowDefinition } | { ok: false; refusal: DefinitionRefusal };

const refuse = (code: DefinitionRefusal['code'], message: string): DefinitionCheck => ({
    ok: false,
    refusal: { code, message },
});

/**
 * The shape every `validateDefinition` section parser answers with: the parsed value, or the
 * refusal to propagate — split out purely to keep `validateDefinition` itself under the repo's
 * complexity ceiling. Each section is checked in the same order and refuses with the same codes
 * and messages the monolithic validator always has.
 */
type StepResult<T> = { ok: true; value: T } | { ok: false; refusal: DefinitionRefusal };

function stepRefuse<T>(code: DefinitionRefusal['code'], message: string): StepResult<T> {
    return { ok: false, refusal: { code, message } };
}

const KNOWN_NODE_KEYS = new Set(['name', 'kind', 'session', 'prompt', 'gates', 'publish']);
const KNOWN_EDGE_KEYS = new Set(['from', 'to', 'when', 'max']);
const KNOWN_TOP_KEYS = new Set(['entry', 'nodes', 'edges', 'params']);

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

const KNOWN_PARAM_KEYS = new Set(['name', 'pattern', 'description', 'example']);

/** Resolves and dedupes a declared param's name — the one field every other check depends on. */
function resolveParamName(param: Record<string, unknown>, i: number, paramNames: Set<string>): StepResult<string> {
    const name = param.name;
    if (typeof name !== 'string' || !PARAM_NAME.test(name)) {
        return stepRefuse('BAD_PARAMS', `params[${i}].name must match ${PARAM_NAME.source}`);
    }
    if (paramNames.has(name)) return stepRefuse('BAD_PARAMS', `duplicate param name "${name}"`);
    paramNames.add(name);
    return { ok: true, value: name };
}

/** Resolves a declared param's optional pattern: bounded, in the safe subset, and compilable. */
function resolveParamPattern(param: Record<string, unknown>, i: number): StepResult<string | undefined> {
    if (param.pattern === undefined) return { ok: true, value: undefined };
    if (typeof param.pattern !== 'string' || !param.pattern.trim() || param.pattern.length > PATTERN_LIMIT) {
        return stepRefuse(
            'BAD_PARAMS',
            `params[${i}].pattern must be a non-empty regex source of at most ${PATTERN_LIMIT} characters`
        );
    }
    if (!isSafePattern(param.pattern)) {
        return stepRefuse(
            'BAD_PARAMS',
            `params[${i}].pattern is outside the safe subset — see docs/workflows.md "Launch parameters"`
        );
    }
    try {
        new RegExp(param.pattern);
    } catch {
        return stepRefuse('BAD_PARAMS', `params[${i}].pattern does not compile: ${param.pattern}`);
    }
    return { ok: true, value: param.pattern };
}

/** The parts of `resolveGuidanceField`'s call that stay fixed across both guidance keys. */
interface GuidanceContext {
    param: Record<string, unknown>;
    i: number;
    pattern: string | undefined;
}

/**
 * One guidance field (`description` or `example`), in isolation. The one exception that keeps
 * the guidance honest: an EXAMPLE is served as a pre-fill/hint for an input the launch validates,
 * so an example the declared pattern would refuse is refused here, with the same full-match
 * semantics as launch.
 */
function resolveGuidanceField(
    ctx: GuidanceContext,
    key: 'description' | 'example',
    limit: number
): StepResult<string | undefined> {
    const raw = ctx.param[key];
    if (raw === undefined) return { ok: true, value: undefined };
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed || trimmed.length > limit) {
        return stepRefuse(
            'BAD_PARAMS',
            `params[${ctx.i}].${key} must be a non-empty string of at most ${limit} characters`
        );
    }
    if (key === 'example' && ctx.pattern !== undefined && !new RegExp(`^(?:${ctx.pattern})$`).test(trimmed)) {
        return stepRefuse('BAD_PARAMS', `params[${ctx.i}].example must match ${ctx.pattern}`);
    }
    return { ok: true, value: trimmed };
}

/**
 * The guidance pair is presentation metadata for the composer: bounded sentences, validated on
 * the TRIMMED value (the marker precedent) and retained trimmed on the normalized definition. They
 * feed nothing else — `checkWorkflowParams` and the interpolator never read them; guidance never
 * substitutes for the pattern.
 */
function resolveParamGuidance(
    param: Record<string, unknown>,
    i: number,
    pattern: string | undefined
): StepResult<{ description?: string; example?: string }> {
    const ctx: GuidanceContext = { param, i, pattern };
    const description = resolveGuidanceField(ctx, 'description', PARAM_DESCRIPTION_LIMIT);
    if (!description.ok) return description;
    const example = resolveGuidanceField(ctx, 'example', PARAM_EXAMPLE_LIMIT);
    if (!example.ok) return example;
    return {
        ok: true,
        value: {
            ...(description.value !== undefined ? { description: description.value } : {}),
            ...(example.value !== undefined ? { example: example.value } : {}),
        },
    };
}

/** One declared param of `definition.params`, in isolation — see `validateDefinition`. */
function parseWorkflowParam(item: unknown, i: number, paramNames: Set<string>): StepResult<WorkflowParam> {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return stepRefuse('BAD_PARAMS', `definition.params[${i}] must be an object`);
    }
    const param = item as Record<string, unknown>;
    for (const key of Object.keys(param)) {
        if (!KNOWN_PARAM_KEYS.has(key)) return stepRefuse('UNKNOWN_KEY', `unknown key "${key}" in params[${i}]`);
    }
    const resolvedName = resolveParamName(param, i, paramNames);
    if (!resolvedName.ok) return resolvedName;
    const resolvedPattern = resolveParamPattern(param, i);
    if (!resolvedPattern.ok) return resolvedPattern;
    const resolvedGuidance = resolveParamGuidance(param, i, resolvedPattern.value);
    if (!resolvedGuidance.ok) return resolvedGuidance;
    return {
        ok: true,
        value: {
            name: resolvedName.value,
            ...(resolvedPattern.value !== undefined ? { pattern: resolvedPattern.value } : {}),
            ...(resolvedGuidance.value.description !== undefined
                ? { description: resolvedGuidance.value.description }
                : {}),
            ...(resolvedGuidance.value.example !== undefined ? { example: resolvedGuidance.value.example } : {}),
        },
    };
}

/** `definition.params`: optional at the JSON, every declared one required at launch. */
function parseParamsSection(def: Record<string, unknown>): StepResult<WorkflowParam[]> {
    if (def.params === undefined) return { ok: true, value: [] };
    if (!Array.isArray(def.params)) {
        return stepRefuse('BAD_PARAMS', 'definition.params must be an array');
    }
    const paramNames = new Set<string>();
    const params: WorkflowParam[] = [];
    for (const [i, item] of def.params.entries()) {
        const parsed = parseWorkflowParam(item, i, paramNames);
        if (!parsed.ok) return parsed;
        params.push(parsed.value);
    }
    return { ok: true, value: params };
}

/** Resolves and dedupes a declared node's name — the one field every other check depends on. */
function resolveNodeIdentity(node: Record<string, unknown>, i: number, names: Set<string>): StepResult<string> {
    for (const key of Object.keys(node)) {
        if (!KNOWN_NODE_KEYS.has(key)) return stepRefuse('UNKNOWN_KEY', `unknown key "${key}" in nodes[${i}]`);
    }
    const name = node.name;
    if (typeof name !== 'string' || !NODE_NAME.test(name)) {
        return stepRefuse('BAD_NODE', `nodes[${i}].name must match ${NODE_NAME.source}`);
    }
    if (name === 'param') {
        // `{{param.NAME}}` is the parameter namespace and wins it — a node literally named
        // "param" could never have its `{{param.output}}` resolved.
        return stepRefuse('BAD_NODE', `nodes[${i}].name "param" is reserved`);
    }
    if (names.has(name)) return stepRefuse('DUPLICATE_NODE', `duplicate node name "${name}"`);
    names.add(name);
    return { ok: true, value: name };
}

/** One declared node of `definition.nodes`, in isolation — see `validateDefinition`. */
function parseWorkflowNode(item: unknown, i: number, names: Set<string>): StepResult<WorkflowNode> {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return stepRefuse('BAD_NODES', `definition.nodes[${i}] must be an object`);
    }
    const node = item as Record<string, unknown>;
    const resolvedName = resolveNodeIdentity(node, i, names);
    if (!resolvedName.ok) return resolvedName;
    const name = resolvedName.value;
    if (node.kind !== 'agent') {
        return stepRefuse('BAD_NODE', `nodes[${i}].kind must be "agent" — no other node kind exists`);
    }
    if (node.session !== 'resume' && node.session !== 'fresh') {
        return stepRefuse('BAD_NODE', `nodes[${i}].session must be "resume" or "fresh"`);
    }
    if (typeof node.prompt !== 'string' || !node.prompt.trim()) {
        return stepRefuse('BAD_NODE', `nodes[${i}].prompt must be a non-empty string`);
    }
    if (node.gates !== undefined && typeof node.gates !== 'boolean') {
        return stepRefuse('BAD_NODE', `nodes[${i}].gates must be a boolean`);
    }
    if (node.publish !== undefined && typeof node.publish !== 'boolean') {
        return stepRefuse('BAD_NODE', `nodes[${i}].publish must be a boolean`);
    }
    return {
        ok: true,
        value: {
            name,
            kind: 'agent',
            session: node.session as 'resume' | 'fresh',
            prompt: node.prompt,
            ...(node.gates !== undefined ? { gates: node.gates as boolean } : {}),
            ...(node.publish !== undefined ? { publish: node.publish as boolean } : {}),
        },
    };
}

/** `definition.nodes`: at least one, every one a declared-shape `agent` node with a unique name. */
function parseNodesSection(def: Record<string, unknown>): StepResult<{ nodes: WorkflowNode[]; names: Set<string> }> {
    if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
        return stepRefuse('BAD_NODES', 'definition.nodes must be a non-empty array');
    }
    const nodes: WorkflowNode[] = [];
    const names = new Set<string>();
    for (const [i, item] of def.nodes.entries()) {
        const parsed = parseWorkflowNode(item, i, names);
        if (!parsed.ok) return parsed;
        nodes.push(parsed.value);
    }
    return { ok: true, value: { nodes, names } };
}

/** Resolves an edge's declared keys and its two node references, in isolation. */
function resolveEdgeEndpoints(
    edge: Record<string, unknown>,
    i: number,
    names: Set<string>
): StepResult<{ from: string; to: string }> {
    for (const key of Object.keys(edge)) {
        if (!KNOWN_EDGE_KEYS.has(key)) return stepRefuse('UNKNOWN_KEY', `unknown key "${key}" in edges[${i}]`);
    }
    const { from, to } = edge;
    for (const [label, value] of [
        ['from', from],
        ['to', to],
    ] as const) {
        if (typeof value !== 'string' || !names.has(value)) {
            return stepRefuse('UNKNOWN_NODE', `edges[${i}].${label} names no declared node`);
        }
    }
    return { ok: true, value: { from: from as string, to: to as string } };
}

/** Resolves an edge's `when` rule: a terminal verdict, `gate-failed`, or an exact marker match. */
function resolveEdgeRule(rule: unknown, i: number): StepResult<EdgeRule> {
    if (
        rule !== 'succeeded' &&
        rule !== 'failed' &&
        rule !== 'gate-failed' &&
        (typeof rule !== 'object' ||
            rule === null ||
            Array.isArray(rule) ||
            typeof (rule as { marker?: unknown }).marker !== 'string' ||
            !(rule as { marker: string }).marker.trim() ||
            (rule as { marker: string }).marker.trim().length > MARKER_LIMIT)
    ) {
        return stepRefuse(
            'BAD_RULE',
            `edges[${i}].when must be "succeeded", "failed", "gate-failed", or { marker } with a non-empty string of at most ${MARKER_LIMIT} characters`
        );
    }
    return {
        ok: true,
        value: typeof rule === 'string' ? rule : { marker: (rule as { marker: string }).marker.trim() },
    };
}

/** Resolves an edge's optional loop bound. */
function resolveEdgeBound(edge: Record<string, unknown>, i: number): StepResult<number | undefined> {
    if (edge.max === undefined) return { ok: true, value: undefined };
    if (typeof edge.max !== 'number' || !Number.isInteger(edge.max) || edge.max < 1 || edge.max > MAX_EDGE_BOUND) {
        return stepRefuse('BAD_BOUND', `edges[${i}].max must be an integer 1..${MAX_EDGE_BOUND}`);
    }
    return { ok: true, value: edge.max };
}

/** One declared edge of `definition.edges`, in isolation — see `validateDefinition`. */
function parseWorkflowEdge(item: unknown, i: number, names: Set<string>): StepResult<WorkflowEdge> {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return stepRefuse('BAD_EDGES', `definition.edges[${i}] must be an object`);
    }
    const edge = item as Record<string, unknown>;
    const endpoints = resolveEdgeEndpoints(edge, i, names);
    if (!endpoints.ok) return endpoints;
    const rule = resolveEdgeRule(edge.when, i);
    if (!rule.ok) return rule;
    const bound = resolveEdgeBound(edge, i);
    if (!bound.ok) return bound;
    return {
        ok: true,
        value: {
            from: endpoints.value.from,
            to: endpoints.value.to,
            when: rule.value,
            ...(bound.value !== undefined ? { max: bound.value } : {}),
        },
    };
}

/** `definition.edges`: every endpoint declared, every rule in the closed vocabulary, bounds positive. */
function parseEdgesSection(def: Record<string, unknown>, names: Set<string>): StepResult<WorkflowEdge[]> {
    if (!Array.isArray(def.edges)) {
        return stepRefuse('BAD_EDGES', 'definition.edges must be an array');
    }
    const edges: WorkflowEdge[] = [];
    for (const [i, item] of def.edges.entries()) {
        const parsed = parseWorkflowEdge(item, i, names);
        if (!parsed.ok) return parsed;
        edges.push(parsed.value);
    }
    return { ok: true, value: edges };
}

/** `definition.entry`: explicit, or the first declared node. Must name a declared node. */
function resolveEntry(def: Record<string, unknown>, nodes: WorkflowNode[], names: Set<string>): StepResult<string> {
    const entry = def.entry ?? nodes[0]!.name;
    if (typeof entry !== 'string' || !names.has(entry)) {
        return stepRefuse('UNKNOWN_NODE', 'definition.entry names no declared node');
    }
    return { ok: true, value: entry };
}

/**
 * Prompt placeholders: the closed vocabulary only — node outputs, the gate pair, declared params,
 * and `{{command}}` (the thread root's command). A template referencing an unknown prior node or
 * an undeclared param would interpolate empty forever.
 */
function validatePlaceholders(nodes: WorkflowNode[], params: WorkflowParam[], names: Set<string>): StepResult<null> {
    for (const node of nodes) {
        for (const match of node.prompt.matchAll(/\{\{([^{}]+)\}\}/g)) {
            const spec = match[1]!.trim();
            const nodeRef = /^([a-z0-9-]+)\.output$/.exec(spec);
            const paramRef = /^param\.([a-z0-9-]+)$/.exec(spec);
            let known: boolean;
            if (paramRef !== null) {
                // `param.` wins the namespace: a node literally named `param` cannot shadow it.
                known = params.some((p) => p.name === paramRef[1]);
            } else if (spec === 'command') {
                known = true;
            } else {
                known = spec === 'gate.name' || spec === 'gate.output' || (nodeRef !== null && names.has(nodeRef[1]!));
            }
            if (!known) {
                return stepRefuse(
                    'UNKNOWN_PLACEHOLDER',
                    `nodes named "${node.name}" carry placeholder "{{${spec}}}" — expected {{nodeName.output}}, {{gate.name}}, {{gate.output}}, {{param.NAME}} or {{command}}`
                );
            }
        }
    }
    return { ok: true, value: null };
}

/**
 * A definition with no path to a publish node has no exit: every thread would rest mid-graph.
 * Reachability is a walk of the declared edges from the entry.
 */
function checkPublishReachable(nodes: WorkflowNode[], edges: WorkflowEdge[], entry: string): StepResult<null> {
    const publishing = nodes.filter((n) => n.publish === true).map((n) => n.name);
    if (publishing.length === 0) {
        return stepRefuse('NO_PUBLISH_PATH', 'no node declares publish: true — the graph has no exit');
    }
    const reachable = new Set([entry]);
    for (let changed = true; changed; ) {
        changed = false;
        for (const edge of edges) {
            if (reachable.has(edge.from) && !reachable.has(edge.to)) {
                reachable.add(edge.to);
                changed = true;
            }
        }
    }
    if (!publishing.some((name) => reachable.has(name))) {
        return stepRefuse('NO_PUBLISH_PATH', 'no publish node is reachable from the entry');
    }
    return { ok: true, value: null };
}

/**
 * The strict validator. Everything it refuses, it names — the key, the node, the edge, the
 * placeholder — so a bad definition is diagnosable from the API answer alone. Each section below
 * is checked in the same order, and refuses with the same codes and messages, as always.
 */
export function validateDefinition(raw: unknown): DefinitionCheck {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return refuse('BAD_DEFINITION', 'definition must be a JSON object');
    }
    const def = raw as Record<string, unknown>;
    for (const key of Object.keys(def)) {
        if (!KNOWN_TOP_KEYS.has(key)) return refuse('UNKNOWN_KEY', `unknown definition key "${key}"`);
    }

    const parsedParams = parseParamsSection(def);
    if (!parsedParams.ok) return { ok: false, refusal: parsedParams.refusal };
    const params = parsedParams.value;

    const parsedNodes = parseNodesSection(def);
    if (!parsedNodes.ok) return { ok: false, refusal: parsedNodes.refusal };
    const { nodes, names } = parsedNodes.value;

    const parsedEdges = parseEdgesSection(def, names);
    if (!parsedEdges.ok) return { ok: false, refusal: parsedEdges.refusal };
    const edges = parsedEdges.value;

    const resolvedEntry = resolveEntry(def, nodes, names);
    if (!resolvedEntry.ok) return { ok: false, refusal: resolvedEntry.refusal };
    const entry = resolvedEntry.value;

    const placeholderCheck = validatePlaceholders(nodes, params, names);
    if (!placeholderCheck.ok) return { ok: false, refusal: placeholderCheck.refusal };

    const publishCheck = checkPublishReachable(nodes, edges, entry);
    if (!publishCheck.ok) return { ok: false, refusal: publishCheck.refusal };

    const definition: WorkflowDefinition = { entry, nodes, edges, params };
    if (JSON.stringify(definition).length > DEFINITION_LIMIT) {
        return refuse('TOO_LARGE', `definition exceeds ${DEFINITION_LIMIT} characters`);
    }
    return { ok: true, definition };
}

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
