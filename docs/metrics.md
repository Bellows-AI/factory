# Aggregation invariants

Read before: touching `core/src/telemetry.ts`, `core/src/range.ts`, `core/src/metrics.ts`, or any
cache/TTL constant.

Aggregation is the one place a wrong number is invisible, so most of these have a test guarding
them. Do not "simplify" them.

- **`ratio()` returns `null`, never `0`, on a zero denominator.** The entire
  unavailable-vs-zero contract on the page rests on this: "0 accepted edits in 0 decisions" reads
  as a real answer. `acceptRatio()` nulls for the same reason when nothing was measured at all.
- **`sum()` returns `null` only when nothing was measured.** A missing contributor must not drag a
  real total down to a smaller real number, and an all-missing total must not read as zero —
  `linesAdded`, `linesRemoved`, `activeHours` and every token total degrade to null per figure, not
  per session.
- **The four token types are never summed into one figure.** A long cached conversation would count
  the same context repeatedly in `cacheRead`; where one number is needed it is input + output, and
  `TokenTotals` keeps the four apart so no call site can add them by accident.
- **`weeklySeries()` seeds every week in the window, including empty ones.** A series that closes
  its own gaps overstates activity; a quiet week must render as a quiet week.
- **`telemetryStats()` takes an injectable `now`.** The `partial` week flag depends on the current
  date; tests pin a frozen date so the current week is deterministic. Keep using the injection
  point.
- **Repo scoping buckets, it never drops.** A session the hook tagged with a repo outside the
  installation list is counted in `otherRepoSessions`; a session with telemetry but no hook report
  is counted in `sessionsWithoutHook`; only in-scope sessions reach the totals. Three different
  setup failures must stay distinguishable — a repo removed from the installation, a broken plugin,
  and genuinely no AI usage must not render identically.
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
  named `cost`/`usd`/`price` exists in `TelemetryStats`, because this is exactly the kind of thing
  that returns via a "small addition".
