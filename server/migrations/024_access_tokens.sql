-- Personal (fat_) and organization (oat_) access tokens, minted from the settings UI (#70).
--
-- Same shape as session and worker_token: only the sha-256 is stored, so the row is a bearer
-- credential at rest, and the token itself is shown exactly once at creation.
--
-- A PERSONAL token is bound to a user and acts as that user on session routes — through the same
-- org_membership join a session row uses, so removing a member ends their tokens' reach on the
-- very next request. That immediacy is why these are rows, and it is also why they may be minted
-- over HTTP at all, unlike the worker token: their authority is bounded by a live membership.
--
-- An ORG token is bound to the organization, has no user, and is minted by an admin. What it may
-- reach is a read subset of the session routes, enforced in the auth hook rather than here —
-- a job's created_by must stay a person, always.
--
-- created_by records who minted the token: the owner for a personal token, the admin for an org
-- token. on delete set null, like worker_token.creator_fk — the token's authority does not depend
-- on its minter continuing to exist.
create table if not exists access_token (
    org_id       text not null,
    id           uuid not null default gen_random_uuid(),
    kind         text not null,
    user_id      uuid,
    created_by   uuid,
    label        text not null,
    token_hash   bytea not null,
    created_at   timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at   timestamptz,
    constraint access_token_pk primary key (org_id, id),
    constraint access_token_kind_ck check (kind in ('personal', 'org')),
    constraint access_token_owner_ck check (
        (kind = 'personal' and user_id is not null) or (kind = 'org' and user_id is null)
    ),
    constraint access_token_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    constraint access_token_user_fk foreign key (user_id)
        references app_user (id) on delete cascade,
    constraint access_token_creator_fk foreign key (created_by)
        references app_user (id) on delete set null,
    constraint access_token_hash_uk unique (token_hash)
);

-- token_hash is uniquely indexed even though the primary key leads with org_id, because the
-- bearer lookup is the one read that cannot start from an organization — the same reasoning
-- worker_token's unique index carries.
--
-- This one serves the personal-token list: a member reads their own tokens, an admin reads the
-- org's. The org-token list is a prefix scan of the primary key, so it needs no index.
create index if not exists access_token_by_owner
    on access_token (user_id) where user_id is not null;
