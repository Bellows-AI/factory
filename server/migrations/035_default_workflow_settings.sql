-- A member's saved defaults for the two optional default-workflow steps: whether a task's review
-- reconciliation runs and whether merge-conflict autofix runs (#203, parent #36).
--
-- MISSING MEANS BOTH ON. There is no backfill and no row for a member who never changed anything:
-- the store answers `true, true, null` for an absent row, so a new member and a member who has
-- never opened the switch are the same thing, and an org with a thousand members carries zero rows.
-- A default that lived in a column would have to be migrated the day the default changes; this one
-- lives in one place, the store's read.
--
-- WHY ORG-OWNED, keyed (org_id, user_id): 012_user_executors.sql settled this for per-member
-- workspace configuration. One person in two organizations holds two independent preferences,
-- because the workflow they are defaulting is that organization's.
--
-- This file must contain NO `create extension` and NO `create_hypertable`, per 005's header: without
-- them postgres wraps the whole body in an implicit transaction, so a crashed run rolls back whole
-- instead of leaving half a schema behind.

create table if not exists user_workflow_default (
    org_id                  text not null,
    user_id                 uuid not null,
    -- Both non-null: a row that exists states BOTH switches. "Unset" is the absence of the row,
    -- never a null column, so no read has two ways to mean the same thing.
    review_reconciliation   boolean not null,
    merge_conflict_autofix  boolean not null,

    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),

    constraint user_workflow_default_pk primary key (org_id, user_id),
    constraint user_workflow_default_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    -- Same argument as user_executor_user_fk in 012: a preference nobody can reach once the
    -- account is gone, and not an audit record the way job is.
    constraint user_workflow_default_user_fk foreign key (user_id)
        references app_user (id) on delete cascade
);
