-- The "make default" action on the executor list (issue 215): a member may flag one of their
-- executors as the one a new task draft autoselects, instead of always landing on whichever row
-- sorts first.
--
-- A FLAG ON THE ROW, not a separate settings table like 035's user_workflow_default. That table
-- works because it is never rewritten wholesale; user_executor IS — `replace()` deletes and
-- re-inserts a member's whole list on every PUT (012's header), so a foreign preference table
-- keyed by executor name would lose its link on every save. A column travels with the row through
-- that same replace, and a deleted row takes its flag with it for free.
--
-- ONE DEFAULT PER MEMBER, by the same partial-unique-index trick 027_workflows.sql's
-- workflow_default_uk uses for one default per scope — a database fact, not a route convention.
--
-- This file must contain NO `create extension` and NO `create_hypertable`, per 005's header: without
-- them postgres wraps the whole body in an implicit transaction, so a crashed run rolls back whole
-- instead of leaving half a schema behind.

alter table user_executor add column if not exists is_default boolean not null default false;

create unique index if not exists user_executor_one_default_uk on user_executor (org_id, user_id)
where is_default;
