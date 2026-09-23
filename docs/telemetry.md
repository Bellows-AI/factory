# Telemetry

Read before: touching `server/src/telemetry/*`, the OTLP ingest routes, any `*.sql` view, or the
collector config.

- **A cumulative counter is reduced with `max(value)` per `start_time`, never `sum(value)`.**
  This is the single most dangerous line in the feature: a plain `SUM` over a cumulative series
  produces a plausible, wildly wrong token count with no error anywhere. A restart begins a new
  `start_time`, so the per-group totals are added. Guarded in `server/test-db`, where the fixture
  series sums to 2.5× its real total.
- **Nanosecond timestamps divide by `1e6`, not `1e9`.** The `1e9` mistake puts every datapoint in
  1970, the session join then returns nothing, and the symptom looks like a broken hook rather
  than a broken parser.
- **One cache slot, `TELEMETRY_TTL_SECONDS` (default 30, floored at 5).** The floor is not a typo —
  there is no quota to protect, only a hot loop to prevent. A failed read serves the last good
  snapshot with 200 and cools down for 30s; see [metrics.md](metrics.md).
- **Migrations are not awaited before `app.listen()`.** They retry with backoff for the better
  part of a minute while the container starts, and blocking would hold the whole dashboard
  hostage. A *required* database is still a slow-starting one, and every store call gates itself
  on `ready`.
- **Telemetry degrades in distinguishable states.** On a 200 the read is `ok` or `empty`, and
  `empty` returns a *real* `TelemetryStats` with `sessions: 0` and null everywhere — non-null on
  purpose, because it is how you see a pipeline that is wired but silent, the most common state
  during setup. `stale` serves the last good snapshot with 200 and names the reason in
  `meta.telemetry.reason`. `disabled` (`TELEMETRY_SOURCE=off`) and a failed first read answer
  `503` instead: telemetry is the whole payload now, so there are no panels left to render
  empty frames for.
- **Attribute keys are allowlisted; metric names are denylisted.** Keep the asymmetry: a future
  Claude Code version can add an identity attribute, and a denylist would silently start storing
  it — whereas an unknown *metric* from a future tool must still be stored so its data
  accumulates before support is written. `user.email`, `user.id`, `user.account_uuid`,
  `organization.id` and `workspace.host_paths` all arrive by default and are all dropped. A vendor
  metric with no row in `metric-map.ts` (a `pull_request.*` counter, say) is stored unmapped in
  `metric_point` — raw datapoints survive even where no canonical field exists to roll them into.
- **Per-user attribution is a read-side join, not a stored identity (issue #67).** The stripping
  above stays: no user column was added to `metric_point` or `session_branch`, and nothing
  identity-bearing travels through the runner. The `byUser` rollup joins `session_branch` to the
  board's own `job` audit rows on `(org_id, session_id)` and those to `app_user` when the read
  runs; a session with no matching task stays null (`unattributedSessions` counts it). A
  pseudonymous id threaded through the runner was the rejected alternative — it would write
  identity into the telemetry store through a third path and drag both executor images and the
  chart into lockstep for nothing the join does not already answer.
- **There is no monetary field anywhere, on purpose.** Prices and cache discounts change, and a
  dollar figure implies precision a ~20s branch sample cannot support.
  `claude_code.cost.usage` and `opencode.cost.usage` are refused, at the collector and again at the
  ingest route. A test asserts no field named `cost`/`usd`/`price` exists in `TelemetryStats`,
  because this is exactly the kind of thing that returns via a "small addition".
- **The two executors reach the same collector by different routes.** claude-executor emits Claude
  Code's native OTLP, driven by env vars baked through its **managed** settings
  (`/etc/claude-code/managed-settings.json`), naming metrics
  `claude_code.*`. opencode's binary has no native metric surface, so opencode-executor bakes
  `@gcornut/opencode-otel`, configured by its own `otel.json` (the `OTEL_EXPORTER_OTLP_*` vars mean
  nothing to it directly) and naming metrics `opencode.*`. Both arrive at the collector's http
  receiver on 4318 as http/json, and both land in `metric-map.ts` — they are rows in one table, not
  two code paths, and `agentOf()` keeps them under their own agents. **Both executors honor
  `RUNNER_OTEL_ENDPOINT`, each rewriting the file its agent actually reads.** claude's settings
  `env` blocks *override* the container environment — the settings file value applies — so the
  driver's forwarded `OTEL_EXPORTER_OTLP_ENDPOINT` would be defeated by the baked
  `http://collector:4318`, and claude-executor's entrypoint rewrites the managed value when the var
  is set. **Managed, never the user-scope `settings.json`:** the checkout's own
  `.claude/settings.json` outranks user scope, and this repo's points the endpoint at
  `127.0.0.1:4318` for host development — every claude job run against it exported into the
  container's loopback, with no error anywhere, until the block moved. Managed also outranks a
  member's executor config, which is what keeps telemetry on whatever the member pastes.
  `docker/claude-executor/test.sh` pins it against the real CLI. opencode-executor's entrypoint rewrites `otel.json`'s `endpoint` instead, because its
  plugin reads neither the var nor a settings.json envelope. Without the rewrite an overridden
  collector (the k8s form, or any docker deployment off the compose network) would silently keep the
  baked `http://collector:4318`.
- **Both executors also bake the branch reporter, because metrics alone scope to nothing.**
  OTLP carries a session id and no branch, so without the reporter's side channel a session would
  resolve to no repo at all and every executor run would sit in `sessionsWithoutHook` however much
  it cost. `branch-reporter.cjs` (one copy per image, byte-identical but for the agent constant)
  samples `session → (repo, branch)` from the task worktree and POSTs the plugin's wire shape to the
  board's `/api/sessions/branch` — `FACTORY_STATS_URL` (`RUNNER_STATS_URL`, defaulted to the board
  URL), authenticated by the attempt it runs for: the driver forwards `RUNNER_JOB_ID` +
  `RUNNER_LEASE_TOKEN`, and the reporter sends them as `x-factory-job-id` +
  `x-factory-job-lease-token`, the pair the board resolves the report's organization from — never
  from the report's `repo` field (CWE-862). The reporter's rules are the plugin's, and the
  entrypoint discards its stdio on top: never fail a run, never lag it, never speak. A refused
  report (no pair on a board that requires a credential, a board that is down) is a silent no-op —
  hook-less, not failed.
- **`ON CONFLICT DO NOTHING` on `metric_point`, never `DO UPDATE`.** OTLP delivery is
  at-least-once, so an identical retry must be a no-op; an update would move `received_at` and
  destroy the only way to tell a retry from a genuine second export.
- **The ingest route returns 5xx only for a genuine write failure.** Exporters retry 5xx forever,
  so a body the parser cannot read gets a 200, and a malformed branch report gets a 400.
- **`session_branch_slice` clamps overlapping intervals.** The upsert widens `first_seen`/
  `last_seen`, so consecutive branches routinely overlap and a raw join would count the same
  datapoint on both branches.
- **`*.repeatable.sql` migrations are re-applied every boot and drop their views first.** Being
  recorded in `schema_migrations` would mean a view fix never lands until someone deletes the
  volume; and `create or replace view` cannot change a column's type, so a fix that widens one
  would fail on every existing database while passing on a fresh one.
- **Week bucketing stays in `core` (`weekStart`/`isoWeekKey`), never `time_bucket()`.** Every
  weekly series on the page shares one chart axis; two implementations is how they drift by a day.
- **`session_source` picks one source per session, OTEL over transcript.** A session that ran
  with OTEL enabled *and* has a transcript on disk would otherwise be counted twice. Every
  view reads `metric_point_used`, never `metric_point`; reading the table reintroduces the
  double count.
- **Versioned migrations run before repeatable ones, regardless of filename order.** A new
  versioned file that adds a column the views read would otherwise fail purely because `003`
  sorts after `002`.
- **Transcripts carry only token usage.** No edit decisions, no active time, so those fields
  are null for backfilled sessions — which is the null-not-zero contract doing its job, not a
  bug. **`input_tokens` in a transcript excludes cache reads**, so on a heavily cached
  conversation it is a small fraction of the real input; `cacheRead` holds the bulk.
- **The collector exporter sets `compression: none`.** It gzips by default, Fastify's JSON parser
  does not decompress, and the result is a flat `400` on every export with "Exporting failed.
  Dropping data" in the collector log and an `empty` dashboard. Symptoms point at the server; the
  cause is one line of collector YAML.
- **`TELEMETRY_SOURCE` defaults to `postgres` everywhere now.** It used to default to `fixture` in
  code and `postgres` in compose, because `npm run dev` and the test suite had no database. Both
  have one by construction now, and a fixture default would 404 the ingest route while a collector
  is already exporting into it.
- **`core/test/telemetry.independent.test.ts` imports no helpers from `core/src/telemetry.ts`**
  (only its subject, `telemetryStats`), for the same reason as every independent recomputation
  suite: importing the code under test into the checker would make a wrong number invisible.
- **`factory_dev` and `factory_test` are separate databases, and the db suite refuses anything
  not named `*_test`.** The suite truncates `metric_point` and `session_branch` in
  `beforeEach`, so a shared database means one test run wipes every backfilled session — and
  the tests still pass, which is what makes it worth a guard rather than a comment.
