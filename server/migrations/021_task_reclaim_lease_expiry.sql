-- The reclaim queue's lease becomes a persisted, granted expiry (review of #54).
--
-- 020 leased task_reclaim through claimed_at plus whatever leaseSeconds the POLLING worker passed:
-- the expiry was re-measured on every poll, so a holder granted 300 seconds could lose its row to
-- the first 10-second poll ten seconds in. The expiry now lives on the row: a claim stamps
-- lease_expires_at from its own requested lease, and the reclaim predicate reads that column back —
-- the holder keeps the row for exactly what it was granted, never re-measured by a later poller.
--
-- A new file, not an edit to 020: applied migrations are skipped by filename, so editing 020 would
-- change nothing for a database that already ran it and only lie about how the schema got there —
-- the same reason 006 was never edited when 008 added standby. For a fresh database 020 creates the
-- claimed_at shape and this file converts it; for a database that already ran 020 it is the whole
-- conversion. Either way the reclaim query's column exists before anything polls the queue.
alter table task_reclaim add column if not exists lease_expires_at timestamptz;
alter table task_reclaim drop column if exists claimed_at;
