-- Durable mutation idempotency (issue #589). The create, follow-up and retry routes accept an
-- `Idempotency-Key`; the key lives ON the job row the mutation inserted, so the mutation and its
-- stored result commit or roll back together — there is no second table to drift from the first.
--
--   idempotency_operation    which mutation made the row: create, follow-up or retry.
--   idempotency_key          the caller-chosen key; with the org, the caller (created_by) and the
--                            operation it is the scope of one logical attempt.
--   idempotency_fingerprint  sha256 of the canonical request, so the same key with a different
--                            payload is refused rather than replayed.
--   idempotency_at           when the key was recorded; a key older than the retention window is
--                            cleared before the next request under it, so the key can be reused.
--
-- Removing a thread deletes its rows, and their keys with them.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists idempotency_operation text;
alter table job add column if not exists idempotency_key text;
alter table job add column if not exists idempotency_fingerprint text;
alter table job add column if not exists idempotency_at timestamptz;

alter table job add constraint job_idempotency_ck check (
    (idempotency_key is null and idempotency_operation is null and idempotency_fingerprint is null
        and idempotency_at is null)
    or (idempotency_key is not null and idempotency_operation is not null
        and idempotency_fingerprint is not null and idempotency_at is not null)
);

-- One live row per (org, caller, operation, key). A null caller (the no-auth stand-in) collapses
-- to the empty string so it is unique too.
create unique index if not exists job_idempotency_key_uk
    on job (org_id, coalesce(created_by::text, ''), idempotency_operation, idempotency_key)
    where idempotency_key is not null;
