-- Retires the code-owned default workflow (issue #543): an omitted `workflow` is objective mode
-- (051), so the frozen optional-block pair, the gate-repair round limit stamped beside it, and the
-- member's saved default-workflow switches have no reader left.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job drop constraint if exists job_default_workflow_pair_ck;
alter table job drop column if exists default_review_reconciliation;
alter table job drop column if exists default_merge_conflict_autofix;
alter table job drop column if exists default_gate_fix_rounds;

drop table if exists user_workflow_default;
