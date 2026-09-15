## 1. Core: attribution types and scope filter

- [ ] 1.1 Add `userId`/`taskKey` to `SessionRollup` (nullable, no synthetic owner) and re-export
      from `core/src/index.ts`; verify `npm run build -w core` and that a rollup without
      attribution typechecks through the existing suites
- [ ] 1.2 Add `user` option to `telemetryStats`: matching sessions count toward totals,
      non-matching bucket into a new `unattributedSessions`-style exclusion counter beside
      `otherRepoSessions`/`sessionsWithoutHook`; verify with a core test pinning that a user-scoped
      run counts only that user's sessions and that coverage is untouched
- [ ] 1.3 Add the independent recomputation test (no helpers imported from `telemetry.ts`, the
      `telemetry.independent.test.ts` pattern) covering scope exclusion and the unattributed count;
      verify `npx vitest run core/test/telemetry.independent.test.ts` passes

## 2. Core: task usage distributions (tokens, job turns, agent turns)

- [ ] 2.1 Add `taskUsageStats(sessions, runs, { user? })` in core: per-task tokens as input+output
      over attributed sessions, job turns per task from job rows, agent turns per task as the sum
      of stored counts — avg/nearest-rank p50/p95 per figure, null-token tasks excluded not
      zeroed, per-figure task counts surfaced; verify with unit tests including the 1k/2k/3k token
      distribution scenario and the null-exclusion scenario from specs/task-usage-stats/spec.md
- [ ] 2.2 Pin the per-figure exclusion rule: a task with any in-range unmeasured (null) agent-turn
      run is excluded from the agent-turn distribution only, while still counting in the token and
      job-turn distributions; verify with a core test holding one measured and one unmeasured run
- [ ] 2.3 Pin range interaction: tasks enter on session overlap or run queued-in-range (the
      boundary-straddling scenario); verify with a frozen-`now` core test
- [ ] 2.4 Verify no monetary field enters any new payload type (`rg 'cost|usd|price'` over the new
      types comes back empty, per docs/metrics.md)

## 3. Core: generalized daily series

- [ ] 3.1 Add `dayStart`/`dayKey` to `core/src/metrics.ts` beside the week helpers; verify unit
      tests pin UTC day boundaries (23:30 vs 00:15 scenario)
- [ ] 3.2 Generalize `weeklySeries` into `bucketSeries(sessions, granularity, now)`: day buckets
      seed every day in the window including quiet ones, `partial` = current day (or week);
      verify tests carry the existing weekly invariants over to daily (gap seeding, quiet day kept,
      today partial)
- [ ] 3.3 Replace `TelemetryStats.weekly` with `series: { granularity, points }` and update every
      caller in the same change (no compatibility shape); verify `npm run build` and
      `npx vitest run core/test` pass with no reference to `weekly` left
- [ ] 3.4 Implement the granularity rule — day when window (or coverage span, for all-time) is
      ≤ 92 days, week beyond — and carry `granularity` in the payload; verify with frozen-`now`
      tests at 92 and 93 days

## 4. Server: attribution join and snapshot extension

- [ ] 4.1 Extend `postgres-client.fetchRollups()` with the org-scoped session→(user, task) map
      query (`min(created_by)`, `min(root_job_id)` grouped by `session_id`) and enrich the rollups;
      verify with a server db test covering executor sessions, follow-up chains agreeing, and
      pre-accounts rows (`created_by` null → unattributed)
- [ ] 4.2 Add the #67 coalesce seam: when the branch-record user column exists it wins over the
      join; verify with a db fixture that pins the disagreement case (ingest says A, join says B →
      A is used); if #67 has not landed, pin the join-only behavior and leave the seam named in a
      test placeholder that fails loudly when the column arrives unnamed
- [ ] 4.3 Extend the cached snapshot with per-run job rows (`root_job_id, created_by, created_at,
      agent_turns`, org-scoped) read in the same fetch; verify the cache test still shows one
      database read serving multiple ranges (and now scopes) without a second fetch

## 5. Board + driver: agent-turn counting at run close

- [ ] 5.1 Migration: add nullable `job.agent_turns int` (null = unmeasured, never zero-by-default);
      verify `npm run test:db` applies it cleanly and existing job suites stay green
- [ ] 5.2 Board: accept optional `agentTurns` on the completion report (`POST /api/jobs/:id/complete`),
      lease-guarded like every field there, stored on the row; verify a route test covering stored,
      absent (null), and negative-rejected cases
- [ ] 5.3 Driver (opencode): count assistant response cycles in `opencode-readout.cjs`'s existing
      root-session message walk and emit `turns` on its JSON line; verify the script suite pins
      the count for a fixture session (including subagent-child exclusion via the root-only scope)
- [ ] 5.4 Driver (claude-code): new script file under `driver/src/scripts/` (real file, passed by
      content — the `remote-session.sh` precedent) that counts assistant entries for the run's
      session id from the transcript, exec'd once after run exit and before container teardown;
      wire the count into the completion report; verify the script suite pins the parse shape and
      that a missing/gone transcript answers null, never zero
- [ ] 5.5 Driver (kubernetes twin): the same close-time read as a pod exec against the runner pod
      before deletion, same script, same report, null on failure; verify the k8s runner tests pin
      the exec shape and failure path (executor parity, docs/kubernetes.md)
- [ ] 5.6 State the null posture for Remote Control runs (no count — interactive conversation,
      per design) and pin it: verify a test asserts no turn read is attempted under
      `RUNNER_REMOTE_CONTROL`

## 6. Server: stats route scope and task stats block

- [ ] 6.1 Add `?scope=org|mine` to `/api/stats`: caller resolved from the signed-in session user,
      `400 SCOPE_REQUIRES_USER` for `mine` without one (open auth mode, worker token), scope filter
      applied at read time in `current()`; verify with route tests covering all three cases plus
      `meta` naming the scope and resolved login
- [ ] 6.2 Compute the task-stats block in `current()` from the cached runs + filtered sessions via
      `taskUsageStats`, honoring scope; verify route test: caller scope narrows the task set, and
      the empty range answers null figures (not zeros) with the empty state reason
- [ ] 6.3 Update `server/test` fixtures/synthetic seed so attributed and unattributed sessions,
      measured and unmeasured agent turns are all representable; verify
      `DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test npm run test:db` passes

## 7. Web: dashboard split, per-task panel, daily chart

- [ ] 7.1 Add the `Org | Me` scope toggle beside the RangeSelector, rendered only when the session
      reports a signed-in user (absent under `AUTH_MODE=none`, not disabled); verify the web render
      smoke covers both auth states
- [ ] 7.2 Thread `scope` through `useStats`/AppShell state (default org, preserved across range
      changes); verify the hook's test pins that a scope change refetches with `scope=mine` and
      never clears `data` on error
- [ ] 7.3 Add the per-task stats panel: avg/p50/p95 for tokens per task, runs per task, and agent
      turns per task — three distinctly-labeled figures (the terminology rule: no bare "turns"),
      each with its task count N, explicit empty state; verify the web render smoke renders
      populated and empty states without NaN (nulls format as unavailable)
- [ ] 7.4 Switch TokenUsagePanel to `series.points` with labels and blurb driven by
      `series.granularity`; verify the render smoke for daily and weekly fallback and that
      `labelEvery` keeps labels legible at 92 daily points
- [ ] 7.5 Surface the unattributed-sessions figure in DataQualityPanel as its own line (distinct
      from no-hook and other-repo); verify the render smoke shows all three exclusions separately

## 8. Docs and end-to-end verification

- [ ] 8.1 Add the terminology block to docs/metrics.md — job turn (a run: one job row, one
      delivered prompt) vs agent turn (one assistant response cycle in the run's root
      conversation), the never-bare-"turns" rule — cross-referenced from docs/jobs.md; verify a
      doc-pinning test (the `core/test/biome.test.ts` pattern for docs, if one exists) or a
      grep check that both docs name both terms
- [ ] 8.2 Update docs/metrics.md (attribution precedence, scope as a read-time dimension, the
      fourth exclusion counter), docs/date-range.md (daily bucketing, 92-day rule, granularity in
      the payload), docs/api.md (`scope` param, `SCOPE_REQUIRES_USER`, task-stats block,
      `agentTurns` on the completion report), docs/jobs.md (the close-time turn read, both
      executors, the null contract); verify `npx vitest run core/test/biome.test.ts` and any
      doc-pinning tests still pass
- [ ] 8.3 Run the full offline gate: `npm test`, `npm run typecheck`, `npm run lint` — all green
- [ ] 8.4 Visual check with seeded data: `DATABASE_URL=...factory_seed npm run seed` then
      `npm run verify:ui`, read the artifacts/ui/ screenshots for the daily chart at month range,
      weekly fallback at all-time, both scopes, and the per-task panel with all three figures;
      verify the screenshots show real layouts, not just passing assertions
