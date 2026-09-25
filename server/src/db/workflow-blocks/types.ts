/**
 * The block registry's shapes: what a descriptor declares, what compiling a block reference
 * produces, and why a compile was refused. Registry-aware — the opposite of workflow-schema.ts,
 * which validates the authored `uses`/`with` shape but knows no block's real id or config.
 */
import type { ERROR_CODES } from '@factory-ai/core';
import type {
    BlockConfigValue,
    DefinitionRefusal,
    WorkflowDefinition,
    WorkflowEdge,
    WorkflowNode,
} from '../workflow-schema.js';

/**
 * The compiler's own node-namespacing separator (`workflow-blocks/index.ts`'s `expandBlockNode`):
 * a block use's internal node names are namespaced as `${blockNodeName}${BLOCK_NAMESPACE_SEPARATOR}${internalName}`,
 * and never appears in an authored node name otherwise (docs/workflows.md, "Built-in blocks" —
 * `--` only ever appears here as the compiler's own separator). `runtime-settle.ts`'s `scopeOf`
 * is the one other reader of this same value, kept as a shared constant so the two can never drift.
 */
export const BLOCK_NAMESPACE_SEPARATOR = '--';

/** One config field a block declares: the catalog route serves this, and the compiler validates
 *  an authored `with` value against it before ever calling `expand`. */
export interface BlockConfigField {
    name: string;
    type: 'string' | 'number' | 'boolean';
    description: string;
    /** Used when the authored node's `with` omits this field. */
    default?: BlockConfigValue;
    /** `type: 'number'` only. */
    min?: number;
    max?: number;
}

/**
 * What `expand()` returns: a ready-to-splice subgraph of ordinary low-level `agent` nodes. Node
 * names are local to the block — the compiler namespaces them under the referencing node's own
 * name, so a descriptor never needs to know how many times it is used in one definition.
 */
export interface BlockExpansion {
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    /** The internal node name inbound outer edges (and a rewritten `entry`) resolve to. */
    entry: string;
    /** The internal node name outbound outer edges resolve from. */
    exit: string;
    /**
     * Private runtime boundaries this expansion declares (issue #231), keyed by the INTERNAL node
     * name (pre-namespacing) — kept separate from `nodes` so it never travels through the authored
     * node parser (which would refuse an unknown key). The compiler validates each entry against
     * `workflow-blocks/runtime.ts`'s allowlist and attaches it to the matching namespaced node only
     * AFTER the expanded graph has passed `validateDefinition`.
     */
    runtime?: Record<string, { runtime: string; params: Record<string, BlockConfigValue> }>;
}

export interface BlockDescriptor {
    /** `namespace/block-name` — matches workflow-schema.ts's `BLOCK_USES` shape. */
    id: string;
    /** Catalog-facing. Never a prompt or script body — those stay inside `expand()`, unserialized. */
    description: string;
    configSchema: BlockConfigField[];
    /** Listed by the catalog regardless; `compileDefinition` refuses `BLOCK_UNAVAILABLE` when false,
     *  BEFORE ever calling `expand` — an unavailable descriptor's `expand` may safely throw. */
    available: boolean;
    expand(nodeName: string, config: Record<string, BlockConfigValue>): BlockExpansion;
}

/** Dependency-injectable so tests can exercise the compiler against fake, available descriptors
 *  without waiting on either real block's implementation issue. */
export type BlockRegistry = ReadonlyMap<string, BlockDescriptor>;

export type CompileRefusal =
    | DefinitionRefusal
    | {
          code:
              | typeof ERROR_CODES.UNKNOWN_BLOCK
              | typeof ERROR_CODES.BLOCK_UNAVAILABLE
              | typeof ERROR_CODES.BAD_BLOCK_CONFIG;
          message: string;
      };

export type CompileCheck = { ok: true; definition: WorkflowDefinition } | { ok: false; refusal: CompileRefusal };
