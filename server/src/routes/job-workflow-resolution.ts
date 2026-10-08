/**
 * `POST /api/jobs`'s workflow resolution (issue #543's launch contract): an explicit `workflow`
 * name resolves the repo -> user -> org stack and the task runs in workflow mode; an omitted
 * `workflow` is OBJECTIVE mode — no workflow is resolved and the raw command is the job. Split out
 * of `job-handlers-worker.ts` to keep `handleCreateJob` within the repo's complexity/parameter
 * budget (AGENTS.md).
 */
import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { workflowsFor } from './job-context.js';
import { type ResolvedWorkflow, buildWorkflowSelection } from './job-field-validation.js';
import { bad, guard } from './helpers.js';
import { HTTP_NOT_FOUND } from './job-limits.js';

type NamedWorkflowStore = NonNullable<Awaited<ReturnType<typeof workflowsFor>>>;

type LaunchResolution = { handled: true } | { handled: false; workflow: ResolvedWorkflow | null; command: string };

/**
 * Resolves the `workflow` field the create body named, within the caller's visible scopes — repo
 * over user over org when the name exists in several. `handled: true` means a refusal already
 * landed on `reply` and the caller must stop; otherwise the selection and the (possibly
 * interpolated) command are ready to create with.
 */
async function resolveNamedWorkflow(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: {
        workflowsStore: NamedWorkflowStore;
        fields: Record<string, unknown>;
        repo: string | null;
        createdBy: string | null;
        command: string;
    }
): Promise<{ handled: true } | { handled: false; workflow: ResolvedWorkflow; command: string }> {
    const { workflowsStore, fields, repo, createdBy, command } = opts;
    if (typeof fields.workflow !== 'string' || !fields.workflow.trim()) {
        bad(reply, ERROR_CODES.BAD_WORKFLOW, 'workflow must be a non-empty string');
        return { handled: true };
    }
    const found = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'workflow resolution failed'),
        () => workflowsStore.findByName(fields.workflow as string, { userId: createdBy, repo })
    );
    if (!found.ok) return { handled: true };
    if (found.value === null) {
        bad(reply, ERROR_CODES.UNKNOWN_WORKFLOW, `"${fields.workflow}" is not a workflow you can use`, HTTP_NOT_FOUND);
        return { handled: true };
    }
    const selection = buildWorkflowSelection(found.value, fields.workflowParams, command);
    if (!selection.ok) {
        bad(reply, selection.code, selection.message);
        return { handled: true };
    }
    return { handled: false, workflow: selection.value, command: selection.command };
}

/**
 * The launch contract's one branch (issue #543): a named `workflow` resolves; an omitted one
 * resolves nothing, and the task is created in objective mode with its command untouched.
 */
export async function resolveLaunchWorkflow(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: {
        workflowsStore: NamedWorkflowStore | null;
        fields: Record<string, unknown>;
        repo: string | null;
        createdBy: string | null;
        command: string;
    }
): Promise<LaunchResolution> {
    const { workflowsStore, fields, repo, createdBy, command } = opts;
    const named = fields.workflow !== undefined && fields.workflow !== null;
    // No workflows store configured for this org (a route-test harness that never wires one) is
    // the same as naming nothing — never reachable in production, where a jobs store and a
    // workflows store are wired together.
    if (!named || !workflowsStore) return { handled: false, workflow: null, command };
    return resolveNamedWorkflow(request, reply, { workflowsStore, fields, repo, createdBy, command });
}
