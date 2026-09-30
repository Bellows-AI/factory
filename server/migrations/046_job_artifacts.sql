-- Run artifacts (issue #325): the full-run log and the agent transcript of one attempt, uploaded
-- by the driver at close and served by GET /api/jobs/:id/log and GET /api/jobs/:id/transcript.
--
-- One row per (job, kind, attempt): the driver uploads the full runner output (tail-kept, capped
-- at 512 KiB) and the per-run transcript delta for every attempt that ran, while its lease is
-- still live. The upsert is idempotent — a retried upload overwrites its own row, never
-- duplicates it.
--
-- Retention is the job row's lifetime: `on delete cascade` from job, so Remove deletes the
-- thread's artifacts with it, exactly as `output` and `gates` die with the row. No TTL sweeper —
-- the same rule every per-job payload on this board follows.
--
-- `content` is text, not bytea: both artifacts are UTF-8 text by construction (runner stdio and
-- JSONL exports), and the read routes page over characters. `truncated` marks a cap cut; the
-- bytes beyond it were dropped by the driver, not by this table.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists job_artifact (
    org_id text not null,
    job_id uuid not null,
    kind text not null check (kind in ('log', 'transcript')),
    attempt integer not null,
    content text not null,
    truncated boolean not null default false,
    created_at timestamptz not null default now(),
    primary key (org_id, job_id, kind, attempt),
    foreign key (org_id, job_id) references job (org_id, id) on delete cascade
);
