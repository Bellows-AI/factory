# Performance / correctness-adjacent audit

Scope: `server/src/db/*`, `server/src/routes/*`, `server/migrations/*.sql`, `driver/src/*`,
`web/src/*`, `core/src/index.ts`. Every finding below was verified by reading the code at the
cited line. Ranked by payoff.

---

## P1 — `useTasks` refetches N pages sequentially on every poll tick, depth uncapped

`web/src/api/useTasks.ts:253-295` (`rebuildTaskPages`), driven from `useTasks.ts:496-515`.

```ts
let cursor = first.page.nextCursor;
let pages = 1;
while (cursor !== null && pages < depth) {
    const next = await fetchPage(morePageUrl(query, cursor));   // sequential, one RTT each
    ...
}
```

- `depthRef` (`useTasks.ts:480`) starts at 1 and is incremented once per **Load more**
  (`useTasks.ts:578`). It is only reset on the lifecycle restart path (`useTasks.ts:437`) — i.e.
  on filter/enable change. There is **no cap**.
- The poll tick when anything is running is `VISIBLE_MOVING_POLL_MS = 3_000`
  (`useTasks.ts:298`, `useTasks.ts:514`).
- So a member who clicked *Load more* 10 times causes **11 sequential `GET /api/tasks` round
  trips every 3 seconds**, each one executing the full `listTasksOf` statement (see P2/P3) —
  latency is `11 × (RTT + query)`, and a slow tail page pushes the next tick out.

Fix directions (pick one, they are not equivalent):
1. Cap `depthRef` (a `MAX_REFRESH_DEPTH`), and let older pages go stale — matches the existing
   "the loaded depth collapses to what the list still serves" comment at `useTasks.ts:260`.
2. Refresh only page 1 on the tick; rebuild deeper pages on an explicit user refresh.
3. If all pages must be refreshed, at minimum the cursors after the first are *not* known ahead
   of time, so `Promise.all` is not available — this is inherently serial. That is the argument
   for capping rather than parallelising.

---

## P2 — Missing index behind the per-thread head resolution (`job`)

Two hot reads resolve "the newest run of each thread":

- `server/src/db/job-store-reads.ts:192-199`
  ```sql
  with head as (
      select distinct on (root_job_id) ...
      from job where org_id = $1
      order by root_job_id, created_at desc, id desc
  )
  ```
- `server/src/db/job-store-reads.ts:122-128` (the terminal-list lateral)
  ```sql
  join lateral (
      select h.* from job h
      where h.org_id = $1 and h.root_job_id = job.root_job_id
      order by h.created_at desc, h.id desc
      limit 1
  ) head on true
  ```
- `server/src/db/job-store-reads.ts:137-143` — the `done_by` lateral, same shape
  (`order by d.done_at desc, d.id desc limit 1`).

The only index on that key prefix is `job_org_root` — `(org_id, root_job_id)`,
`server/migrations/022_job_root.sql:31-33`. It carries **no** `created_at`/`id`, so both the
`distinct on` and each lateral need a sort/extra heap fetch rather than an index-ordered first
row.

Proposed: `create index job_org_root_recent on job (org_id, root_job_id, created_at desc, id desc)`.
It supersedes `job_org_root` as a prefix, so `job_org_root` can be dropped in the same migration
(no-backward-compat rule applies). Measure with `EXPLAIN (ANALYZE, BUFFERS)` on a seeded
`factory_seed` before committing the number — `docs/limits.md` rules apply.

---

## P3 — `listJobs(status: 'terminal')` scans the org's whole job history per call

`server/src/db/job-store-reads.ts:77-94`:

```sql
with finished_thread as (
    select root_job_id, sum(wall_clock_ms), max(done_at), max(finished_at)
    from job
    where org_id = $1
    group by root_job_id
    having count(*) filter (where status not in ('succeeded','failed','dead','stopped')) = 0
)
```

There is no `created_at` bound and no pre-filter — the aggregate touches **every row the org has
ever had** before the `limit` at line 104 applies. The in-file comment (lines 79-83) argues the
rollup "rides the terminality scan", which is true, but the scan itself is unbounded and grows
monotonically with retention. `useCompletedJobs` polls this.

Cheapest mitigation without changing semantics: add a `created_at > now() - interval` floor
derived from the caller's range, or materialise thread terminality. Either needs a decision, not
a mechanical edit — flagging, not fixing.

---

## P4 — A database outage is reported to the SPA as "not signed in"

- `server/src/routes/auth.ts:314` — `GET /api/auth/me`:
  ```ts
  const caller = await resolveUser(request).catch(() => null);
  if (!caller) return reply.code(HTTP_OK).send({ authenticated: false });
  ```
- `server/src/routes/auth.ts:256` — `handleSwitchOrg`: same `.catch(() => null)`, then 401.

The 200-instead-of-401 decision (comment at `auth.ts:315-318`) is about *unauthenticated*
callers and is sound. The problem is the `.catch(() => null)`: it collapses "this credential is
not valid" and "the session store could not be reached" into the same answer, **with no log
line**. Operationally that reads as "everyone got logged out" with nothing in the logs.

Fix: distinguish. Log the error (`request.log.error({ err })`) and answer 503 on a store failure,
keeping `authenticated: false` for a genuinely absent/invalid credential.

---

## P5 — Boot-time org warm swallows its error with no log

`server/src/main.ts:117`:

```ts
void ready.then(() => orgs.warmAll()).catch(() => {});
```

Every other fire-and-forget in this codebase logs — compare `server/src/orgs.ts:202-207`:

```ts
void stores.workflows.seedBase().catch((e: Error) => console.error(`[workflows] seed failed: ${e.message}`));
void stores.cloneQueue?.start().catch((e: Error) => console.error(`[workspace] ${e.message}`));
```

A failed warm is silent and the only symptom is a slow first page load. Add the same
`console.error` / `app.log.error` shape.

Same class, lower stakes: `server/src/workspace/queue.ts:144` —
`await store.markFailed(...).catch(() => {})`. If `markFailed` fails the row stays `cloning`
forever with nothing said; it self-heals only at the next boot recovery (`queue.ts:195-200`).
One log line.

---

## P6 — `replaceTrackedRepos`: one INSERT per repo inside a transaction

`server/src/db/tracked-repos.ts:41-54`:

```ts
await sql.begin(async (tx) => {
    await tx`delete from tracked_repo where org_id = ${orgId}`;
    for (const repo of repos) {
        ...
        await tx`insert into tracked_repo (org_id, owner, name) values (...)`;
    }
});
```

One round trip per repo. `repos` is the org's installation listing selection — hundreds is
realistic for a large App install. Collapse to a single multi-row insert
(`sql(rows)` — the codebase already does this at `server/src/backfill/transcripts.ts:222`:
`insert into metric_point ${sql(batch)}`). Onboarding-path only, so the payoff is latency of one
screen, not steady state.

---

## P7 — `signIn`: two statements per installation

`server/src/auth/store.ts:282-294`:

```ts
for (const org of installations) {
    await sql`insert into organization ... on conflict (id) do update ...`;
    await sql`insert into org_membership ... on conflict (org_id, user_id) do update ...`;
}
```

`2 × installations.length` round trips per sign-in, and it runs on **every** sign-in, not only
the first. Both are upserts with no cross-row dependency: each collapses to one multi-row
`insert ... on conflict do update`. Note the ordering constraint — `organization` must land
before `org_membership` (FK), so it stays two statements, not one.

---

## P8 — `refreshOrgRepoCaches`: sequential GitHub round trips per org

`server/src/routes/auth-onboarding.ts:177-186`:

```ts
for (const orgId of orgIds) {
    const runtime = await orgs?.for(orgId);
    if (!runtime) continue;
    runtime.repos.invalidate();
    await runtime.repos.list();     // a GitHub installation listing — seconds, not ms
    runtime.repos.invalidate();
}
```

The per-org work is independent (different runtimes, different installations). The
invalidate/list/invalidate ordering *within* one org is load-bearing (the comment at lines
174-184 explains it), but across orgs nothing is. `Promise.all(orgIds.map(...))` turns
`n × listing` into `1 × listing`, on the onboarding-completion critical path.

---

## P9 — `orgs.warmAll()` warms orgs one at a time

`server/src/orgs.ts:246-251`:

```ts
for (const org of await this.list()) {
    const rt = await this.for(org.id);
    rt?.service.ensureFresh();
}
```

`this.for()` is a cached promise but a **cold** one triggers `build(orgId)`, which is real work.
Independent per org → `Promise.all`. Boot path; the whole point (line 114-116 comment) is to
beat the first visitor to the cold read, and serialising defeats that for org #2 onward.

---

## P10 — `boardsFor`: sequential `orgs.for` across every org

`server/src/routes/job-context.ts:25-31`:

```ts
for (const org of await orgs.list()) {
    const rt = await orgs.for(org.id);
    if (rt?.jobs) boards.push(rt.jobs);
}
```

Independent lookups → `Promise.all`. Low payoff once runtimes are warm (cached promises), but
this is the **worker claim** path and it runs on every driver poll; at cold start it serialises
every org's `build()`.

Note: `scanBoards` (`job-context.ts:56-74`) is *correctly* sequential — first claim wins, and
parallelising it would claim from several boards at once. Do not touch it.

---

## P11 — Unbounded telemetry reads

`server/src/telemetry/postgres-client.ts`:

- `tx<FieldRow[]>`select session_id, field, value from session_field_total`` — **no org filter,
  no limit, whole view**. The in-place comment justifies it ("no org column by design ... only
  the ids present in the filtered summaries above are ever read out of it"), which explains the
  missing filter but not the missing bound: every org's every session's every field crosses the
  wire on each cache miss. `session_field_total` is a view over `metric_point_used`
  (`server/migrations/002_views.repeatable.sql:89-99`).
- The summaries query joins a subquery that does `group by org_id, session_id` over `job` with
  **no supporting index** — the file says so itself (`postgres-client.ts:93-95`: "The subquery
  groups job on (org_id, session_id) with no index behind it ... add one only when a real
  deployment measures this read"). That is an explicit, documented deferral — listed here so it
  is in one place, not as a defect.

The read is cooldown-gated by `stats-service`'s cache, so this is a growth risk rather than a
per-request cost. Bounding `session_field_total` to the session ids actually needed
(`where session_id = any($1)`) is the mechanical win.

---

## P12 — Dead re-exports in `core/src/index.ts`

Five symbols are exported from `core/src/index.ts` and imported by **nothing** in `server/`,
`web/`, `driver/`, or any test — verified by scanning every `.ts`/`.tsx` under
`core/{src,test}`, `server/{src,test,test-db}`, `web/{src,test}`, `driver/{src,test}`:

| Symbol | Home | Note |
| --- | --- | --- |
| `RANGE_PRESETS` | `core/src/range.ts:5` | used internally by `isRangePreset` (`range.ts:27`) — drop the re-export, keep the const |
| `ROLES` | `core/src/roles.ts:7` | used internally to derive `ADMIN_ROLE`/`MEMBER_ROLE` (`roles.ts:11`) — same |
| `seriesGranularity` | `core/src/telemetry.ts:97` | used internally at `telemetry.ts:231` — same |
| `TelemetryStatsOptions` (type) | `core/src/telemetry.ts:55` | internal parameter type only |
| `TaskUsageOptions` (type) | `core/src/task-usage.ts:3` | internal parameter type only |

None of these should be *deleted* — each has an in-file caller. What is dead is the
`core/src/index.ts` line (lines 9, 13, 21, 22, 24). Removing them narrows the public surface and
costs nothing.

---

## Checked and clean — do not "fix" these

Recording the negatives so the next pass does not re-litigate them.

- **Driver fire-and-forget is safe.** Every `void f()` in `driver/src` either has a `.catch` or
  calls a function that cannot reject: `deleteJob`/`deleteSecret` swallow via
  `.then(() => undefined, () => undefined)` (`driver/src/k8s-auxspec.ts:393-411`); `dockerKill`
  (`driver/src/docker-runner.ts:127-160`) and `dockerServiceTeardown`
  (`docker-runner.ts:107-125`) guard every `execDocker` with `.catch`. No unhandled-rejection
  path found.
- **`driver/src` sequential awaits are all dependent.** A scan for adjacent `const x = await …`
  pairs with no data dependency turned up only `k8s-gates.ts:237-238` and
  `k8s-runner.ts:244-245`, and both pass the first result (`succeeded` / `jobSucceeded`) into the
  second call. `loop-run.ts:556` likewise feeds `helperFailure` forward.
- **`server/src/routes/job-handlers-worker.ts:61-62`** awaits `workflowsFor` then
  `workflowDefaultsFor`; both resolve the *same* cached `orgs.for(orgOf(request))` promise, so
  `Promise.all` would buy nothing.
- **React render work is clean.** No expensive `sort`/`filter`/`reduce` in a component body
  outside `useMemo` (the two hits — `pages/SettingsLayout.tsx:66`, `panels/TaskOutcome.tsx:218` —
  are function *definitions*, not per-render computation). No missing-dep effect refetch loops:
  every polling hook in `web/src/api/` drives its chain from a stable `useCallback` with a
  `useRef`-held cursor, and the poll intervals are already visibility-adaptive
  (`useTasks.ts:298-310`, `useJobs.ts:192-193`, `useDefaultWorkflowSettings.ts:7-8`). The one
  real problem in the web layer is P1, which is a request-count issue, not a render issue.
- **`scanBoards`** (`job-context.ts:56-74`) and **`workspace/queue.ts:120-150`** are
  deliberately not `Promise.all`ed, and both carry the comment explaining why
  (`queue.ts:109-119` is explicit that `Promise.all` made concurrency effectively one). Leave
  them.
- **`sql.begin` loops** in `db/workflow-blocks/runtime.ts:201` and
  `db/workflow-blocks/runtime-settle.ts:78` iterate under advisory locks — serialisation is the
  point.

---

## Suggested order

1. P1 (cap refresh depth) — biggest single reduction in request volume, web-only change.
2. P12 (dead re-exports) — zero risk, one file.
3. P4 + P5 (log the swallowed failures) — small, and they are what makes the rest debuggable.
4. P2 (the index) — needs an `EXPLAIN ANALYZE` measurement before the migration lands.
5. P6–P10 (the `Promise.all` / multi-row-insert batch) — mechanical, each independently testable.
6. P3, P11 — need a semantics decision first; do not start with these.
