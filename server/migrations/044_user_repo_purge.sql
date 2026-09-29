-- The manual purge (issue #92): a member deletes ONE orphaned checkout, deliberately, after a
-- confirmation that names what is lost (uncommitted work, local factory/<root> branches).
--
-- `purging` is a fifth clone status, and it is a stamp a single dashboard process owns — exactly
-- the single-process assumption 011's header already wrote for `cloning`, extended: a `purging`
-- row is owned by one in-process removal child, and at boot there are none, so boot recovery may
-- finish each interrupted row (remove residue, delete the row) before the routes accept anything.
-- The stamp is set and released only inside transactions that hold the row's lock, so a select,
-- a second purge, and both job-insert paths either observe it or are serialized behind it.
--
-- The failure of a purge lands back on `failed` + the existing `error` column, so the row stays
-- visible and retryable — no second error column. The row outlives any partial directory: only a
-- transaction that has OBSERVED the removal child's exit may delete the row.

alter table user_repo add column if not exists purge_started_at timestamptz;

alter table user_repo drop constraint if exists user_repo_status_ck;
alter table user_repo
    add constraint user_repo_status_ck check (status in ('queued','cloning','ready','failed','purging'));
