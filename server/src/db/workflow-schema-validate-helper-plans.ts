import { ERROR_CODES } from '@factory-ai/core';
import {
    HELPER_ID,
    HELPER_ID_LIMIT,
    HELPER_PLANS_MAX,
    type DefinitionRefusal,
    type WorkflowNodeHelperPlan,
} from './workflow-schema.js';

/**
 * A node's `helperPlans` validation (issue #122/#207), split out of `workflow-schema-validate.ts`
 * purely to keep that file under the repo's line-count ceiling — no behavior change, same rules,
 * same refusal codes. `resolveHelperPlans` is the one export `parseAgentNode` calls.
 */

type StepResult<T> = { ok: true; value: T } | { ok: false; refusal: DefinitionRefusal };

function stepRefuse<T>(code: DefinitionRefusal['code'], message: string): StepResult<T> {
    return { ok: false, refusal: { code, message } };
}

const KNOWN_HELPER_PLAN_KEYS = new Set(['helperId', 'phase', 'githubWriting']);

/** One declared helper plan of `nodes[i].helperPlans`, in isolation — see `resolveHelperPlans`. */
function resolveHelperPlan(item: unknown, i: number, j: number): StepResult<WorkflowNodeHelperPlan> {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].helperPlans[${j}] must be an object`);
    }
    const plan = item as Record<string, unknown>;
    for (const key of Object.keys(plan)) {
        if (!KNOWN_HELPER_PLAN_KEYS.has(key)) {
            return stepRefuse(ERROR_CODES.UNKNOWN_KEY, `unknown key "${key}" in nodes[${i}].helperPlans[${j}]`);
        }
    }
    if (typeof plan.helperId !== 'string' || plan.helperId.length > HELPER_ID_LIMIT || !HELPER_ID.test(plan.helperId)) {
        return stepRefuse(
            ERROR_CODES.BAD_NODE,
            `nodes[${i}].helperPlans[${j}].helperId must match ${HELPER_ID.source}`
        );
    }
    if (plan.phase !== 'pre' && plan.phase !== 'post') {
        return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].helperPlans[${j}].phase must be "pre" or "post"`);
    }
    if (typeof plan.githubWriting !== 'boolean') {
        return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].helperPlans[${j}].githubWriting must be a boolean`);
    }
    return { ok: true, value: { helperId: plan.helperId, phase: plan.phase, githubWriting: plan.githubWriting } };
}

/** A node's optional `helperPlans`: bounded, each a declared-shape helper step. */
export function resolveHelperPlans(
    node: Record<string, unknown>,
    i: number
): StepResult<WorkflowNodeHelperPlan[] | undefined> {
    if (node.helperPlans === undefined) return { ok: true, value: undefined };
    if (!Array.isArray(node.helperPlans)) {
        return stepRefuse(ERROR_CODES.BAD_NODE, `nodes[${i}].helperPlans must be an array`);
    }
    if (node.helperPlans.length > HELPER_PLANS_MAX) {
        return stepRefuse(
            ERROR_CODES.BAD_NODE,
            `nodes[${i}].helperPlans must declare at most ${HELPER_PLANS_MAX} entries`
        );
    }
    const plans: WorkflowNodeHelperPlan[] = [];
    for (const [j, item] of node.helperPlans.entries()) {
        const parsed = resolveHelperPlan(item, i, j);
        if (!parsed.ok) return parsed;
        plans.push(parsed.value);
    }
    return { ok: true, value: plans };
}
