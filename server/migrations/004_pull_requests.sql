-- Permanent storage for pull request data, so a restart does not re-pay a ~243-point-per-repo
-- fetch and so history accumulates past whatever one fetch can reach.
--
-- Normalized rather than a jsonb blob: the child lists feed distributions and are queried, and
-- a blob makes every future question a rewrite of the writer.
--
-- Deliberately NOT partitioned. A PR is dimensional — updated in place for months after it is
-- created. Time partitioning is for genuine append-only series, and metric_point is the only one.
--
-- `provider` is in every primary key: a repo path is not unique across forges ("group/proj"
-- can exist on gitlab.com and on a self-hosted instance), and a mirrored repo must read as two
-- rows rather than one silently overwriting the other. `repo` is in every primary key because a
-- PR number is unique only within a repo — the same rule that makes the telemetry join key
-- `repo#number` rather than `number`. A branch name is likewise not unique across repos.

create table if not exists pull_request (
    provider            text        not null,
    repo                text        not null,   -- "owner/name"
    number              integer     not null,
    title               text        not null,
    state               text        not null,   -- open | closed | merged
    is_draft            boolean     not null,
    base_ref            text        not null,
    head_ref            text        not null,
    author              text,                   -- null on a deleted account; the 'ghost' substitution is core's job
    created_at          timestamptz not null,
    merged_at           timestamptz,
    closed_at           timestamptz,
    ready_at            timestamptz,
    additions           integer     not null,
    deletions           integer     not null,
    changed_files       integer     not null,
    -- AUTHORITATIVE totals, straight from the provider. NEVER count(*) of the child rows below:
    -- those lists are capped at 100 per fetch and #149 really does have 397 reviews, so a
    -- count(*) would undercount with nothing anywhere reporting an error.
    commit_count        integer     not null,
    review_count        integer     not null,
    thread_count        integer     not null,
    issue_comment_count integer     not null,
    -- NULL means this provider cannot observe force pushes at all. 0 means it can and none
    -- happened. Different facts; conflating them asserts a clean history never measured.
    force_push_count    integer,
    -- Which of the child lists is shorter than its count above.
    truncated           text[]      not null default '{}',
    -- The incremental-sync input. Named apart from created/merged so nobody reads it as a
    -- metric timestamp: no metric buckets by it.
    provider_updated_at timestamptz not null,
    fetched_at          timestamptz not null default now(),
    primary key (provider, repo, number)
);

-- THE read-path index. `stats.meta.window` is derived from array position, not min/max, so the
-- store has to reproduce the ordering the GraphQL query used to provide. This is what makes
-- `order by created_at desc` a scan of an index rather than a sort of every row.
create index if not exists pull_request_repo_created
    on pull_request (provider, repo, created_at desc);

create index if not exists pull_request_repo_updated
    on pull_request (provider, repo, provider_updated_at desc);

-- Partial: the cutoff floor for an incremental sync reads the oldest still-open PR.
create index if not exists pull_request_open_updated
    on pull_request (provider, repo, provider_updated_at)
    where state = 'open';

create table if not exists pr_review (
    provider       text        not null,
    repo           text        not null,
    pr_number      integer     not null,
    -- Opaque provider correlation token; the only thing pr_review_thread joins to.
    review_key     text        not null,
    author         text,
    state          text        not null,   -- neutral enum
    provider_state text        not null,   -- verbatim, for audit
    submitted_at   timestamptz,
    primary key (provider, repo, pr_number, review_key),
    foreign key (provider, repo, pr_number)
        references pull_request (provider, repo, number) on delete cascade
);

-- The first comment is denormalized ONTO the thread; there is no pr_thread_comment table. The
-- query asks for comments(first: 1) and core reads exactly the first comment and nothing else,
-- so a comment table would be one whose every row is the only row — and it would invite
-- count(*) as a comment total the fetch never retrieved.
create table if not exists pr_review_thread (
    provider             text        not null,
    repo                 text        not null,
    pr_number            integer     not null,
    thread_key           text        not null,
    is_resolved          boolean     not null,
    is_outdated          boolean     not null,
    first_comment_author text,
    first_comment_at     timestamptz,
    -- NULL means the thread began outside any review, OR the provider cannot link the two.
    -- Which one it is comes from the provider's capabilities, not from this column.
    parent_review_key    text,
    primary key (provider, repo, pr_number, thread_key),
    foreign key (provider, repo, pr_number)
        references pull_request (provider, repo, number) on delete cascade
);

create table if not exists pr_commit (
    provider     text        not null,
    repo         text        not null,
    pr_number    integer     not null,
    sha          text        not null,
    committed_at timestamptz not null,
    primary key (provider, repo, pr_number, sha),
    foreign key (provider, repo, pr_number)
        references pull_request (provider, repo, number) on delete cascade
);

create table if not exists pr_label (
    provider  text    not null,
    repo      text    not null,
    pr_number integer not null,
    label     text    not null,
    primary key (provider, repo, pr_number, label),
    foreign key (provider, repo, pr_number)
        references pull_request (provider, repo, number) on delete cascade
);

-- Base-branch history is a SEPARATE table, not pr_commit with a nullable pr_number. The two
-- answer different questions with different keys and different bounds: a PR commit is keyed by
-- PR and capped at 100, a base-branch commit is keyed by branch, bounded by `since`, and
-- carries a headline. One table would leave "commits on dev" a single count(*) away from being
-- conflated with "commits in PRs".
--
-- Stores `message_headline`, never a precomputed is_revert. Same reason metric_point stores
-- datapoints and not rollups: the classifier will change, and a verdict cannot be re-derived.
create table if not exists branch_commit (
    provider         text        not null,
    repo             text        not null,
    branch           text        not null,
    sha              text        not null,
    committed_at     timestamptz not null,
    message_headline text        not null,
    primary key (provider, repo, branch, sha)
);

create index if not exists branch_commit_branch
    on branch_commit (provider, repo, branch, committed_at desc);

-- The history as the provider reported it. `commits` is the connection's totalCount, NOT
-- count(*) of branch_commit: a partial scan would make the revert ratio a plausible number over
-- an unknown denominator, which is the exact failure the null-not-zero contract exists to stop.
-- `covered_from` is what an incremental scan has actually reached back to, and it is what lets a
-- narrowed date range say "unavailable" instead of quietly answering over a shorter window.
create table if not exists branch_history (
    provider     text        not null,
    repo         text        not null,
    branch       text        not null,
    covered_from timestamptz not null,
    commits      integer     not null,
    reverts      integer     not null,
    scanned_at   timestamptz not null default now(),
    primary key (provider, repo, branch)
);

-- Sync bookkeeping. The watermark lives here rather than being computed as
-- max(provider_updated_at) over pull_request, because that maximum advances on every successful
-- upsert — including part-way through a walk that then died. The next run would resume from the
-- newest row it happened to write and skip everything in between, silently and permanently.
-- This column advances only when a walk completes.
create table if not exists sync_state (
    provider        text        not null,
    repo            text        not null,
    kind            text        not null,   -- 'pull_requests' | 'history:<branch>'
    watermark_at    timestamptz,
    last_sync_at    timestamptz,
    last_full_at    timestamptz,
    -- Bumped in code when a newly selected field leaves existing rows null. A full walk is the
    -- only repair, and without this marker nothing knows the rows are stale rather than empty.
    synced_epoch    integer     not null default 0,
    -- The last rate limit the provider reported. Restored into the payload when a fetch is
    -- failing, because "retry at 14:20" cannot be asked for while the token is refused.
    last_rate_limit jsonb,
    primary key (provider, repo, kind)
);
