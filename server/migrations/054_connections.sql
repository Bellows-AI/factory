-- Managed connector connections (issue #546): a Jira site an org admin or a member authorizes, which
-- a task may use through the board's connector proxy. The platform owns the credential: it is never
-- delivered to a runner, and the proxy re-checks the connection on every call.
--
-- `owner_user_id` null means org-owned (any member's task may select it); otherwise the connection
-- belongs to that member and only their own tasks may select it. `access` bounds what the proxy
-- forwards: `read` is GET only. `cloud_id` is resolved once, at create, from the site's tenant_info.
--
-- `api_token` sits in plaintext, the `env_var` rule (docs/env.md): the proxy has to present it.
-- Every read path except the proxy's lookup omits it.
--
-- `job.jira_connection_id` is written on the ROOT row only; a follow-up, retry, reclaim or workflow
-- node reads its root's choice. Deleting the connection nulls it, which is the revocation.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists connector_connection (
    id uuid primary key default gen_random_uuid(),
    org_id text not null references organization (id) on update cascade on delete cascade,
    owner_user_id uuid references app_user (id) on delete cascade,
    kind text not null check (kind in ('jira')),
    site text not null,
    cloud_id text not null,
    email text not null,
    api_token text not null,
    access text not null default 'read' check (access in ('read', 'write')),
    created_at timestamptz not null default now()
);

create index if not exists connector_connection_org on connector_connection (org_id);

alter table job add column if not exists jira_connection_id uuid references connector_connection (id) on delete set null;
