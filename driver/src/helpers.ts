import { readFileSync } from 'node:fs';

/**
 * The generic block-helper transport (issue #207): one allowlisted, board-owned script an
 * expanded workflow `block` node may declare to run before or after its agent turn — a runtime
 * plan naming a helper id and validated/bounded JSON input, never arbitrary shell or an image.
 * Docker and kubernetes execute the same plan through the same `Runner.runHelper` seam (docker.ts,
 * k8s-runner.ts) with the same credential, bound and failure semantics; this module is the shared,
 * platform-agnostic half — the plan/result types, the registry closed over real files under
 * `driver/src/scripts/`, and the bounded-JSON verdict parser both transports call.
 *
 * NOT YET WIRED to a real producer: issue #204's compiler expands a `block` node into ordinary
 * `agent` nodes and carries no helper-plan field on `WorkflowNode` today, so `BoardJob.helperPlans`
 * is never populated by a real claim. This issue ships the transport only, exactly as `review.ts`
 * shipped the review helpers' script content with nothing wired to it yet — a later issue (#122 /
 * #133, which own the block-specific content) is what threads a real plan through the compiler and
 * the claim. The one shipped descriptor here (`noop`) exists solely so this transport is testable
 * end to end without reaching into either block's own scope.
 */

const script = (name: string): string => readFileSync(new URL(`./scripts/${name}`, import.meta.url), 'utf8');

/** Before the node's agent run, gating its launch; after it, gating publish. */
export type HelperPhase = 'pre' | 'post';

/**
 * The low-level runtime plan an expanded block node names: an allowlisted helper id, which phase
 * it belongs to, its validated/bounded JSON input (opaque to the transport, read by the script),
 * and whether it writes to GitHub — the loop mints a fresh installation token for it immediately
 * before it runs; a read-only helper uses the claim env untouched.
 */
export interface HelperPlan {
    helperId: string;
    phase: HelperPhase;
    input: unknown;
    githubWriting: boolean;
}

/** Every named, bounded way a helper run can fail — never a thrown context leak into the agent. */
export type HelperFailureReason =
    | 'unknown_helper'
    | 'malformed_output'
    | 'oversized_output'
    | 'wrong_version'
    | 'auth_failed'
    | 'timeout'
    | 'runner_error';

const FAILURE_REASONS: readonly HelperFailureReason[] = [
    'unknown_helper',
    'malformed_output',
    'oversized_output',
    'wrong_version',
    'auth_failed',
    'timeout',
    'runner_error',
];

/** What one helper run answers: its output, or a failure named for the loop to report. */
export type HelperResult = { ok: true; output: unknown } | { ok: false; reason: HelperFailureReason; message: string };

/**
 * One allowlisted helper: its script content (read once at load time, passed to the container by
 * content — never a path, never a template string, the same rule every script in this driver
 * follows), the wire schema/version its stdout verdict must carry, and the byte cap its stdout is
 * checked against BEFORE anything attempts to parse it.
 */
export interface HelperDescriptor {
    id: string;
    scriptBody: string;
    schema: string;
    version: 1;
    outputCapBytes: number;
}

const BYTES_PER_KB = 1024;
const NOOP_OUTPUT_CAP_KB = 8;
const MERGE_CONFLICT_PROBE_OUTPUT_CAP_KB = 16;

/** The noop helper's own bound — generous for a fixture, far under any real helper's own cap. */
const NOOP_OUTPUT_CAP_BYTES = NOOP_OUTPUT_CAP_KB * BYTES_PER_KB;

/**
 * The merge-conflict-autofix block's preflight (issue #122): bounded past a real conflict's worth
 * of paths (CONFLICTING_PATHS_MAX in the script itself), far under any concern for the argv/env
 * value it travels as.
 */
const MERGE_CONFLICT_PROBE_OUTPUT_CAP_BYTES = MERGE_CONFLICT_PROBE_OUTPUT_CAP_KB * BYTES_PER_KB;

/** The wall-clock bound one helper run gets, on either executor — a batch-Job-shaped aux step. */
export const HELPER_TIMEOUT_MS = 300_000;

const NOOP_SCRIPT = script('helper-noop.cjs');
const MERGE_CONFLICT_PROBE_SCRIPT = script('merge-conflict-probe.cjs');

/**
 * The shipped descriptors: `noop` is a fixture that echoes its bounded input back as its output,
 * proving the transport (argv/env secrecy, output parsing, cleanup, failure semantics) without any
 * real board-owned side effect. `merge-conflict-probe` is the first real one (issue #122's
 * merge-conflict-autofix block, `server/src/db/workflow-blocks/merge-conflict-autofix.ts`) —
 * registered here exactly the same way, additive to the transport #207 shipped.
 */
const DESCRIPTORS: readonly HelperDescriptor[] = [
    {
        id: 'noop',
        scriptBody: NOOP_SCRIPT,
        schema: 'helper-noop/v1',
        version: 1,
        outputCapBytes: NOOP_OUTPUT_CAP_BYTES,
    },
    {
        id: 'merge-conflict-probe',
        scriptBody: MERGE_CONFLICT_PROBE_SCRIPT,
        schema: 'merge-conflict-probe/v1',
        version: 1,
        outputCapBytes: MERGE_CONFLICT_PROBE_OUTPUT_CAP_BYTES,
    },
];

export const HELPER_REGISTRY: ReadonlyMap<string, HelperDescriptor> = new Map(DESCRIPTORS.map((d) => [d.id, d]));

/** The allowlisted helper this id names, or null — looked up BEFORE any container/Job starts. */
export function lookupHelper(id: string): HelperDescriptor | null {
    return HELPER_REGISTRY.get(id) ?? null;
}

/**
 * Parses one helper's bounded stdout verdict against its own descriptor. Order matters: the byte
 * cap is checked before anything attempts to parse, so an oversized answer is never even handed to
 * `JSON.parse` — malformed, oversized, or wrong-version output is a helper FAILURE, never agent
 * context, exactly as the issue requires. A script's own `ok: false` line may name one of the
 * reasons above (`reason`); anything else it names collapses to `runner_error` rather than
 * inventing a reason this module never declared.
 */
export function parseHelperOutput(descriptor: HelperDescriptor, stdout: string): HelperResult {
    if (Buffer.byteLength(stdout, 'utf8') > descriptor.outputCapBytes) {
        return {
            ok: false,
            reason: 'oversized_output',
            message: `the helper's output exceeded its ${descriptor.outputCapBytes}-byte bound`,
        };
    }
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return { ok: false, reason: 'malformed_output', message: 'the helper answered nothing readable as JSON' };
    }
    const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
    if (o.schema !== descriptor.schema || o.version !== descriptor.version) {
        return {
            ok: false,
            reason: 'wrong_version',
            message: `expected schema "${descriptor.schema}" version ${descriptor.version}`,
        };
    }
    if (o.ok === false) {
        const reason = FAILURE_REASONS.includes(o.reason as HelperFailureReason)
            ? (o.reason as HelperFailureReason)
            : 'runner_error';
        return { ok: false, reason, message: typeof o.error === 'string' ? o.error : 'the helper reported failure' };
    }
    return { ok: true, output: o.output ?? null };
}

/** One helper's plan and the failure it produced — what a post-run helper failure rides on a verdict. */
export interface HelperFailureReport {
    helperId: string;
    result: Extract<HelperResult, { ok: false }>;
}

/** The bounded JSON `-e HELPER_INPUT=` value both transports pass a helper — never a credential. */
export function helperInputValue(plan: HelperPlan): string {
    try {
        return JSON.stringify(plan.input ?? null);
    } catch {
        return 'null';
    }
}
