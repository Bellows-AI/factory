-- The PR lifecycle: persistent evidence that a task's work reached GitHub, and the durable, wait
-- side-channel the GitHub webhook operates (issue #202). Three tables, one concern: making the
-- board's threads answer to what their PRs and review traffic do WITHOUT a driver polling for it.
--
-- WHY A ROW, NOT A JOIN: the driver's completion report already carries the publication's identity
-- — the pushed branch, the PR URL, the base it branched from — but only in a log line. Nothing in
-- the database could say which task published which PR, so review activity and PR state could
-- never wake their thread. job_pr is that missing join, written only by a verdict that published
-- (never by a no-op or a failed publish), and validated at the store against the lease the verdict
-- went through, so a payload cannot claim another org's repository by spelling it.
--
-- WHY THE WAIT IS A DUPLICATE COUNTER, NOT A QUEUE: a block must wait on review without occupying
-- the driver. Each delivery that GitHub reports for the wait's PR is folded ONCE into `pending`
-- (deduplicated by the delivery's own GUID — GitHub redelivers, and a redelivery must not double
-- count) and claimed atomically by the block when it wakes. Waiting consumes a row, never a
-- claim or a runner. The cursor is the last folded delivery's id, bounded to one GUID per wait
-- cycle. Close/merge arrive as `pull_request` `closed`, and task stop/remove cancel the wait
-- idempotently, from the same store.
--
-- THE DELIVERY LEDGER IS THE DEDUPE: every supported delivery is recorded by its X-GitHub-Delivery
-- GUID once; a redelivery conflicts on the primary key and folds nothing. The ledger is pruned
-- past a week, so the dedupe set is bounded while delivery ids stay unique forever.
--
-- This file must contain NO `create extension` and NO `create_hypertable`, per 005's header: without
-- them postgres wraps the whole body in an implicit transaction, so a crashed run rolls back whole
-- instead of leaving half a schema behind.

-- One structured publication identity per thread root: the repo label, the PR number and URL, the
-- head branch the task pushed and the base it branched from. Upserted by each publishing verdict
-- (idempotent, newest wins), deleted with its organization. repo and the branches are bounded
-- here to what the route trusts; the repo label is additionally validated against the leased
-- job's own repo column before this row is ever written.
create table if not exists job_pr (
    org_id      text        not null,
    root_job_id uuid        not null,
    repo        text        not null check (char_length(repo) between 3 and 201),
    pr_number   integer     not null check (pr_number > 0),
    pr_url      text        not null check (char_length(pr_url) <= 2048 and pr_url like 'https://%'),
    head_branch text        not null check (char_length(head_branch) between 1 and 255),
    base_branch text        not null check (char_length(base_branch) between 1 and 255),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint job_pr_pk primary key (org_id, root_job_id),
    constraint job_pr_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade
);

-- One durable, named wait per thread root. `reason` is the block's own name ("review", "fixes",
-- ...) — the block registry of the follow-up issue uses it as the key. Exactly one of
-- completed/cancelled may ever be set (the other must be null), so a wait that is not active is
-- terminal by one clear stamp; the terminal reason travels with it for the read model. The fold
-- counter and the last-seen delivery cursor are reset when the wait is entered or re-entered, and
-- increments are bounded to positive integers by the row check. repo + pr_number is the address
-- the webhook resolves a delivery to: events for ANOTHER repository or PR match no open wait here
-- and fold nothing — the fence that keeps one thread's review traffic out of another's.
create table if not exists workflow_wait (
    org_id           text        not null,
    root_job_id      uuid        not null,
    reason           text        not null check (char_length(reason) between 1 and 255),
    repo             text        not null check (char_length(repo) between 3 and 201),
    pr_number        integer     not null check (pr_number > 0),
    pending          integer     not null default 0 check (pending >= 0),
    last_delivery_id text        check (char_length(last_delivery_id) <= 64),
    active_at        timestamptz not null default now(),
    completed_at     timestamptz,
    cancelled_at     timestamptz,
    terminal_reason  text        check (char_length(terminal_reason) <= 255),
    last_event_at    timestamptz,
    created_at       timestamptz not null default now(),

    constraint workflow_wait_pk primary key (org_id, root_job_id, reason),
    constraint workflow_wait_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    constraint workflow_wait_cycle_ck check (completed_at is null or cancelled_at is null)
);

-- The open-wait address: the webhook folds (and the close cancels) by repo + pr_number across the
-- org, so the partial index mirrors the predicate it serves.
create index if not exists workflow_wait_open_idx
    on workflow_wait (repo, pr_number)
    where completed_at is null and cancelled_at is null;
-- The read paths walk one thread's waits: stop/remove cancel by root, the task list joins by root.
create index if not exists workflow_wait_root_idx on workflow_wait (org_id, root_job_id);

-- One row per GitHub delivery supported by the webhook, deduped by the delivery GUID: a
-- redelivery inserts nothing and folds nothing. Pruned past a week by the store, which is what
-- keeps the ledger bounded while redeliveries stay silent forever.
create table if not exists github_delivery (
    delivery_id text        not null primary key check (char_length(delivery_id) <= 64),
    event       text        not null check (char_length(event) <= 64),
    action      text        not null check (char_length(action) <= 64),
    repo        text        not null check (char_length(repo) between 3 and 201),
    pr_number   integer     not null check (pr_number > 0),
    seen_at     timestamptz not null default now()
);

create index if not exists github_delivery_seen_idx on github_delivery (seen_at);