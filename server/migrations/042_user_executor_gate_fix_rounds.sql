-- The default-workflow gate-repair round limit (issue #49): how many bounded gate-fix rounds an
-- ordinary task may spend repairing a failed gate before the thread rests. One column per
-- executor row, the same shape 040 chose for is_default — user_executor is rewritten wholesale by
-- replace() on every PUT, so a foreign preference table would lose its link on every save; a
-- column travels with the row.
--
-- The value is read at POST /api/jobs, frozen onto the thread's root row beside the snapshot
-- (043), and bounds every edge into the default workflow's gate-fix node. 0 turns automatic gate
-- repair off; the ceiling matches the review-reconciliation block's maxRounds (1-10) plus the off
-- value, the same bound the route validates — a database fact and a route convention that agree.
--
-- This file must contain NO `create extension` and NO `create_hypertable`, per 005's header: without
-- them postgres wraps the whole body in an implicit transaction, so a crashed run rolls back whole
-- instead of leaving half a schema behind.

alter table user_executor add column if not exists gate_fix_rounds integer not null default 3;

alter table user_executor drop constraint if exists user_executor_gate_fix_rounds_ck;
alter table user_executor
    add constraint user_executor_gate_fix_rounds_ck check (gate_fix_rounds between 0 and 10);
