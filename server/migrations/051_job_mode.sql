-- A task's execution mode, stored durably on every job row (issue #543): 'objective' is an
-- ordinary claimable job with no workflow snapshot, node, successor or wait; 'workflow' walks a
-- named workflow's frozen graph. The root decides, and follow-ups, retries and workflow
-- successors inherit it.
--
-- BACKFILL: a thread whose root carries a workflow_snapshot was a workflow thread; everything
-- else becomes objective via the column default.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists mode text not null default 'objective';

update job set mode = 'workflow'
where exists (
    select 1 from job root where root.id = job.root_job_id and root.workflow_snapshot is not null
);

alter table job add constraint job_mode_ck check (mode in ('objective', 'workflow'));
-- A workflow node only ever exists on a workflow-mode row.
alter table job add constraint job_mode_node_ck check (mode = 'workflow' or workflow_node is null);
