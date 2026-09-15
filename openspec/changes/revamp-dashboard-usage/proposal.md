# Proposal: revamp dashboard usage — org/my split, per-task stats, daily series

## Why

The dashboard measures consumption and nothing else, at a granularity nobody acts on. It cannot
answer "what did *I* use" (telemetry sessions carry no owner), it cannot answer "what does a task
cost" (no per-task figures exist anywhere in the payload), and its one chart buckets by ISO week,
which hides the day-to-day variance that is the actual signal. Issue #67 (in progress) threads
member identity into session reporting at **ingest time** — future runs only — but the dashboard
needs a **read path** and coverage of existing history, neither of which #67 includes.

## What Changes

- **Read-side session attribution**: `SessionRollup` gains `userId` and `taskKey` (the job
  thread's `root_job_id`). The postgres telemetry client enriches sessions by joining
  `job.session_id → (created_by, root_job_id)` — retroactive over all existing rows, both CLIs
  (opencode ids are scraped and stored the same way), no ingest changes. When #67's ingest-time
  attribution lands on `session_branch`, it takes precedence for new sessions (it survives thread
  removal, which deletes job rows); the join remains the fallback and the bridge for history.
- **Org vs my usage**: `/api/stats` gains a `scope` dimension (`org` default, `mine` = the signed-in
  caller). Filtering happens at read time over the cached `TelemetryInput` — the same shape as the
  range filter, so no new cache slot. The dashboard grows an org/my toggle. Sessions with no
  attributable owner (laptop/hook sessions, whose identity attributes are dropped on purpose —
  docs/telemetry.md) count in the org scope and render as an explicit *unattributed* figure, never
  silently inside "mine". Under `AUTH_MODE=none` there is no "me"; the toggle is absent, not
  disabled.
- **Per-task usage stats**: a new panel reporting avg / p50 / p95 per task for three figures —
  tokens, **job turns** (runs), and **agent turns** — over the selected range. The two turn kinds
  are distinct measurements and are never conflated (see the terminology rule below). "Task" =
  job thread (`root_job_id`). Per-task token totals are `input + output` summed over the thread's
  sessions; sessions with null tokens are excluded from the distribution, never counted as zero.
  The panel surfaces N (tasks measured) so a p95 over five tasks cannot masquerade as a statistic.
- **Agent turns counted at run close**: no OTLP metric carries turns (the arriving metric set is
  closed — verified against the live store), so each executor counts agent turns from the session's
  own records at close — opencode from the session database the readout already walks, claude-code
  from its transcript read before container teardown — and the driver reports the count on the
  completion report; the board stores it on the job row. An agent turn is one assistant response
  cycle in the run's root conversation (subagent conversations excluded); unmeasured runs report
  null, never zero, and a task with any unmeasured run is excluded from the agent-turn
  distribution rather than summed partially.
- **Turn terminology guideline**: "job turn" (a run — one job row, one delivered prompt) and
  "agent turn" (one assistant response cycle inside a session) are defined once in docs, and every
  figure, label and doc sentence names which kind it means — a bare "turns" is a bug in wording,
  not a shorthand.

**Terminology (binding for this change):**

| term | meaning | counted from |
| --- | --- | --- |
| job turn (product word: "run") | one job row in a thread — the first run or a follow-up | the board's own rows |
| agent turn | one assistant response cycle in the run's root conversation | the session's records, at close |

- **Daily chart series**: the token usage chart buckets by day instead of ISO week, with the
  existing invariants carried over (every day in the window seeded including quiet ones, `partial`
  = today, bucketing in core beside `weekStart`/`isoWeekKey`, never `time_bucket()`). Windows
  longer than 92 days fall back to weekly buckets — a year of daily bars in a fixed-width chart is
  hairline, not information.

Non-goals (candidates for follow-up changes, deliberately out of scope): cache-efficiency ratio,
task outcome mix (success rate, dead tasks, wall-time distributions — data already banked on the
board), per-repo and per-member breakdowns, agent turns for non-executor sessions (laptop/hook
sessions have no close-time record to count — they gain turns only if a future ingest change adds
a source), reading transcripts from the `add-executor-transcript-store` volume (this change counts
at close instead; the store remains the future richer source), hourly granularity for the Today
preset, monetary figures (permanent non-goal, docs/metrics.md).

## Capabilities

### New Capabilities

- `usage-attribution`: agent sessions are attributed to a member and a task at read time, from the
  job join now and from #67's ingest-time attribution when it lands; `/api/stats` can scope
  figures to the signed-in caller.
- `task-usage-stats`: per-task usage distributions — tokens per task (avg, p50, p95), job turns
  (runs) per task, and agent turns per task as a distinct, separately-counted figure — over the
  selected range, with the null-not-zero and N-surfacing contracts.
- `daily-usage-series`: the usage chart is bucketed daily (weekly beyond 92 days), with gap-seeding
  and partial-day semantics.

### Modified Capabilities

<!-- openspec/specs/ is empty; no existing capability's requirements change. -->

## Impact

- `core/src/types.ts` (`SessionRollup.userId`/`taskKey`, series and stats payload types),
  `core/src/telemetry.ts` (distribution math, daily series, scope filter),
  `core/src/metrics.ts` (day bucketing), `core/src/index.ts` re-exports.
- `server/src/telemetry/postgres-client.ts` (the job join; prefers `session_branch` attribution
  once it exists), `server/src/stats-service.ts` (read-time scope filter, task-stats block from
  the job store), `server/src/routes/stats.ts` (`scope` query param, caller resolution).
- Agent-turn plumbing: a migration adding `job.agent_turns` (nullable int), the completion report
  accepting an optional `agentTurns`, `driver/src/scripts/` gaining the claude-code transcript
  turn-count read (a real script file, passed by content — the `remote-session.sh` precedent) and
  `opencode-readout.cjs` gaining the counter, with the kubernetes twin of the close-time read
  (executor parity, docs/kubernetes.md).
- `web/src`: dashboard org/my toggle, per-task stats panel (tokens, runs, agent turns — labeled
  distinctly), daily chart wiring.
- Docs: the job-turn/agent-turn terminology block (docs/metrics.md, cross-referenced from
  docs/jobs.md), plus docs/metrics.md attribution/date-range updates.
- Tests: core pure-aggregation suites (distribution null rules, daily seeding, scope filter,
  agent-turn exclusion), driver script suites (turn-count readouts, report shape), server db suite
  (join attribution incl. follow-up chains and removed threads; agent_turns storage), web render
  smoke.
- Coordination: issue #67 (ingest attribution — this change consumes its column, does not create
  it; until it lands the join is the only source and that is stated, not hidden),
  `add-executor-transcript-store` (independent: that change persists transcripts for later richer
  analysis; this change counts turns at close and does not read the store).
- Migrations of our own: `job.agent_turns` only. The attribution join needs none.
