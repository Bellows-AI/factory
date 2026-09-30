-- The default workflow's gate-repair round limit, frozen on the root job at create (issue #49) —
-- the third of the launch-time options 039 started: the pair said WHICH optional blocks were
-- selected, this says how many bounded gate-fix rounds the graph may spend repairing a failed
-- gate. The value is read off the selected executor's row (042) by POST /api/jobs and stamped
-- here beside the snapshot; a later executor edit changes later tasks, never a running thread,
-- and the task view reads this column rather than re-deriving the budget from settings.
--
-- Null on every other create — a named workflow, or a pre-209 workflow-less create — exactly like
-- the pair columns. Unlike them it is USABLE null: the UI treats null as "no default workflow" and
-- shows no repair counter at all.
--
-- THE BACKFILL BEFORE THE CONSTRAINT: rows created between #209 and this file hold the pair
-- non-null with the new column null by construction — and a NOT VALID check constraint, while
-- skipping existing rows at ADD time, is still enforced against every subsequent INSERT and
-- UPDATE, so leaving them as-is would fail the next claim, heartbeat or verdict write on every
-- thread that was live at upgrade. They backfill to 0, the honest value: their frozen snapshots
-- predate the gate-fix node entirely, so no repair round was ever possible for them — the same
-- answer repair-off gives, and one the UI renders no counter for, matching their actual
-- behavior. 033/034 is the precedent (backfill, then NOT VALID, then a validating follow-up);
-- 039 could skip the backfill only because ITS new columns were guaranteed null everywhere.
--
-- The triple constraint: 039's job_default_workflow_pair_ck said both pair columns non-null
-- TOGETHER; the round limit joins that same shape — all three null together (no default
-- workflow), or all three non-null on a code-owned default root (workflow_name = 'default',
-- workflow_id is null, snapshot present). Rewritten as NOT VALID per 033's own reasoning: after
-- the backfill above, every pre-existing row satisfies it, and the validating follow-up in the
-- 034 style can land later.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists default_gate_fix_rounds integer;

update job set default_gate_fix_rounds = 0
where default_review_reconciliation is not null
  and default_merge_conflict_autofix is not null
  and default_gate_fix_rounds is null;

alter table job drop constraint if exists job_default_workflow_pair_ck;
alter table job add constraint job_default_workflow_pair_ck check (
    (
        default_review_reconciliation is null
        and default_merge_conflict_autofix is null
        and default_gate_fix_rounds is null
    )
    or (
        default_review_reconciliation is not null
        and default_merge_conflict_autofix is not null
        and default_gate_fix_rounds is not null
        and workflow_name = 'default' and workflow_id is null and workflow_snapshot is not null
    )
) not valid;
