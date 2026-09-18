-- Defaults die: an unnamed task runs the member's words verbatim, and a workflow walks one only
-- when a body names it. The default slot has no reader left — `POST /api/jobs` resolves an
-- explicit name and nothing else — so the column and its one-default-per-scope index go with it.

drop index if exists workflow_default_uk;

alter table workflow drop column if exists is_default;
