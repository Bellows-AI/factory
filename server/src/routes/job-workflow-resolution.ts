/**
 * `POST /api/jobs`'s workflow resolution (issue #209's launch contract): an explicit `workflow`
 * name resolves the repo -> user -> org stack exactly as before; an unnamed task now resolves the
 * code-owned DEFAULT workflow — the mandatory `{{command}}` spine plus whichever of the two
 * optional blocks the caller selected (a per-task `defaultWorkflow` override, else the caller's
 * saved settings from #203, else both on). Split out of `job-handlers-worker.ts` to keep
 * `handleCreateJob` within the repo's complexity/parameter budget (AGENTS.md).
 */
import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
    compileDefaultWorkflow,
    DEFAULT_WORKFLOW_NAME,
    parseDefaultWorkflowSelection,
    type DefaultWorkflowSelection,
} from '../db/default-workflow.js';
import { BOTH_ENABLED, type DefaultWorkflowSettingsStore } from '../db/default-workflow-settings-store.js';
import type { workflowsFor } from './job-context.js';
import { type ResolvedWorkflow, buildWorkflowSelection } from './job-field-validation.js';
import { bad, guard } from './helpers.js';
import { HTTP_NOT_FOUND } from './job-limits.js';

type NamedWorkflowStore = NonNullable<Awaited<ReturnType<typeof workflowsFor>>>;

type LaunchResolution = { handled: true } | { handled: false; workflow: ResolvedWorkflow | null; command: string };

/** Strips a settings/override shape down to the plain two-key pair `ResolvedWorkflow.defaultOptions` carries. */
function pairOf(value: { reviewReconciliation: boolean; mergeConflictAutofix: boolean }): DefaultWorkflowSelection {
    return { reviewReconciliation: value.reviewReconciliation, mergeConflictAutofix: value.mergeConflictAutofix };
}

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
 * Resolves the code-owned default workflow's selected pair — an explicit per-task override, else
 * the caller's saved settings (missing row/no store/no caller means both on) — and compiles it.
 * `handled: true` means a refusal already landed on `reply`.
 */
async function resolveDefaultWorkflow(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: {
        defaultsStore: DefaultWorkflowSettingsStore | null;
        fields: Record<string, unknown>;
        createdBy: string | null;
        command: string;
    }
): Promise<{ handled: true } | { handled: false; workflow: ResolvedWorkflow; command: string }> {
    const { defaultsStore, fields, createdBy, command } = opts;
    const hasOverride = fields.defaultWorkflow !== undefined && fields.defaultWorkflow !== null;

    let selection: DefaultWorkflowSelection;
    if (hasOverride) {
        const parsed = parseDefaultWorkflowSelection(fields.defaultWorkflow);
        if (!parsed.ok) {
            bad(reply, ERROR_CODES.BAD_DEFAULT_WORKFLOW, parsed.message);
            return { handled: true };
        }
        selection = parsed.value;
    } else if (defaultsStore && createdBy) {
        const loaded = await guard(
            reply,
            (e) => request.log.error({ err: e }, 'default workflow settings read failed'),
            () => defaultsStore.get(createdBy)
        );
        if (!loaded.ok) return { handled: true };
        selection = pairOf(loaded.value);
    } else {
        // No settings store, or no authenticated caller to key one by (open auth mode, a route
        // test harness with no store configured): both optional blocks on, matching "missing
        // settings include both blocks" — the same answer a missing row gives.
        selection = pairOf(BOTH_ENABLED);
    }

    const definition = compileDefaultWorkflow(selection);
    const built = buildWorkflowSelection(
        { id: null, name: DEFAULT_WORKFLOW_NAME, definition },
        fields.workflowParams,
        command
    );
    if (!built.ok) {
        bad(reply, built.code, built.message);
        return { handled: true };
    }
    return {
        handled: false,
        workflow: { ...built.value, defaultOptions: selection },
        command: built.command,
    };
}

/**
 * The launch contract's top-level branch (issue #209): an explicit `workflow` alongside a
 * `defaultWorkflow` override is always refused, before either is ever resolved — a named workflow
 * has no optional-block options to select, so combining the two fields is a client bug, not an
 * ambiguity to guess at.
 */
export async function resolveLaunchWorkflow(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: {
        workflowsStore: NamedWorkflowStore | null;
        defaultsStore: DefaultWorkflowSettingsStore | null;
        fields: Record<string, unknown>;
        repo: string | null;
        createdBy: string | null;
        command: string;
    }
): Promise<LaunchResolution> {
    const { workflowsStore, defaultsStore, fields, repo, createdBy, command } = opts;
    const named = fields.workflow !== undefined && fields.workflow !== null;
    const hasOverride = fields.defaultWorkflow !== undefined && fields.defaultWorkflow !== null;

    if (named && hasOverride) {
        bad(reply, ERROR_CODES.BAD_DEFAULT_WORKFLOW, 'defaultWorkflow cannot accompany a named workflow');
        return { handled: true };
    }

    if (named) {
        // No workflows store configured for this org (a route-test harness that never wires one):
        // the name is silently not resolved, the pre-209 quirk this branch has always had — never
        // reachable in production, where a jobs store and a workflows store are wired together.
        if (!workflowsStore) return { handled: false, workflow: null, command };
        return resolveNamedWorkflow(request, reply, { workflowsStore, fields, repo, createdBy, command });
    }

    return resolveDefaultWorkflow(request, reply, { defaultsStore, fields, createdBy, command });
}
