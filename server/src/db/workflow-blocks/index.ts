/**
 * The board-owned block registry and the compiler that expands `kind: "block"` references into
 * the ordinary low-level `agent`-node graph `workflow-engine.ts` and `routes/jobs.ts` already run
 * (issue #204). `workflow-store.ts`'s `create()` is the one caller: a workflow is compiled once,
 * at creation, and the STORED `workflow.definition` is the expanded graph — never a live block
 * reference — so every existing consumer of a stored definition (the engine's transitions, a
 * job's frozen snapshot) keeps working unchanged and can never see a node with no `.prompt`.
 *
 * New reserved ids land as new files here plus one registry-array entry; this module and
 * workflow-schema.ts stay untouched by that work.
 */
import { ERROR_CODES } from '@factory-ai/core';
import {
    EXPANDED_DEFINITION_LIMIT,
    type AuthoredWorkflowDefinition,
    type BlockConfigValue,
    type BlockNode,
    type WorkflowDefinition,
} from '../workflow-schema.js';
import { validateDefinition } from '../workflow-schema-validate.js';
import { GITHUB_REVIEW_RECONCILE } from './github-review-reconcile.js';
import { MERGE_CONFLICT_AUTOFIX } from './merge-conflict-autofix.js';
import { parseRuntimeParams } from './runtime.js';
import type { BlockConfigField, BlockDescriptor, BlockRegistry, CompileCheck, CompileRefusal } from './types.js';

export const BLOCK_REGISTRY: BlockRegistry = new Map(
    [GITHUB_REVIEW_RECONCILE, MERGE_CONFLICT_AUTOFIX].map((descriptor) => [descriptor.id, descriptor])
);

/** What `GET /api/workflow-blocks` serves — catalog metadata only, never a prompt or script body. */
export interface BlockCatalogEntry {
    id: string;
    description: string;
    configSchema: BlockConfigField[];
    available: boolean;
}

export function blockCatalog(registry: BlockRegistry = BLOCK_REGISTRY): BlockCatalogEntry[] {
    return [...registry.values()].map(({ id, description, configSchema, available }) => ({
        id,
        description,
        configSchema,
        available,
    }));
}

type FieldResolution = { ok: true; value: BlockConfigValue | undefined } | { ok: false; message: string };

/**
 * One config field's value against its declared type and (for a number) its declared bounds — the
 * default is resolved through the SAME checks as an authored value, since a descriptor whose own
 * default falls outside its declared bounds is a descriptor bug, and must refuse loudly rather
 * than ship a silently-unvalidated config value. `undefined` means the field stays unset.
 */
function resolveField(field: BlockConfigField, raw: Record<string, BlockConfigValue>): FieldResolution {
    const value = field.name in raw ? raw[field.name] : field.default;
    if (value === undefined) return { ok: true, value: undefined };
    if (typeof value !== field.type) {
        return { ok: false, message: `config "${field.name}" must be a ${field.type}` };
    }
    if (field.type === 'number') {
        if (field.min !== undefined && (value as number) < field.min) {
            return { ok: false, message: `config "${field.name}" must be >= ${field.min}` };
        }
        if (field.max !== undefined && (value as number) > field.max) {
            return { ok: false, message: `config "${field.name}" must be <= ${field.max}` };
        }
    }
    return { ok: true, value };
}

/**
 * Resolves an authored node's `with` against a descriptor's declared config: unknown keys and
 * type/bound mismatches refuse by name; an omitted field falls back to its declared default.
 */
function resolveConfig(
    descriptor: BlockDescriptor,
    raw: Record<string, BlockConfigValue>
): { ok: true; config: Record<string, BlockConfigValue> } | { ok: false; message: string } {
    const fields = new Map(descriptor.configSchema.map((field) => [field.name, field]));
    for (const key of Object.keys(raw)) {
        if (!fields.has(key)) return { ok: false, message: `unknown config key "${key}"` };
    }
    const config: Record<string, BlockConfigValue> = {};
    for (const field of descriptor.configSchema) {
        const resolved = resolveField(field, raw);
        if (!resolved.ok) return resolved;
        if (resolved.value !== undefined) config[field.name] = resolved.value;
    }
    return { ok: true, config };
}

/**
 * Rewrites `{{internalName.output}}` references inside a block's own prompt to the namespaced
 * name the compiler is about to give that node — only for names the block's OWN expansion
 * declares; anything else (an outer node, `{{param.*}}`, `{{command}}`, `{{gate.*}}`) passes
 * through untouched, and a genuinely stray reference surfaces as UNKNOWN_PLACEHOLDER on
 * re-validation instead of being silently rewritten into a name that never existed.
 *
 * The reserved specs are checked FIRST, before the generic node-output pattern, the same
 * precedence `interpolate()` itself gives them: `{{gate.output}}` must always mean the completed
 * run's first failed gate, never a same-named internal node — workflow-schema.ts reserves `param`
 * as a node name for exactly this reason, but a block's internal names are the descriptor's own
 * and are not run through that check, so this function is where the same guarantee holds for them.
 */
function namespacePrompt(prompt: string, prefix: string, internalNames: ReadonlySet<string>): string {
    return prompt.replace(/\{\{([^{}]+)\}\}/g, (whole, raw: string) => {
        const spec = (raw as string).trim();
        if (spec === 'command' || spec === 'gate.name' || spec === 'gate.output' || spec.startsWith('param.')) {
            return whole;
        }
        const match = /^([a-z0-9-]+)\.output$/.exec(spec);
        if (match && internalNames.has(match[1]!)) return `{{${prefix}${match[1]}.output}}`;
        return whole;
    });
}

/** A namespaced node name -> its validated runtime descriptor, collected across every block use. */
type RuntimeAttachments = Map<string, { runtime: string; block: string; params: Record<string, BlockConfigValue> }>;

type BlockExpansionResult =
    | {
          ok: true;
          nodes: AuthoredWorkflowDefinition['nodes'];
          edges: AuthoredWorkflowDefinition['edges'];
          entry: string;
          exit: string;
          runtime: RuntimeAttachments;
      }
    | { ok: false; refusal: CompileRefusal };

/**
 * One block node's expansion: the registry lookup, availability and config checks a block
 * reference needs before `expand()` may run, then the namespaced nodes/edges and entry/exit the
 * caller splices into the compiled graph. Split out of `compileDefinition` so its own four
 * sequential refusals do not add to that function's complexity budget.
 */
function expandBlockNode(node: BlockNode, registry: BlockRegistry): BlockExpansionResult {
    const descriptor = registry.get(node.uses);
    if (!descriptor) {
        return {
            ok: false,
            refusal: {
                code: ERROR_CODES.UNKNOWN_BLOCK,
                message: `node "${node.name}" uses unknown block "${node.uses}"`,
            },
        };
    }
    if (!descriptor.available) {
        return {
            ok: false,
            refusal: {
                code: ERROR_CODES.BLOCK_UNAVAILABLE,
                message: `node "${node.name}" uses "${node.uses}", which is not yet available`,
            },
        };
    }
    const resolved = resolveConfig(descriptor, node.with ?? {});
    if (!resolved.ok) {
        return {
            ok: false,
            refusal: { code: ERROR_CODES.BAD_BLOCK_CONFIG, message: `node "${node.name}": ${resolved.message}` },
        };
    }

    const expansion = descriptor.expand(node.name, resolved.config);
    const prefix = `${node.name}--`;
    const internalNames = new Set(expansion.nodes.map((inner) => inner.name));
    const nodes = expansion.nodes.map((inner) => ({
        ...inner,
        name: `${prefix}${inner.name}`,
        prompt: namespacePrompt(inner.prompt, prefix, internalNames),
    }));
    const edges = expansion.edges.map((inner) => ({
        ...inner,
        from: `${prefix}${inner.from}`,
        to: `${prefix}${inner.to}`,
    }));

    const runtime: RuntimeAttachments = new Map();
    for (const [internalName, declared] of Object.entries(expansion.runtime ?? {})) {
        if (!internalNames.has(internalName)) {
            return {
                ok: false,
                refusal: {
                    code: ERROR_CODES.BAD_BLOCK_CONFIG,
                    message: `node "${node.name}": block "${node.uses}" declared a runtime boundary on unknown internal node "${internalName}"`,
                },
            };
        }
        const params = parseRuntimeParams(declared.runtime, declared.params);
        if (params === null) {
            return {
                ok: false,
                refusal: {
                    code: ERROR_CODES.BAD_BLOCK_CONFIG,
                    message: `node "${node.name}": block "${node.uses}" declared an invalid runtime "${declared.runtime}" on "${internalName}"`,
                },
            };
        }
        runtime.set(`${prefix}${internalName}`, { runtime: declared.runtime, block: descriptor.id, params });
    }

    return {
        ok: true,
        nodes,
        edges,
        entry: `${prefix}${expansion.entry}`,
        exit: `${prefix}${expansion.exit}`,
        runtime,
    };
}

/**
 * Compiles an AUTHORED definition (block nodes intact) into a low-level, agent-only
 * `WorkflowDefinition` — every block node replaced by its expansion, namespaced under the block
 * node's own name (`${blockNodeName}--${internalName}`, never collidable with a bare NODE_NAME
 * since `--` only ever appears here as the compiler's own separator — and even so, an accidental
 * clash is not trusted to a naming proof: the expanded graph is re-validated below, and
 * `validateDefinition`'s own DUPLICATE_NODE check is what actually refuses one). Edges into or out
 * of a block node are rewritten to its declared entry/exit; edges wholly outside any block pass
 * through unchanged. Registry-aware, unlike workflow-schema.ts — this is where `uses` is looked up,
 * availability is enforced, and `with` is validated against the descriptor's real config shape.
 */
export function compileDefinition(
    authored: AuthoredWorkflowDefinition,
    registry: BlockRegistry = BLOCK_REGISTRY
): CompileCheck {
    const nodes: AuthoredWorkflowDefinition['nodes'] = [];
    const edges: AuthoredWorkflowDefinition['edges'] = [];
    // Outer node name -> the compiled name inbound/outbound edges should resolve to. Identity for
    // an agent node; the namespaced internal entry/exit for a block node.
    const entryOf = new Map<string, string>();
    const exitOf = new Map<string, string>();
    // Every block's namespaced runtime attachments, merged — collision-free by construction, since
    // each block use's own namespace prefix is unique (the same DUPLICATE_NODE proof `nodes` relies
    // on covers this map's keys too, being a subset of the namespaced node names).
    const runtime: RuntimeAttachments = new Map();

    for (const node of authored.nodes) {
        if (node.kind === 'agent') {
            nodes.push(node);
            entryOf.set(node.name, node.name);
            exitOf.set(node.name, node.name);
            continue;
        }

        const result = expandBlockNode(node, registry);
        if (!result.ok) return result;
        nodes.push(...result.nodes);
        edges.push(...result.edges);
        entryOf.set(node.name, result.entry);
        exitOf.set(node.name, result.exit);
        for (const [name, descriptor] of result.runtime) runtime.set(name, descriptor);
    }

    for (const edge of authored.edges) {
        edges.push({
            ...edge,
            from: exitOf.get(edge.from) ?? edge.from,
            to: entryOf.get(edge.to) ?? edge.to,
        });
    }

    const expanded = {
        entry: entryOf.get(authored.entry) ?? authored.entry,
        nodes,
        edges,
        params: authored.params,
    };
    // Reuses every existing invariant — reachability, the publish path, the placeholder
    // vocabulary, positive bounds — against the wider expanded-snapshot cap, instead of
    // duplicating them: this IS the "validate the expanded graph again" step. `runtime` is
    // deliberately NOT part of `expanded` above — the validator's own key set has no `runtime`,
    // and a node carrying one here would refuse `UNKNOWN_KEY` on its own expansion. It is grafted
    // onto the ALREADY-VALIDATED nodes below instead, which is what keeps it unauthorable: nothing
    // upstream of this line ever sees the field.
    const revalidated = validateDefinition(expanded, { sizeLimit: EXPANDED_DEFINITION_LIMIT });
    if (!revalidated.ok) return { ok: false, refusal: revalidated.refusal };
    if (runtime.has(expanded.entry)) {
        // A thread's very first row is inserted directly by routes/jobs.ts, never through
        // runWorkflowTransition — the only place a `runtime` node's park is enforced. A wait
        // boundary as the graph's entry would therefore run immediately as an ordinary claimable
        // job, silently skipping the wait this field exists to guarantee (the issue's "never falls
        // back to a runnable insert" contract). Refused here, at compile time, rather than
        // discovered at the first thread that ever launches one.
        return {
            ok: false,
            refusal: {
                code: ERROR_CODES.BAD_BLOCK_CONFIG,
                message:
                    'a workflow-block runtime boundary cannot be the graph entry — it is never reached by a transition',
            },
        };
    }
    if (runtime.size === 0) {
        // Safe: every node the expanded graph carries is `kind: 'agent'` — block nodes existed
        // only in the authored input, and every one was replaced above before revalidation ran.
        return { ok: true, definition: revalidated.definition as WorkflowDefinition };
    }
    const withRuntime: WorkflowDefinition = {
        ...(revalidated.definition as WorkflowDefinition),
        nodes: (revalidated.definition as WorkflowDefinition).nodes.map((n) => {
            const attached = runtime.get(n.name);
            return attached ? { ...n, runtime: attached } : n;
        }),
    };
    if (JSON.stringify(withRuntime).length > EXPANDED_DEFINITION_LIMIT) {
        return {
            ok: false,
            refusal: {
                code: ERROR_CODES.TOO_LARGE,
                message: `definition exceeds ${EXPANDED_DEFINITION_LIMIT} characters`,
            },
        };
    }
    return { ok: true, definition: withRuntime };
}
