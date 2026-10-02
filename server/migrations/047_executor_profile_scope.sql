-- Organization-scoped executor profiles (issue 391): an administrator configures one executor for
-- the whole team, and every member may select it.
--
-- ONE TABLE, SIBLING SCOPES — the shape 027_workflows.sql chose for workflow definitions and 017
-- for env vars: `user_id` becomes nullable, and NULL is the org scope. A second table would
-- duplicate the config bag, the round limit, the position ordering and the claim-time read for no
-- second behavior; one discriminator (nullness) needs no scope column at all.
--
-- The old primary key (org_id, user_id, name) cannot hold a NULL user_id, so the table moves to a
-- surrogate `id` with PK (org_id, id) — org_id leads, per docs/organizations.md. Name uniqueness
-- WITHIN each ownership scope comes from 027's coalesce index: personal rows key on their owner's
-- id, org rows on the NIL uuid, so the same name may exist once per member AND once for the
-- organization, and personal and org rows with the same name stay distinguishable (the selection's
-- scope is what disambiguates them, never the name alone).
--
-- `created_by` records which administrator created (or last promoted to) an org row — an audit
-- fact, not an ownership: any current admin manages every org row regardless of who created it.
--
-- THE DEFAULT MOVES OFF THE ROW. 040 argued a column beats a table because `replace()` rewrites
-- the whole list on every PUT — and that argument dies here: one org row is shared by every
-- member, so a member's default can no longer live on the row at all. `user_executor_default` is
-- the per-member preference, keyed by (org_id, user_id) — one row each — and by (scope, name)
-- inside it, NOT by the surrogate id: the whole-list PUT still deletes and re-inserts personal
-- rows, and an id-keyed link would be severed by every save. The stored preference is re-resolved
-- at read time (resolvedDefault): a preference whose profile is gone falls back deterministically —
-- first personal row by position, then first org row, then none. 040's flag rows are backfilled
-- into the table before the column drops, so every member's existing default survives the upgrade.
--
-- `job.executor_scope` carries the selection's scope beside the `executor` audit label (docs/
-- jobs.md): NULL reads as 'user' — the pre-391 meaning — so every task queued before this
-- migration and every body that omits the field keeps resolving against the author's personal
-- rows. A value outside the pair is refused at the row, the way 006's job_status_ck does.
--
-- This file must contain NO `create extension`, per 005's header: without
-- them postgres wraps the whole body in an implicit transaction, so a crashed run rolls back whole
-- instead of leaving half a schema behind.

alter table user_executor rename to executor_profile;

alter table executor_profile add column if not exists id uuid not null default gen_random_uuid();
alter table executor_profile drop constraint if exists user_executor_pk;
alter table executor_profile alter column user_id drop not null;
alter table executor_profile add constraint executor_profile_pk primary key (org_id, id);

drop index if exists user_executor_one_default_uk;
create unique index if not exists executor_profile_name_uk on executor_profile (
    org_id,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    name
);

alter table executor_profile add column if not exists created_by uuid references app_user (id)
    on delete set null;

create table if not exists user_executor_default (
    org_id     text not null,
    user_id    uuid not null,
    scope      text not null,
    name       text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    primary key (org_id, user_id),
    constraint user_executor_default_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    constraint user_executor_default_user_fk foreign key (user_id)
        references app_user (id) on delete cascade,
    constraint user_executor_default_scope_ck check (scope in ('user', 'org'))
);

insert into user_executor_default (org_id, user_id, scope, name)
    select org_id, user_id, 'user', name from executor_profile where is_default
    on conflict (org_id, user_id) do nothing;

alter table executor_profile drop column if exists is_default;

alter table job add column if not exists executor_scope text;
alter table job drop constraint if exists executor_scope_ck;
alter table job add constraint executor_scope_ck
    check (executor_scope is null or executor_scope in ('user', 'org'));

-- The block-wait park (issue #231) copies the continuation's labels onto the round row and back
-- at wake — executor included, so executor_scope rides the same round trip: a parked org-scope
-- continuation wakes onto the same scope it parked with, never the author's personal rows.
alter table workflow_round add column if not exists executor_scope text;
alter table workflow_round drop constraint if exists workflow_round_executor_scope_ck;
alter table workflow_round add constraint workflow_round_executor_scope_ck
    check (executor_scope is null or executor_scope in ('user', 'org'));
