-- Revision-bound evidence (issue #548). `evidence` is the attempt's own verdict record: the tree
-- fingerprint the run started from (`treeBefore`), the one its gates assessed (`treeAfter`) and how
-- the declared gates ended (`gates`). `policy` is the evidence the repository required when the
-- attempt was claimed, read from the base clone's `.bellows.yaml` and re-stamped on every claim,
-- so a retry or a reclaim is judged against the requirement as it stands, never a stale copy.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists evidence jsonb;
alter table job add column if not exists policy jsonb;
