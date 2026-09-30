-- The structured terminal reason of a run (issue #339): why a FAILED run failed. The driver
-- reports it with the verdict (`failureKind` on POST /api/jobs/:id/complete), the route validates
-- it against the six known spellings, and every job read serves it — so "how many timeouts this
-- week" and "timeouts where the gates passed" are queries over this column, and the task view can
-- badge a failed run ("timed out") instead of making the reader scan the output tail.
--
-- The values: `timeout` (the DRIVER_JOB_TIMEOUT_MS kill), `cache_lost` (the prompt-cache watch
-- kill), `gate` (a declared gate failed), `publish` (the deterministic publish did not land),
-- `helper` (a declared block-helper step failed), `runner_error` (everything else that lands
-- failed — a non-zero exit, a premature finish, a refused setup).
--
-- Null is "not a failure": a succeeded run, and every row that predates this column — there is no
-- backfill, because a historical row's tail usually does not name a kind and guessing one would
-- manufacture history. Unlike `status`, the database itself never transitions this column: the
-- verdict's overwrite is the only write, so the value boundary is the route's validation and no
-- check constraint is needed.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists failure_kind text;
