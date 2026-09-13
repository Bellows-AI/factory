-- The thread's root, stored on every row.
--
-- 015 linked follow-ups through parent_job_id alone, and every composite read — the claim's
-- thread-exclusion, thread(), the verdict's terminality, removeThread — re-walked up to the root
-- and back down on each call. The walk is correct but it is reconstruction: the UI's /api/jobs
-- list carries only the immediate parent, so the client re-climbs the chain inside its capped
-- window and a root that falls out of the window strands its newer turns, which then cannot be
-- resolved to a task at all. root_job_id is the same fact every row already implies, written once
-- at insert (the root's own id, or the parent's root) and read everywhere: the composite is
-- served, never re-derived. Like parent_job_id, no foreign key — it names an older audit row, and
-- nothing joins through it at claim time; the claim copies its own row's value.
--
-- This file IS the backfill: for a database that already ran 015 the recursive update writes the
-- walk's answer onto every existing row before the not-null lands, and for a fresh database the
-- update is a no-op over rows the insert paths stamp themselves. The index is new because the
-- queries it serves are new — every composite read now keys by (org_id, root_job_id), where the
-- walks they replace keyed by the primary key.
alter table job add column if not exists root_job_id uuid;

with recursive up as (
    select org_id, id, id as root_id from job where parent_job_id is null
    union all
    select j.org_id, j.id, up.root_id
    from job j join up on j.org_id = up.org_id and j.parent_job_id = up.id
)
update job set root_job_id = up.root_id
from up
where job.org_id = up.org_id and job.id = up.id;

alter table job alter column root_job_id set not null;

create index if not exists job_org_root
    on job (org_id, root_job_id);
