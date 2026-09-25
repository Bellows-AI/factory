-- Remote Control is gone: the driver no longer runs claude-code as an interactive
-- `--remote-control` session, so nothing parks a job on `standby` (the idle park was its only
-- producer) and nothing reports a claude.ai bridge id into `remote_session_id` (009).
--
-- Any row still sitting on standby is settled `stopped` — the same terminal landing a user's
-- Stop gives it, session kept, so a follow-up can still continue the conversation — before the
-- constraint is rewritten without the value (the constraint rewrite 008 and 023 document, re-
-- appliable by dropping first). Its lease is already expired (the park expired it) and its
-- attempt was already handed back, so only the status and the finish stamp move.
update job set status = 'stopped', finished_at = coalesce(finished_at, now())
where status = 'standby';

alter table job drop constraint if exists job_status_ck;
alter table job add constraint job_status_ck
    check (status in ('queued','running','succeeded','failed','dead','stopped'));

alter table job drop column if exists remote_session_id;
