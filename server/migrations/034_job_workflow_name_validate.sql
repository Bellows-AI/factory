-- The second half of 033: validate the job_workflow_name_ck rows its NOT VALID left unchecked.
--
-- 033 added the check NOT VALID so its constraint creation would not scan the job table under a
-- write-blocking lock (see 033's header). This file runs VALIDATE CONSTRAINT, which takes SHARE
-- UPDATE EXCLUSIVE — concurrent job writes proceed — and confirms every backfilled row satisfies
-- the boundary they were backfilled under. Empty on a fresh database, instant on a used one.
--
-- This file must contain NO `create extension` and NO `create_hypertable`, per 005's header.

alter table job validate constraint job_workflow_name_ck;
