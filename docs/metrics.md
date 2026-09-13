# Aggregation invariants

Read before: touching `core/src/metrics.ts`, `core/src/canonical.ts`, the GraphQL query, or any
cache/TTL constant.

Aggregation is the one place a wrong number is invisible, so most of these have a test guarding
them. Do not "simplify" them.

- **`ratio()` returns `null`, never `0`, on a zero denominator.** The entire
  unavailable-vs-zero contract on the page rests on this. "0 reverts in 0 commits" reads as a
  real answer.
- **Totals come from the count fields; distributions come from the arrays beside them.** GraphQL
  caps nested connections at 100 nodes (`INNER_LIMIT`). PRs over that get a second pass in
  `backfill()`; anything still cut lands in `CanonicalPr.truncated` and surfaces as
  `stats.meta.truncated` rather than being silently undercounted. `CanonicalPr` names the two
  separately (`reviewCount` vs `reviews`) precisely so no call site can confuse them — a
  `{ totalCount, nodes }` wrapper reads as if they agree, and for #149 they differ by 297.
- **Force pushes are counted from the filtered node list.** `timelineItems.totalCount` ignores
  `itemTypes` and reports the whole timeline — it once claimed 404 force pushes across 14 PRs.
- **`forcePushCount` is `number | null` and `bodyOnlyReviews` degrades to null.** Null means the
  provider cannot observe the thing; 0 means it can and none happened. `Stats.rework.forcePushes`
  is all-or-nothing across the set for the same reason the revert rate is, and a plain reduce over
  nulls would render the literal string "NaN". Guarded by the NaN walker in
  `metrics.invariants.test.ts` and by `core/test/canonical.derive.test.ts`.
- **`stats.meta.window` is derived from array position, not min/max.** It used to rely on the
  query's `CREATED_AT DESC` ordering; with a store in play, `loadPullRequests()`'s
  `order by created_at desc, repo asc, number desc` is the single authority that keeps it true.
  Do not sort in `stats-service.ts` — that puts the invariant in two places. Guarded by
  `server/test/stats.persistence.test.ts` → "reports the window off creation order".
- **`compute()` and `createStatsService()` take an injectable `now`.** The `partial` week flag
  and `generatedAt` depend on the current date; tests pin `FIXTURE_NOW` /
  `2026-08-21T12:00:00.000Z`. Keep using the injection point.
- **`weeklySeries()` seeds every week in the window, including empty ones.** A median over only
  the weeks that had a merge overstates throughput.
- **`SYNC_TTL_SECONDS` (floored at 60 per measured repo) is the only cache floor, and
  `CACHE_TTL_SECONDS` is gone.** The 300-per-repo floor protected a full walk's ~243 rate-limit points, which every
  refresh used to be; history is always persisted now, so the ordinary refresh is an incremental
  walk of a few pages. The full walk is not gated by a TTL at all — it runs on
  `FULL_RESYNC_INTERVAL_MS` (24h) and refuses to start unless `last_rate_limit.remaining` actually
  covers `243 × repos × 1.5`, and reading the remaining budget is strictly stronger than inferring
  it from a clock. Setting `CACHE_TTL_SECONDS` is **fatal, not ignored**: a deployment that had
  raised it to protect its quota would otherwise silently drop to the 60s floor.
- **A stale snapshot is served with 200.** A rate limit must keep the last good render on screen
  and explain itself, not blank the dashboard. `useStats` likewise never clears `data` on error.
- **`ERROR_COOLDOWN_MS` (30s) after a failed fetch.** Without it every request restarts the
  fetch and a rejected token becomes a request loop. `POST /api/refresh` bypasses it.
- **`INSTALLATION_REPOS_TTL_MS` (10 min) on the repo list.** Long next to the sync TTL, because the
  answer changes when a human installs or uninstalls the GitHub App — minutes, not seconds — and
  short enough that granting the App a new repository shows up without a restart, which is the
  workflow that replaced `ORG_REPOS`. A failed refresh serves the last good list with the reason
  named, exactly as a stale snapshot does.
- **The per-repo sync floor is applied by the stats service, not by `loadConfig`.** It cannot be
  applied there any more: the repo count comes from the installation and is not known at boot.
  `loadConfig` still floors `SYNC_TTL_SECONDS` at one repo's worth, which is all it can honestly
  check.
- **The revert rate degrades alone.** It is the only metric needing `Contents: read`; a missing
  ref returns `null` history and `revert.status = 'unavailable'`, never `{commits: 0, reverts: 0}`.
- **`core/test/metrics.independent.test.ts` imports no helpers from `core/src/metrics.ts` on
  purpose** — only its subjects, `compute` and `deriveAll`. It recomputes headline numbers off the
  canonical payload and pins SPEC §1 landmarks. Importing helpers into it would make a wrong
  number invisible. **`server/test/github.map.test.ts`
  holds the other half of that chain**, recomputing the same landmarks off the *raw* GitHub
  capture — the seam moved there when `core` stopped speaking GitHub. If any of 203 / 178 / 654 /
  226 / 624 / 30 / 37 / 153.5 / 224 / 0.325 moves, the adapter is wrong; do not adjust the
  expectation.
- **Do not switch GraphQL pagination to `gh api graphql --paginate`.** It only advances the
  cursor if the variable is named `$endCursor`; anything else silently re-requests page 1 forever.
- **When a PR page times out, shrink the nested selections, not `PAGE_SIZE` (25).** Per-page cost
  is superlinear in the nested connections.
