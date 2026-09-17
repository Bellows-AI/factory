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

/** The character cap on one parameter value — bounded author content, like everything interpolated. */
export const PARAM_VALUE_LIMIT = 512;

/** A marker is a fixed string the node's block must emit as its final line. Bounded, non-empty. */
const MARKER_LIMIT = 256;

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

/**
 * The parameter pattern grammar: a STRICT SUBSET of regular expressions, refused on any doubt.
 * A pattern runs in the board's event loop (the route validates every launch value) and in every
 * member's browser (the composer mirrors the check per keystroke), so an ambiguous pattern must
 * never be stored — catastrophic backtracking on a ≤512-character value would hang the whole
 * board process, not just the request. The subset bounds the work by construction:
 *
 * - literals, `.`, the class shorthands (`\d \D \w \W \s \S \b \B`) and punctuation escapes only
 *   — no backreferences, no `\u`/`\p`/`\c`/`\k`, no anchors (`^`/`$` are implicit in the full
 *   match), no lookarounds;
 * - quantifiers (`* + ? {m} {m,} {m,n}`) apply to a single atom only — never to a group, never
 *   to another quantifier;
 * - the AMBIGUITY BUDGET: quantified atoms chain into a "run" only when nothing mandatory sits
 *   between them (groups are transparent to this — `(a+)(a+)` is a run of two, the classic
 *   blowup shape); a run is capped at MAX_QUANTIFIED_RUN, the whole pattern at
 *   MAX_QUANTIFIED_ATOMS, and bounded repetitions at MAX_PATTERN_BOUND. The worst backtrack a
 *   stored pattern can force is therefore C(value-length, MAX_QUANTIFIED_RUN) — ~2×10⁷ cheap
 *   steps for a 512-character value — instead of unbounded.
 *
 * Everything else is refused at create (`BAD_PARAMS`) — the same loud-refusal doctrine as the
 * rest of the grammar.
 */
const MAX_QUANTIFIED_ATOMS = 4;
const MAX_QUANTIFIED_RUN = 3;
const MAX_PATTERN_BOUND = 64;
const CLASS_SHORTHANDS = 'dDwWsSbB';

function isSafePattern(source: string): boolean {
    let pos = 0;
    let quantifiedTotal = 0;
    // The ambiguity budget: quantified atoms currently chained with nothing mandatory between
    // them. Shared between the sequence and its groups on purpose — `(a+)(a+)` chains THROUGH
    // the group boundary, which is exactly the shape the cap exists for.
    let run = 0;

    /** Parses `[...]` from `pos` (at '[') past the closing ']'. */
    const parseClass = (): boolean => {
        pos += 1; // past '['
        if (source[pos] === '^') pos += 1;
        let items = 0;
        while (pos < source.length && source[pos] !== ']') {
            if (source[pos] === '\\') {
                const next = source[pos + 1];
                if (next === undefined || !/[dDwWsS]/.test(next)) return false;
                pos += 2;
            } else {
                pos += 1;
            }
            items += 1;
        }
        if (source[pos] !== ']' || items === 0) return false;
        pos += 1;
        return true;
    };

    /**
     * Parses a sequence until end-of-source (`eof`) or the closing `)` of its group (`group`).
     * `prev` is local — quantifier legality only ever looks at the immediately preceding token
     * — while the counters and the run budget are shared, because ambiguity composes across
     * group boundaries but not across a mandatory atom, which resets the run.
     */
    const parseSequence = (stop: 'eof' | 'group'): boolean => {
        let prev: 'none' | 'atom' | 'quantified' | 'group' | 'bar' = 'none';
        // What `run` becomes if the pending atom ends up quantified: a chain continues through
        // it only when it sits directly after a quantified atom (nothing mandatory between).
        let chainIfQuantified = run + 1;
        while (pos < source.length) {
            const ch = source[pos]!;
            if (ch === ')') {
                if (stop !== 'group') return false;
                if (prev === 'atom') run = 0; // the trailing atom resolved unquantified
                pos += 1;
                return true;
            }
            if (ch === '|') {
                run = 0; // a branch boundary breaks any chain
                prev = 'bar';
                pos += 1;
                continue;
            }
            if (ch === '*' || ch === '+' || ch === '?') {
                if (prev !== 'atom') return false;
                run = chainIfQuantified;
                quantifiedTotal += 1;
                if (quantifiedTotal > MAX_QUANTIFIED_ATOMS || run > MAX_QUANTIFIED_RUN) return false;
                prev = 'quantified';
                pos += 1;
                continue;
            }
            if (ch === '{') {
                const bounded = /^\{(\d+)(,(\d+)?)?\}/.exec(source.slice(pos));
                if (bounded === null) return false; // a literal brace must be escaped
                if (bounded[2] !== undefined && bounded[3] === undefined) return false; // open-ended {m,}: write {m,64} or +
                const min = Number(bounded[1]!);
                const max = bounded[3] === undefined ? min : Number(bounded[3]);
                if (min > max || max > MAX_PATTERN_BOUND) return false;
                if (prev !== 'atom') return false;
                run = chainIfQuantified;
                quantifiedTotal += 1;
                if (quantifiedTotal > MAX_QUANTIFIED_ATOMS || run > MAX_QUANTIFIED_RUN) return false;
                prev = 'quantified';
                pos += bounded[0].length;
                continue;
            }
            if (ch === '(') {
                if (prev === 'atom') run = 0; // the pending atom resolved unquantified
                if (source.startsWith('(?', pos) && !source.startsWith('(?:', pos)) {
                    return false; // lookarounds and named groups
                }
                pos += source.startsWith('(?:', pos) ? 3 : 1;
                if (!parseSequence('group')) return false;
                // parseSequence consumed through the ')' and left the group's trailing run
                prev = 'group';
                continue;
            }
            if (ch === '[') {
                if (prev === 'atom') run = 0; // the pending atom resolved unquantified
                if (!parseClass()) return false;
                chainIfQuantified = run + 1;
                prev = 'atom';
                continue;
            }
            if (ch === '\\') {
                const next = source[pos + 1];
                if (next === undefined) return false;
                // Class shorthands are atoms; every other alphanumeric escape — backreferences,
                // \u, \p, \c, \k — is outside the subset. Punctuation escapes are literals.
                if (/[a-zA-Z0-9]/.test(next) && !CLASS_SHORTHANDS.includes(next)) return false;
                pos += 2;
                if (prev === 'atom') run = 0;
                chainIfQuantified = run + 1;
                prev = 'atom';
                continue;
            }
            if (ch === '^' || ch === '$' || ch === ']' || ch === '}') return false;
            pos += 1;
            if (prev === 'atom') run = 0;
            chainIfQuantified = run + 1;
            prev = 'atom';
        }
        return stop === 'eof';
    };
    return parseSequence('eof');
}

/**
 * The strict validator. Everything it refuses, it names — the key, the node, the edge, the
 * placeholder — so a bad definition is diagnosable from the API answer alone.
 */
export function validateDefinition(raw: unknown): DefinitionCheck {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return refuse('BAD_DEFINITION', 'definition must be a JSON object');
    }
    const def = raw as Record<string, unknown>;
    for (const key of Object.keys(def)) {
        if (!KNOWN_TOP_KEYS.has(key)) return refuse('UNKNOWN_KEY', `unknown definition key "${key}"`);
    }

    // Params: optional at the JSON, every declared one required at launch. Names are the
    // placeholder identifiers, patterns are bounded regex sources matched fully.
    const params: WorkflowParam[] = [];
    if (def.params !== undefined) {
        if (!Array.isArray(def.params)) {
            return refuse('BAD_PARAMS', 'definition.params must be an array');
        }
        const paramNames = new Set<string>();
        for (const [i, item] of def.params.entries()) {
            if (typeof item !== 'object' || item === null || Array.isArray(item)) {
                return refuse('BAD_PARAMS', `definition.params[${i}] must be an object`);
            }
            const param = item as Record<string, unknown>;
            for (const key of Object.keys(param)) {
                if (!['name', 'pattern'].includes(key)) {
                    return refuse('UNKNOWN_KEY', `unknown key "${key}" in params[${i}]`);
                }
            }
            const name = param.name;
            if (typeof name !== 'string' || !PARAM_NAME.test(name)) {
                return refuse('BAD_PARAMS', `params[${i}].name must match ${PARAM_NAME.source}`);
            }
            if (paramNames.has(name)) return refuse('BAD_PARAMS', `duplicate param name "${name}"`);
            paramNames.add(name);
            let pattern: string | undefined;
            if (param.pattern !== undefined) {
                if (
                    typeof param.pattern !== 'string' ||
                    !param.pattern.trim() ||
                    param.pattern.length > PATTERN_LIMIT
                ) {
                    return refuse(
                        'BAD_PARAMS',
                        `params[${i}].pattern must be a non-empty regex source of at most ${PATTERN_LIMIT} characters`
                    );
                }
                if (!isSafePattern(param.pattern)) {
                    return refuse(
                        'BAD_PARAMS',
                        `params[${i}].pattern is outside the safe subset — see docs/workflows.md "Launch parameters"`
                    );
                }
                try {
                    new RegExp(param.pattern);
                } catch {
                    return refuse('BAD_PARAMS', `params[${i}].pattern does not compile: ${param.pattern}`);
                }
                pattern = param.pattern;
            }
            params.push({ name, ...(pattern !== undefined ? { pattern } : {}) });
        }
    }

    // Nodes: at least one, every one a declared-shape `agent` node with a unique name.
    if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
        return refuse('BAD_NODES', 'definition.nodes must be a non-empty array');
    }
    const nodes: WorkflowNode[] = [];
    const names = new Set<string>();
    for (const [i, item] of def.nodes.entries()) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            return refuse('BAD_NODES', `definition.nodes[${i}] must be an object`);
        }
        const node = item as Record<string, unknown>;
        for (const key of Object.keys(node)) {
            if (!KNOWN_NODE_KEYS.has(key)) return refuse('UNKNOWN_KEY', `unknown key "${key}" in nodes[${i}]`);
        }
        const name = node.name;
        if (typeof name !== 'string' || !NODE_NAME.test(name)) {
            return refuse('BAD_NODE', `nodes[${i}].name must match ${NODE_NAME.source}`);
        }
        if (name === 'param') {
            // `{{param.NAME}}` is the parameter namespace and wins it — a node literally named
            // "param" could never have its `{{param.output}}` resolved.
            return refuse('BAD_NODE', `nodes[${i}].name "param" is reserved`);
        }
        if (names.has(name)) return refuse('DUPLICATE_NODE', `duplicate node name "${name}"`);
        names.add(name);
        if (node.kind !== 'agent') {
            return refuse('BAD_NODE', `nodes[${i}].kind must be "agent" — no other node kind exists`);
        }
        if (node.session !== 'resume' && node.session !== 'fresh') {
            return refuse('BAD_NODE', `nodes[${i}].session must be "resume" or "fresh"`);
        }
        if (typeof node.prompt !== 'string' || !node.prompt.trim()) {
            return refuse('BAD_NODE', `nodes[${i}].prompt must be a non-empty string`);
        }
        if (node.gates !== undefined && typeof node.gates !== 'boolean') {
            return refuse('BAD_NODE', `nodes[${i}].gates must be a boolean`);
        }
        if (node.publish !== undefined && typeof node.publish !== 'boolean') {
            return refuse('BAD_NODE', `nodes[${i}].publish must be a boolean`);
        }
        nodes.push({
            name,
            kind: 'agent',
            session: node.session as 'resume' | 'fresh',
            prompt: node.prompt,
            ...(node.gates !== undefined ? { gates: node.gates } : {}),
            ...(node.publish !== undefined ? { publish: node.publish } : {}),
        });
    }

    // Edges: every endpoint declared, every rule in the closed vocabulary, bounds positive.
    if (!Array.isArray(def.edges)) {
        return refuse('BAD_EDGES', 'definition.edges must be an array');
    }
    const edges: WorkflowEdge[] = [];
    for (const [i, item] of def.edges.entries()) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            return refuse('BAD_EDGES', `definition.edges[${i}] must be an object`);
        }
        const edge = item as Record<string, unknown>;
        for (const key of Object.keys(edge)) {
            if (!KNOWN_EDGE_KEYS.has(key)) return refuse('UNKNOWN_KEY', `unknown key "${key}" in edges[${i}]`);
        }
        const { from, to, when } = edge;
        for (const [label, value] of [
            ['from', from],
            ['to', to],
        ] as const) {
            if (typeof value !== 'string' || !names.has(value)) {
                return refuse('UNKNOWN_NODE', `edges[${i}].${label} names no declared node`);
            }
        }
        const rule = when;
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
            return refuse(
                'BAD_RULE',
                `edges[${i}].when must be "succeeded", "failed", "gate-failed", or { marker } with a non-empty string of at most ${MARKER_LIMIT} characters`
            );
        }
        let max: number | undefined;
        if (edge.max !== undefined) {
            if (typeof edge.max !== 'number' || !Number.isInteger(edge.max) || edge.max < 1 || edge.max > 1_000) {
                return refuse('BAD_BOUND', `edges[${i}].max must be an integer 1..1000`);
            }
            max = edge.max;
        }
        edges.push({
            from: from as string,
            to: to as string,
            when: typeof rule === 'string' ? rule : { marker: (rule as { marker: string }).marker.trim() },
            ...(max !== undefined ? { max } : {}),
        });
    }

    // Entry: explicit, or the first declared node. Must name a declared node.
    const entry = def.entry ?? nodes[0]!.name;
    if (typeof entry !== 'string' || !names.has(entry)) {
        return refuse('UNKNOWN_NODE', 'definition.entry names no declared node');
    }

    // Prompt placeholders: the closed vocabulary only — node outputs, the gate pair, declared
    // params, and `{{command}}` (the thread root's command). A template referencing an unknown
    // prior node or an undeclared param would interpolate empty forever.
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
                return refuse(
                    'UNKNOWN_PLACEHOLDER',
                    `nodes named "${node.name}" carry placeholder "{{${spec}}}" — expected {{nodeName.output}}, {{gate.name}}, {{gate.output}}, {{param.NAME}} or {{command}}`
                );
            }
        }
    }

    // A definition with no path to a publish node has no exit: every thread would rest mid-graph.
    // Reachability is a walk of the declared edges from the entry.
    const publishing = nodes.filter((n) => n.publish === true).map((n) => n.name);
    if (publishing.length === 0) {
        return refuse('NO_PUBLISH_PATH', 'no node declares publish: true — the graph has no exit');
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
        return refuse('NO_PUBLISH_PATH', 'no publish node is reachable from the entry');
    }

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
        const value = body[declared.name];
        if (value === undefined) {
            return refuseParams(`missing required workflow parameter "${declared.name}"`);
        }
        if (typeof value !== 'string') {
            return refuseParams(`workflow parameter "${declared.name}" must be a string`);
        }
        const trimmed = value.trim();
        if (!trimmed) {
            return refuseParams(`workflow parameter "${declared.name}" must be a non-empty string`);
        }
        if (trimmed.length > PARAM_VALUE_LIMIT) {
            return refuseParams(`workflow parameter "${declared.name}" exceeds ${PARAM_VALUE_LIMIT} characters`);
        }
        if (declared.pattern !== undefined && !new RegExp(`^(?:${declared.pattern})$`).test(trimmed)) {
            return refuseParams(`workflow parameter "${declared.name}" must match ${declared.pattern}`);
        }
        values[declared.name] = trimmed;
    }
    for (const key of Object.keys(body)) {
        if (!definition.params.some((p) => p.name === key)) {
            return refuseParams(`unknown workflow parameter "${key}"`);
        }
    }
    return { ok: true, values };
}
