-- The order a member's executors are listed in is the order that member saved them, held as an
-- explicit column instead of being inferred.
--
-- It was inferred, from `created_at asc, name asc` (012), and that never worked: `replace()` deletes
-- and re-inserts the whole list inside ONE transaction, and postgres' `now()` is the transaction's
-- start time, so every row of a save carries the SAME created_at. The first key is therefore always
-- a tie and the second always decides — the list is alphabetical, and has been since 012, whatever
-- order the member arranged.
--
-- That is not only cosmetic. The composer autoselects `executors[0]` when no row carries 040's
-- is_default flag (defaultExecutorName, web/src/workspace/executors.ts), so the row that sorts first
-- alphabetically is the one a new task silently runs with.
--
-- The whole-list replace is what makes a plain integer enough: the column is rewritten from the
-- array index on every PUT, so it cannot drift from the list it describes, and a deleted row takes
-- its position with it the way 040's flag does. No uniqueness constraint — a gap or a repeat is a
-- harmless tie that `name asc` still breaks deterministically, and enforcing it would reject a
-- perfectly orderable save for no gain.
--
-- Existing rows are backfilled in the order they are currently served, so the first list a member
-- sees after this migration is the list they saw before it; the next save replaces the values.
--
-- This file must contain NO `create extension` and NO `create_hypertable`, per 005's header: without
-- them postgres wraps the whole body in an implicit transaction, so a crashed run rolls back whole
-- instead of leaving half a schema behind.

alter table user_executor add column if not exists position integer not null default 0;

with ordered as (
    select org_id,
           user_id,
           name,
           row_number() over (partition by org_id, user_id order by created_at asc, name asc) - 1 as rank
    from user_executor
)
update user_executor e
set position = ordered.rank
from ordered
where e.org_id = ordered.org_id
  and e.user_id = ordered.user_id
  and e.name = ordered.name;
