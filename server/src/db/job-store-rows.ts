/**
 * Row shapes and the row-to-API mappers, plus the small SQL helpers every other job-store file
 * shares: the author join/columns and wall-tick fragments `createJobStore` precompiles, the
 * `exists` probe, the running-member check and the workspace-path rule.
 */

import type { UserRef } from '@factory-ai/core';
import type { Sql, Fragment } from 'postgres';
import type { JobStatus, GateReport, RuntimeVitals, Job, TaskSummary, JobStoreContext } from './job-store-types.js';

export interface JobRow {
    id: string;
    command: string;
    status: JobStatus;
    attempts: number;
    max_attempts: number;
    claimed_by: string | null;
    created_by: string | null;
    /** The authorship joins (see authorJoin): app_user labels for created_by/stopped_by/done_by. */
    creator_id: string | null;
    creator_login: string | null;
    creator_name: string | null;
    creator_avatar_url: string | null;
    stopper_id: string | null;
    stopper_login: string | null;
    stopper_name: string | null;
    stopper_avatar_url: string | null;
    doner_id: string | null;
    doner_login: string | null;
    doner_name: string | null;
    doner_avatar_url: string | null;
    stopped_by: string | null;
    done_by: string | null;
    session_id: string | null;
    exit_code: number | null;
    output?: string | null;
    /** Absent from reads before 028 filled it; null is unmeasured, never empty. */
    summary?: string | null;
    /** Absent from the list() select — a list view shows no checks, and bounded is not free. */
    gates?: GateReport[] | null;
    /**
     * On list() rows: the vitals object is a few hundred bytes, and the task tree and the tab
     * strip render `runtime.activity` as the task's live summary — the tabs' "what is it doing"
     * answer. Unlike `output`, whose unbounded tail would tank every poll for a line no list view
     * draws.
     */
    runtime?: RuntimeVitals | null;
    repo: string | null;
    executor: string | null;
    parent_job_id: string | null;
    root_job_id: string;
    /** The row's graph position (027); null on workflow-less rows and user follow-ups. */
    workflow_node: string | null;
    /** The thread's frozen workflow name (033); null on workflow-less rows. */
    workflow_name: string | null;
    done_at: Date | null;
    cancel_requested_at: Date | null;
    command_delivered_at: Date | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
    /** Selected by every read (the list and detail serve it); bigint reads back as a string. */
    wall_clock_ms?: string | null;
    /** Only thread() and the grouped terminal list select it; bigint (and the sum over it) read
     * back as a string. */
    task_wall_clock_ms?: string | null;
    /** Only thread() joins the wait lateral; absent everywhere else. */
    wait_reason?: string | null;
    waiting_since?: Date | null;
    wait_terminal_reason?: string | null;
}

/**
 * One row of the task summary read — the `task` CTE's projection. Page rows arrive as parsed
 * postgres rows (timestamps as Date); the navigation previews arrive inside json, where the same
 * columns read back as strings — every stamp is accepted in either shape.
 */
export interface TaskRow {
    id: string;
    command: string;
    repo: string | null;
    executor: string | null;
    created_at: Date | string;
    status: JobStatus;
    done_at: Date | string | null;
    cancel_requested_at: Date | string | null;
    summary: string | null;
    runtime: RuntimeVitals | null;
    activity_at: Date | string;
    creator_id: string | null;
    creator_login: string | null;
    creator_name: string | null;
    creator_avatar_url: string | null;
    wait_reason: string | null;
    waiting_since: Date | string | null;
    wait_terminal_reason: string | null;
}

export const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** A stamp from either engine: a parsed Date from the row, an ISO string out of the json. */
export const stampOf = (value: Date | string | null): string | null =>
    value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

// A left join answers null columns when the uuid matched nothing; a matched row always has its
// login (not null in app_user), so id+login is the honest presence test.
export function userRef(
    id: string | null,
    login: string | null,
    name: string | null,
    avatarUrl: string | null
): UserRef | null {
    return id === null || login === null ? null : { id, login, name, avatarUrl };
}

/** `<orgId>/<userId>` when workspaces are on and there is an author, the same rule everywhere a
 *  job row's checkout path is derived. */
export function workspacePathFor(orgId: string, hasWorkspaces: boolean, createdBy: string | null): string | null {
    return hasWorkspaces && createdBy ? `${orgId}/${createdBy}` : null;
}

/**
 * The key-wise patch one vitals report applies to the stored `runtime` jsonb. Null numbers are
 * "not read this round" — left OUT, so the last good sample stays (the missed-sample rule, now
 * per part) — and a missing `services` key means the fleet half did not change and stays too.
 * `activity`, `sampledAt` and `memPercent` are always written: null is legitimate data for each.
 */
export function runtimePatch(runtime: RuntimeVitals): Record<string, unknown> {
    return {
        ...(runtime.cpuPercent !== null ? { cpuPercent: runtime.cpuPercent } : {}),
        ...(runtime.memUsedMb !== null ? { memUsedMb: runtime.memUsedMb } : {}),
        memPercent: runtime.memPercent,
        activity: runtime.activity,
        sampledAt: runtime.sampledAt,
        ...(runtime.services ? { services: runtime.services } : {}),
    };
}

export function toJob(orgId: string, hasWorkspaces: boolean, row: JobRow): Job {
    return {
        id: row.id,
        command: row.command,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        claimedBy: row.claimed_by,
        createdBy: row.created_by,
        author: userRef(row.creator_id, row.creator_login, row.creator_name, row.creator_avatar_url),
        stoppedBy: userRef(row.stopper_id, row.stopper_login, row.stopper_name, row.stopper_avatar_url),
        doneBy: userRef(row.doner_id, row.doner_login, row.doner_name, row.doner_avatar_url),
        sessionId: row.session_id,
        exitCode: row.exit_code,
        output: row.output ?? null,
        summary: row.summary ?? null,
        gates: row.gates ?? null,
        runtime: row.runtime ?? null,
        repo: row.repo,
        executor: row.executor,
        followUpTo: row.parent_job_id,
        rootJobId: row.root_job_id,
        workflowNode: row.workflow_node ?? null,
        workflowName: row.workflow_name ?? null,
        doneAt: iso(row.done_at),
        cancelRequestedAt: iso(row.cancel_requested_at),
        // The claim builds the same path only for jobs it hands out; every read carries it too,
        // which is what the task view's status sidebar shows.
        workspacePath: workspacePathFor(orgId, hasWorkspaces, row.created_by),
        createdAt: row.created_at.toISOString(),
        startedAt: iso(row.started_at),
        finishedAt: iso(row.finished_at),
        wallClockMs: row.wall_clock_ms == null ? null : Number(row.wall_clock_ms),
        taskWallClockMs: row.task_wall_clock_ms == null ? null : Number(row.task_wall_clock_ms),
        waitReason: row.wait_reason ?? null,
        waitingSince: row.waiting_since ? row.waiting_since.toISOString() : null,
        waitTerminalReason: row.wait_terminal_reason ?? null,
    };
}

// The task summary mapper. Deliberately NOT toJob with synthetic fields: a summary is a different
// shape with a different contract — bounded fields only, run detail (output, gates, the runtime
// object, session ids) left behind, and the head's activity line carried alone.
export function toTask(row: TaskRow): TaskSummary {
    return {
        id: row.id,
        command: row.command,
        status: row.status,
        cancelRequestedAt: stampOf(row.cancel_requested_at),
        doneAt: stampOf(row.done_at),
        repo: row.repo,
        executor: row.executor,
        author: userRef(row.creator_id, row.creator_login, row.creator_name, row.creator_avatar_url),
        activity: row.runtime?.activity ?? null,
        summary: row.summary,
        waitReason: row.wait_reason,
        waitingSince: stampOf(row.waiting_since),
        waitTerminalReason: row.wait_terminal_reason,
        // Both are NOT NULL in the schema — created_at by the column, activity_at through
        // greatest() with created_at in it.
        createdAt: stampOf(row.created_at)!,
        activityAt: stampOf(row.activity_at)!,
    };
}

export const toJobRow = (ctx: JobStoreContext, row: JobRow): Job => toJob(ctx.orgId, ctx.hasWorkspaces, row);

/** Separates "no such job" from "the lease is not yours" once a guarded update matched nothing. */
export async function exists(sql: Sql, orgId: string, id: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`select id from job where org_id = ${orgId} and id = ${id}`;
    return rows.length > 0;
}

/**
 * removeThread's one refusal: a member is running. The user stops it first — the per-task
 * worktree is a live runner's checkout, and tearing it out under the container would corrupt a
 * run that was happily going.
 */
export function hasRunningMember(members: { status: JobStatus }[]): boolean {
    return members.some((member) => member.status === 'running');
}

/**
 * The wall-clock banking, shared by every settle point that ends (or supersedes) an executed
 * segment: add the segment `started_at → now()` to what the row has banked. Used inside
 * transactions, like the claim's sameThreadRunning fragment. The SET expression reads the
 * PRE-update row, so it composes beside `started_at = now()` in the claim — the superseded
 * segment is banked in the same statement that resets the stamp, which is the only moment it
 * can be. `greatest` ignores nulls, so a row that never started measures zero, and a clock never
 * runs backwards.
 */
export function wallTickFragment(sql: Sql): Fragment {
    return sql`coalesce(wall_clock_ms, 0) + greatest(0, (extract(epoch from (now() - started_at)) * 1000)::bigint)`;
}

// The authorship joins, shared by get/thread/list: created_by, stopped_by and done_by resolve to
// app_user labels at read time, never denormalised onto the job row (logins and display names go
// stale; the join does not). Left joins on nullable uuids — a pre-accounts row or an unstamped
// action joins to nothing and reads as null, never a synthetic author. `job.` is qualified on the
// columns app_user also has (id, created_at); every other selected column exists only on job.
export function authorJoinFragment(sql: Sql): Fragment {
    return sql`
        left join app_user cu on cu.id = job.created_by
        left join app_user su on su.id = job.stopped_by
        left join app_user du on du.id = job.done_by
    `;
}

export function authorColumnsFragment(sql: Sql): Fragment {
    return sql`
        , cu.id as creator_id, cu.github_login as creator_login, cu.display_name as creator_name
        , cu.avatar_url as creator_avatar_url
        , su.id as stopper_id, su.github_login as stopper_login, su.display_name as stopper_name
        , su.avatar_url as stopper_avatar_url
        , du.id as doner_id, du.github_login as doner_login, du.display_name as doner_name
        , du.avatar_url as doner_avatar_url
    `;
}

// The task summary's columns once the `task` CTE has named them — selected again inside every
// navigation-preview and page subquery, which read the derived set rather than the tables.
export function taskPreviewColumnsFragment(sql: Sql): Fragment {
    return sql`
        id, command, repo, executor, created_at, status, done_at, cancel_requested_at,
        summary, runtime, activity_at, creator_id, creator_login, creator_name, creator_avatar_url,
        wait_reason, waiting_since, wait_terminal_reason
    `;
}
