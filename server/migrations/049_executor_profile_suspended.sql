-- Executor profile suspension (issue 440): a profile can be taken out of service without losing its
-- configuration or ownership. A suspended row stays listed and editable but is not selectable, cannot
-- be a member's default, and is refused at submission and at claim. Personal and org rows share the
-- flag for the reason 047 shares the table: one discriminator (nullness of user_id) is the scope.
--
-- The member's stored default preference (user_executor_default) is deliberately NOT touched by
-- suspension, so resuming restores it: resolvedDefault skips a suspended row at read time instead.
--
-- This file must contain NO `create extension`, per 005's header.

alter table executor_profile add column if not exists suspended boolean not null default false;
