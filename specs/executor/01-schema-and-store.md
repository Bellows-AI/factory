# 01 — Schema and store

**Depends on:** [00-overview](00-overview.md) for context. Nothing else.
**Blocks:** [03-controller](03-controller.md), [06-api-and-auth](06-api-and-auth.md).

## Scope

- Workspace wiring for the new `executor/` package (listed here because this spec is first).
- `core/src/executor.ts` — the neutral status contract and transition tables.
- `server/migrations/006_agent_tasks.sql` and `007_agent_tasks.repeatable.sql`.
- `server/src/db/task-store.ts` — `createTaskStore`, mirroring `pr-store.ts`.
- `memoryTaskStore()` in `server/test/helpers.ts`.
- Offline and database test files.

## Non-goals

No HTTP routes ([06](06-api-and-auth.md)), no controller ([03](03-controller.md)), no adapters
([02](02-adapters.md)), no config plumbing ([07](07-config.md)). This spec ends with a schema and a
store that compile, typecheck and pass both suites, with nothing calling them.

---

## 1. Workspace wiring

| File | Change |
| --- | --- |
| `package.json` | `workspaces: ["core","server","web","executor"]`; `"build": "npm run build -w core && npm run build -w server && npm run build -w executor && npm run build -w web"`; add `"task": "npm run build -w core && npm run build -w executor && node executor/dist/cli/task.js"` |
| `tsconfig.json` | add `{ "path": "./executor" }` to `references` |
| `vitest.config.ts` | add `'executor/test/**/*.test.ts'` to `include` |
| `vitest.db.config.ts` | add `'server/test-db/**/*.test.ts'` to `include` |
| `docker/Dockerfile` | add `COPY executor/package.json executor/` in **both** the `deps` and `runtime` stages, beside the existing three |
| `executor/package.json` | new: `@factory-ai/executor`, `"type": "module"`, deps `@factory-ai/core: "*"`, `postgres`, `fastify`, `@kubernetes/client-node` |
| `executor/tsconfig.json` | new: copy `server/tsconfig.json`, `references: [{ "path": "../core" }]` |

`executor/src/index.ts` may be a stub that exits immediately at this stage; it exists so `tsc -b` has
something to build.

**Do not skip the Dockerfile line.** Root `npm ci` needs every workspace manifest, so adding the
workspace breaks the *existing dashboard image* until it lands — and only in the container.

---

## 2. `core/src/executor.ts`

Neutral contract only. **`core` must not know claude-code exists**, for the same reason it no longer
knows GitHub exists: `CanonicalPr` used to be `RawPullRequest`, and a second forge could only be added
by faking GitHub's shape.

```ts
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type AttemptStatus =
    | 'claimed' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'lost';

export type PermissionMode = 'readOnly' | 'acceptEdits' | 'full';
export type InvocationKind = 'prompt' | 'command' | 'skill';

export interface TaskInvocation {
    readonly kind: InvocationKind;
    /** Null exactly when kind === 'prompt'. Mirrored by a check constraint. */
    readonly name: string | null;
    readonly args: string | null;
}

/** `string`, not a literal union: adding a third agent must be config plus an adapter, not a `core`
 *  change plus a rebuild of all four packages. Same call `metric_point.agent` already makes. */
export type AgentTool = string;
export const KNOWN_AGENT_TOOLS = ['claude-code', 'opencode'] as const;

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
    queued:    ['running', 'cancelled'],
    running:   ['queued', 'succeeded', 'failed', 'cancelled'],
    succeeded: [],
    failed:    [],
    cancelled: [],
};

export const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
    claimed:   ['running', 'failed', 'cancelled', 'lost'],
    running:   ['succeeded', 'failed', 'timed_out', 'cancelled', 'lost'],
    succeeded: [], failed: [], timed_out: [], cancelled: [], lost: [],
};

export function canTransition<S extends string>(
    table: Readonly<Record<S, readonly S[]>>, from: S, to: S): boolean;
```

Re-export every symbol from `core/src/index.ts`, or the server sees "module has no exported member".

`AgentRunSpec`, `AgentRunPlan`, `AgentResult`, `RunEnvelope` and `AgentAdapter` also live in this file
but are specified by [02](02-adapters.md); add them there rather than guessing here.

### Why the transition tables are data

So `npm test` can assert them with no database and no controller. See §7.

### Decisions

- **No task-level `claimed` status.** A claimed task the controller then abandoned is
  indistinguishable from a running one by status; the *lease* is what detects it. *Rejected:* a
  `claimed` status, which needs its own reaper predicate and gives two ways to express one fact.
- **No `canceling` status.** Cancellation is `cancel_requested_at` on a row that stays `running`. A
  status can get stuck if the controller dies and a stuck `canceling` reads as a bug; a timestamp on
  a `running` row is unambiguous, and it is what lets `POST /cancel` answer an honest **200 when it
  really stopped** vs **202 when it was only requested** ([06](06-api-and-auth.md)).
- **`lost` is not folded into `failed`.** "The agent exited non-zero" and "we never found out" are
  different facts, and only one of them is worth retrying.
- **Terminal is terminal.** A row that read `succeeded` and later `failed` makes every historical
  figure unreproducible. Enforced by compare-and-set in the store (§5), not by a trigger — a trigger
  would make the rule invisible at the call site.

---

## 3. `server/migrations/006_agent_tasks.sql`

Two tables. **A task retried is not the same task**: its token spend, its commits and its session id
are all per-run, so runs get their own table.

### Decisions up front

| Question | Answer | Rejected |
| --- | --- | --- |
| Hypertable? | **Plain tables.** `004_pull_requests.sql` already states the rule: hypertables are for genuine append-only series, and `metric_point` is the only one. A task is dimensional — created once, mutated for minutes. | A hypertable on `created_at`: the queue would need `created_at` in every unique constraint and the claim's `for update` would fight chunk exclusion for no gain. |
| `org_id` leading the key? | **Yes**, `primary key (org_id, id)` even though `id` is a uuid. Every read is org-scoped — the queue claim most of all — so leading it makes the queue index a prefix scan of the partition rather than scan-then-filter. That is exactly what `005` rewrote eleven keys to buy. | `id uuid primary key` with `org_id` as a plain column: the claim becomes a filter over a global index, i.e. one org's backlog paged past another's. |
| Boot adoption? | **No — and none exists anywhere anymore.** `agent_task.org_id` is `not null` with **no default**, so nothing can ever write `__unclaimed__` into it. This is a **third** distinct reason for absence, alongside `metric_point` (no `org_id`) and the four PR children (`on update cascade`). | Adding it "for symmetry": a permanent no-op statement that teaches the next reader the list means something it doesn't. |
| `agent_task_attempt` adopted at boot? | **No.** Its FK includes `org_id` with `on update cascade`, so it is the same case as `pr_review` — a child follows its parent, never an allowlist of its own. | — |

### `agent_task`

```sql
-- The intake row and the queue. One row per thing a human asked for; the runs live in
-- agent_task_attempt.
--
-- PRIVACY, stated so it is a decision and not an accident: `prompt` puts free text into the
-- database. docs/security.md is emphatic that OTEL_LOG_USER_PROMPTS must stay off precisely to keep
-- prompt text out of here — but that rule is about the AGENT's conversation (every user turn, every
-- assistant reply, every tool argument, arriving as a log-record body the attribute allowlist cannot
-- filter). This column is the opposite: one operator-authored intake string, which is the primary
-- record of what was asked, the only thing a retry can replay, and the only way an audit can answer
-- "what did this pod do". It is stored knowingly. The consequence is that "this database holds no
-- prompt text" stops being true, so anything that exported, dumped or backed up on that assumption
-- has to be re-read: see docs/security.md. The three OTEL_LOG_* switches stay 0 in the pod
-- regardless — agent transcripts are still not stored, and error_message/final_message are truncated
-- for the same reason.
create table if not exists agent_task (
    org_id              text        not null,
    id                  uuid        not null,

    -- Intake. Snapshotted, never re-read from config: a config change must not retroactively alter
    -- what a queued task was authorised to do.
    repo                text        not null,   -- "owner/name", validated against organization.repos
    base_branch         text        not null,
    tool                text        not null,   -- plain text, like metric_point.agent
    invocation_kind     text        not null,
    invocation_name     text,
    invocation_args     text,
    prompt              text        not null,   -- '' is legal for a bare command
    permission_mode     text        not null,
    mcp_servers         jsonb       not null default '[]',  -- NAMES ONLY, resolved against config
    model               text,
    timeout_seconds     integer     not null,
    max_attempts        integer     not null,

    -- Audit. NOT NULL on purpose: an unattributable request to execute an arbitrary prompt on a
    -- machine with push credentials is exactly the one you most need attributed.
    requested_by        text        not null,
    client_key          text,

    -- Queue state
    status              text        not null,
    attempts            integer     not null default 0,
    priority            integer     not null default 0,
    run_after           timestamptz,
    cancel_requested_at timestamptz,
    revision            bigint      not null default 0,

    -- Mirror of the winning attempt, so a list page needs no join
    result_status       text,
    result_branch       text,
    result_head_sha     text,
    result_commits      integer,
    error_code          text,
    error_message       text,       -- truncated by the store, never raw agent output

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    started_at          timestamptz,
    finished_at         timestamptz,

    constraint agent_task_pk primary key (org_id, id),
    constraint agent_task_status_ck   check (status in ('queued','running','succeeded','failed','cancelled')),
    constraint agent_task_kind_ck     check (invocation_kind in ('prompt','command','skill')),
    -- A command or skill has a name; a bare prompt does not. Enforced here because the API's 400 is
    -- the only other place that knows it, and a CLI writing rows directly would not.
    constraint agent_task_name_ck     check ((invocation_kind = 'prompt') = (invocation_name is null)),
    constraint agent_task_perm_ck     check (permission_mode in ('readOnly','acceptEdits','full')),
    constraint agent_task_attempts_ck check (attempts >= 0 and attempts <= max_attempts),
    constraint agent_task_maxatt_ck   check (max_attempts between 1 and 5),
    constraint agent_task_timeout_ck  check (timeout_seconds between 60 and 86400)
);

-- THE queue index. Partial on 'queued' so it stays the size of the backlog rather than of all
-- history — the difference between a 2s poll that is free forever and one that degrades.
create index if not exists agent_task_queue
    on agent_task (org_id, priority desc, created_at asc)
    where status = 'queued';

create index if not exists agent_task_listing   on agent_task (org_id, created_at desc);
create index if not exists agent_task_by_status on agent_task (org_id, status, created_at desc);

-- Idempotency. Partial, so a null client_key is not a conflict with every other null. A CLI that
-- times out and retries must not launch a second agent holding push credentials.
create unique index if not exists agent_task_client_key
    on agent_task (org_id, client_key) where client_key is not null;
```

`run_after` is **filtered, not indexed** — the partial index is already backlog-sized. Note it in a
comment so nobody "optimises" it into the index key and loses the `priority desc, created_at asc`
ordering.

### `agent_task_attempt`

```sql
create table if not exists agent_task_attempt (
    org_id            text        not null,
    task_id           uuid        not null,
    attempt_no        integer     not null,     -- 1-based, = agent_task.attempts after the claim
    status            text        not null,

    -- Kubernetes identity. job_name is DETERMINISTIC from (org, task, attempt) and the unique index
    -- below is what makes a controller that crashed between "create Job" and "record it" fail
    -- loudly on the retry instead of launching a second pod on the same branch.
    job_name          text,
    pod_name          text,

    -- THE join key to token spend. Pre-assigned when the tool accepts one (claude-code
    -- --session-id), otherwise filled from the result envelope. See §4.
    session_id        text,
    session_assigned  boolean     not null default false,

    -- A lease, not a status. A `claimed` row whose controller died is indistinguishable from a
    -- healthy one by status alone; the expiring lease is what tells them apart.
    lease_owner       text,
    lease_expires_at  timestamptz,

    -- Normalised result. EVERY quantity nullable: null means "not measured", never 0. Same contract
    -- as docs/telemetry.md — "0 tokens would assert the PR was written without AI".
    exit_code         integer,
    branch            text,
    base_sha          text,
    head_sha          text,
    commits           integer,
    files_changed     integer,
    final_message     text,
    final_message_truncated boolean not null default false,
    tool_version      text,
    result_schema     integer,
    result_parse      text,                     -- ok | degraded | missing
    failure_kind      text,                     -- agent | timeout | infra | lost
    error_code        text,
    error_message     text,

    started_at        timestamptz,
    finished_at       timestamptz,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),

    constraint agent_task_attempt_pk primary key (org_id, task_id, attempt_no),
    constraint agent_task_attempt_task_fk
        foreign key (org_id, task_id) references agent_task (org_id, id)
        on update cascade on delete cascade,
    constraint agent_task_attempt_status_ck
        check (status in ('claimed','running','succeeded','failed','timed_out','cancelled','lost')),
    constraint agent_task_attempt_parse_ck
        check (result_parse is null or result_parse in ('ok','degraded','missing')),
    constraint agent_task_attempt_kind_ck
        check (failure_kind is null or failure_kind in ('agent','timeout','infra','lost'))
);

create unique index if not exists agent_task_attempt_job
    on agent_task_attempt (org_id, job_name) where job_name is not null;

create index if not exists agent_task_attempt_session
    on agent_task_attempt (org_id, session_id) where session_id is not null;

-- What the lease reaper scans.
create index if not exists agent_task_attempt_lease
    on agent_task_attempt (org_id, lease_expires_at)
    where status in ('claimed','running');
```

- **No `agent_task_commit` child table.** `base_sha`..`head_sha` bounds the range, so the commit list
  is *re-derivable* from the git mirror — strictly better than a stored copy that can disagree, and
  the same reasoning as `branch_commit` storing `message_headline` instead of a precomputed
  `is_revert`. *Rejected:* a child table mirroring `pr_commit`; the 4 KB termination-message budget
  cannot carry the shas anyway ([05](05-job-and-runtime.md)).
- **No `agent_task_log` table.** `executor.store_logs` defaults false, so slice 1 never writes one,
  and a table nothing writes is a shape no consumer has validated. It lands in `008_agent_task_logs.sql`
  when a reader exists. *Rejected:* creating it now "so the privacy switch is config-only" — a schema
  change is cheaper than a wrong schema.

Also edit `server/src/db/migrate.ts`: extend the `ORG_OWNED` docblock with the third reason for
absence. **Do not add either new table to the array.**

---

## 4. `server/migrations/007_agent_tasks.repeatable.sql`

Joining a task to its token spend, which is awkward because `metric_point` has **no `org_id` and no
`repo`** — its organization arrives through `session_branch`.

**Is a session id knowable at launch time? Tool-dependent, and that asymmetry drives the design.**

- **claude-code: yes.** The CLI accepts `--session-id <uuid>`, so the controller generates the uuid at
  claim time and writes it onto the attempt *before the pod exists*. The join then survives the pod
  dying, being evicted, or never producing a result at all.
- **opencode: no.** `run --session <id>` continues an existing session rather than creating one with a
  given id. Its session id comes out of the result envelope, or not at all.

Hence `session_id` nullable, `session_assigned boolean` recording which path produced it, and
`AgentAdapter.acceptsSessionId` as the interface flag ([02](02-adapters.md)). When it is null, token
spend reports **null with a reason**, never 0.

**The controller writes the `session_branch` row itself** (`recordAttemptSession`, §5), reusing
exactly the upsert shape `createPostgresStore.recordBranch` uses in
`server/src/telemetry/store.ts`. Load-bearing, not bookkeeping: without it an executor pod's metrics
belong to *no* organization — invisible with one org, wrong with two — and executor work also
silently misses the existing `branch_field_total` panels. Corollary: **the agent-telemetry plugin
must not be installed in the executor image.** One writer.

```sql
drop view if exists agent_task_token_total;

-- Token spend per attempt.
--
-- Reads session_field_total, NEVER metric_point. That view is where the cumulative-vs-delta
-- reduction lives — a plain sum() over a cumulative series produces a plausible, wildly wrong number
-- with no error anywhere — and it is also what applies session_source, so a session covered by both
-- OTEL and a transcript is counted once.
--
-- The join is on session_id ALONE. metric_point.agent is derived from the metric NAME prefix
-- (agentOf() in metric-map.ts), so it is a property of the vendor's naming rather than of the tool
-- we launched: requiring it to equal agent_task.tool would make the join fail for exactly the tool
-- whose metric map has not been written yet. `observed_agent` exposes the mismatch instead.
--
-- org_id comes from the ATTEMPT, not from a join. That is the one place this differs from
-- session_summary, which has to read `org_id = $1 or org_id is null` because a datapoint's org is
-- recovered through session_branch. Here the executor created the session, so its organization is a
-- fact we already own.
create or replace view agent_task_token_total as
select
    a.org_id, a.task_id, a.attempt_no, a.session_id,
    min(t.agent) as observed_agent,
    sum(case when t.field = 'tokens_input'         then t.value end) as tokens_input,
    sum(case when t.field = 'tokens_output'        then t.value end) as tokens_output,
    sum(case when t.field = 'tokens_cacheRead'     then t.value end) as tokens_cache_read,
    sum(case when t.field = 'tokens_cacheCreation' then t.value end) as tokens_cache_creation
from agent_task_attempt a
join session_field_total t on t.session_id = a.session_id
where a.session_id is not null
group by a.org_id, a.task_id, a.attempt_no, a.session_id;
```

**Ordering is load-bearing and nothing else tests it.** Repeatable files run last regardless of
filename order, and within that group they run sorted — so `002_views.repeatable.sql` (which *drops*
and recreates `session_field_total`) runs before `007`. Pin it with an assertion in
`server/test-db/task-tokens.test.ts` that the view exists after `migrate()` runs twice.

---

## 5. `server/src/db/task-store.ts`

Model it line-for-line on `server/src/db/pr-store.ts`: `orgId` bound at construction, a `ready` gate,
and an interface the offline suite can implement in memory.

```ts
export interface AttemptRef { readonly taskId: string; readonly attemptNo: number }

export interface NewTask {
    readonly repo: string;
    readonly baseBranch: string;
    readonly tool: string;
    readonly invocation: TaskInvocation;        // from @factory-ai/core
    readonly prompt: string;
    readonly permissionMode: PermissionMode;
    readonly mcpServers: readonly string[];
    readonly model: string | null;
    readonly timeoutSeconds: number;
    readonly maxAttempts: number;
    readonly requestedBy: string;
    readonly clientKey: string | null;
    readonly priority: number;
}

export interface AttemptOutcome {
    readonly status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'lost';
    readonly failureKind: 'agent' | 'timeout' | 'infra' | 'lost' | null;
    readonly result: AgentResult | null;        // null for 'lost'
    readonly at: string;
}

export interface TaskStore {
    // ---------- intake (server) ----------
    /** `created: false` means the client_key already existed; the caller answers 200, not 201. */
    createTask(input: NewTask): Promise<{ task: AgentTask; created: boolean }>;
    getTask(id: string): Promise<AgentTaskDetail | null>;
    listTasks(query: TaskQuery): Promise<{ tasks: readonly AgentTask[]; nextCursor: string | null }>;
    /** Atomic. `cancelled: true` == it went terminal in this statement (200); false == only
     *  requested, a live attempt has to be torn down first (202). */
    requestCancel(id: string): Promise<{ task: AgentTask; cancelled: boolean } | null>;
    countCreatedSince(since: string): Promise<number>;

    // ---------- queue (controller) ----------
    claimTasks(o: { limit: number; owner: string; leaseSeconds: number; now?: Date }): Promise<readonly ClaimedTask[]>;
    /** false means the lease was stolen or the attempt went terminal — the caller must stop touching
     *  that Job, not retry the renewal. */
    renewLease(ref: AttemptRef, leaseSeconds: number): Promise<boolean>;
    recordLaunch(ref: AttemptRef, launch: { jobName: string; podName: string | null }): Promise<void>;
    /** Writes the attempt's session_id AND the session_branch row. Both, always: the second is the
     *  only thing that gives the pod's metrics an organization. */
    recordAttemptSession(ref: AttemptRef, s: {
        sessionId: string; assigned: boolean; repo: string; branch: string; at: string;
    }): Promise<void>;
    markRunning(ref: AttemptRef, at: string): Promise<void>;
    /** Also flips the task: succeeded / cancelled / requeued with backoff / failed. Guarded by
     *  `where status = 'running'`, so a duplicate report is a no-op rather than a resurrection. */
    completeAttempt(ref: AttemptRef, outcome: AttemptOutcome): Promise<AgentTask | null>;
    /** Attempts whose lease expired past the grace window -> 'lost'. Returns them so the controller
     *  can delete the Job BEFORE the task is retried. */
    reclaimExpired(o: { graceSeconds: number; limit: number; now?: Date }): Promise<readonly AttemptRef[]>;
    pendingCancellations(limit: number): Promise<readonly ClaimedTask[]>;
    tokenTotals(refs: readonly AttemptRef[]): Promise<ReadonlyMap<string, TaskTokens | null>>;
}

export function createTaskStore(o: {
    sql: Sql; orgId: string; ready?: Promise<unknown>;
}): TaskStore;
```

### The claim — one statement, and `skip locked` is the whole mechanism

```sql
with candidate as (
    select id from agent_task
     where org_id = ${orgId} and status = 'queued' and cancel_requested_at is null
       -- Ahead of the increment below, or a task at its budget violates
       -- agent_task_attempts_ck instead of being skipped.
       and attempts < max_attempts
       and (run_after is null or run_after <= ${now})
     order by priority desc, created_at asc
     limit ${limit}
     for update skip locked
), promoted as (
    update agent_task t
       set status = 'running', attempts = t.attempts + 1,
           started_at = coalesce(t.started_at, ${now}),
           revision = t.revision + 1, updated_at = ${now}
      from candidate c
     where t.org_id = ${orgId} and t.id = c.id
    returning t.id, t.attempts
)
insert into agent_task_attempt
    (org_id, task_id, attempt_no, status, lease_owner, lease_expires_at, created_at, updated_at)
select ${orgId}, p.id, p.attempts, 'claimed', ${owner},
       ${now}::timestamptz + make_interval(secs => ${leaseSeconds}), ${now}, ${now}
from promoted p
returning task_id, attempt_no;
```

Another replica's candidate rows are **invisible**, not contended — so two controllers never take one
task and neither waits. A plain `for update` would serialise them; no lock at all would double-run an
agent holding push credentials, which is the failure this whole design exists to prevent.

`attempt_no = agent_task.attempts` after the increment, so the number is derived from a counter the
same statement moved: no `max(attempt_no)` subquery and therefore no race. A second
`select * from agent_task where org_id = $1 and id in (…)` hydrates the rows inside the same
transaction.

### `completeAttempt` — the compare-and-set

```sql
update agent_task set
    status = case
        when ${outcome.status} = 'succeeded' then 'succeeded'
        when ${outcome.status} = 'cancelled' then 'cancelled'
        when attempts < max_attempts        then 'queued'   -- retry
        else 'failed' end,
    run_after = case when ${outcome.status} not in ('succeeded','cancelled')
                      and attempts < max_attempts
                     then ${now}::timestamptz + make_interval(secs => ${backoffSeconds})
                     else null end,
    revision = revision + 1,
    ...
where org_id = ${orgId} and id = ${taskId} and status = 'running'
returning *
```

The trailing `and status = 'running'` is the whole point. Same reasoning as `on conflict do nothing`
on `metric_point`: a duplicate report of a fact that already landed must be a no-op, not an update —
otherwise a cancelled task gets resurrected by a late result from the pod that was already killed.

`error_message` is truncated by the store (2 KB), never written raw. Agent stdout contains source code.

---

## 6. `memoryTaskStore()`

Add to `server/test/helpers.ts` beside `memoryPrStore()`, with the same shape: a `broken: boolean` to
force failures and a recorded call log.

**It must implement the claim honestly** — an in-flight `Set` of task ids, so the concurrency test in
`executor/test` means something. `docs/persistence.md` states the offline suite covers store *logic*
through the memory store and only the SQL needs a container; a memory store that hands the same task
to two callers makes that claim false.

---

## 7. Acceptance criteria

### `npm test` — offline, no token, no network, no database

| File | Must assert |
| --- | --- |
| `core/test/task-state.independent.test.ts` | The transition tables, with the test **declaring its own copy** so a wrong edit to `core/src/executor.ts` cannot hide — same construction and same reason as `metrics.independent.test.ts`. Plus: every terminal status has no outgoing edges; every status is reachable from `queued` (a status nobody can enter cannot be added by accident); `canTransition` is total over both enums. |
| `executor/test/task-store.memory.test.ts` | Two claimers never receive the same task. `attempt_no` numbering is 1-based and monotonic. `attempts < max_attempts` is honoured. `run_after` gating. Lease expiry → `lost` → requeue-or-fail depending on budget. A duplicate `completeAttempt` is a no-op. **A completion arriving after a cancel does not resurrect the task.** |

### `npm run test:db` — needs timescale, refuses any database not named `*_test`

| File | Must assert |
| --- | --- |
| `server/test-db/task-store.test.ts` | The real SQL. `beforeEach` adds `truncate agent_task cascade`. **Concurrent claim:** two `createTaskStore` instances on the same pool, N queued tasks, the claimed sets are disjoint and their union complete — this is the `skip locked` proof and it *cannot* be written offline. **Org isolation** via the existing `otherOrgStore` pattern: a second org cannot see, get, claim or cancel the first's tasks. `unique (org_id, job_name)` rejects a double-create. `client_key` partial unique allows many nulls and rejects a duplicate. Attempt rows cascade on task delete. Every check constraint rejects its bad case, including a `prompt`-kind row carrying a name. Lease reclaim. `migrate()` twice is a no-op. |
| `server/test-db/task-tokens.test.ts` | `agent_task_token_total`. Seed `metric_point` with **both** a delta series and a cumulative series spanning two `start_time`s, plus `session_branch`, plus an attempt; the joined total equals the hand-computed figure and **not** the naive sum. A second org's attempt carrying a colliding session id picks up nothing. An attempt with `session_id = null` yields no row, so the API reports null rather than 0. The view exists after `migrate()` — pinning that `002_views.repeatable.sql` runs before `007`. |

### Also

- `npm run typecheck` passes across four project references.
- `npm test` still passes with **no** database running. If any new test needs one, it is in the wrong
  suite.
- `docker compose up --build` still builds the dashboard image (proves the Dockerfile line landed).

## Files

**Create:** `executor/package.json`, `executor/tsconfig.json`, `executor/src/index.ts` (stub),
`core/src/executor.ts`, `server/migrations/006_agent_tasks.sql`,
`server/migrations/007_agent_tasks.repeatable.sql`, `server/src/db/task-store.ts`,
`core/test/task-state.independent.test.ts`, `executor/test/task-store.memory.test.ts`,
`server/test-db/task-store.test.ts`, `server/test-db/task-tokens.test.ts`.

**Modify:** `package.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.db.config.ts`,
`docker/Dockerfile`, `core/src/index.ts`, `server/src/db/migrate.ts` (docblock only),
`server/test/helpers.ts`.
