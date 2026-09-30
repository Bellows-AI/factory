-- Per-member checkouts: which repositories somebody chose, and where each clone got to.
--
-- Until now there was ONE workspace per deployment — `ensureWorkspace()` cloned every repo in
-- ORG_REPOS to <root>/<orgId>/<name> at boot, and the driver handed every runner
-- WORKDIR=/workspaces/<orgId>. Every member's agent therefore worked in the same tree, and the repo
-- list was an environment variable no user could change. This table is what replaced both: a person
-- signs in, picks repositories from the dashboard, and gets their own tree at
-- <root>/<orgId>/<user id>/<repo name>.
--
-- WHY user_id AND NOT github_login IN THE PATH: 010_auth.sql already decided this on app_user.id —
-- "it becomes a docker volume name component and a workspace path segment sitting next to repo
-- names, and a uuid can collide with neither". The login loses on two further counts that cost work
-- rather than tidiness. A rename would orphan a tree that may hold uncommitted work belonging to an
-- agent session, which is the one thing the never-touch-an-existing-checkout rule exists to protect.
-- And GitHub lets a freed login be claimed by somebody else, so a login-keyed directory hands a
-- stranger the previous holder's checkouts and their .git/config — the same account-takeover path
-- docs/auth.md names, except the prize is a working tree.
--
-- WHY ORG-OWNED: 005_organizations.sql states the rule as "exactly those tables that already carry
-- `repo`". This one carries a repo, so it leads with org_id. app_user does not, and stays global.
--
-- ONE TABLE, NOT TWO. A separate "workspace" row would assert only that a user exists, which
-- app_user already asserts; workspace-level facts are aggregates over this one.
--
-- SINGLE-PROCESS ASSUMPTION: the clone queue requeues rows left in 'cloning' at boot, which is sound
-- only because a 'cloning' row can be owned solely by a live in-process runner and at boot there are
-- none. A second dashboard replica breaks that one statement and nothing else — the claim query is
-- already `for update skip locked`. The fix when that day comes is a (claimed_by, lease_expires_at)
-- pair exactly like job's, not a redesign.
--
-- This file must contain NO `create extension`, per 005's header: without
-- them postgres wraps the whole body in an implicit transaction, so a crashed run rolls back whole
-- instead of leaving half a schema behind.

create table if not exists user_repo (
    org_id        text not null,
    user_id       uuid not null,
    repo_owner    text not null,
    repo_name     text not null,

    -- All four values from the first line, for the reason 006 put 'dead' in job_status_ck: adding a
    -- value to a check constraint on a populated table is a rewrite.
    status        text not null default 'queued',
    -- Why a clone failed, in the clone's own words. The old ensureWorkspace() swallowed this and
    -- counted a failure instead, because boot had nowhere to put a message. This column is that
    -- somewhere, and it is what the Workspace page shows beside a failed repo.
    error         text,
    attempts      int not null default 0,

    selected_at   timestamptz not null default now(),
    -- Set rather than deleting the row. The row is the ONLY record that a tree exists on disk, and
    -- deleting it would make disk growth invisible — which is precisely the failure docs/workspace.md
    -- already admits to, one that per-member checkouts multiply by the number of members. A
    -- deselected row is reported as `orphaned`, which is where a future prune attaches.
    deselected_at timestamptz,
    started_at    timestamptz,
    ready_at      timestamptz,

    constraint user_repo_pk primary key (org_id, user_id, repo_owner, repo_name),
    constraint user_repo_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    -- `on delete cascade`, unlike job.created_by's `set null`. A job is an audit record of what a
    -- person ran and must outlive them; this row describes a directory nobody can reach once the
    -- account is gone. The DIRECTORY is not deleted — nothing prunes, still.
    constraint user_repo_user_fk foreign key (user_id)
        references app_user (id) on delete cascade,
    constraint user_repo_status_ck check (status in ('queued','cloning','ready','failed')),

    -- The database's own copy of the path-segment rules. Duplicated on purpose, like
    -- organization_id_ck restates ORG_ID_PATTERN: a repo name arrives in a JSON body now rather than
    -- from an operator's config, so the route guards the request and this guards the row. A leading
    -- '-' is read by git as an option rather than a path; a '.' or '..' is not a directory name.
    constraint user_repo_name_ck check (
        repo_name !~ '[/\\]' and repo_name !~ '^[-.]' and repo_name <> ''
        and repo_owner !~ '[/\\]' and repo_owner !~ '^[-.]' and repo_owner <> ''
    )
);

-- The on-disk directory is <repo_name> alone, so two owners' same-named repositories would be one
-- directory. That fact, restated as a constraint — the check `checkWorkspaceNames` used to make
-- against ORG_REPOS at boot, moved to where a name actually becomes a path.
create unique index if not exists user_repo_dir_uk
    on user_repo (org_id, user_id, repo_name);

-- The clone queue's read. Partial, because 'ready' rows are the overwhelming majority and are never
-- claimed — without the predicate this index grows with the whole table to serve a query that only
-- ever wants the tail of it.
create index if not exists user_repo_pending
    on user_repo (org_id, selected_at) where status in ('queued','cloning');
