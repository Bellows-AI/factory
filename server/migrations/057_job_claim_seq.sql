-- The claim sequence (issue #559): bumped by every claim and never handed back, unlike `attempts`,
-- which stop, suspend and a contention requeue refund. The kubernetes checkout claim orders a
-- replacement against an older holder by this number (driver/src/k8s-fence.ts), so a refunded
-- attempt can never make a newer claim look older than the one it replaces.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists claim_seq bigint not null default 0;
