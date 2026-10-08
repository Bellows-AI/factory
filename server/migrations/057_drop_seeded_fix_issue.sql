-- Retires the board-seeded `fix-issue` workflow: the board no longer seeds it, so its org-level
-- rows go. The name was reserved at org scope while it was seeded, so every org-level row of that
-- name is the board's own; a member's user- or repo-scoped `fix-issue` stays. A running thread is
-- unaffected — its snapshot froze on its root row at create.
--
-- This file must contain NO `create extension`, per 005's header.

delete from workflow
where name = 'fix-issue'
  and user_id is null
  and repo_owner is null
  and repo_name is null;
