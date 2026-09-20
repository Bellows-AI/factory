# Aggregation invariants

Read before: touching `core/src/telemetry.ts`, `core/src/range.ts`, `core/src/metrics.ts`, or any
cache/TTL constant.

Aggregation is the one place a wrong number is invisible, so most of these have a test guarding
them. Do not "simplify" them.

## Turn terminology

Two different measurements are both colloquially "turns", and conflating them makes every figure
wrong in a way no test can catch — only wording can. This block is the definition of record; the
dashboard's labels and every doc sentence follow it, and **a payload field, UI label, or doc
sentence that says a bare "turns" is a bug in wording, not a shorthand**:

| term | meaning | counted from |
| --- | --- | --- |
| **job turn** (product word: **run**) | one job row in a task thread — the first run or a follow-up, the member delivering one prompt | the board's own rows |
| **agent turn** | one assistant response cycle in the run's ROOT conversation, whatever tool calls it contains; subagent conversations never count | the session's own records, counted at run close (opencode: the session database the readout walks; claude-code: the transcript, read from the workspaces volume after exit — see docs/jobs.md) |

So "runs per task" and "agent turns per task" are different figures from different sources and are
never summed, compared, or averaged into one another. A run whose count could not be taken is
stored as null — unmeasured, never zero — and a task with any unmeasured in-range run is excluded
from the agent-turn distribution only, while its tokens and job turns still count in theirs.

## Invariants

- **`ratio()` returns `null`, never `0`, on a zero denominator.** The entire
  unavailable-vs-zero contract on the page rests on this: "0 accepted edits in 0 decisions" reads
  as a real answer. `editAcceptance()` nulls the ratio for the same reason when nothing was
  measured at all — and keeps `decisions` (the null-aware sum of accepted + rejected) separate,
  so a measured zero-out-of-zero stays distinguishable from wholly unmeasured input.
- **`sum()` returns `null` only when nothing was measured.** A missing contributor must not drag a
  real total down to a smaller real number, and an all-missing total must not read as zero —
  `linesAdded`, `linesRemoved`, `activeHours` and every token total degrade to null per figure, not
  per session.
- **The four token types are never summed into one figure.** A long cached conversation would count
  the same context repeatedly in `cacheRead`; where one number is needed it is input + output, and
  `TokenTotals` keeps the four apart so no call site can add them by accident.
- **`weeklySeries()` seeds every week in the window, including empty ones. A series that closes
  its own gaps overstates activity; a quiet week must render as a quiet week.** The series is now
  one generalized `bucketSeries()` with a day granularity beside the ISO week: every day in the
  window is seeded including quiet ones, the current day (or week) is the `partial` one, and the
  bucketing lives in core beside `weekStart`/`isoWeekKey` — never `time_bucket()`.
- **Series granularity is chosen by window span: day at ≤ 92 days, week beyond — and for
  all-time, the coverage span decides.** A fixed-width chart of a year of daily bars renders
  hairlines, not information, so the fallback is a feature; and the payload NAMES the granularity
  actually used (`series: { granularity, points }`), which is what makes the chart's labels and
  blurb describe what is rendered rather than what was requested. The threshold is pinned by
  frozen-`now` tests at 92 and 93 days.
- **Scope (`org` / `mine`) is a read-time filter over the cached input, exactly like the range.**
  `telemetryStats()` takes the caller; sessions the attribution join resolved to someone else fall
  out of the totals, the series and `byUser`, while coverage and the setup-failure counters keep
  describing the store. Unattributed sessions stay out of "mine" but keep their own
  `unattributedSessions` figure — scoped out is not the same as invisible. The task statistics
  filter the same way over the same snapshot, so a scope switch never re-fetches (docs/date-range.md's
  one-cache-slot rule, extended to a second dimension).
- **Task attribution is the same read-side join as member attribution, extended in place.**
  #102's subquery groups `job` on `(org_id, session_id)`; it also resolves each session's task
  thread via `min(root_job_id::text)::uuid`, because follow-ups copy the parent's root, so the
  minimum is that root, deterministically. No ingest-time identity column exists or is coming —
  the telemetry tables stay identity-free, and this join is the whole attribution path.
- **`telemetryStats()` takes an injectable `now`.** The `partial` week flag depends on the current
  date; tests pin a frozen date so the current week is deterministic. Keep using the injection
  point.
- **Repo scoping buckets, it never drops.** A session the hook tagged with a repo outside the
  installation list is counted in `otherRepoSessions`; a session with telemetry but no hook report
  is counted in `sessionsWithoutHook`; a session whose board task no longer exists (or never
  existed) is counted in `unattributedSessions`. Four different states must stay distinguishable —
  a repo removed from the installation, a broken plugin, a removed task, and genuinely no AI usage
  must not render identically. The figures live in the payload; the dashboard does not render the
  breakdown (#109 removed the data-quality panel), but the counters are contract — tests and the
  telemetry client both speak them.
- **`TelemetryStats.totals` comes only from in-scope sessions.** `otherRepoSessions` and
  `sessionsWithoutHook` contribute to no total. Pinning that is what stops a future "count
  everything" refactor from rendering figures over an unnamed subset of sessions.
- **`filterTelemetryInput()` keeps a session on overlap, and `coverage` is untouched.** A session
  straddling the range boundary did real work inside the range; and coverage reports what the store
  holds, which is how the UI distinguishes "no AI usage in this range" from "telemetry does not
  reach back this far".
- **`TELEMETRY_TTL_SECONDS` (default 30, floored at 5) is the only cache floor.** The floor is not
  a typo next to any quota-protecting TTL — there is no quota to protect, only a hot loop to
  prevent. Its retired predecessors (`CACHE_TTL_SECONDS`, `SYNC_TTL_SECONDS`, which floored the PR
  sync slots at 300s per repo and 60s) are **fatal, not ignored**: a deployment that had raised one
  to protect its quota would otherwise silently drop to the 5s floor.
- **A stale snapshot is served with 200.** A dead database socket must keep the last good render on
  screen and explain itself, not blank the dashboard. `useStats` likewise never clears `data` on
  error.
- **`ERROR_COOLDOWN_MS` (30s) after a failed read.** Without it every request restarts the read and
  a rejected query becomes a request loop. `POST /api/refresh` bypasses it.
- **`INSTALLATION_REPOS_TTL_MS` (10 min) on the repo list.** Long, because the answer changes when
  a human installs or uninstalls the GitHub App — minutes, not seconds — and every read of it
  costs a rate-limit point. Short enough that granting the App a new repository shows up without a
  restart, which is the whole workflow this replaced `ORG_REPOS` to enable. A failed refresh serves
  the last good list with the reason named, exactly as a stale snapshot does.
- **There is no monetary field anywhere, on purpose.** Prices and cache discounts change, and a
  dollar figure implies precision a ~20s branch sample cannot support. A test asserts no field
  named `cost`/`usd`/`price` exists in `TelemetryStats` or the task statistics, because this is
  exactly the kind of thing that returns via a "small addition".
- **Per-task distributions exclude, they never zero.** A task whose sessions measured no tokens is
  excluded from the token distribution (not counted as a 0-token task); a task with any unmeasured
  in-range run is excluded from the agent-turn and wall-clock distributions only — a never-executed
  run would make either sum a quiet undercount — while its tokens and job turns still count in
  theirs. A task with no in-range run banks zero of both, which is measured: nothing of it executed
  in the range. Percentiles are nearest-rank
  (`ceil(p·N)`-th of the ascending sort) because they must recompute by hand in the independent
  suites. Every distribution carries its task count N — a p95 over five tasks renders beside its
  count or it masquerades as a settled statistic. Wall clock is the board's banked EXECUTION time
  (`job.wall_clock_ms`, 024) summed over the task's in-range runs — never the time a queued row sat
  waiting, and null is the contract for a run that never executed.
