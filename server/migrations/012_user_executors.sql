-- Per-member executor configuration: what a member has told this deployment about the executors
-- their agents may run.
--
-- A row is a CONFIG BAG, not a source of derived truth: the member pastes JSON on the Workspace
-- page, it is stored verbatim, and nothing in this change runs an executor. The driver's
-- claude-executor container reads nothing from this table yet — wiring a consumer is future work,
-- and deepening the validation past "is a JSON object" belongs to the day one exists and can be
-- wrong about the fields.
--
-- WHY ORG-OWNED: 011_user_workspace.sql decided this for user_repo ("exactly those tables that
-- already carry `repo`"), and executor config is workspace data the same way — it describes work
-- done inside this organization's deployment, scoped to the member's own tree, not identity data.
--
-- NO SOFT DELETE, unlike user_repo's deselected_at. That row is the only record that a tree exists
-- on disk, so deleting it would hide growth. This row tracks no disk state: dropping it loses
-- nothing but the pasted JSON, which the whole-list PUT already replaces wholesale.
--
-- This file must contain NO `create extension`, per 005's header: without
-- them postgres wraps the whole body in an implicit transaction, so a crashed run rolls back whole
-- instead of leaving half a schema behind.

create table if not exists user_executor (
    org_id     text not null,
    user_id    uuid not null,
    name       text not null,
    type       text not null,
    -- Stored verbatim. jsonb (not text) so a future server-side consumer can query into it.
    config     jsonb not null,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint user_executor_pk primary key (org_id, user_id, name),
    constraint user_executor_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    -- Same argument as user_repo_user_fk in 011: config describes something nobody can reach once
    -- the account is gone, and it is not an audit record the way job is.
    constraint user_executor_user_fk foreign key (user_id)
        references app_user (id) on delete cascade,

    -- MUST list the same values as EXECUTOR_TYPES in core/src/executors.ts; add the value to both in
    -- the same change. Adding a value to a check on a populated table is a rewrite (006's
    -- job_status_ck rule), so this is deliberately a closed list.
    constraint user_executor_type_ck check (type in ('claude-code')),

    -- The database's own copy of the path-segment rules, restating the route guard the way
    -- user_repo_name_ck does: a name arrives in a JSON body now, so the route guards the request and
    -- this guards the row.
    constraint user_executor_name_ck check (
        name !~ '[/\\]' and name !~ '^[-.]' and name <> ''
    )
);
