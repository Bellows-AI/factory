-- Removes the pull-request statistics schema, dropped with the feature (issue #62).
--
-- 004 created the PR tables, 005 partitioned them by organization, and 003 added the
-- session_pr side channel that joined agent sessions to PR numbers. Nothing reads any of
-- them any more.
--
-- Never edit an applied migration (docs/persistence.md), so this is a new file rather than a
-- trim of 004/005: a fresh database applies 004 and 005 and then drops what they made, which
-- is the accepted cost of the filename-tracking rule. Children are listed before their
-- parents so the drops need no FK juggling — each `cascade` takes the org-partitioned keys
-- and indexes 005 built with it.
--
-- The telemetry tables (metric_point, session_branch) and 002's branch views are untouched.

drop table if exists pr_review cascade;
drop table if exists pr_review_thread cascade;
drop table if exists pr_commit cascade;
drop table if exists pr_label cascade;
drop table if exists pull_request cascade;
drop table if exists branch_commit cascade;
drop table if exists branch_history cascade;
drop table if exists sync_state cascade;
drop table if exists session_pr cascade;
