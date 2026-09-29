-- User control for a thread parked on a durable PR wait (issue #328): the two person routes
-- `POST /api/jobs/:id/wait/cancel` and `POST /api/jobs/:id/wait/poke`.
--
-- CANCELLED_BY: the acting caller on the wait row, 025's actor pattern (stopped_by/done_by) —
-- stamped at the cancel with the same first-writer coalesce, recorded but not served by any read
-- (task_reclaim.removed_by's precedent). The wait row is the only survivor of a cancel — the
-- thread's job rows keep living — so, unlike removeThread's actor, it has a row to ride.
--
-- DELIVERY_COUNT LOOSENS TO >= 0: a user-poked wake runs the sweep's exact wake transaction minus
-- the `pending > 0` gate, so `delivery_count = 0` with a null `last_delivery_id` is the audit
-- signature of a poke that folded nothing — an honest zero, not a broken constraint. A sweep wake
-- always has pending > 0 and is unaffected.

alter table workflow_wait add column if not exists cancelled_by uuid;
do $$ begin
    alter table workflow_wait add constraint workflow_wait_canceller_fk
        foreign key (cancelled_by) references app_user (id) on delete set null;
exception when duplicate_object then null; end $$;

alter table workflow_round drop constraint if exists workflow_round_delivery_count_check;
alter table workflow_round add constraint workflow_round_delivery_count_check check (delivery_count >= 0);
