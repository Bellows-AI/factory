/**
 * The board-owned master prompt (issue #244): a bounded, code-rendered text every agent claim
 * carries through the executor's native system-instruction channel, telling the agent it is one
 * turn inside a Factory-run process and naming exactly what Factory itself will do around it.
 * Pure — no I/O — so the claim path (`job-store-claim.ts`) is the one caller, and every shape here
 * is trusted, already-validated metadata: a workflow name off the row, a node off the frozen
 * snapshot, helper plans off the claim's own resolver. Nothing here ever reads `job.command`, a
 * node's own prompt text, prior output, env values, or credentials — the whole point is that a
 * workflow or task author cannot supply, append, or interpolate a single byte of this text.
 */
import { type ClaimHelperPlan } from './job-store-types.js';
import { COLLECT_HELPER_ID, REPLY_HELPER_ID } from './workflow-blocks/github-review-reconcile.js';
import { PROBE_HELPER_ID } from './workflow-blocks/merge-conflict-autofix.js';
import { nodeOf, type WorkflowDefinition } from './workflow-schema.js';

/** Versioned so tests and later migrations can name the exact behavior they expect. */
export const MASTER_PROMPT_VERSION = 'factory-master-prompt/v1';

/**
 * The character cap on the rendered prompt. Generous for the closed, fixed-shape template this
 * renders — the cap exists to fail closed on a future template mistake, not to ration space.
 */
export const MASTER_PROMPT_LIMIT = 4_096;

/**
 * A workflow name is member-chosen free text (`WORKFLOW_NAME` in workflow-schema.ts allows almost
 * any character), and OpenCode's config format treats `{`/`}` as live template syntax
 * (`{env:...}`, `{file:...}`). A name outside this safe display shape is withheld entirely rather
 * than sanitized — sanitizing invites a reader to assume the withheld text was merely cosmetic.
 */
const SAFE_WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:()#+/-]{0,99}$/;

const CAPABILITY_LABELS = [
    'declared gates',
    'publish/reuse PR',
    'pre-turn helper steps',
    'post-turn helper steps',
    'review reconciliation',
    'merge-conflict repair',
    'durable GitHub waits',
    'board helper steps',
] as const;

type CapabilityLabel = (typeof CAPABILITY_LABELS)[number];

const RULES = `Rules for this turn
- This is one agent turn inside a Factory-run process, not authority to run that process.
- Factory decides what happens next from this turn's verdict and final output.
- Factory runs every capability listed above; do not emulate any of them.
- Do not push, open, update, merge or close a pull request, enable auto-merge, comment on or reply to GitHub reviews, poll or wait for GitHub activity, or start the next workflow step.
- You may edit files, run tests and other local verification, and commit, as the current task requires; Factory still runs its declared gates afterwards.
- If the current task defines an exact output line or marker, end with exactly that line, then stop.`;

/** What one claim resolves the prompt from — trusted, already-validated board metadata only. */
export interface MasterPromptClaimInput {
    /** The row's own graph position; null on a standalone task or an off-graph member follow-up. */
    workflowNode: string | null;
    /** The thread's frozen workflow name; null on a task that never ran a workflow. */
    workflowName: string | null;
    /** The root's frozen workflow snapshot; null when the thread never ran a workflow. */
    snapshot: WorkflowDefinition | null;
    /** This claim's own declared pre/post block-helper steps, exactly as resolved onto it. */
    helperPlans: ClaimHelperPlan[] | undefined;
}

interface RenderContext {
    mode: 'standalone' | 'workflow';
    workflowName: string | null;
    workflowNode: string | null;
    capabilities: readonly CapabilityLabel[];
}

function workflowNameLine(name: string): string {
    return SAFE_WORKFLOW_NAME.test(name) ? `- Workflow: ${name}` : '- Workflow: (custom workflow; name not shown)';
}

function renderContextBlock(ctx: RenderContext): string {
    const lines = ['Factory execution context', `- Mode: ${ctx.mode}`];
    if (ctx.mode === 'workflow' && ctx.workflowName !== null) lines.push(workflowNameLine(ctx.workflowName));
    if (ctx.workflowNode !== null) {
        lines.push(`- Current node: ${ctx.workflowNode}`);
    } else if (ctx.mode === 'workflow') {
        // An off-graph row of a workflow thread: a member's follow-up. Its completion re-fires
        // the halted node's edges (docs/workflows.md), so it is still Factory-managed, just not
        // itself a graph position.
        lines.push('- Turn: member follow-up');
    }
    lines.push(
        `- Factory-managed capabilities: ${ctx.capabilities.length ? ctx.capabilities.join(', ') : '(none declared for this run)'}`
    );
    // "Current task", not "current node prompt": a standalone claim has no node at all, and the
    // wording must read true in both modes.
    lines.push('- Your boundary: complete only the current task and return control.');
    return lines.join('\n');
}

/** Assembles and bounds the final text. */
function renderMasterPrompt(ctx: RenderContext): string | null {
    const text = `Factory execution contract (${MASTER_PROMPT_VERSION})\n\n${renderContextBlock(ctx)}\n\n${RULES}`;
    return text.length > MASTER_PROMPT_LIMIT ? null : text;
}

function snapshotCapabilities(snapshot: WorkflowDefinition): CapabilityLabel[] {
    const found = new Set<CapabilityLabel>();
    if (snapshot.nodes.some((n) => n.publish === true)) found.add('publish/reuse PR');
    for (const node of snapshot.nodes) {
        if (node.runtime !== undefined) found.add('durable GitHub waits');
        for (const plan of node.helperPlans ?? []) {
            if (plan.helperId === COLLECT_HELPER_ID || plan.helperId === REPLY_HELPER_ID) {
                found.add('review reconciliation');
            } else if (plan.helperId === PROBE_HELPER_ID) {
                found.add('merge-conflict repair');
            } else {
                found.add('board helper steps');
            }
        }
    }
    return CAPABILITY_LABELS.filter((label) => found.has(label));
}

/**
 * The full capability set for one claim: this node's own gates/helper policy, plus the graph-wide
 * facts (a publish path, the two builtin blocks, a durable wait) `snapshotCapabilities` finds. A
 * standalone or off-graph claim has no node to opt out of gates/publish — both are always on,
 * matching resolveClaimGates/resolveClaimPublish's own "absent means publish" contract.
 */
function claimCapabilities(input: MasterPromptClaimInput, node: { gates?: boolean } | undefined): CapabilityLabel[] {
    const { workflowNode, snapshot, helperPlans } = input;
    const capabilities = new Set<CapabilityLabel>();
    if (workflowNode === null || node?.gates !== false) capabilities.add('declared gates');
    if (workflowNode === null || (snapshot && snapshot.nodes.some((n) => n.publish === true))) {
        capabilities.add('publish/reuse PR');
    }
    if (helperPlans?.some((plan) => plan.phase === 'pre')) capabilities.add('pre-turn helper steps');
    if (helperPlans?.some((plan) => plan.phase === 'post')) capabilities.add('post-turn helper steps');
    if (snapshot) for (const label of snapshotCapabilities(snapshot)) capabilities.add(label);
    return CAPABILITY_LABELS.filter((label) => capabilities.has(label));
}

/**
 * claim()'s one read of everything the renderer needs, turned into the final prompt text — or
 * null, which the claim treats as a contract violation and refuses the agent launch explicitly
 * (never a silent run with no master prompt). Null happens only when a node claim's own snapshot
 * is missing or does not contain the claimed node: neither can happen on a live thread (the same
 * fail-closed posture `resolveClaimPublish` already takes for a node with no snapshot), but a
 * future bug here must never surface as an agent quietly running unbounded.
 */
export function resolveMasterPrompt(input: MasterPromptClaimInput): string | null {
    const { workflowNode, workflowName, snapshot } = input;
    if (workflowNode !== null && (snapshot === null || nodeOf(snapshot, workflowNode) === undefined)) {
        return null;
    }
    const node = workflowNode !== null && snapshot !== null ? nodeOf(snapshot, workflowNode) : undefined;

    return renderMasterPrompt({
        mode: workflowName !== null ? 'workflow' : 'standalone',
        workflowName,
        workflowNode,
        capabilities: claimCapabilities(input, node),
    });
}
