-- Workflow definitions: the process a task walks, owned by the board instead of baked into runner
-- prompts (issue #94). A definition is a graph of `agent` nodes — each holding only its prompt
-- template and its session policy — joined by deterministic edges (verdict, gate-failure, or an
-- output-tail marker), with per-edge loop bounds. Checkout/sync, gates and publish stay driver
-- machinery the graph references by outcome; they are deliberately NOT nodes.
--
-- ONE TABLE, THREE SIBLING SCOPES: the same shape env_var (017) uses, because workflows resolve on
-- the same stack — repo over user over org (docs/workflows.md). Exactly one of {user, repo, org} is
-- set per row, enforced by workflow_scope_ck; the nullable scope columns cannot sit in a primary
-- key, so name uniqueness per scope comes from the coalesce index, by the env_var_key_uk precedent.
--
-- THE DEFINITION IS FROZEN ON THE JOB, NOT JOINED LIVE: job.workflow_snapshot (below) carries a
-- copy of the resolved definition at task creation, so editing a workflow mid-flight changes later
-- tasks, never a running thread. That is also why job.workflow_id carries NO foreign key — job is
-- an audit record (docs/jobs.md), and deleting a definition must not touch the threads that walked
-- it; the snapshot column is what keeps them honest afterwards.
--
-- THE DEFAULT SLOT: each scope may declare one default workflow (is_default), which is what
-- resolution walks when a task names none — repo default > user default > org default > none. The
-- partial unique index makes "one default per scope" a database fact, not a route convention.
--
-- This file must contain NO `create extension` and NO `create_hypertable`, per 005's header: without
-- them postgres wraps the whole body in an implicit transaction, so a crashed run rolls back whole
-- instead of leaving half a schema behind.

create table if not exists workflow (
    org_id     text not null,
    id         uuid not null default gen_random_uuid(),
    -- Unique per scope (workflow_name_uk below). The name a task names, the composer lists, and
    -- `POST /api/jobs` resolves — human-chosen, so bounded and non-empty by the row check the same
    -- way env_var_name_ck is.
    name       text not null,
    -- Null = not user-scoped. Null for org and repo rows.
    user_id    uuid,
    -- Null = not repo-scoped. Repo rows are org-wide: one process for a repository, offered to
    -- every member who queues against it — the same scope shape a repo-level env_var has.
    repo_owner text,
    repo_name  text,
    -- The validated graph: named agent nodes (kind, session policy, prompt template) and edges
    -- (from, rule, to, optional loop bound). Written only through the store's strict validator;
    -- served back verbatim. Bounded by the validator's size cap, so a column and not a table.
    definition jsonb not null,
    -- The scope's default (see header). At most one true row per scope.
    is_default boolean not null default false,
    -- Who created the definition — attribution, not authorization: the route decides who may
    -- create at request time from the live caller. Set null when the account is deleted; the
    -- definition outlives its author.
    created_by uuid,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint workflow_pk primary key (org_id, id),
    constraint workflow_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    -- The user SCOPE dies with the account (a user's private workflows are theirs alone); the
    -- created_by attribution merely anonymizes.
    constraint workflow_user_fk foreign key (user_id)
        references app_user (id) on delete cascade,
    constraint workflow_creator_fk foreign key (created_by)
        references app_user (id) on delete set null,

    -- Exactly one scope per row; the all-null case is the org scope. Same shape as
    -- env_var_scope_ck, for the same reason.
    constraint workflow_scope_ck check (
        (user_id is not null and repo_owner is null and repo_name is null)
        or (user_id is null and repo_owner is not null and repo_name is not null)
        or (user_id is null and repo_owner is null and repo_name is null)
    ),

    constraint workflow_name_ck check (name <> '' and char_length(name) <= 100)
);

-- The scope stand-ins are the env_var_key_uk ones, for the same reason: the NIL uuid can never be
-- minted by gen_random_uuid(), and the empty strings can never pass the segment rules a real
-- owner/name obey — so a substituted value can never collide with a real scope's row.
create unique index if not exists workflow_name_uk on workflow (
    org_id,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(repo_owner, ''),
    coalesce(repo_name, ''),
    name
);

-- One default per scope, by the same coalesce trick, partial on the flag.
create unique index if not exists workflow_default_uk on workflow (
    org_id,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(repo_owner, ''),
    coalesce(repo_name, '')
)
where is_default;

-- Where the task carries its workflow: the definition it resolved (workflow_id), the node the row
-- IS (workflow_node — the graph position, and what loop counts and the task view read), and — root
-- row only — the snapshot frozen at creation. All nullable: existing rows and workflow-less tasks
-- are untouched and behave exactly as before 027.
alter table job add column if not exists workflow_id uuid;
alter table job add column if not exists workflow_node text;
alter table job add column if not exists workflow_snapshot jsonb;
