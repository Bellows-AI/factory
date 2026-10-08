-- The skills a task selects (issue #545): names from the shipped catalog (docker/skills), chosen at
-- task creation. ONLY THE ROOT's value means anything: a follow-up, retry or workflow successor
-- keeps the default and the claim reads the thread root's selection, so every row of a thread and
-- every reclaim of it sees the same set without an insert site copying it.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists skills text[] not null default '{}';
