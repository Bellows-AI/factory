-- Membership becomes the materialized fact GitHub reported at last sign-in (#99).
--
-- INVITES RETIRE. A membership now always names an account — the person GitHub showed us at
-- sign-in — so unclaimed invite rows, the only rows in this table without one, are deleted.
-- They are irrecoverable, and that is the point: nothing admits a login nobody has signed in
-- with any more. Same for auto-join provenance: auto_joined recorded how a row was born under
-- invite+auto-join, and every row is now GitHub-reported; invited_by recorded the admin who
-- invited, and there are no invites. invited_at SURVIVES as the row-creation stamp (the first
-- sign-in that reported this membership).
--
-- The primary key moves from (org_id, github_login) to (org_id, user_id): the login is a
-- mutable label GitHub may rename, and a rename must UPDATE the row rather than insert a second
-- one. The login stays as a maintained column with its lowercase check.
--
-- Per-user repo scoping (#66) retires with auto-join: it existed only to intersect the
-- installation with what each member's GitHub account could reach, and #99 settles that repo
-- permissions are NOT projected into Factory — installation access is the boundary.

delete from org_membership where user_id is null;

alter table org_membership alter column user_id set not null;

alter table org_membership drop constraint if exists org_membership_pk;
alter table org_membership add constraint org_membership_pk primary key (org_id, user_id);
-- The PK now covers this: one person, at most one membership per organization, is the primary key.
drop index if exists org_membership_user_uk;

-- user_id just became NOT NULL, so the old `on delete set null` action could no longer fire —
-- deleting an account would violate its own membership instead of detaching it. A membership is
-- GitHub-reported, and with the account gone there is nothing left to report on: cascade.
alter table org_membership drop constraint if exists org_membership_user_fk;
alter table org_membership add constraint org_membership_user_fk
    foreign key (user_id) references app_user (id) on delete cascade;

alter table org_membership drop column if exists auto_joined;
alter table org_membership drop column if exists invited_by;

drop table if exists user_repo_access;
