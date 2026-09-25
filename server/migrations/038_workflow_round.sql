-- The durable block-wait's parked continuation and bounded wake audit (issue #231). One row per
-- "round" a workflow-block runtime boundary parks: a thread that transitions into a wait-boundary
-- node holds NO job row while it waits — this table is what it holds instead, so waiting consumes
-- no runner/executor lease and the claim loop never has to poll a permanently sleeping job.
--
-- ONE ROW PER PARK, NEVER DELETED ON WAKE: `woken_at`/`job_id`/`delivery_count`/`last_delivery_id`
-- turn a parked round into its own bounded audit record — which continuation job it became, and how
-- many folded deliveries woke it — linking the root job, the PR identity (repo/pr_number, #202's
-- `job_pr`/`workflow_wait`) and the workflow node together for exactly the round it describes. A
-- node re-entering the same wait boundary later (a loop back into review, say) parks a NEW round;
-- `workflow_round_parked_uk` is what makes "the currently parked one" a single, indexed lookup.
--
-- REASON DOUBLES AS THE NODE NAME: the compiled node name is already unique within one thread's
-- expanded graph (`DUPLICATE_NODE`), so `workflow_node` is reused directly as `workflow_wait.reason`
-- — no separate namespacing scheme, no extra column to keep in sync with it.
--
-- This file must contain NO `create extension` and NO `create_hypertable`, per 005's header.

create table if not exists workflow_round (
    org_id           text        not null,
    root_job_id      uuid        not null,
    workflow_node    text        not null check (char_length(workflow_node) between 1 and 200),
    round            integer     not null check (round > 0),

    -- The PR identity this round waited on — audit only; the live address lives on workflow_wait.
    repo             text        not null check (char_length(repo) between 3 and 201),
    pr_number        integer     not null check (pr_number > 0),

    -- The parked continuation: what the wake inserts as an ordinary job row, verbatim.
    command          text        not null check (char_length(command) <= 16384),
    session_id       text,
    job_repo         text,
    executor         text,
    parent_job_id    uuid        not null,
    parked_at        timestamptz not null default now(),

    -- The wake audit. woken_at/job_id/delivery_count are null together while parked and set
    -- together once woken (workflow_round_wake_ck); last_delivery_id is not part of that check —
    -- claimReview's own cursor can in principle be null on the folded row it claims.
    woken_at         timestamptz,
    job_id           uuid,
    delivery_count   integer     check (delivery_count > 0),
    last_delivery_id text        check (char_length(last_delivery_id) <= 64),

    constraint workflow_round_pk primary key (org_id, root_job_id, workflow_node, round),
    constraint workflow_round_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    constraint workflow_round_wake_ck check (
        (woken_at is null) = (job_id is null) and (woken_at is null) = (delivery_count is null)
    )
);

-- "The currently parked round of this wait boundary" — the sweep's join target and the transition's
-- re-park check both address it as one row via this partial unique index.
create unique index if not exists workflow_round_parked_uk
    on workflow_round (org_id, root_job_id, workflow_node)
    where woken_at is null;

-- One round per continuation job — the claim's cancellation fence looks a claimed job up this way.
create unique index if not exists workflow_round_job_uk on workflow_round (job_id) where job_id is not null;
