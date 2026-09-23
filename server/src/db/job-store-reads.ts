/**
 * The read side the dashboard polls: one job, one thread, the job list, and the task list with its
 * filter fragments and keyset cursor.
 */

import type { Sql, Fragment } from 'postgres';
import { type JobRow, toJobRow, type TaskRow, toTask } from './job-store-rows.js';
import type { JobStoreContext, Job, JobStore, TaskListFilters, TaskSummary } from './job-store-types.js';
import { type TaskCursor, decodeCursor, encodeCursor } from './task-summary.js';

export async function threadOf(ctx: JobStoreContext, id: string): Promise<Job[] | null> {
    const { sql, orgId, authorJoin, authorColumns } = ctx;
    // The named row's root_job_id is the whole resolution (022): every member of the
    // conversation carries the same value, so the chain is one indexed read, oldest
    // first. If two adjustments ever landed on one parent, both come back in creation
    // order — the conversation still reads top to bottom. An absent id resolves nothing
    // and the read answers null.
    const rows = await sql<JobRow[]>`
        select job.id, command, status, attempts, max_attempts, claimed_by, created_by,
               session_id, exit_code, output, gates, runtime, repo, executor,
               parent_job_id, root_job_id, workflow_node, workflow_name, done_at, cancel_requested_at, job.created_at, started_at, finished_at,
               -- The task's overall wall clock, summed over the thread the WHERE already
               -- scoped: every member carries the total, so the view reads it off any of
               -- them. A sum over all-null banks is null — nothing measurable, never zero.
               sum(wall_clock_ms) over () as task_wall_clock_ms,
               wall_clock_ms, summary,
               wl.wait_reason, wl.waiting_since, wl.wait_terminal_reason
               ${authorColumns}
        from job ${authorJoin}
        -- The thread's wait (036), carried on every member alike — the open wait first, else
        -- the most recently active terminal one, the same rule listTasksOf() applies.
        left join lateral (
            select w.reason as wait_reason, w.active_at as waiting_since,
                   w.terminal_reason as wait_terminal_reason
            from workflow_wait w
            where w.org_id = ${orgId} and w.root_job_id = job.root_job_id
            order by (w.completed_at is null and w.cancelled_at is null) desc, w.active_at desc
            limit 1
        ) wl on true
        where org_id = ${orgId}
          and root_job_id = (select root_job_id from job where org_id = ${orgId} and id = ${id})
        order by job.created_at, job.id
    `;
    const [first] = rows;
    return first ? rows.map((row) => toJobRow(ctx, row)) : null;
}

export async function getJob(ctx: JobStoreContext, id: string): Promise<Job | null> {
    const { sql, orgId, authorJoin, authorColumns } = ctx;
    const rows = await sql<JobRow[]>`
        select job.id, command, status, attempts, max_attempts, claimed_by, created_by,
               session_id, exit_code, output, gates, runtime, repo, executor,
               parent_job_id, root_job_id, workflow_node, workflow_name, done_at, cancel_requested_at, job.created_at, started_at, finished_at,
               summary, wall_clock_ms
               ${authorColumns}
        from job ${authorJoin}
        where org_id = ${orgId} and job.id = ${id}
    `;
    const row = rows[0];
    return row ? toJobRow(ctx, row) : null;
}

export type ListFilter = Parameters<JobStore['list']>[0];

export async function listJobs(ctx: JobStoreContext, filter: ListFilter): Promise<Job[]> {
    const { sql, orgId, authorColumns, authorJoin } = ctx;
    const { status, repo, limit } = filter;
    // The recently-completed view asks for TASKS, not runs (#124): the terminal set folds
    // into one row per thread. Identity (id, command, author, created) comes from the
    // root; the present tense (status, summary, runtime, session, started) from the HEAD
    // — the newest member, the same resolution `chainHead` renders in the sidenav; the
    // clock and the completion stamp are the thread's sum and max; the done comes from
    // whichever member carries it (one done is the thread's). A thread with a member
    // still queued or running is not completed and is excluded whole — which
    // also makes the sum exact, because nothing in it is still banking.
    if (status === 'terminal') {
        const rows = await sql<JobRow[]>`
            with finished_thread as (
                -- The rollup rides the terminality scan: one read of the org's history
                -- answers both the settled-verdict filter and the per-thread clock and
                -- completion stamps. The order+limit below therefore binds to AGGREGATE
                -- rows, and the per-thread head and actor resolution afterwards runs for
                -- the selected tasks alone — not once per thread the retention keeps.
                select root_job_id,
                       sum(wall_clock_ms) as task_wall_clock_ms,
                       max(done_at) as done_at,
                       max(finished_at) as finished_at
                from job
                where org_id = ${orgId}
                group by root_job_id
                having count(*) filter (
                    where status not in ('succeeded', 'failed', 'dead', 'stopped')
                ) = 0
            ),
            picked as (
                select finished_thread.root_job_id as root_job_id,
                       finished_thread.task_wall_clock_ms as task_wall_clock_ms,
                       finished_thread.done_at as done_at,
                       finished_thread.finished_at as finished_at
                from finished_thread
                join job on job.org_id = ${orgId} and job.id = finished_thread.root_job_id
                ${repo ? sql`where job.repo = ${repo}` : sql``}
                order by finished_thread.finished_at desc, job.created_at desc, job.id
                limit ${limit}
            )
            select job.id as id, job.command as command, head.status as status,
                   head.attempts as attempts, head.max_attempts as max_attempts,
                   head.claimed_by as claimed_by, job.created_by as created_by,
                   head.session_id as session_id,
                   head.exit_code as exit_code, head.summary as summary, head.runtime as runtime,
                   head.wall_clock_ms as wall_clock_ms,
                   job.repo as repo, job.executor as executor,
                   job.parent_job_id as parent_job_id, job.root_job_id as root_job_id,
                   job.workflow_node as workflow_node, job.workflow_name as workflow_name,
                   picked.done_at as done_at, head.cancel_requested_at as cancel_requested_at,
                   job.created_at as created_at, head.started_at as started_at,
                   picked.finished_at as finished_at,
                   picked.task_wall_clock_ms as task_wall_clock_ms
                   ${authorColumns}
            from picked
            join job on job.org_id = ${orgId} and job.id = picked.root_job_id
            join lateral (
                select h.*
                from job h
                where h.org_id = ${orgId} and h.root_job_id = job.root_job_id
                order by h.created_at desc, h.id desc
                limit 1
            ) head on true
            -- The authorship joins, aimed per member: the author is the thread's (the
            -- root's — a follow-up's creator is forced to the parent's), the stopper the
            -- head's (the status is the head's verdict), the doner the member carrying
            -- the thread's done. The shared authorJoin cannot be reused here: it binds
            -- su/du to the row's own stopped_by/done_by, which in this query is the
            -- root's.
            left join app_user cu on cu.id = job.created_by
            left join app_user su on su.id = head.stopped_by
            left join app_user du on du.id = (
                select d.done_by from job d
                where d.org_id = ${orgId} and d.root_job_id = job.root_job_id
                  and d.done_by is not null
                order by d.done_at desc, d.id desc
                limit 1
            )
            order by picked.finished_at desc, job.created_at desc, job.id
        `;
        return rows.map((row) => toJobRow(ctx, row));
    }
    const rows = await sql<JobRow[]>`
        select job.id, command, status, attempts, max_attempts, claimed_by, created_by,
               session_id, exit_code, runtime, repo, executor,
               parent_job_id, root_job_id, workflow_name, done_at, cancel_requested_at, job.created_at, started_at, finished_at,
               -- The close-time summary and the run's own banked clock ride beside the
               -- vitals, both bounded where output is not (#109).
               summary, wall_clock_ms
               ${authorColumns}
        from job ${authorJoin}
        where org_id = ${orgId} ${
            // The terminal set is the branch above; this query is the per-run lists.
            status ? sql`and status = ${status}` : sql``
        }
          ${repo ? sql`and repo = ${repo}` : sql``}
        order by job.created_at desc, job.id
        limit ${limit}
    `;
    return rows.map((row) => toJobRow(ctx, row));
}

export async function listTasksOf(ctx: JobStoreContext, filters: TaskListFilters): ReturnType<JobStore['listTasks']> {
    const { sql, taskPreviewColumns, orgId } = ctx;
    const cursor = resolveTaskCursor(filters);
    const newest = filters.sort === 'newest';

    // One statement, one derived set. `head` resolves each thread's newest run exactly as
    // the sidenav's chainHead does (created desc, id desc); `task` keeps one row per ROOT
    // — the root row for identity and authorship, the head for the present tense — and
    // computes the bucket and the activity stamp once, so the state filter, the counts
    // and the previews cannot disagree. Navigation reads the set UNFILTERED (org-wide,
    // rule of the read model); the page reads it under every filter, paginated by keyset
    // on (activity_at, id) — direction flips with the sort, never an OFFSET.
    const stateWhere = taskStateWhere(sql, filters.state);
    const pageOrder = newest ? sql`activity_at desc, id desc` : sql`activity_at asc, id asc`;
    const cursorWhere = taskCursorWhere(sql, cursor, newest);

    const [row] = await sql<
        {
            counts: { running: number; review: number; past: number };
            running_preview: TaskRow[] | null;
            review_preview: TaskRow[] | null;
            page: TaskRow[] | null;
        }[]
    >`
        with head as (
            select distinct on (root_job_id)
                   root_job_id, id, status, done_at, cancel_requested_at,
                   created_at, started_at, finished_at, summary, runtime
            from job
            where org_id = ${orgId}
            order by root_job_id, created_at desc, id desc
        ),
        task as (
            -- The root row joins back by PK from the head's root id (one index lookup per
            -- thread) rather than scanning the org's runs and filtering id = root_job_id —
            -- the EXPLAIN-measured difference between touching every run and touching one
            -- row per thread.
            select h.root_job_id as id, r.command, r.repo, r.executor, r.created_at,
                   h.status, h.done_at, h.cancel_requested_at, h.summary, h.runtime,
                   -- The sort key is truncated to milliseconds, the precision an ISO
                   -- stamp and a JS Date carry: the cursor's value round-trips EXACTLY,
                   -- so the exclusive keyset predicate cannot re-admit a row that only
                   -- differs from the boundary below the millisecond.
                   date_trunc('milliseconds',
                              greatest(h.created_at, h.started_at, h.finished_at, h.done_at)) as activity_at,
                   -- An open wait (a wait row with no terminal reason yet) is terminal for
                   -- bucketing the same way a settled status is: a thread parked on a human's
                   -- review is never "running", whatever status the row itself carries while
                   -- parked on it (206). A wait that has gone terminal carries no extra weight
                   -- here — the status/done rule alone decides, same as a thread that never waited.
                   (h.status in ('succeeded', 'failed', 'dead', 'stopped')
                       or (wl.wait_reason is not null and wl.wait_terminal_reason is null)) as terminal,
                   cu.id as creator_id, cu.github_login as creator_login,
                   cu.display_name as creator_name, cu.avatar_url as creator_avatar_url,
                   wl.wait_reason, wl.waiting_since, wl.wait_terminal_reason
            from head h
            join job r on r.org_id = ${orgId} and r.id = h.root_job_id
            left join app_user cu on cu.id = r.created_by
            -- The thread's wait, when it has one (036): the OPEN wait first, else the most
            -- recently active terminal one — one row, so a waiting thread reads waiting and
            -- a finished wait reads what exhausted it.
            left join lateral (
                select w.reason as wait_reason, w.active_at as waiting_since,
                       w.terminal_reason as wait_terminal_reason
                from workflow_wait w
                where w.org_id = ${orgId} and w.root_job_id = h.root_job_id
                order by (w.completed_at is null and w.cancelled_at is null) desc, w.active_at desc
                limit 1
            ) wl on true
        )
        select
            (
                select json_build_object(
                           'running', count(*) filter (where not terminal),
                           'review', count(*) filter (where terminal and done_at is null),
                           'past', count(*) filter (where terminal and done_at is not null)
                       )
                from task
            ) as counts,
            (
                select coalesce(json_agg(p), '[]'::json)
                from (select ${taskPreviewColumns} from task
                      where not terminal
                      order by activity_at desc, id desc limit 3) p
            ) as running_preview,
            (
                select coalesce(json_agg(p), '[]'::json)
                from (select ${taskPreviewColumns} from task
                      where terminal and done_at is null
                      order by activity_at desc, id desc limit 5) p
            ) as review_preview,
            (
                select coalesce(json_agg(p), '[]'::json)
                from (select ${taskPreviewColumns} from task
                      where ${stateWhere}
                        ${taskQWhere(sql, filters.q)}
                        ${taskRepoWhere(sql, filters.repo)}
                        ${taskAuthorWhere(sql, filters.author)}
                        ${cursorWhere}
                      order by ${pageOrder}
                      limit ${filters.limit + 1}) p
            ) as page
    `;

    // Fetch limit + 1: the extra row is the only honest nextCursor signal — a page filled
    // exactly is not — and the cursor is minted from the last row RETURNED.
    const pageRows = (row?.page ?? []).map(toTask);
    const items = pageRows.slice(0, filters.limit);
    return {
        navigation: {
            counts: row?.counts ?? { running: 0, review: 0, past: 0 },
            running: (row?.running_preview ?? []).map(toTask),
            review: (row?.review_preview ?? []).map(toTask),
        },
        page: {
            items,
            nextCursor: nextTaskCursor(filters, pageRows.length, items),
        },
    };
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
