-- Who acted on a task. Stop and done are a person's verdict (docs/auth.md), and until now the row
-- remembered neither verdict's actor: job.created_by records who started a task but not who ended
-- or closed it.
--
-- Columns, not a job_event table: the thread read answers "who" with the app_user joins it already
-- pays for the author, and every action here lands on a row that exists to be read. The coalesce
-- at the write site (job-store) makes a retried click answer the first actor — the idempotence rule
-- cancel_requested_at and done_at already follow. Stop is stamped at REQUEST time: a running row
-- settles later through suspend, and the person who asked is the actor, not the parking that
-- delivered the ask.
--
-- Nullable both ways: every task stopped or closed before this migration has no actor, and
-- inventing one would be a lie (the created_by rule from 010). on delete set null, never cascade —
-- removing somebody from the organization must not delete the record of what they did.
alter table job add column if not exists stopped_by uuid;
alter table job add column if not exists done_by uuid;

do $$ begin
    alter table job add constraint job_stopper_fk
        foreign key (stopped_by) references app_user (id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
    alter table job add constraint job_done_by_fk
        foreign key (done_by) references app_user (id) on delete set null;
exception when duplicate_object then null; end $$;

-- Remove deletes the whole thread in the same transaction that queues the reclaim, so a
-- removed_by on job would be written and immediately deleted — the action's only surviving
-- artifact is the task_reclaim row, so the actor rides it. It outlives the thread exactly as long
-- as the worktree reclaim is queued, which is the honest bound of what "who removed this" can mean
-- once nothing of the task remains. A durable removal audit is a job_event table, and waits for
-- the day something renders one.
alter table task_reclaim add column if not exists removed_by uuid;

do $$ begin
    alter table task_reclaim add constraint task_reclaim_remover_fk
        foreign key (removed_by) references app_user (id) on delete set null;
exception when duplicate_object then null; end $$;

-- No index on stopped_by / done_by: nothing queries "jobs stopped by X" — the reads join app_user
-- by primary key. job_org_creator exists because "what did I queue" is a planned read; these
-- columns have no reader of that shape.
