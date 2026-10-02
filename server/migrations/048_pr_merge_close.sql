-- The merged-PR ledger and the per-thread closure marker it drives (issue #390): a verified
-- `pull_request` `closed` delivery with `merged: true` marks every task thread published to that
-- PR done — automatically, with no local actor.
--
-- TWO TABLES, TWO LIFECYCLES:
--
-- pr_merge is the DEDUPE GATE and the DURABLE MERGE STATE. One row per (org, repo, pr_number),
-- inserted by the first merge delivery and never rewritten. A redelivery — same or different
-- GUID — conflicts on the primary key and runs no cleanup twice; and because the row survives a
-- reopen, a redelivered merge cannot undo a manual Reopen either. It is also what makes
-- merge-before-publication safe: the delivery may arrive before the publishing verdict commits
-- its job_pr row, and the ledger keeps the fact until that verdict's transaction reads it and
-- applies the closure inline (completeJob). The row is deliberately NOT deleted on remove —
-- github_delivery's precedent: the fact that this PR merged is history, not live state.
--
-- job_merge_close is the REVERSIBLE per-thread marker: the discriminator completeJob reads to
-- rest a workflow instead of inserting its successor, stamped once per thread by the merge
-- closure. Reopen deletes it (the thread may walk again), remove deletes it with the thread's
-- other audit rows.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists pr_merge (
    org_id      text        not null,
    repo        text        not null check (char_length(repo) between 3 and 201),
    pr_number   integer     not null check (pr_number > 0),
    delivery_id text        not null check (char_length(delivery_id) between 1 and 64),
    merged_at   timestamptz not null default now(),

    constraint pr_merge_pk primary key (org_id, repo, pr_number),
    constraint pr_merge_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade
);

create table if not exists job_merge_close (
    org_id      text        not null,
    root_job_id uuid        not null,
    closed_at   timestamptz not null default now(),

    constraint job_merge_close_pk primary key (org_id, root_job_id),
    constraint job_merge_close_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade
);
