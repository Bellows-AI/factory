-- The workflow's NAME, frozen on the job at create (issue #175).
--
-- job.workflow_id names the definition a thread walked, but the id is opaque on every read that
-- is not a workflow join, and the workflow row is deletable by design (027: job is an audit
-- record, no foreign key) — so a deleted definition took its human name with it. workflow_name
-- is the same freeze-at-create rule the snapshot and the params (030) follow: the RESOLVED
-- record's name is stamped on the root row at insert, every successor and user follow-up inherits
-- it, and a later rename or delete of the source workflow changes later tasks, never this one.
--
-- NO FK, NO READ-TIME JOIN, same as workflow_id: the column is written from the trusted resolution
-- in routes/jobs.ts (the record the store resolved — never a body field, the created_by trust
-- pattern) and read straight off the row. The check restates the workflow name boundary
-- (workflow_name_ck, 027) at the job row. The backfill is best-effort: names recover only from
-- workflow rows that still exist, propagating the root's recovered name down the thread via
-- root_job_id (022), and rows whose definition is already gone stay null.
--
-- This file must contain NO `create extension` and NO `create_hypertable`, per 005's header.

alter table job add column if not exists workflow_name text;

-- Best-effort recovery, pass one: every row still pointing at a living workflow row (roots via
-- create, graph successors via the transition insert — both carry workflow_id).
update job
set workflow_name = w.name
from workflow w
where w.org_id = job.org_id
  and w.id = job.workflow_id;

-- Pass two: user follow-ups carry no workflow_id (createFollowUp never did), so they take the
-- thread root's recovered name through root_job_id. Runs before any constraint lands.
update job child
set workflow_name = root.workflow_name
from job root
where root.org_id = child.org_id
  and child.root_job_id = root.id
  and child.id <> root.id
  and root.workflow_name is not null
  and child.workflow_name is null;

-- The row-level restatement of the 1..100 name boundary the workflow table already enforces
-- (workflow_name_ck, 027); backfilled values passed it at the source, so nothing violates.
alter table job add constraint job_workflow_name_ck check (
    workflow_name is null or (workflow_name <> '' and char_length(workflow_name) <= 100)
);
