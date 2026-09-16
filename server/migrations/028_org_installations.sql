-- Multi-org sign-in (#99): one GitHub App installation = one Factory organization.
--
-- The org id BECOMES the installation id (a decimal string — it passes organization_id_ck,
-- which restates ORG_ID_PATTERN: 1-39 chars of [a-z0-9_-], no leading __). Organizations are
-- no longer seeded from config; they are upserted at sign-in from GET /user/installations,
-- keyed by installation id and named after the installation account's login.
--
-- Sessions stay global rows (one human = one id, see 010) and gain the organization they were
-- created in. The org is re-checked through the org_membership join on every request — which is
-- what keeps a GitHub-side removal immediate — and is what POST /api/auth/org rewrites.
-- NULL only for rows that predate this migration: the read joins on it, so a NULL-org session
-- matches no membership and is UNAUTHENTICATED — fail closed, so an upgrade signs everybody
-- out rather than mis-scoping anybody. `npm run adopt` re-homes the legacy data; operators
-- re-sign-in after running it.

alter table organization add column if not exists installation_id bigint;

-- One installation = at most one organization, by construction: every directory org's id IS
-- its installation id. The partial unique index keeps AUTH_MODE=none's 'default' row — which
-- has no installation — legal beside them.
create unique index if not exists organization_installation_uk
    on organization (installation_id) where installation_id is not null;

alter table session add column if not exists org_id text;
create index if not exists session_org on session (org_id);
-- Re-runnable, like every statement in every file: a crash between applying a file and recording
-- its version re-applies the whole body, so a plain `add constraint` would fail the retry with
-- duplicate_object and brick the boot. The same DO-block 010 uses.
do $$ begin
    alter table session
        add constraint session_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade;
exception when duplicate_object then null; end $$;
