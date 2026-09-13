-- Accounts, memberships and sessions.
--
-- Until now there were no users at all: docs/security.md's opening sentence was that the 127.0.0.1
-- bind IS the access control. These tables are what let a request name a caller, which is what makes
-- POST /api/jobs — a route that queues a shell command — something other than unauthenticated remote
-- code execution.
--
-- WHICH TABLES ARE ORG-OWNED: 005_organizations.sql states the rule as "exactly those that already
-- carry `repo`. That is not a coincidence. A repo belongs to an organization, so anything keyed by
-- repo is keyed by organization." A GitHub identity carries no repo, so app_user and session are
-- GLOBAL and only org_membership leads with org_id. Keying app_user by organization instead would
-- give one human two ids, and the per-user Claude credential planned on top of that id is the
-- person's, not the organization's — so a key would have created a product bug.
--
-- IDENTITY vs LABEL: github_user_id is the identity, github_login is a label. GitHub permits renames
-- and then lets the freed login be claimed by somebody else, so a schema keyed on the login is an
-- account-takeover path rather than a convenience.
--
-- This file must contain NO `create extension` and NO `create_hypertable`, per 005's header: without
-- them postgres wraps the whole body in an implicit transaction, so a crashed run rolls back whole
-- instead of leaving half a schema behind. gen_random_uuid() is core since PG13 and compose pins 17.

-- The organization itself. It has never had a table: with one config-defined org there was nothing
-- to point at. A membership needs a foreign key target, and without one a typo in an invite creates
-- a membership of an organization that does not exist — which presents as "login works, dashboard
-- empty" rather than as a bad invite.
--
-- Seeded from config at boot by seedOrganization() rather than by this file, for the same reason
-- adoptOrg() exists: a .sql file cannot see the config, and guessing wrong here is silent.
--
-- The check constraint restates ORG_ID_PATTERN from config.ts. Duplicated deliberately: config.ts
-- guards the process, this guards the database, and the CLIs write here without going through
-- loadConfig at all.
create table if not exists organization (
    id         text not null,
    name       text not null,
    created_at timestamptz not null default now(),
    constraint organization_pk primary key (id),
    constraint organization_id_ck check (id ~ '^[a-z0-9][a-z0-9_-]{0,38}$' and id !~ '^__')
);

-- GLOBAL, not org-owned. See the header.
--
-- The id is a uuid, and that is load-bearing beyond this file: it becomes a docker volume name
-- component and a workspace path segment sitting next to repo names, and a uuid can collide with
-- neither. driver/src/docker.ts already refuses a session id that is not a uuid before interpolating
-- it into a command, and this value travels the same path.
create table if not exists app_user (
    id             uuid not null default gen_random_uuid(),
    github_user_id bigint not null,
    github_login   text not null,
    display_name   text,
    avatar_url     text,
    created_at     timestamptz not null default now(),
    last_login_at  timestamptz,
    constraint app_user_pk primary key (id),
    constraint app_user_github_uk unique (github_user_id)
);

-- Org-owned, org_id leading, per 005.
--
-- THE INVITE EXISTS BEFORE THE USER DOES. That is the whole reason the primary key is the login and
-- user_id is nullable: at invite time there is no account to point at. First login claims the row.
--
-- github_login is stored lowercase and the constraint enforces it. This is the OPPOSITE call from
-- ORG_ID_PATTERN, which config.ts rejects rather than normalises, and the difference is not an
-- inconsistency: an org id is chosen by the operator and lives in three places that have to agree
-- (the file, the database, the query string), so silently lowercasing it would let them disagree
-- invisibly. A GitHub login is chosen by GitHub, which is itself case-insensitive — `Andrii` and
-- `andrii` are one account — so normalising is the only way an invite matches the login the identity
-- endpoint reports back.
--
-- Both role values are in the constraint now rather than when they are needed, for the same reason
-- 'dead' is in job_status_ck from 006's first line: adding a value to a check constraint on a
-- populated table is a rewrite. 'owner' is deliberately absent — it implies an at-least-one
-- invariant nothing here enforces, and an unenforced role is worse than one that does not exist.
create table if not exists org_membership (
    org_id       text not null,
    github_login text not null,
    user_id      uuid,
    role         text not null default 'member',
    invited_at   timestamptz not null default now(),
    invited_by   uuid,
    claimed_at   timestamptz,
    constraint org_membership_pk primary key (org_id, github_login),
    constraint org_membership_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    constraint org_membership_user_fk foreign key (user_id)
        references app_user (id) on delete set null,
    constraint org_membership_inviter_fk foreign key (invited_by)
        references app_user (id) on delete set null,
    constraint org_membership_login_ck check (github_login = lower(github_login)),
    constraint org_membership_role_ck check (role in ('admin','member'))
);

-- One person holds at most one membership per organization. Without this, somebody invited under
-- both an old and a new login claims both rows and appears twice in their own membership list.
create unique index if not exists org_membership_user_uk
    on org_membership (org_id, user_id) where user_id is not null;

-- Every authenticated request resolves memberships by user. This is that read's index.
create index if not exists org_membership_by_user
    on org_membership (user_id) where user_id is not null;

-- GLOBAL, and keyed by the HASH of the token rather than the token.
--
-- A session row is a bearer credential at rest: anyone with a read on this table would otherwise
-- hold every live session. Same reasoning as the chmod-600 warning in docs/security.md — a readable
-- credential next to a service is worse than either alone.
--
-- Sessions are rows rather than self-contained tokens because revocation has to be immediate here.
-- Removing somebody from an organization must stop their next request, not their next fortnight, on
-- a deployment where POST /api/jobs runs shell commands. A stateless token reaches that only with a
-- denylist, and a denylist is this table with worse ergonomics.
-- The expiry is absolute, not sliding: there is no "touch" on the read path, so an active session
-- ends on schedule rather than being extended by use. That costs a signed-in person one sign-in a
-- fortnight and buys a write-free read path, which matters because every authenticated request
-- reads the session row — a per-request update would turn each of those reads into a write.
create table if not exists session (
    token_hash   bytea not null,
    user_id      uuid not null,
    created_at   timestamptz not null default now(),
    expires_at   timestamptz not null,
    constraint session_pk primary key (token_hash),
    constraint session_user_fk foreign key (user_id)
        references app_user (id) on delete cascade
);

create index if not exists session_by_user on session (user_id);

-- The reaper reads this. Without it `delete from session where expires_at < now()` is a sequential
-- scan that gets slower in exactly the situation that makes it necessary.
create index if not exists session_expiry on session (expires_at);

-- The driver's credential.
--
-- The job board has two callers with nothing in common: a human in a browser queueing a job, and a
-- driver claiming one. They get different credentials, and the sets are disjoint on purpose — a
-- session cookie accepted on /claim would let any member steal another worker's lease, and a worker
-- token accepted on POST /api/jobs would produce a job with no author.
--
-- token_hash is uniquely indexed even though the primary key leads with org_id, because this is the
-- one lookup that cannot start from an organization: the token IS how a process with no session
-- says which organization it is working for.
create table if not exists worker_token (
    org_id       text not null,
    id           uuid not null default gen_random_uuid(),
    token_hash   bytea not null,
    name         text not null,
    created_at   timestamptz not null default now(),
    created_by   uuid,
    last_used_at timestamptz,
    revoked_at   timestamptz,
    constraint worker_token_pk primary key (org_id, id),
    constraint worker_token_hash_uk unique (token_hash),
    constraint worker_token_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    constraint worker_token_creator_fk foreign key (created_by)
        references app_user (id) on delete set null
);

-- Who queued a job.
--
-- Nullable, because every job written before this migration has no author and inventing one would be
-- a lie — nothing in the database names a person: claimed_by is a worker id, and the collector strips
-- identity attributes on purpose.
--
-- `on delete set null`, never cascade: removing somebody from the organization must not delete the
-- record of what they ran. This column is the audit trail on the one route docs/security.md
-- describes as remote code execution.
alter table job add column if not exists created_by uuid;

do $$
begin
    alter table job add constraint job_creator_fk
        foreign key (created_by) references app_user (id) on delete set null;
exception
    when duplicate_object then null;
end $$;

-- "What did I queue", and the per-user grouping the per-user credential work reads later. Cheap now,
-- a rewrite once the table is large — the same argument 006 makes for folding org_id in early.
create index if not exists job_org_creator on job (org_id, created_by, created_at desc);
