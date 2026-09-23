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
 *
 * Issue #230 closes two further generic gaps, still block-agnostic: a successful pre-helper may
 * answer an explicit `control: 'conclude'` (`HelperControl`) to complete the job without ever
 * launching the agent — `loop-helpers.ts` owns that short-circuit — and a `CompositeDescriptor`
 * lets an allowlisted host-side program sequence several registered SCRIPT helpers, with pure
 * planning between them, through the exact same per-call `runner.runHelper` seam. `runHelperPlan`
 * is the shared sequencing algorithm; the one shipped composite (`sequence-fixture`) exists for
 * the same reason `noop` does.
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
    | 'runner_error'
    | 'invalid_control'
    | 'invalid_composite_plan';

const FAILURE_REASONS: readonly HelperFailureReason[] = [
    'unknown_helper',
    'malformed_output',
    'oversized_output',
    'wrong_version',
    'auth_failed',
    'timeout',
    'runner_error',
    'invalid_control',
    'invalid_composite_plan',
];

/**
 * A successful pre-run helper's explicit control outcome (issue #230): `continue` (the default —
 * absent from the wire verdict reads the same way) runs the node's agent turn as before;
 * `conclude` completes the claimed job through the ordinary board completion path without ever
 * launching the agent, running gates, running post-helpers, or publishing. Valid only on a
 * successful PRE helper — `loop-helpers.ts` fails closed on a post-helper or a failed result that
 * names one.
 */
export type HelperControl = 'continue' | 'conclude';

const CONTROLS: readonly HelperControl[] = ['continue', 'conclude'];

/**
 * What one helper run answers: its output and (when the wire verdict named one) its control
 * outcome, or a failure named for the loop to report. `control` is deliberately absent rather than
 * defaulted to `'continue'` when the wire verdict never mentioned it — every result built before
 * this issue, and every script that never adopts the field, keeps its exact old shape.
 */
export type HelperResult =
    | { ok: true; output: unknown; control?: HelperControl }
    | { ok: false; reason: HelperFailureReason; message: string };

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
    return succeedWithControl(o.output ?? null, o.control);
}

/**
 * The success half of `parseHelperOutput`, split out to keep that function's own branching under
 * the linter's complexity budget. An absent control reads as `'continue'` without attaching the
 * field at all — see `HelperResult`'s own comment for why that shape is deliberate.
 */
function succeedWithControl(output: unknown, control: unknown): HelperResult {
    if (control === undefined) return { ok: true, output };
    if (!CONTROLS.includes(control as HelperControl)) {
        return {
            ok: false,
            reason: 'invalid_control',
            message: `the helper named an unknown control "${String(control)}" — expected "continue" or "conclude"`,
        };
    }
    return { ok: true, output, control: control as HelperControl };
}

/**
 * `conclude`'s bounded structured output, as the string the board's existing `output` field
 * already carries on completion. A string passes through verbatim — so a helper's own marker
 * convention still lands on the exact final line the workflow engine's marker edges read
 * (docs/workflows.md, "The edge vocabulary") — anything else is JSON-stringified.
 */
export function formatConcludeOutput(output: unknown): string {
    if (typeof output === 'string') return output;
    try {
        return JSON.stringify(output ?? null);
    } catch {
        return 'null';
    }
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

/**
 * One step of a composite helper program (issue #230): which registered SCRIPT helper it
 * invokes — never another composite, nesting is refused at registry-validation time below — and
 * whether that step writes to GitHub, minted its own fresh token exactly when that step runs, the
 * same "fresh write-token" rule every other github-writing helper follows.
 */
export interface CompositeStep {
    helperId: string;
    githubWriting: boolean;
}

/**
 * An allowlisted, host-side helper PROGRAM: sequences its declared script steps through the
 * existing per-call runner.runHelper seam — never a container or Job of its own — with pure
 * TypeScript planning between them. `planStepInput` computes one step's bounded input from the
 * PREVIOUS step's bounded output (`null` for the first step) and the composite's own declared
 * input; `finalize` folds every step's output, once all have succeeded, into the composite's own
 * bounded result and its own continue/conclude control. Both are pure — no I/O, no shell, no
 * credential, no arbitrary image — every actual side effect still happens inside an ordinary
 * registered script step, through the transport's own bounded I/O, fencing and failure semantics.
 */
export interface CompositeDescriptor {
    id: string;
    steps: readonly CompositeStep[];
    planStepInput(stepIndex: number, previousOutput: unknown, compositeInput: unknown): unknown;
    finalize(stepOutputs: readonly unknown[], compositeInput: unknown): { output: unknown; control: HelperControl };
}

/**
 * Defensive bound on one composite's step count. There is no aggregate composite timeout
 * otherwise — each step still gets its own independent `HELPER_TIMEOUT_MS` — so this is what
 * keeps a pathological registration from chaining an unbounded number of container/Job spins.
 */
export const MAX_COMPOSITE_STEPS = 8;

/**
 * The one neutral fixture composite (issue #230): two `noop` steps, proving sequencing (two
 * distinct child calls), intermediate planning (`planStepInput` transforms the previous step's
 * output rather than passing it through untouched) and output propagation, with `finalize`
 * deciding `conclude` vs. `continue` purely from the composite's own declared input — so a test
 * drives both outcomes deterministically without touching any real block's own scope.
 */
const SEQUENCE_FIXTURE: CompositeDescriptor = {
    id: 'sequence-fixture',
    steps: [
        { helperId: 'noop', githubWriting: false },
        { helperId: 'noop', githubWriting: false },
    ],
    planStepInput(stepIndex, previousOutput, compositeInput) {
        return stepIndex === 0 ? { step: 0, seed: compositeInput } : { step: 1, receivedFromStep0: previousOutput };
    },
    finalize(stepOutputs, compositeInput) {
        const wantsConclude =
            typeof compositeInput === 'object' &&
            compositeInput !== null &&
            (compositeInput as { conclude?: unknown }).conclude === true;
        return { output: { steps: stepOutputs }, control: wantsConclude ? 'conclude' : 'continue' };
    },
};

/**
 * Every named composite-registration failure, thrown synchronously at module load — the strongest
 * form of "fail closed before execution": a malformed registration never reaches a claim because
 * the driver process itself refuses to start. Exported so the test suite can exercise every
 * violation against throwaway descriptors without reloading the module.
 */
export function validateComposite(
    descriptor: CompositeDescriptor,
    scriptIds: ReadonlySet<string>,
    compositeIds: ReadonlySet<string>
): void {
    if (scriptIds.has(descriptor.id)) {
        throw new Error(`composite "${descriptor.id}" collides with a registered script helper id`);
    }
    if (descriptor.steps.length < 1 || descriptor.steps.length > MAX_COMPOSITE_STEPS) {
        throw new Error(
            `composite "${descriptor.id}" declares ${descriptor.steps.length} steps, outside 1..${MAX_COMPOSITE_STEPS}`
        );
    }
    for (const step of descriptor.steps) {
        if (compositeIds.has(step.helperId)) {
            throw new Error(
                `composite "${descriptor.id}" names composite "${step.helperId}" as a step — nesting is refused`
            );
        }
        if (!scriptIds.has(step.helperId)) {
            throw new Error(`composite "${descriptor.id}" names unregistered helper "${step.helperId}"`);
        }
    }
    if (typeof descriptor.planStepInput !== 'function' || typeof descriptor.finalize !== 'function') {
        throw new Error(`composite "${descriptor.id}" must declare planStepInput and finalize as functions`);
    }
}

const COMPOSITE_DESCRIPTORS: readonly CompositeDescriptor[] = [SEQUENCE_FIXTURE];

const scriptIds = new Set(DESCRIPTORS.map((d) => d.id));
const compositeIds = new Set(COMPOSITE_DESCRIPTORS.map((d) => d.id));
for (const composite of COMPOSITE_DESCRIPTORS) validateComposite(composite, scriptIds, compositeIds);

export const COMPOSITE_REGISTRY: ReadonlyMap<string, CompositeDescriptor> = new Map(
    COMPOSITE_DESCRIPTORS.map((d) => [d.id, d])
);

/** The allowlisted composite this id names, or null — looked up BEFORE any child call starts. */
export function lookupComposite(id: string): CompositeDescriptor | null {
    return COMPOSITE_REGISTRY.get(id) ?? null;
}

/**
 * Sequences one composite's declared script steps through `invokeChild` — every child still
 * rides whatever fencing, token-minting and bounded-I/O the caller's own `invokeChild` performs,
 * exactly as a lone plan always did — folding each child's bounded output through the composite's
 * own pure `planStepInput` before the next call, and its `finalize` once every child has
 * succeeded. Split from `runHelperPlan` so the sequencing algorithm is directly testable against a
 * throwaway descriptor, without a real one needing to misbehave. `invokeChild` answering `null`
 * means "abandon this plan, the caller has already stood the attempt down (or lost the lease)" —
 * propagated immediately, without running the remaining steps or `finalize`.
 */
export async function runComposite(
    composite: CompositeDescriptor,
    plan: HelperPlan,
    invokeChild: (childPlan: HelperPlan) => Promise<HelperResult | null>
): Promise<HelperResult | null> {
    if (plan.githubWriting) {
        return {
            ok: false,
            reason: 'invalid_composite_plan',
            message: `composite helper "${plan.helperId}" cannot itself declare githubWriting — each of its steps declares its own`,
        };
    }

    const outputs: unknown[] = [];
    for (let i = 0; i < composite.steps.length; i += 1) {
        const step = composite.steps[i]!;
        let input: unknown;
        try {
            input = composite.planStepInput(i, i === 0 ? null : outputs[i - 1], plan.input);
        } catch (e) {
            return {
                ok: false,
                reason: 'invalid_composite_plan',
                message: `composite "${plan.helperId}" step ${i} planning threw: ${(e as Error).message}`,
            };
        }
        const childResult = await invokeChild({
            helperId: step.helperId,
            phase: plan.phase,
            input,
            githubWriting: step.githubWriting,
        });
        if (childResult === null) return null;
        if (!childResult.ok) return childResult;
        outputs.push(childResult.output);
    }

    try {
        const final = composite.finalize(outputs, plan.input);
        return { ok: true, output: final.output, control: final.control };
    } catch (e) {
        return {
            ok: false,
            reason: 'invalid_composite_plan',
            message: `composite "${plan.helperId}" finalize threw: ${(e as Error).message}`,
        };
    }
}

/**
 * Runs one declared plan to its final result. A plain script plan is a single call through
 * `invokeChild`, unchanged from before this issue. A composite plan (issue #230) resolves the
 * registered descriptor and sequences it via `runComposite`.
 */
export async function runHelperPlan(
    plan: HelperPlan,
    invokeChild: (childPlan: HelperPlan) => Promise<HelperResult | null>
): Promise<HelperResult | null> {
    const composite = lookupComposite(plan.helperId);
    if (!composite) return invokeChild(plan);
    return runComposite(composite, plan, invokeChild);
}
