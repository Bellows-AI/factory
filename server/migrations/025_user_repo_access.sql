-- GitHub-org sync (#66): how a membership row was born, and what a member's GitHub account can
-- actually reach.
--
-- `auto_joined` records provenance on org_membership. A row born from auth.auto_join_github_org is
-- GitHub's to maintain — its role is re-derived from the org at every sign-in and swept by the
-- periodic roster sync, and membership in the GitHub org is what keeps it alive. An invited row is
-- Factory's: an admin named this person, so GitHub is never asked about it and can never remove or
-- re-role it. Rows created before this column existed are invite-born by default, which keeps the
-- upgrade non-destructive: nobody loses access because a flag said so.
alter table org_membership
    add column if not exists auto_joined boolean not null default false;

-- One row per member: the repos their GitHub account could reach at the last sign-in, as
-- "owner/name" (the form the hook stamps and the installation list carries — there are no ids to
-- join on, so the one spelling of a repo name is the contract). An ARRAY in a single row rather
-- than a row per repo, because the list is only ever compared as a set of strings and the empty
-- set must be distinguishable from "never computed": no row means no computation yet (the account
-- pre-dates scoping, or has not signed in since), while an empty array is a real answer — GitHub
-- grants this account nothing, and the dashboard shows that rather than everything.
--
-- on delete cascade for user, like user_repo (011): this is derived data, not audit. The
-- installation list intersects it on every read, so a repo removed from the App stops matching
-- without a rewrite here.
create table if not exists user_repo_access (
    org_id      text not null,
    user_id     uuid not null,
    repos       text[] not null default '{}',
    computed_at timestamptz not null default now(),
    constraint user_repo_access_pk primary key (org_id, user_id),
    constraint user_repo_access_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    constraint user_repo_access_user_fk foreign key (user_id)
        references app_user (id) on delete cascade
);
