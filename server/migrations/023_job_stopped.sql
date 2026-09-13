-- Stopped: the user's verdict on a turn they ended themselves.
--
-- Stop used to park a task on standby, which left the turn hanging: standby is not terminal, so
-- the board refused any follow-up on it and the UI offered nothing but a resume. Stopping a task
-- now ENDS the turn — the row settles `stopped`, terminal, its session kept so the follow-up
-- composer continues the conversation — and the resume path is gone (023's companion change).
-- Standby remains, for the Remote Control idle park only.
--
-- This is the constraint rewrite 008's header documented, for the same reason: the value could not
-- be predicted into 006, and `add constraint` scans every row to validate it. Re-appliable after a
-- crash between running it and recording it, by dropping first.
alter table job drop constraint if exists job_status_ck;
alter table job add constraint job_status_ck
    check (status in ('queued','running','standby','succeeded','failed','dead','stopped'));

-- No index change, for the reason 008 gave: `job_claimable` is partial on
-- `status in ('queued','running')`, so a stopped job is invisible to the claim without a single
-- extra predicate.
