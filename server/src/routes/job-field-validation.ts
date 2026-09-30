import { COMMAND_LIMIT, ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply } from 'fastify';
import type { FailureKind, GateReport, JobOutcome, JobStatus } from '../db/job-store-types.js';
import {
    type ParamValues,
    type WorkflowDefinition,
    checkWorkflowParams,
    interpolate,
    nodeOf,
} from '../db/workflow-schema.js';
import { bad, body } from './helpers.js';
import {
    AGENT_TURNS_MAX,
    BRANCH_LIMIT,
    CONTEXT_COST_MAX,
    CONTEXT_TOKENS_MAX,
    GATE_NAME_LIMIT,
    HTTP_CONFLICT,
    HTTP_FORBIDDEN,
    LEASE_SECONDS_MAX,
    LIST_LIMIT_DEFAULT,
    LIST_LIMIT_MAX,
    OUTPUT_LIMIT,
    PR_URL,
    PR_URL_LIMIT,
    STATUSES,
    SUMMARY_LIMIT,
    WAIT_TIMEOUT_DEFAULT_S,
    WAIT_TIMEOUT_MAX_S,
    WORKER_NAME_LIMIT,
    executorReason,
    leaseSeconds,
    notFoundJob,
} from './job-limits.js';
import { repoReason } from './helpers.js';
import { MS_PER_SECOND } from './auth-shared.js';

/**
 * Field-by-field body/query validation for the job routes — everything that turns an untrusted
 * `unknown` into either a typed value or a refusal message, with no Fastify request/store
 * coupling beyond `FastifyReply` for the few helpers that answer directly.
 */

export function validateWorkerField(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > WORKER_NAME_LIMIT) {
        return { ok: false, message: 'worker must be a non-empty string' };
    }
    return { ok: true, value: raw };
}

/** The claim body shared, byte for byte, by the job queue and the worktree-reclaim queue. */
export function validateClaimBody(
    fields: Record<string, unknown>
): { ok: true; value: { worker: string; lease: number } } | { ok: false; code: string; message: string } {
    const workerResult = validateWorkerField(fields.worker);
    if (!workerResult.ok) return { ok: false, code: ERROR_CODES.BAD_WORKER, message: workerResult.message };
    const lease = leaseSeconds(fields.leaseSeconds);
    if (lease === null) {
        return {
            ok: false,
            code: ERROR_CODES.BAD_LEASE,
            message: `leaseSeconds must be an integer 1..${LEASE_SECONDS_MAX}`,
        };
    }
    return { ok: true, value: { worker: workerResult.value, lease } };
}

export function validateCommandField(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
    if (typeof raw !== 'string' || !raw.trim()) {
        return { ok: false, message: 'command must be a non-empty string' };
    }
    if (raw.length > COMMAND_LIMIT) {
        return { ok: false, message: `command exceeds ${COMMAND_LIMIT} characters` };
    }
    return { ok: true, value: raw };
}

// Absent and explicit null both mean "not given" — what every job queued before the chat carries.
export function validateRepoField(raw: unknown): { ok: true; value: string | null } | { ok: false; message: string } {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false, message: 'repo must be a string' };
    const reason = repoReason(raw);
    if (reason) return { ok: false, message: reason };
    return { ok: true, value: raw };
}

export function validateExecutorField(
    raw: unknown
): { ok: true; value: string | null } | { ok: false; message: string } {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false, message: 'executor must be a string' };
    const reason = executorReason(raw);
    if (reason) return { ok: false, message: reason };
    return { ok: true, value: raw };
}

export interface ResolvedWorkflow {
    /** Null for the code-owned default (issue #209): never a row in `workflow`, so no id to freeze. */
    id: string | null;
    name: string;
    node: string;
    snapshot: WorkflowDefinition;
    params: ParamValues;
    /**
     * The default workflow's launch-time options, only for the code-owned default. Absent on a
     * named workflow. `gateFixRounds` is the selected executor's configured repair-round limit
     * (issue #49) — resolved here, frozen with the snapshot, never re-read from settings later.
     */
    defaultOptions?: { reviewReconciliation: boolean; mergeConflictAutofix: boolean; gateFixRounds: number };
}

/**
 * The root row runs the ENTRY node's prompt, interpolated now with the member's own words — the
 * graph's first run IS the task. `{{command}}` carries the chat line; `{{param.*}}` the validated
 * values; `{{node.*}}` is empty HERE by definition (no run of this thread exists yet). The same
 * cap applies to the built command as to a raw one. Also the code-owned default's own resolution
 * step (issue #209): its assembled definition declares no params, so `checkWorkflowParams` already
 * refuses any `workflowParams` sent beside it with the same `BAD_WORKFLOW_PARAMS` code a named
 * workflow's own unknown-parameter refusal uses — no separate check is needed here.
 */
export function buildWorkflowSelection(
    found: { id: string | null; name: string; definition: WorkflowDefinition },
    workflowParams: unknown,
    command: string
): { ok: true; value: ResolvedWorkflow; command: string } | { ok: false; code: string; message: string } {
    const definition = found.definition;
    // The declared parameters are code-enforced, not prompt-discipline: a parametrized workflow
    // must never launch on a guess, so a missing or malformed value refuses HERE — a 400 to the
    // composer, not a runner improvising (issue #127).
    const checked = checkWorkflowParams(definition, workflowParams);
    if (!checked.ok) return { ok: false, code: checked.refusal.code, message: checked.refusal.message };
    const entry = nodeOf(definition, definition.entry);
    if (!entry) return { ok: false, code: ERROR_CODES.BAD_WORKFLOW, message: 'workflow has no entry node' };
    const interpolated = interpolate(entry.prompt, {
        nodeOutput: () => '',
        gateName: '',
        gateOutput: '',
        param: (name) => checked.values[name] ?? '',
        command,
    });
    if (interpolated.length > COMMAND_LIMIT) {
        return { ok: false, code: ERROR_CODES.BAD_COMMAND, message: `command exceeds ${COMMAND_LIMIT} characters` };
    }
    return {
        ok: true,
        value: {
            id: found.id,
            // The resolved record's NAME, frozen on the task as workflow_name — the same trust
            // pattern as created_by: it travels from the record the store resolved, never off the
            // body, which only NAMES a workflow to resolve.
            name: found.name,
            node: definition.entry,
            snapshot: definition,
            params: checked.values,
        },
        command: interpolated,
    };
}

function validateGateEntry(raw: unknown): GateReport | string {
    const entry = body(raw);
    const { name, status, exitCode, output } = entry;
    if (typeof name !== 'string' || !name.trim() || name.length > GATE_NAME_LIMIT) {
        return `every gate needs a name of at most ${GATE_NAME_LIMIT} characters`;
    }
    if (status !== 'running' && status !== 'passed' && status !== 'failed') {
        return "gate status must be 'running', 'passed' or 'failed'";
    }
    if (exitCode !== undefined && exitCode !== null && !Number.isInteger(exitCode)) {
        return 'gate exitCode must be an integer or null';
    }
    if (output !== undefined && output !== null && typeof output !== 'string') {
        return 'gate output must be a string or null';
    }
    return {
        name,
        status,
        exitCode: (exitCode as number | undefined) ?? null,
        output: typeof output === 'string' ? output.slice(0, OUTPUT_LIMIT) : null,
    };
}

export function validateGates(raw: unknown): { ok: true; value: GateReport[] } | { ok: false; message: string } {
    if (!Array.isArray(raw)) return { ok: false, message: 'gates must be an array' };
    const results: GateReport[] = [];
    for (const item of raw) {
        const one = validateGateEntry(item);
        if (typeof one === 'string') return { ok: false, message: one };
        results.push(one);
    }
    return { ok: true, value: results };
}

export interface CompleteFields {
    status: JobOutcome;
    exitCode: number | null;
    output: string | null;
    contextTokens: number | null;
    contextCostUsd: number | null;
    agentTurns: number | null;
    summary: string | null;
    failureKind: FailureKind | null;
}

/**
 * The structured terminal reasons a verdict may name (issue #339). The route is the value
 * boundary: anything not in this list is refused, so the stored column is always one of these
 * six spellings or null — "not a failure".
 */
export const FAILURE_KINDS: readonly FailureKind[] = [
    'timeout',
    'cache_lost',
    'gate',
    'publish',
    'helper',
    'runner_error',
];

function badFailureKind(failureKind: unknown): boolean {
    return failureKind !== undefined && failureKind !== null && !FAILURE_KINDS.includes(failureKind as FailureKind);
}

function badExitCode(exitCode: unknown): boolean {
    return exitCode !== undefined && exitCode !== null && !Number.isInteger(exitCode);
}

function badOutputField(output: unknown): boolean {
    return output !== undefined && output !== null && typeof output !== 'string';
}

function badContextTokens(contextTokens: unknown): boolean {
    return (
        contextTokens !== undefined &&
        contextTokens !== null &&
        (!Number.isInteger(contextTokens) ||
            (contextTokens as number) < 0 ||
            (contextTokens as number) > CONTEXT_TOKENS_MAX)
    );
}

function badContextCost(contextCostUsd: unknown): boolean {
    return (
        contextCostUsd !== undefined &&
        contextCostUsd !== null &&
        (typeof contextCostUsd !== 'number' ||
            !Number.isFinite(contextCostUsd) ||
            (contextCostUsd as number) < 0 ||
            (contextCostUsd as number) > CONTEXT_COST_MAX)
    );
}

// The close-time agent-turn count: optional, and absent means unmeasured — the never-zero
// contract puts the boundary at the route, so a malformed report cannot write a
// plausible-looking zero over a run nobody counted. Capped at PostgreSQL's int4 maximum,
// because `job.agent_turns` is an int and an out-of-range value would fail the verdict's
// transaction, leaving a finished run unsettled.
function badAgentTurns(agentTurns: unknown): boolean {
    return (
        agentTurns !== undefined &&
        agentTurns !== null &&
        (!Number.isInteger(agentTurns) || (agentTurns as number) < 0 || (agentTurns as number) > AGENT_TURNS_MAX)
    );
}

function badSummaryField(summary: unknown): boolean {
    return summary !== undefined && summary !== null && typeof summary !== 'string';
}

/** The last two scalar checks of a complete body — the close-time summary and the failure kind. */
function closingFieldRefusal(fields: Record<string, unknown>): { code: string; message: string } | null {
    if (badSummaryField(fields.summary)) {
        return { code: ERROR_CODES.BAD_SUMMARY, message: 'summary must be a string or null' };
    }
    if (badFailureKind(fields.failureKind)) {
        return {
            code: ERROR_CODES.BAD_FAILURE_KIND,
            message: `failureKind must be one of ${FAILURE_KINDS.join(', ')} or null`,
        };
    }
    return null;
}

/** The measured fields of a complete body, before the close-time pair — every bounded number. */
function measuredFieldRefusal(fields: Record<string, unknown>): { code: string; message: string } | null {
    const { status, exitCode, output, contextTokens, contextCostUsd, agentTurns } = fields;
    if (status !== 'succeeded' && status !== 'failed') {
        return { code: ERROR_CODES.BAD_STATUS, message: "status must be 'succeeded' or 'failed'" };
    }
    if (badExitCode(exitCode)) {
        return { code: ERROR_CODES.BAD_EXIT_CODE, message: 'exitCode must be an integer or null' };
    }
    if (badOutputField(output)) {
        return { code: ERROR_CODES.BAD_OUTPUT, message: 'output must be a string or null' };
    }
    if (badContextTokens(contextTokens)) {
        return {
            code: ERROR_CODES.BAD_CONTEXT,
            message: `contextTokens must be an integer 0..${CONTEXT_TOKENS_MAX}`,
        };
    }
    if (badContextCost(contextCostUsd)) {
        return {
            code: ERROR_CODES.BAD_CONTEXT,
            message: `contextCostUsd must be a number 0..${CONTEXT_COST_MAX}`,
        };
    }
    if (badAgentTurns(agentTurns)) {
        return {
            code: ERROR_CODES.BAD_AGENT_TURNS,
            message: `agentTurns must be an integer 0..${AGENT_TURNS_MAX}`,
        };
    }
    return null;
}

// Empty is none, the same contract the store and the docs state: null is unmeasured,
// never an empty string. Bounded by codepoint, so the cap never splits a surrogate pair.
const summaryValue = (summary: unknown): string | null =>
    typeof summary === 'string' && summary.trim() ? [...summary.trim()].slice(0, SUMMARY_LIMIT).join('') : null;

export function validateCompleteFields(
    fields: Record<string, unknown>
): { ok: true; value: CompleteFields } | { ok: false; code: string; message: string } {
    const { status, exitCode, output, contextTokens, contextCostUsd, agentTurns, summary, failureKind } = fields;
    const refusal = measuredFieldRefusal(fields) ?? closingFieldRefusal(fields);
    if (refusal !== null) return { ok: false, ...refusal };
    return {
        ok: true,
        value: {
            status: status as JobOutcome,
            exitCode: (exitCode as number | undefined) ?? null,
            output: typeof output === 'string' ? output.slice(0, OUTPUT_LIMIT) : null,
            contextTokens: (contextTokens as number | undefined) ?? null,
            contextCostUsd: (contextCostUsd as number | undefined) ?? null,
            agentTurns: (agentTurns as number | undefined) ?? null,
            summary: summaryValue(summary),
            failureKind: (failureKind as FailureKind | undefined) ?? null,
        },
    };
}

export interface Publication {
    repo: string;
    prNumber: number;
    prUrl: string;
    headBranch: string;
    baseBranch: string;
}

/**
 * The publication a run reports beside a successful publish (036): optional and null, and
 * shape-validated rather than trusted — a forged report must not pin another org's repository
 * onto this thread. The cross-check against the leased job's OWN repo label is the store's,
 * inside the verdict's transaction.
 */
export function validatePublication(
    raw: unknown
): { ok: true; value: Publication | null } | { ok: false; message: string } {
    if (raw === null || raw === undefined) return { ok: true, value: null };
    if (typeof raw !== 'object') return { ok: false, message: 'publication must be an object or null' };
    const pub = raw as Record<string, unknown>;
    const { repo, prNumber, prUrl, headBranch, baseBranch } = pub;
    if (typeof repo !== 'string' || repoReason(repo) !== null) {
        return { ok: false, message: 'publication.repo must be an owner/name' };
    }
    if (!Number.isInteger(prNumber) || (prNumber as number) < 1) {
        return { ok: false, message: 'publication.prNumber must be a positive integer' };
    }
    if (typeof prUrl !== 'string' || prUrl.length > PR_URL_LIMIT || !PR_URL.test(prUrl)) {
        return { ok: false, message: 'publication.prUrl must be a github.com pull url' };
    }
    for (const [key, value] of [
        ['headBranch', headBranch],
        ['baseBranch', baseBranch],
    ] as const) {
        if (typeof value !== 'string' || value.length < 1 || value.length > BRANCH_LIMIT || /[^\w./-]/.test(value)) {
            return { ok: false, message: `publication.${key} must be a branch name (1..${BRANCH_LIMIT})` };
        }
    }
    return {
        ok: true,
        value: {
            repo,
            prNumber: prNumber as number,
            prUrl,
            headBranch: headBranch as string,
            baseBranch: baseBranch as string,
        },
    };
}

export type FollowUpRefusal = 'missing' | 'not_finished' | 'task_done' | 'no_session' | 'forbidden' | 'purging';

/** The refusal answers both wait-control verbs (issue #328) share; the ok paths differ per route. */
export type WaitControlRefusal = 'missing' | 'forbidden' | 'no_wait';

export function waitControlRefusal(reply: FastifyReply, reason: WaitControlRefusal) {
    switch (reason) {
        case 'missing':
            return notFoundJob(reply);
        case 'forbidden':
            return reply.code(HTTP_FORBIDDEN).send({
                error: 'Only the account that queued the task can control its wait',
                code: ERROR_CODES.FORBIDDEN,
            });
        case 'no_wait':
            return reply
                .code(HTTP_CONFLICT)
                .send({ error: 'The task has no open wait', code: ERROR_CODES.NO_OPEN_WAIT });
    }
}

export function followUpRefusal(reply: FastifyReply, reason: FollowUpRefusal) {
    switch (reason) {
        case 'missing':
            return notFoundJob(reply);
        case 'not_finished':
            return reply.code(HTTP_CONFLICT).send({ error: 'Task is not finished', code: ERROR_CODES.NOT_FINISHED });
        case 'task_done':
            return reply.code(HTTP_CONFLICT).send({ error: 'Task is done', code: ERROR_CODES.TASK_DONE });
        case 'no_session':
            return reply
                .code(HTTP_CONFLICT)
                .send({ error: 'The finished run has no agent session to continue', code: ERROR_CODES.NO_SESSION });
        case 'forbidden':
            return bad(
                reply,
                ERROR_CODES.FORBIDDEN,
                'Only the account that queued the task can follow it up',
                HTTP_FORBIDDEN
            );
        case 'purging':
            return reply.code(HTTP_CONFLICT).send({
                error: "The task's checkout is being deleted from disk",
                code: ERROR_CODES.PURGE_IN_PROGRESS,
            });
    }
}

export type RetryRefusal = 'missing' | 'not_finished' | 'task_done' | 'forbidden' | 'purging';

export function retryRefusal(reply: FastifyReply, reason: RetryRefusal) {
    switch (reason) {
        case 'missing':
            return notFoundJob(reply);
        case 'not_finished':
            return reply.code(HTTP_CONFLICT).send({ error: 'Task is not finished', code: ERROR_CODES.NOT_FINISHED });
        case 'task_done':
            return reply.code(HTTP_CONFLICT).send({ error: 'Task is done', code: ERROR_CODES.TASK_DONE });
        case 'forbidden':
            return bad(
                reply,
                ERROR_CODES.FORBIDDEN,
                'Only the account that queued the task can retry it',
                HTTP_FORBIDDEN
            );
        case 'purging':
            return reply.code(HTTP_CONFLICT).send({
                error: "The task's checkout is being deleted from disk",
                code: ERROR_CODES.PURGE_IN_PROGRESS,
            });
    }
}

export function validateListQuery(query: {
    status?: string;
    limit?: string;
    repo?: string;
}):
    | { ok: true; value: { status: JobStatus | 'terminal' | undefined; repo: string | undefined; limit: number } }
    | { ok: false; code: string; message: string } {
    // 'terminal' is the one pseudo-status: every settled verdict at once, so a completed-jobs
    // view can bound its request instead of filtering a newest-N window client-side and losing
    // finished runs behind a busy queue.
    if (query.status !== undefined && query.status !== 'terminal' && !STATUSES.includes(query.status as JobStatus)) {
        return {
            ok: false,
            code: ERROR_CODES.BAD_STATUS,
            message: `status must be one of ${STATUSES.join(', ')} or 'terminal'`,
        };
    }
    const limit = query.limit === undefined ? LIST_LIMIT_DEFAULT : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
        return { ok: false, code: ERROR_CODES.BAD_LIMIT, message: `limit must be an integer 1..${LIST_LIMIT_MAX}` };
    }
    const repo = query.repo;
    // Fastify's query parser hands repeated keys over as an array, so the shape is checked before
    // use — a malformed filter is a 400, never a TypeError.
    if (repo !== undefined && (typeof repo !== 'string' || repoReason(repo) !== null)) {
        const reason = typeof repo === 'string' ? repoReason(repo) : 'repo must be a string';
        return { ok: false, code: ERROR_CODES.BAD_REPO, message: reason ?? 'repo must be owner/name' };
    }
    return { ok: true, value: { status: query.status as JobStatus | 'terminal' | undefined, repo, limit } };
}

/**
 * The settle long-poll's query (issue #323): `waitFor` takes the one value `terminal`, and
 * `timeout` is whole seconds `1..${WAIT_TIMEOUT_MAX_S}` — smaller is refused, larger is clamped
 * to the server-side cap rather than refused, since the ask is "as long as you allow". Absent,
 * `timeout` waits the default. A value without `waitFor=terminal` is refused — there is no
 * second valid spelling of "don't wait" beside leaving the parameters off, and a typo must not
 * read as one. `null` on success means no wait was requested: the read answers as it always did.
 */
export function validateWaitQuery(query: {
    waitFor?: unknown;
    timeout?: unknown;
}): { ok: true; value: { timeoutMs: number } | null } | { ok: false; code: string; message: string } {
    const waitFor = query.waitFor;
    if (waitFor === undefined && query.timeout === undefined) return { ok: true, value: null };
    if (waitFor === undefined) {
        return { ok: false, code: ERROR_CODES.BAD_TIMEOUT, message: 'timeout requires waitFor=terminal' };
    }
    if (waitFor !== 'terminal') {
        return { ok: false, code: ERROR_CODES.BAD_WAIT_FOR, message: "waitFor must be 'terminal'" };
    }
    const timeout = query.timeout;
    if (timeout === undefined) {
        return { ok: true, value: { timeoutMs: WAIT_TIMEOUT_DEFAULT_S * MS_PER_SECOND } };
    }
    // One shape check, one refusal: not a string (a repeated key arrives as an array), not all
    // digits (fractional, signed, empty, space-prefixed), or the digit `0` — all the same
    // "not an integer 1..N" answer. A digit string past the cap clamps below, never NaNs.
    if (typeof timeout !== 'string' || !/^\d+$/.test(timeout) || Number(timeout) < 1) {
        return {
            ok: false,
            code: ERROR_CODES.BAD_TIMEOUT,
            message: `timeout must be an integer 1..${WAIT_TIMEOUT_MAX_S} (seconds)`,
        };
    }
    return { ok: true, value: { timeoutMs: Math.min(Number(timeout), WAIT_TIMEOUT_MAX_S) * MS_PER_SECOND } };
}
