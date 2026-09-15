# Proposal: revamp dashboard usage — org/my split, per-task stats, daily series

## Why

The dashboard measures consumption and nothing else, at a granularity nobody acts on. It cannot
answer "what did *I* use" (no scope exists — #102's by-user rows are a display breakdown, not a
filter), it cannot answer "what does a task cost" (no per-task figures exist anywhere in the
payload — #102's join attributes sessions to members but not to tasks), and its one chart buckets
by ISO week, which hides the day-to-day variance that is the actual signal. #102 settled the
attribution foundation: a read-side job join that resolves each session's member, with
`unattributedSessions` as an explicit figure, and it names that join "the whole attribution path"
— no ingest-time identity column is coming.

## What Changes

- **Task attribution**: `SessionRollup` gains `taskKey` (the job thread's `root_job_id`),
  extending #102's landed join in place — the same board rows that resolve a session's member
  (`job.session_id → created_by`) also know its thread, retroactively over all existing rows and
  both CLIs (opencode ids are scraped and stored the same way). No ingest changes; no
  ingest-time column, per #102's decision.
- **Org vs my usage**: `/api/stats` gains a `scope` dimension (`org` default, `mine` = the signed-in
  caller) — a filter over every figure, not another breakdown panel. Filtering happens at read
  time over the cached `TelemetryInput`, matching sessions against #102's `user` — the same shape
  as the range filter, so no new cache slot. The dashboard grows an org/my toggle. Sessions with
  no attributable owner (laptop/hook sessions; the board holds no job row for them) count in the
  org scope and stay in #102's explicit *unattributed* figure, never silently inside "mine".
  Under `AUTH_MODE=none` there is no "me"; the toggle is absent, not disabled.
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

- `usage-attribution`: sessions are attributed to their task thread at read time (extending
  #102's member attribution, which stands as landed), and `/api/stats` can scope every figure to
  the signed-in caller.
- `task-usage-stats`: per-task usage distributions — tokens per task (avg, p50, p95), job turns
  (runs) per task, and agent turns per task as a distinct, separately-counted figure — over the
  selected range, with the null-not-zero and N-surfacing contracts.
- `daily-usage-series`: the usage chart is bucketed daily (weekly beyond 92 days), with gap-seeding
  and partial-day semantics.

### Modified Capabilities

<!-- openspec/specs/ holds executor-transcripts only; no existing capability's requirements change. -->

## Impact

- `core/src/types.ts` (`SessionRollup.taskKey` — `user` landed with #102; series and stats payload
  types), `core/src/telemetry.ts` (distribution math, daily series, scope filter),
  `core/src/metrics.ts` (day bucketing), `core/src/index.ts` re-exports.
- `server/src/telemetry/postgres-client.ts` (extend #102's attribution subquery with
  `root_job_id`), `server/src/stats-service.ts` (read-time scope filter, task-stats block from
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
  (task attribution incl. follow-up chains and removed threads, on top of #102's member
  attribution; agent_turns storage), web render smoke.
- Coordination: #102 landed issue #67's session attribution as the read-side join and chose it as
  the whole path (telemetry tables stay identity-free) — this change extends that join in place
  and adds no ingest-time column. `add-executor-transcript-store` (archived; it persists
  transcripts for later richer analysis — this change counts turns at close and does not read the
  store).
- Migrations of our own: `job.agent_turns` only. The attribution join needs none.
