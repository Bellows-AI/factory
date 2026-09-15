## Context

The stats pipeline is: postgres views → `fetchRollups()` → cached `TelemetryInput` (session list,
TTL 30s, keyed by nothing) → read-time `filterTelemetryInput(range)` + `telemetryStats(repos)` →
`/api/stats`. The cache holds the unfiltered input precisely so every range is served from one
read; any new dimension must follow that shape. Telemetry sessions today carry no owner and no
task; the job board already records `job.session_id` (both CLIs — opencode's id is scraped and
stored), `job.created_by`, `job.root_job_id`, org-scoped, indexed on `(org_id, created_by,
created_at)`. Issue #67 will add ingest-time attribution on `session_branch`; that work is in
progress and this change must not duplicate or pre-empt it. Aggregation invariants live in
docs/metrics.md and docs/date-range.md (null-not-zero, gap seeding, four token types never summed,
no monetary fields, bucketing in core never `time_bucket()`).

## Goals / Non-Goals

**Goals:**

- Attribution resolved at read time, retroactive over existing history, consuming #67's column
  when it exists and bridging with the job join until then.
- Scope (`org` / `mine`) and the task-stats block served from the one cached fetch, like ranges.
- Agent turns counted from each CLI's own session records at run close, stored on the job row,
  reported as a distribution distinct from job turns (runs).
- Daily series with the weekly invariants carried over, generalized rather than forked.
- One terminology rule, written down once, that keeps job turns and agent turns from ever being
  conflated again.

**Non-Goals:**

- Ingest-time attribution itself (#67 owns it).
- Reading the transcript store (`add-executor-transcript-store`) — this change counts turns at
  close, before that store is even implemented; the store remains the future richer source (full
  transcripts, not a count) and can supersede the close-time read without changing the reported
  definition.
- Agent turns for laptop/hook sessions — no close-time record exists to count; a future ingest
  change would have to add a source.
- Cache efficiency, outcome mix, per-repo/per-member panels, hourly buckets for the day preset.
- Identity for laptop/hook sessions — the dropped `user.*` attributes stay dropped.

## Decisions

### 1. Attribution: a session→(member, task) map fetched beside the rollups, ingest-time preferred

The postgres client runs one extra query per fetch:

```sql
select session_id, min(created_by) as user_id, min(root_job_id) as task_id
from job where org_id = $1 and session_id is not null
group by session_id
```

`min()` collapses follow-up rows (author-guarded, same root, so all rows of a session agree).
The map enriches each `SessionRollup` with `userId`/`taskKey`. When #67's `session_branch` user
column exists, the summaries query coalesces it ahead of the join — one seam, one query, ingest
wins because it survives thread removal (the board deletes job rows on `remove`; the store does
not delete sessions).

Alternatives considered: a web-side join of two endpoints (breaks the one-read cache design and
moves aggregation out of core); teaching the branch reporter to carry identity now (duplicates
#67, covers only future runs). The join covers history with zero ingest surface and no migration.

### 2. Scope is a read-time option on `telemetryStats`, mirroring `repos`

`telemetryStats(input, { repos, now, user? })`: a session counts toward totals when its `userId`
matches, exactly as repo scoping buckets today. Unattributed sessions become a third named
exclusion beside `otherRepoSessions` and `sessionsWithoutHook` — the existing
three-distinguishable-failures pattern extends to four. The route takes `?scope=org|mine`,
resolves the caller from the signed-in session user, and answers `400 SCOPE_REQUIRES_USER` for
`mine` without one (honest error over silently serving org figures under a personal heading — the
same reasoning `resolveOrg` applies to unknown orgs). `meta` carries the scope and the resolved
login. Coverage stays unfiltered, per docs/date-range.md.

### 3. Task stats: raw per-run rows cached in the snapshot, distributions computed in core

The stats service's fetch additionally reads `select root_job_id, created_by, created_at,
agent_turns from job where org_id = $1` into the cached snapshot (beside `TelemetryInput`, same
TTL — it is one round-trip against an indexed table at a volume where the session read is already
single-digit-ms). Core gets a pure `taskUsageStats(sessions, runs, { user? })`:

- per-task tokens: `input + output` summed over the task's attributed sessions surviving the range
  filter (the overlap rule already ran; `taskKey` travels on the rollup so no second filter);
- job turns per task: rows with `created_at` inside the range;
- agent turns per task: sum of `agent_turns` over those rows — but a task with any in-range
  unmeasured run is excluded from this distribution only (a partial sum presented as a total is a
  quiet undercount), while still counting in the token and job-turn distributions;
- avg / nearest-rank p50 / p95 per figure over tasks, null-token tasks excluded (not zeroed),
  per-figure task counts surfaced.

Nearest-rank (`ceil(p·N)`-th of the ascending sort) because it is reproducible in the independent
recomputation suites without a percentile library. Distributions render as cards + counts; a
histogram can come later without payload changes.

### 4. Agent turns: counted at run close by each executor, stored on the job row

No OTLP metric carries turns — the arriving metric set is closed (`claude_code.token.usage`,
`lines_of_code`, `code_edit_tool.decision`, `active_time`, `commit.count`, `session.count`, plus
opencode's mirrors and an unmapped `opencode.pull_request.count`; verified against the live
store). So the count comes from the session records each CLI already leaves behind, taken at run
close by the driver, which owns the lifecycle:

- **opencode**: `opencode-readout.cjs` already walks the root session's message rows and skips
  non-assistant entries — counting assistant response cycles is a counter in the existing loop,
  reported on the readout's JSON line. No new read, no new container.
- **claude-code**: the transcript lives at `<CLAUDE_CONFIG_DIR>/projects/*/<sessionId>.jsonl`
  inside the runner container. The driver execs a new script file (the `remote-session.sh`
  precedent: a real file under `driver/src/scripts/`, passed by content, POSIX/node-portable) once
  the run exits and before container teardown, counting assistant entries of the run's session id.
  A killed or already-gone container answers null — unmeasured, never zero.

The count rides the existing completion report (`POST /api/jobs/:id/complete` gains an optional
`agentTurns`), and the board stores it on a new nullable `job.agent_turns` — this change's only
migration. Null means "not measured" (read failed, killed first, Remote Control, pre-change rows);
zero means a genuine zero-assistant-response run. Remote Control runs keep interactive sessions
whose conversation continues after any single read, so they stay null rather than freezing a
mid-conversation count — a parked session's turns can be banked at the park later if that turns
out to matter. Kubernetes parity: the close-time exec becomes a pod exec against the runner pod
before deletion, same script, same report, same null-on-failure — stated here so the k8s twin is
part of this change, not a follow-up discovered by a user.

An agent turn is defined once, symmetrically for both CLIs: **one assistant response cycle in the
run's root conversation** — subagent/task-tool child conversations excluded (the opencode readout
already scopes to the root session by `parent_id is null`; the claude script matches the run's
session id only). When the transcript store lands, its richer records can supersede the close-time
read without changing this definition — only the source moves.

Alternatives considered: deriving turns from token-usage delta exports (no per-turn boundary
exists in OTLP — rejected); reading the transcript store (not implemented yet, 0/11 tasks — a
hard dependency for a number countable today — rejected); counting in the runner entrypoint (the
entrypoint never fails the run and prints nothing — telemetry posture; the driver owns the
lifecycle and already owns the close-time reads — rejected).

### 5. Terminology: "job turn" and "agent turn" defined once, in docs

The two terms are defined in a terminology block in docs/metrics.md (where the dashboard's figures
are specified), cross-referenced from docs/jobs.md (where runs and follow-ups are specified), and
mirrored in the spec above: a **job turn** (product word: "run") is one job row in a thread — the
member delivering one prompt; an **agent turn** is one assistant response cycle in the run's root
conversation. The rule the block enforces: no payload field, UI label, or doc sentence says a bare
"turns" — every figure names its kind. The dashboard panel labels follow it ("runs per task",
"agent turns per task"), and code review treats an unqualified "turns" as a wording bug.

### 6. Daily series: one generalized bucketing path, granularity chosen by window span

`weeklySeries` generalizes to `bucketSeries(sessions, granularity, now)` with `dayStart`/`dayKey`
added beside `weekStart`/`isoWeekKey` in `core/src/metrics.ts` (the docs/metrics.md rule: core,
never `time_bucket()`). The payload replaces `weekly: TelemetryWeekPoint[]` with
`series: { granularity: 'day' | 'week', points: TelemetryPoint[] }` — a rename, deliberately not
compatibility-shaped (AGENTS.md: no shims); TokenUsagePanel and the tests are updated in the same
change. Granularity rule: day when the window (or, for all-time, the coverage span) is ≤ 92 days,
week beyond. The blurb and labels render from `granularity`, which is what makes the fallback a
statement rather than a lie.

### 7. Web: a scope toggle, absent rather than disabled without a session

The dashboard grows `Org | Me` beside the RangeSelector. `Me` renders only when the session hook
reports a signed-in user (already available via the auth session); under `AUTH_MODE=none` the
toggle does not exist, because no "me" does. The per-task panel renders under both scopes from the
same payload block.

## Risks / Trade-offs

- [Risk] The claude-code close-time exec races container teardown or a killed run → the read is
  best-effort before teardown on every settle path that reaches it; a missed read stores null and
  the task drops out of the turn distribution only — tokens and runs still count, per the
  per-figure exclusion rule.
- [Risk] k8s pod exec differs from docker exec in failure modes (pod terminating, no shell) →
  same null-on-failure contract, pinned in the k8s runner's tests like the remote-session read.
- [Risk] Remote Control sessions under-report turns (null by design) → stated in the panel's
  note and in docs; a park-time bank is a follow-up if it matters.
- [Risk] The assistant-entry count drifts if a CLI changes its transcript/session record shape →
  the scripts pin the exact shapes they parse (the house rule for container scripts); a parse
  miss is null, not a wrong number.
- [Risk] #67's column lands with a different name or shape than assumed → the coalesce seam is one
  query in one client; adjusting it belongs to whichever change lands second, and until it lands
  the join is the sole source — stated, not hidden.
- [Risk] Session ids could collide across orgs (both CLIs mint ids generously but not
  universally) → the join is org-scoped (`where org_id = $1`), same partitioning every job read
  already applies.
- [Risk] Removed threads lose attribution (job rows deleted) → spec'd as unattributed; #67's
  ingest path is the durable fix; tokens still count in org totals either way.
- [Risk] p95 over few tasks reads as settled → N is surfaced beside every distribution.
- [Risk] Unmapped opencode token rows make tasks vanish from distributions → excluded-not-zeroed,
  the established null contract; the empty-vs-zero panel state names it.
- [Risk] Daily buckets at the edge of the 92-day rule look sparse next to weekly → the granularity
  is named in the payload and rendered in the chart labels, so the switch is visible.
- [Trade-off] Two attribution sources to keep coherent → precedence is fixed (ingest wins), one
  seam, and the db suite pins both paths including the disagreement case.

## Migration Plan

One migration of our own: `job.agent_turns` (nullable int, null = unmeasured). The attribution job
join reads existing columns; #67 owns any schema there. Deploy order is free — the report field is
optional and unknown pre-change rows read as null. Rollback is revert. If #67 lands first, this
change's coalesce arm activates against its column in the same PR that renames the seam.

## Open Questions

- The exact #67 column name on `session_branch` (assumed `user_id` here) — answerable when #67
  lands; does not change the approach or the task breakdown.
- Whether the per-task panel later wants a histogram beside the cards — payload already carries
  per-task totals implicitly through the distributions; additive, defer.
