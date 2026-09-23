import { ERROR_CODES } from '@factory-ai/core';
import { isSafePattern } from './workflow-pattern.js';
import {
    BLOCK_CONFIG_KEY,
    BLOCK_USES,
    BLOCK_USES_LIMIT,
    BLOCK_WITH_MAX_KEYS,
    DEFINITION_LIMIT,
    MARKER_LIMIT,
    MAX_EDGE_BOUND,
    NODE_NAME,
    PARAM_DESCRIPTION_LIMIT,
    PARAM_EXAMPLE_LIMIT,
    PARAM_NAME,
    PARAM_VALUE_LIMIT,
    PATTERN_LIMIT,
    type AuthoredWorkflowDefinition,
    type AuthoredWorkflowNode,
    type BlockConfigValue,
    type BlockNode,
    type DefinitionCheck,
    type DefinitionRefusal,
    type EdgeRule,
    type WorkflowEdge,
    type WorkflowNode,
    type WorkflowParam,
} from './workflow-schema.js';

/**
 * `validateDefinition` and every section parser it composes — split out of workflow-schema.ts
 * purely to keep both files under the repo's line-count ceiling, no behavior change. Read
 * docs/workflows.md before touching this file: the decisions here look simplifiable and mostly
 * are not.
 */

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

const KNOWN_AGENT_NODE_KEYS = new Set(['name', 'kind', 'session', 'prompt', 'gates', 'publish']);
const KNOWN_BLOCK_NODE_KEYS = new Set(['name', 'kind', 'uses', 'with']);
const KNOWN_EDGE_KEYS = new Set(['from', 'to', 'when', 'max']);
const KNOWN_TOP_KEYS = new Set(['entry', 'nodes', 'edges', 'params']);

const KNOWN_PARAM_KEYS = new Set(['name', 'pattern', 'description', 'example']);

/** Resolves and dedupes a declared param's name — the one field every other check depends on. */
function resolveParamName(param: Record<string, unknown>, i: number, paramNames: Set<string>): StepResult<string> {
    const name = param.name;
    if (typeof name !== 'string' || !PARAM_NAME.test(name)) {
        return stepRefuse(ERROR_CODES.BAD_PARAMS, `params[${i}].name must match ${PARAM_NAME.source}`);
    }
    if (paramNames.has(name)) return stepRefuse(ERROR_CODES.BAD_PARAMS, `duplicate param name "${name}"`);
    paramNames.add(name);
    return { ok: true, value: name };
}

/** Resolves a declared param's optional pattern: bounded, in the safe subset, and compilable. */
function resolveParamPattern(param: Record<string, unknown>, i: number): StepResult<string | undefined> {
    if (param.pattern === undefined) return { ok: true, value: undefined };
    if (typeof param.pattern !== 'string' || !param.pattern.trim() || param.pattern.length > PATTERN_LIMIT) {
        return stepRefuse(
            ERROR_CODES.BAD_PARAMS,
            `params[${i}].pattern must be a non-empty regex source of at most ${PATTERN_LIMIT} characters`
        );
    }
    if (!isSafePattern(param.pattern)) {
        return stepRefuse(
            ERROR_CODES.BAD_PARAMS,
            `params[${i}].pattern is outside the safe subset — see docs/workflows.md "Launch parameters"`
        );
    }
    try {
        new RegExp(param.pattern);
    } catch {
        return stepRefuse(ERROR_CODES.BAD_PARAMS, `params[${i}].pattern does not compile: ${param.pattern}`);
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
            ERROR_CODES.BAD_PARAMS,
            `params[${ctx.i}].${key} must be a non-empty string of at most ${limit} characters`
        );
    }
    if (key === 'example' && ctx.pattern !== undefined && !new RegExp(`^(?:${ctx.pattern})$`).test(trimmed)) {
        return stepRefuse(ERROR_CODES.BAD_PARAMS, `params[${ctx.i}].example must match ${ctx.pattern}`);
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
        return stepRefuse(ERROR_CODES.BAD_PARAMS, `definition.params[${i}] must be an object`);
    }
    const param = item as Record<string, unknown>;
    for (const key of Object.keys(param)) {
        if (!KNOWN_PARAM_KEYS.has(key))
            return stepRefuse(ERROR_CODES.UNKNOWN_KEY, `unknown key "${key}" in params[${i}]`);
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
        return stepRefuse(ERROR_CODES.BAD_PARAMS, 'definition.params must be an array');
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

/**
 * Resolves and dedupes a declared node's name — the one field every other check depends on. The
 * key set is picked off `kind` alone, before `kind` itself is validated: anything other than the
 * literal `"block"` falls to the agent key set, which is exactly what makes a missing/bad `kind`
 * still refuse `BAD_NODE` (unchanged from before blocks existed) rather than a confusing
 * `UNKNOWN_KEY`.
 */
function resolveNodeIdentity(node: Record<string, unknown>, i: number, names: Set<string>): StepResult<string> {
    const knownKeys = node.kind === 'block' ? KNOWN_BLOCK_NODE_KEYS : KNOWN_AGENT_NODE_KEYS;
    for (const key of Object.keys(node)) {
        if (!knownKeys.has(key)) return stepRefuse(ERROR_CODES.UNKNOWN_KEY, `unknown key "${key}" in nodes[${i}]`);
    }
    const name = node.name;
    if (typeof name !== 'string' || !NODE_NAME.test(name)) {
        return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].name must match ${NODE_NAME.source}`);
    }
    if (name === 'param') {
        // `{{param.NAME}}` is the parameter namespace and wins it — a node literally named
        // "param" could never have its `{{param.output}}` resolved.
        return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].name "param" is reserved`);
    }
    if (names.has(name)) return stepRefuse(ERROR_CODES.DUPLICATE_NODE, `duplicate node name "${name}"`);
    names.add(name);
    return { ok: true, value: name };
}

/** Resolves one `with` value's shape: a string bounded by PARAM_VALUE_LIMIT, a finite number, or a boolean. */
function resolveBlockWithValue(value: unknown, i: number, key: string): StepResult<BlockConfigValue> {
    if (typeof value === 'string') {
        if (value.length > PARAM_VALUE_LIMIT) {
            return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].with.${key} exceeds ${PARAM_VALUE_LIMIT} characters`);
        }
        return { ok: true, value };
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].with.${key} must be a finite number`);
        }
        return { ok: true, value };
    }
    if (typeof value !== 'boolean') {
        return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].with.${key} must be a string, number or boolean`);
    }
    return { ok: true, value };
}

/** Resolves a block node's `with` config: bounded keys, each a string/number/boolean value. */
function resolveBlockWith(
    node: Record<string, unknown>,
    i: number
): StepResult<Record<string, BlockConfigValue> | undefined> {
    if (node.with === undefined) return { ok: true, value: undefined };
    if (typeof node.with !== 'object' || node.with === null || Array.isArray(node.with)) {
        return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].with must be an object`);
    }
    const raw = node.with as Record<string, unknown>;
    const keys = Object.keys(raw);
    if (keys.length > BLOCK_WITH_MAX_KEYS) {
        return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].with must declare at most ${BLOCK_WITH_MAX_KEYS} keys`);
    }
    const validated: Record<string, BlockConfigValue> = {};
    for (const key of keys) {
        if (!BLOCK_CONFIG_KEY.test(key)) {
            return stepRefuse(
                ERROR_CODES.BAD_NODE,
                `nodes[${i}].with key "${key}" must match ${BLOCK_CONFIG_KEY.source}`
            );
        }
        const resolved = resolveBlockWithValue(raw[key], i, key);
        if (!resolved.ok) return resolved;
        validated[key] = resolved.value;
    }
    return { ok: true, value: validated };
}

/** One declared `block` node of `definition.nodes`, in isolation — see `validateDefinition`. */
function parseBlockNode(node: Record<string, unknown>, i: number, name: string): StepResult<BlockNode> {
    if (typeof node.uses !== 'string' || node.uses.length > BLOCK_USES_LIMIT || !BLOCK_USES.test(node.uses)) {
        return stepRefuse(
            ERROR_CODES.BAD_NODE,
            `nodes[${i}].uses must be a reserved block id matching ${BLOCK_USES.source}`
        );
    }
    const withConfig = resolveBlockWith(node, i);
    if (!withConfig.ok) return withConfig;
    return {
        ok: true,
        value: {
            name,
            kind: 'block',
            uses: node.uses,
            ...(withConfig.value !== undefined ? { with: withConfig.value } : {}),
        },
    };
}

/** One declared `agent` node of `definition.nodes`, in isolation — see `validateDefinition`. */
function parseAgentNode(node: Record<string, unknown>, i: number, name: string): StepResult<WorkflowNode> {
    if (node.kind !== 'agent') {
        return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].kind must be "agent" or "block"`);
    }
    if (node.session !== 'resume' && node.session !== 'fresh') {
        return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].session must be "resume" or "fresh"`);
    }
    if (typeof node.prompt !== 'string' || !node.prompt.trim()) {
        return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].prompt must be a non-empty string`);
    }
    if (node.gates !== undefined && typeof node.gates !== 'boolean') {
        return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].gates must be a boolean`);
    }
    if (node.publish !== undefined && typeof node.publish !== 'boolean') {
        return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].publish must be a boolean`);
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

/**
 * One declared node of `definition.nodes`, in isolation — see `validateDefinition`. A node is an
 * `agent` node or a `block` node, never mixed.
 */
function parseWorkflowNode(item: unknown, i: number, names: Set<string>): StepResult<AuthoredWorkflowNode> {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return stepRefuse(ERROR_CODES.BAD_NODES, `definition.nodes[${i}] must be an object`);
    }
    const node = item as Record<string, unknown>;
    const resolvedName = resolveNodeIdentity(node, i, names);
    if (!resolvedName.ok) return resolvedName;
    const name = resolvedName.value;
    return node.kind === 'block' ? parseBlockNode(node, i, name) : parseAgentNode(node, i, name);
}

/** `definition.nodes`: at least one, every one a declared-shape `agent` or `block` node with a unique name. */
function parseNodesSection(
    def: Record<string, unknown>
): StepResult<{ nodes: AuthoredWorkflowNode[]; names: Set<string> }> {
    if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
        return stepRefuse(ERROR_CODES.BAD_NODES, 'definition.nodes must be a non-empty array');
    }
    const nodes: AuthoredWorkflowNode[] = [];
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
        if (!KNOWN_EDGE_KEYS.has(key))
            return stepRefuse(ERROR_CODES.UNKNOWN_KEY, `unknown key "${key}" in edges[${i}]`);
    }
    const { from, to } = edge;
    for (const [label, value] of [
        ['from', from],
        ['to', to],
    ] as const) {
        if (typeof value !== 'string' || !names.has(value)) {
            return stepRefuse(ERROR_CODES.UNKNOWN_NODE, `edges[${i}].${label} names no declared node`);
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
            ERROR_CODES.BAD_RULE,
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
        return stepRefuse(ERROR_CODES.BAD_BOUND, `edges[${i}].max must be an integer 1..${MAX_EDGE_BOUND}`);
    }
    return { ok: true, value: edge.max };
}

/** One declared edge of `definition.edges`, in isolation — see `validateDefinition`. */
function parseWorkflowEdge(item: unknown, i: number, names: Set<string>): StepResult<WorkflowEdge> {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return stepRefuse(ERROR_CODES.BAD_EDGES, `definition.edges[${i}] must be an object`);
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
        return stepRefuse(ERROR_CODES.BAD_EDGES, 'definition.edges must be an array');
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
function resolveEntry(
    def: Record<string, unknown>,
    nodes: AuthoredWorkflowNode[],
    names: Set<string>
): StepResult<string> {
    const entry = def.entry ?? nodes[0]!.name;
    if (typeof entry !== 'string' || !names.has(entry)) {
        return stepRefuse(ERROR_CODES.UNKNOWN_NODE, 'definition.entry names no declared node');
    }
    return { ok: true, value: entry };
}

/** Whether a prompt placeholder's spec names a known node output, param, gate field, or `command`. */
function placeholderKnown(spec: string, params: WorkflowParam[], names: Set<string>): boolean {
    const nodeRef = /^([a-z0-9-]+)\.output$/.exec(spec);
    const paramRef = /^param\.([a-z0-9-]+)$/.exec(spec);
    if (paramRef !== null) {
        // `param.` wins the namespace: a node literally named `param` cannot shadow it.
        return params.some((p) => p.name === paramRef[1]);
    }
    if (spec === 'command') return true;
    return spec === 'gate.name' || spec === 'gate.output' || (nodeRef !== null && names.has(nodeRef[1]!));
}

/**
 * Prompt placeholders: the closed vocabulary only — node outputs, the gate pair, declared params,
 * and `{{command}}` (the thread root's command). A template referencing an unknown prior node or
 * an undeclared param would interpolate empty forever. A block node has no prompt of its own to
 * scan — its eventual expansion carries the placeholder contract instead.
 */
function validatePlaceholders(
    nodes: AuthoredWorkflowNode[],
    params: WorkflowParam[],
    names: Set<string>
): StepResult<null> {
    for (const node of nodes) {
        if (node.kind !== 'agent') continue;
        for (const match of node.prompt.matchAll(/\{\{([^{}]+)\}\}/g)) {
            const spec = match[1]!.trim();
            if (!placeholderKnown(spec, params, names)) {
                return stepRefuse(
                    ERROR_CODES.UNKNOWN_PLACEHOLDER,
                    `nodes named "${node.name}" carry placeholder "{{${spec}}}" — expected {{nodeName.output}}, {{gate.name}}, {{gate.output}}, {{param.NAME}} or {{command}}`
                );
            }
        }
    }
    return { ok: true, value: null };
}

/**
 * A definition with no path to a publish node has no exit: every thread would rest mid-graph.
 * Reachability is a walk of the declared edges from the entry. A block node is never itself a
 * publish node — the outer graph must route to a downstream agent that declares `publish`.
 */
function checkPublishReachable(nodes: AuthoredWorkflowNode[], edges: WorkflowEdge[], entry: string): StepResult<null> {
    const publishing = nodes.filter((n) => n.kind === 'agent' && n.publish === true).map((n) => n.name);
    if (publishing.length === 0) {
        return stepRefuse(ERROR_CODES.NO_PUBLISH_PATH, 'no node declares publish: true — the graph has no exit');
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
        return stepRefuse(ERROR_CODES.NO_PUBLISH_PATH, 'no publish node is reachable from the entry');
    }
    return { ok: true, value: null };
}

/**
 * The strict validator. Everything it refuses, it names — the key, the node, the edge, the
 * placeholder — so a bad definition is diagnosable from the API answer alone. Each section below
 * is checked in the same order, and refuses with the same codes and messages, as always.
 *
 * `opts.sizeLimit` overrides the JSON-character cap (default `DEFINITION_LIMIT`, the authored
 * cap). `workflow-blocks/index.ts`'s compiler reuses this same function — every other invariant
 * unchanged — to re-validate an EXPANDED (post-block-compilation) definition against the wider
 * `EXPANDED_DEFINITION_LIMIT`, instead of duplicating reachability/publish-path/placeholder logic.
 */
export function validateDefinition(raw: unknown, opts?: { sizeLimit?: number }): DefinitionCheck {
    const sizeLimit = opts?.sizeLimit ?? DEFINITION_LIMIT;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return refuse(ERROR_CODES.BAD_DEFINITION, 'definition must be a JSON object');
    }
    const def = raw as Record<string, unknown>;
    for (const key of Object.keys(def)) {
        if (!KNOWN_TOP_KEYS.has(key)) return refuse(ERROR_CODES.UNKNOWN_KEY, `unknown definition key "${key}"`);
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

    const definition: AuthoredWorkflowDefinition = { entry, nodes, edges, params };
    if (JSON.stringify(definition).length > sizeLimit) {
        return refuse(ERROR_CODES.TOO_LARGE, `definition exceeds ${sizeLimit} characters`);
    }
    return { ok: true, definition };
}
