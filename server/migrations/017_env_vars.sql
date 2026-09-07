-- Environment variables and secrets for runners, in three stacked scopes — the GitHub Actions
-- model, one level coarser: org ("core") < workspace (the member) < repository, the more specific
-- scope winning a name collision at resolve time.
--
-- ONE TABLE, THREE SIBLING SCOPES: exactly one of {workspace, repo, org} is set per row, enforced
-- by env_var_scope_ck. A table per scope would put the stacking rule — which levels exist, in what
-- order they merge — in three places and a union; here the claim's resolve reads one scope
-- disjunction and the merge lives in one function (stackEnv in env-var-store.ts). The nullable
-- scope columns cannot sit in a primary key, so uniqueness comes from the env_var_key_uk index
-- over coalesced columns instead; the nil-uuid/empty-string stand-ins can collide with no real
-- scope because the check leaves them only in rows where the real column is null.
--
-- PLAINTEXT AT REST, deliberately. These values must be RETRIEVED to be injected into a runner, so
-- hashing is impossible and encrypting with a key that lives beside them (in .env or the compose
-- file, like the App private key already does) is theatre with extra steps. The honest statement —
-- also in docs/security.md — is: read access to this database is equivalent to holding every
-- runner credential. Secrets are still write-only at the API (list never echoes a secret's value),
-- which closes the browser, not the database, as the leak.
--
-- WHO OWNS A ROW: org rows are the "Core secrets" of issue #17 and are admin-written; repo rows
-- are org-wide (one configuration per repository, applied to every member's runs in it — the
-- Actions precedent) and also admin-written; workspace rows are the member's own. Membership is
-- not a sandbox here (docs/jobs.md), and nothing about env changes that.
--
-- This file must contain NO `create extension` and NO `create_hypertable`, per 005's header: without
-- them postgres wraps the whole body in an implicit transaction, so a crashed run rolls back whole
-- instead of leaving half a schema behind.

create table if not exists env_var (
    org_id     text not null,
    -- Null = not workspace-scoped. Null for org and repo rows.
    user_id    uuid,
    -- Null = not repo-scoped. Repo rows are org-wide: one configuration per repository, applied to
    -- every member's runs in it, which is why there is no user_id beside these two.
    repo_owner text,
    repo_name  text,
    -- The environment variable's name. Checked at the row for the same reason user_repo_name_ck
    -- restates the route guard: the body arrives as JSON now, and the row is the last line of
    -- defence. `^[A-Za-z_][A-Za-z0-9_]*$` — names a shell can stand, and no `-e "name with space"`
    -- oddity for the runner images to trip over — bounded at 255, the route's own ceiling, so a
    -- name can neither bloat a row nor push a `NAME=value` past the kernel's per-string limit.
    name       text not null,
    value      text not null,
    -- Write-only at the API: list echoes null for a secret's value. Kept verbatim otherwise.
    is_secret  boolean not null default false,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint env_var_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    -- Same argument as user_executor_user_fk in 012: a member's environment is not an audit
    -- record, and it describes nothing once the account is gone.
    constraint env_var_user_fk foreign key (user_id)
        references app_user (id) on delete cascade,

    -- Exactly one scope per row. The all-null case is the org scope — "Core secrets" — and this
    -- deployment has exactly one org (ORG_ID), which is what makes a per-org row a per-deployment
    -- one without a third identifier column.
    constraint env_var_scope_ck check (
        (user_id is not null and repo_owner is null and repo_name is null)
        or (user_id is null and repo_owner is not null and repo_name is not null)
        or (user_id is null and repo_owner is null and repo_name is null)
    ),

    constraint env_var_name_ck check (name ~ '^[A-Za-z_][A-Za-z0-9_]*$' and char_length(name) <= 255),

    -- The same segment rules a checkout's name obeys (user_repo_name_ck): an owner/name becomes a
    -- scope key, never a path, but a name that could not be a directory has no business being a
    -- scope at all — it would read as a second convention.
    constraint env_var_repo_name_ck check (
        (repo_owner is null and repo_name is null)
        or (
            repo_owner !~ '[/\\]' and repo_owner !~ '^[-.]' and repo_owner <> ''
            and repo_name !~ '[/\\]' and repo_name !~ '^[-.]' and repo_name <> ''
        )
    )
);

-- The obvious `primary key (org_id, user_id, repo_owner, repo_name, name)` is not available: a
-- PK column must be NOT NULL, and the scope columns are deliberately nullable. The real uniqueness
-- comes from this index over coalesced stand-ins. The empty-string stand-ins cannot collide with a
-- real owner or repo name (env_var_repo_name_ck forbids both empty); the stand-in uuid is the NIL
-- uuid, which gen_random_uuid() (010) can never mint — every v4 uuid it produces has version bits
-- set — so a substituted value can never equal a real app_user.id.
create unique index if not exists env_var_key_uk on env_var (
    org_id,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(repo_owner, ''),
    coalesce(repo_name, ''),
    name
);
