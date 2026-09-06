-- The repository and executor a job was queued with, for the tasks chat.
--
-- Both are nullable grouping metadata: jobs queued before the chat existed have neither and belong
-- in the unfiltered view, and neither is validated against the member's `user_repo` or
-- `user_executor` rows — `job` is an audit record (the `created_by` precedent) while those rows are
-- member state that comes and goes with a PUT. Nothing consumes them at claim time either: the
-- claim is unchanged, and wiring an executor into the driver remains future work. See docs/jobs.md.
--
-- The index serves the chat's per-repository thread, which reads one repository's jobs newest
-- first; unfiltered listing already scans by created_at.
alter table job add column if not exists repo text;
alter table job add column if not exists executor text;

create index if not exists job_repo_created
    on job (org_id, repo, created_at desc);
