-- Raw datapoints, never rollups. The attribution rules will change once real data arrives,
-- and a rollup cannot be re-derived. A year of single-developer telemetry is megabytes.
--
-- No surrogate primary key: a partitioned table's unique constraints must include the partition
-- column, and `id bigserial primary key` would not. Nothing needs it.
--
-- No `repo` column either. A datapoint carries only session.id; the repo is resolved by
-- joining to session_branch, so there is one source of truth rather than two that disagree.
create table if not exists metric_point (
    agent       text             not null default 'claude-code',
    metric      text             not null,   -- verbatim vendor name, so an unknown tool still lands
    -- Canonical field from metric-map.ts, e.g. 'tokens_input'. NULL for a metric we do not
    -- understand yet, which is stored anyway so a new tool's data accumulates before support
    -- is written. The mapping lives in TypeScript so adding opencode is adding rows there,
    -- not editing a CASE expression in two places.
    field       text,
    session_id  text,
    value       double precision not null,
    temporality text             not null,   -- delta | cumulative | unspecified
    start_time  timestamptz,
    time        timestamptz      not null,
    attrs       jsonb            not null default '{}',  -- allowlisted keys only; no identity, ever
    received_at timestamptz      not null default now()
) partition by range (time);

-- One DEFAULT partition, and no other. A range-partitioned table rejects any row no partition
-- covers, which is a failure mode the hypertable did not have — and the writers cannot promise a
-- range: backfill imports transcripts of arbitrary age, and an OTLP client's clock can skew
-- ahead of ours. The default accepts all of it. Nothing here prunes by partition (the views
-- filter on time and bucket in core, not in SQL), so there is no read to trade away, and adding
-- a real range later is a one-off scan of the default rather than a migration of the schema.
-- Deliberately no pg_partman: an extension is the thing this schema stopped requiring.
create table if not exists metric_point_default partition of metric_point default;

-- OTLP delivery is at-least-once, so an identical retry must be a no-op. `time` is part of
-- the key, which is also what makes this index legal on a partitioned table — postgres requires
-- every unique constraint to contain the partition column.
create unique index if not exists metric_point_dedup
    on metric_point (metric, session_id, time, md5(attrs::text));
create index if not exists metric_point_session on metric_point (session_id, time desc);

-- Deliberately unpartitioned: it is dimensional, tiny, and the attribution
-- join needs a real primary key. One row per (session, branch) — three checkouts, three rows.
create table if not exists session_branch (
    agent      text        not null default 'claude-code',
    session_id text        not null,
    repo       text        not null,
    branch     text,                     -- null on detached HEAD; never the literal 'HEAD'
    head_sha   text,
    first_seen timestamptz not null,
    last_seen  timestamptz not null,
    samples    integer     not null default 1,
    primary key (agent, session_id, repo, branch)
);

create index if not exists session_branch_repo on session_branch (repo, branch);
