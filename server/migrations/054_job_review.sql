-- Independent reviewer invocation (issue #549). A named-profile review is a job row of its OWN
-- thread (root_job_id = its own id, so it never contends with the caller for the thread's one
-- running row and gets its own worktree), linked to the caller by `review_of`.
--
--   reviewers        the reviewer profiles the repository declared when the CALLER was claimed,
--                    read from the base clone's `.bellows.yaml` and re-stamped on every claim like
--                    `policy` (053) — a request is validated against this, never the repository.
--   review_of        the caller row this review assesses; null on every ordinary job.
--   review_key       the caller-chosen idempotency key: the same (caller, key) is the same review,
--                    so a retried or reclaimed caller never starts a second one.
--   review_profile   the profile the review runs as, frozen on the row with its instructions,
--                    connections and budget (`review_spec`), so editing the repository mid-review
--                    changes nothing about it.
--   review_revision  the caller's tree fingerprint the driver measured when the review was asked
--                    for — what the verdict is bound to. Never taken from the request body.
--   review_ref       the git ref the driver snapshotted that tree under; the reviewer's worktree
--                    starts from it.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists reviewers jsonb;
alter table job add column if not exists review_of uuid;
alter table job add column if not exists review_key text;
alter table job add column if not exists review_profile text;
alter table job add column if not exists review_spec jsonb;
alter table job add column if not exists review_revision text;
alter table job add column if not exists review_ref text;

-- One review per (caller, key): the idempotency the request route's insert relies on.
create unique index if not exists job_review_key_uk on job (org_id, review_of, review_key)
    where review_of is not null;

-- Cancellation and evidence both read "the reviews of this caller".
create index if not exists job_review_of_idx on job (org_id, review_of) where review_of is not null;

alter table job add constraint job_review_ck check (
    (review_of is null and review_key is null and review_profile is null and review_spec is null
        and review_revision is null and review_ref is null)
    or (review_of is not null and review_key is not null and review_profile is not null
        and review_spec is not null and review_revision is not null and review_ref is not null)
);
