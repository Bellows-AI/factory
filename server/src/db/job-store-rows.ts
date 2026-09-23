import type { Fragment, Sql, TransactionSql } from 'postgres';
import type { UserRef } from '@factory-ai/core';
import type { BellowsConfig } from '../workspace/bellows.js';
import { type TaskCursor, decodeCursor, encodeCursor } from './task-summary.js';
import type { GateReport, Job, JobStatus, RuntimeVitals } from './job-store-contract.js';
import type { TaskListFilters, TaskSummary } from './job-store-read-model.js';

/**
 * Row shapes, row-to-API mappers, and the task list's SQL-fragment builders — split out of
 * job-store-types.ts purely to keep every file under the repo's line-count ceiling, re-exported
 * from job-store.ts for every existing import site. `CreateJobStoreDeps`/`JobStorePrs` (the
 * factory's own dependency shape) live here too: they are read together with the row mappers by
 * `createJobStore`.
 */

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
    remote_session_id: string | null;
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

export const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

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

/** A stamp from either engine: a parsed Date from the row, an ISO string out of the json. */
export const stampOf = (value: Date | string | null): string | null =>
    value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

/** `<orgId>/<userId>` when workspaces are on and there is an author, the same rule everywhere a
 *  job row's checkout path is derived. */
export function workspacePathFor(orgId: string, hasWorkspaces: boolean, createdBy: string | null): string | null {
    return hasWorkspaces && createdBy ? `${orgId}/${createdBy}` : null;
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
 * listTasks's cursor: the route already refused one that does not decode under the handed
 * filters, so a store call that carries one anyway is a programming error, thrown rather than
 * answered with a page of a different question.
 */
export function resolveTaskCursor(filters: TaskListFilters): TaskCursor | null {
    if (filters.cursor === undefined) return null;
    const cursor = decodeCursor(filters.cursor, filters);
    if (cursor === null) throw new Error('invalid task cursor');
    return cursor;
}

export function taskStateWhere(sql: Sql, state: TaskListFilters['state']): Fragment {
    return {
        attention: sql`not (terminal and done_at is not null)`,
        running: sql`not terminal`,
        review: sql`terminal and done_at is null`,
        past: sql`terminal and done_at is not null`,
    }[state];
}

/** The keyset predicate: direction flips with the sort, never an OFFSET. */
export function taskCursorWhere(sql: Sql, cursor: TaskCursor | null, newest: boolean): Fragment {
    if (cursor === null) return sql``;
    return newest
        ? sql`and (activity_at, id) < (${cursor.activityAt}::timestamptz, ${cursor.rootId}::uuid)`
        : sql`and (activity_at, id) > (${cursor.activityAt}::timestamptz, ${cursor.rootId}::uuid)`;
}

export function taskQWhere(sql: Sql, q: string | undefined): Fragment {
    return q === undefined ? sql`` : sql`and strpos(lower(command), lower(${q})) > 0`;
}

export function taskRepoWhere(sql: Sql, repo: string | undefined): Fragment {
    return repo === undefined ? sql`` : sql`and repo = ${repo}`;
}

export function taskAuthorWhere(sql: Sql, author: string | undefined): Fragment {
    return author === undefined ? sql`` : sql`and lower(creator_login) = lower(${author})`;
}

/**
 * Fetch limit + 1: the extra row is the only honest nextCursor signal — a page filled exactly is
 * not — and the cursor is minted from the last row RETURNED.
 */
export function nextTaskCursor(filters: TaskListFilters, pageRowCount: number, items: TaskSummary[]): string | null {
    const last = items[items.length - 1];
    if (pageRowCount <= filters.limit || last === undefined) return null;
    return encodeCursor({
        sort: filters.sort,
        state: filters.state,
        q: filters.q,
        repo: filters.repo,
        author: filters.author,
        activityAt: last.activityAt,
        rootId: last.id,
    });
}

/**
 * `markDone`'s second half: if this done just made the whole thread terminal, queue its worktree
 * reclaim. The thread is one indexed read off the root column (022), and the ROOT row carries the
 * labels the reclaim is addressed by — the same fields removeThread queues. Terminal only: a
 * member still queued, parked or running keeps the tree (its verdict will reclaim); one member
 * done (this one, usually — the UI marks the head) is what makes the done a THREAD's done and not
 * one turn's.
 */
export async function queueReclaimIfThreadDone(
    tx: TransactionSql,
    orgId: string,
    hasWorkspaces: boolean,
    rootJobId: string
): Promise<void> {
    const [thread] = await tx<{ total: number; terminal: number }[]>`
        select count(*)::int as total,
               count(*) filter (where status in ('succeeded','failed','dead','stopped'))::int as terminal
        from job
        where org_id = ${orgId} and root_job_id = ${rootJobId}
    `;
    if (!thread || thread.total === 0 || thread.total !== thread.terminal) return;

    const [root] = await tx<{ repo: string | null; created_by: string | null }[]>`
        select repo, created_by from job
        where org_id = ${orgId} and id = ${rootJobId}
    `;
    const workspacePath = workspacePathFor(orgId, hasWorkspaces, root?.created_by ?? null);
    // Idempotent against a row already queued (an earlier done, or a concurrent one): one tree,
    // one reclaim. The claim-ack cycle removes the row; until then a duplicate insert would only
    // re-offer an already-removed tree, so the guard is tidiness, not correctness.
    await tx`
        insert into task_reclaim (org_id, root_job_id, repo, workspace_path)
        select ${orgId}, ${rootJobId}, ${root?.repo ?? null}, ${workspacePath}
        where not exists (
            select 1 from task_reclaim
            where org_id = ${orgId} and root_job_id = ${rootJobId}
        )
    `;
}

/**
 * The organization is bound at construction: it is a constant for the life of the process, and a
 * per-call parameter is one more thing a write path can forget.
 *
 * `hasWorkspaces` is bound the same way, and it decides whether a claim reports a `workspacePath`
 * at all. Without a configured workspace root no directory was ever created, so naming one would
 * hand the driver a path that does not exist — and `docker run -w` silently CREATES a missing
 * workdir, so the runner would start in an empty directory rather than failing the job. That is
 * exactly the case the driver's null check exists to catch, and it only reaches it if the board is
 * honest here.
 */
export interface CreateJobStoreDeps {
    sql: Sql;
    hasWorkspaces?: boolean;
    orgId: string;
    ready?: Promise<unknown>;
    /**
     * The env-var store's resolver, when the deployment stores runner environment. Present in
     * main.ts, absent in the tests that predate it — a claim then simply carries no `env`. The
     * second parameter is the executor the resolver MUST run on: the claim's own transaction, so
     * a claim holds one connection rather than two (a resolver on the pool would let enough
     * concurrent claims wedge the pool against itself).
     */
    env?: {
        resolveFor(
            target: { userId: string | null; repo: string | null },
            exec: Sql | TransactionSql
        ): Promise<Record<string, string>>;
    };
    /**
     * The GitHub App's installation-token provider, laid under the resolved env as the base layer
     * (`withMintedToken`). Present in main.ts under the App — which is every env-booted process —
     * and absent in the offline tooling and the tests that predate it: a board that cannot fetch
     * mints nothing. Declared inline, like
     * `env`, because `db/` must not import from `github/`. Each claim mints FRESH rather than
     * reading the provider's cache, because the credential has to outlive the claim: a runner's
     * env is written once and a run is capped at two hours, so a cached token's remaining
     * five minutes would die mid-run. A mint failure throws, and the same rollback that guards
     * the resolver leaves the job queued with its attempt unburned.
     */
    githubToken?: {
        fresh(): Promise<string>;
    };
    /**
     * The gates reader, when the deployment has a workspace root to read checkouts from. Declared
     * inline like `env`, because `db/` imports nothing from `workspace/` at runtime — a claim
     * hands it the workspace path, the repo label and the thread's root id (the worktree the run
     * edits), and gets the parsed `.bellows.yaml` or the reason the file could not be honoured.
     * Present in main.ts, absent in the tests that predate gates — a claim then simply carries
     * none.
     */
    gates?: {
        readFor(
            workspacePath: string,
            repo: string,
            worktreeId: string | null
        ): Promise<{ config: BellowsConfig | null; error: string | null }>;
    };
    /**
     * The member executor store's claim-time reader. Declared inline like `env`, because `db/`
     * must not import from `db/user-executor-store.ts`'s surface — the claim needs exactly one
     * question answered: the row the task's executor LABEL names. Its type selects the task's
     * runner and its config travels under that runner's config env name. A reader failure throws,
     * and the same rollback that guards the env resolver leaves the job queued with its attempt
     * unburned.
     */
    executorConfig?: {
        configFor(
            userId: string,
            name: string,
            exec: Sql | TransactionSql
        ): Promise<{ type: string; config: Record<string, unknown> } | null>;
    };
    /**
     * The PR lifecycle store, when the deployment records publications and PR waits (036).
     * Declared inline like `env`, because only the completion surface (the publication upsert),
     * the stop/remove sweep (wait cancellation) and the read model (the thread's wait) touch it —
     * the rest of the job store has no opinion of it. Present in main.ts under `withStores`,
     * absent in the tests that predate it: a verdict then simply records no publication.
     */
    prs?: JobStorePrs;
}

/** The PR lifecycle store's claim-time surface — named once so a helper can take it explicitly. */
export interface JobStorePrs {
    recordPublication(
        input: {
            root: string;
            repo: string;
            prNumber: number;
            prUrl: string;
            headBranch: string;
            baseBranch: string;
        },
        exec?: Sql | TransactionSql
    ): Promise<void>;
    cancelWaitsForRoot(root: string, terminalReason?: string, exec?: Sql | TransactionSql): Promise<number>;
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
        remoteSessionId: row.remote_session_id,
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
