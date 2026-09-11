-- Stop and Remove for the job board.
--
-- cancel_requested_at marks a ROW whose worker has been told to stop: the user's POST /stop hit a
-- running job, and the driver parks it on the next heartbeat it reads the flag in. The standalone
-- flag (rather than a status value) is deliberate: parking is done by the existing suspend path,
-- which the flag defers to — status stays 'running' until the worker actually parks, so the claim
-- and heartbeat machinery is untouched. A null value forever after suspend() and complete() clear
-- it (parking and finishing ARE the stop happening, and a resumed standby job must not drown in a
-- stale request). Null on every job that predates this migration and on every job nobody has ever
-- asked to stop.
alter table job add column if not exists cancel_requested_at timestamptz;

-- task_reclaim is the durable queue for worktree reclaims issued by POST /remove, and it exists
-- because of WHO is missing when a task is removed: a queue flows post-run, through the live
-- driver holding a lease, but a removed thread is queued, parked or terminal — nothing is running
-- it, so no live driver will ever notice. The row is the driver's work order: it polls the queue,
-- removes the worktree named by root_job_id, and only then acks the row. Lease via claimed_by /
-- claimed_at, so two drivers never reclaim one tree; an un-acked claim expires and the row is
-- retried. Not a foreign key to job — the thread rows are DELETED, so there would be nothing to
-- point at.
--
-- workspace_path is the thread's relative checkout root (`<orgId>/<author>`), the same value the
-- claim derives and the driver mounts; repo is the label the worktree was checked out by. Garbage
-- in either means the reclaim falls back to keying purely on root_job_id, never a crash.
--
-- No index on root_job_id: the queue keys by (org_id, created_at), never by task.
create table if not exists task_reclaim (
    id             uuid primary key default gen_random_uuid(),
    org_id         text not null,
    root_job_id    uuid not null,
    repo           text,
    workspace_path text,
    created_at     timestamptz not null default now(),
    claimed_by     text,
    claimed_at     timestamptz
);
create index if not exists task_reclaim_org_created on task_reclaim (org_id, created_at);