-- Follow-ups and user-set completion for the job board.
--
-- parent_job_id links a follow-up to the finished run it asks for adjustments on. The tasks
-- chat's conversation thread is this column; a follow-up is a NEW job row, never an edit of the
-- parent, because a job is an audit record of what ran (the created_by precedent) -- overwriting
-- the parent's command or output would erase the very run the user is following up on. No
-- foreign key, same as repo/executor in 014: the parent is the older audit row and nothing joins
-- through this at claim time -- the claim reads its own row's copies of the parent session. No
-- index either: the chat already lists by repo + created_at (014's job_repo_created), and a
-- follow-up inherits the parent's repo.
--
-- done_at is the user's verdict, set by POST /api/jobs/:id/done. A status value ('done') would
-- have to overwrite succeeded/failed -- losing the run's outcome the UI displays -- and would
-- cost the job_status_ck rewrite 008's header warns about; a nullable timestamp is orthogonal to
-- status and idempotent (coalesce on write). Null forever on every job queued before this
-- migration and on every task nobody has finished by hand.
--
-- command_delivered_at pins the delivered-once rule docs/jobs.md states for a resumed session:
-- the command goes into the transcript once. suspend() stamps it -- parking is the moment a
-- command is known to sit in a transcript somebody may have been driving -- and the claim reads
-- it to decide whether a follow-up row needs its command delivered. A crashed follow-up attempt
-- is re-claimed before any suspend, so it re-delivers; a parked one does not.
alter table job add column if not exists parent_job_id uuid;
alter table job add column if not exists done_at timestamptz;
alter table job add column if not exists command_delivered_at timestamptz;
