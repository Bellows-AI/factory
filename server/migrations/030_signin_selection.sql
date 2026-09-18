-- Sign-in onboarding (#125): the pending round trip and the per-org repo allowlist.
--
-- The OAuth code is single-use, so the selection screen cannot re-exchange it: the identity and
-- the installation report survive the hop in a ROW, keyed by the hash of an opaque token held in
-- a signed cookie — not in the OAUTH state cookie, because a browser cookie is capped at ~4KB
-- and the report this flow exists for is the enterprise account with many installations. The row
-- holds the HASH only: completing a pending sign-in mints a session, so it is a bearer credential
-- at rest (the same rule as `session`, docs/auth.md). Ten-minute TTL, single-use — the
-- completion route deletes the row it consumed, and expired rows are reaped at boot (and spent on
-- sight by the read). No organization FK: the installations it names are deliberately NOT
-- materialized yet — that is what the confirmation is for.

create table if not exists pending_sign_in (
    token_hash     bytea not null,
    github_user_id bigint not null,
    login          text not null,
    display_name   text,
    avatar_url     text,
    installations  jsonb not null,
    return_to      text not null default '/',
    org_preference text,
    created_at     timestamptz not null default now(),
    expires_at     timestamptz not null,
    constraint pending_sign_in_pk primary key (token_hash)
);
create index if not exists pending_sign_in_expiry on pending_sign_in (expires_at);

-- The repos an organization tracks (#125): the onboarding screen's per-org checkbox answer.
-- NO rows = every repository the installation reports — today's behavior, and the reason a
-- confirm-with-everything-checked writes nothing. Org-owned with org_id leading, per 005's rule;
-- the rows die with the organization, whose repo scope they are.
create table if not exists tracked_repo (
    org_id      text not null,
    owner       text not null,
    name        text not null,
    selected_at timestamptz not null default now(),
    constraint tracked_repo_pk primary key (org_id, owner, name),
    constraint tracked_repo_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade
);
