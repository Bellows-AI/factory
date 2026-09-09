# Telemetry

Read before: touching `server/src/telemetry/*`, the OTLP ingest routes, any `*.sql` view, or the
collector config.

- **A cumulative counter is reduced with `max(value)` per `start_time`, never `sum(value)`.**
  This is the single most dangerous line in the feature: a plain `SUM` over a cumulative series
  produces a plausible, wildly wrong token count with no error anywhere. A restart begins a new
  `start_time`, so the per-group totals are added. Guarded in `server/test-db`, where the fixture
  series sums to 2.5× its real total.
- **Nanosecond timestamps divide by `1e6`, not `1e9`.** The `1e9` mistake puts every datapoint in
  1970, the branch join then returns nothing, and the symptom looks like a broken hook rather
  than a broken parser.
- **Two cache slots with independent TTLs, cooldowns and `lastFailureAt`.** A GitHub rate limit
  must not freeze the local database read, and a dead database must not stall the PR fetch.
  `TELEMETRY_TTL_SECONDS` has a floor of 5 — not a typo next to the 300s in `docs/metrics.md`, the
  reasons are opposite: there is no quota to protect, only a hot loop to prevent.
- **Migrations are not awaited before `app.listen()`.** They retry with backoff for the better
  part of a minute while the container starts, and blocking would hold the PR metrics — which
  need no database at all — hostage. That reasoning survives the database becoming mandatory: a
  *required* database is still a slow-starting one, and `prime()` plus every store call gates
  itself on `ready`.
- **Telemetry degrades alone, in four distinct states.** `disabled` renders no panels at all;
  `unreachable` renders frames with a reason and no numbers; `stale` serves the last good
  snapshot with 200; `empty` returns a *real* `TelemetryStats` with `sessions: 0` and null
  everywhere. `empty` being non-null is deliberate — it is how you see a pipeline that is wired
  but silent, which is the most common state during setup and would otherwise be
  indistinguishable from `disabled`.
- **`attribution: 'none'` and `'shared'` rows carry null on every quantity, and are still
  listed.** `0 tokens` would assert the PR was written without AI, which is not what was
  measured. One indivisible session nulls the whole row rather than reporting the divisible part.
- **`TelemetryStats.totals` comes from sessions, never from the PR rows.** They legitimately
  disagree, because a shared session contributes to totals and to no row. Pinning which is
  authoritative is what stops a future "make these agree" refactor from double-counting.
- **Attribute keys are allowlisted; metric names are denylisted.** Keep the asymmetry: a future
  Claude Code version can add an identity attribute, and a denylist would silently start storing
  it — whereas an unknown *metric* from a future tool must still be stored so its data
  accumulates before support is written. `user.email`, `user.id`, `user.account_uuid`,
  `organization.id` and `workspace.host_paths` all arrive by default and are all dropped.
- **There is no monetary field anywhere, on purpose.** Prices and cache discounts change, and a
  dollar figure implies precision a ~20s branch sample cannot support.
  `claude_code.cost.usage` and `opencode.cost.usage` are refused, at the collector and again at the
  ingest route. A test asserts no field named `cost`/`usd`/`price` exists in `TelemetryStats`,
  because this is exactly the kind of thing that returns via a "small addition".
- **The two executors reach the same collector by different routes.** claude-executor emits Claude
  Code's native OTLP, driven by env vars baked through its `settings.json`, naming metrics
  `claude_code.*`. opencode's binary has no native metric surface, so opencode-executor bakes
  `@gcornut/opencode-otel`, configured by its own `otel.json` (the `OTEL_EXPORTER_OTLP_*` vars mean
  nothing to it directly) and naming metrics `opencode.*`. Both arrive at the collector's http
  receiver on 4318 as http/json, and both land in `metric-map.ts` — they are rows in one table, not
  two code paths, and `agentOf()` keeps them under their own agents. **The opencode executor honors
  `RUNNER_OTEL_ENDPOINT` too:** its entrypoint rewrites `otel.json`'s `endpoint` from the
  `OTEL_EXPORTER_OTLP_ENDPOINT` env var the driver forwards, because the plugin reads neither the
  var nor the settings.json envelope claude-code uses. Without that rewrite an overridden collector
  (the k8s form, or any docker deployment off the compose network) would silently keep the baked
  `http://collector:4318`.
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
- **Week bucketing stays in `core` (`weekStart`/`isoWeekKey`), never `time_bucket()`.** The
  telemetry series shares a chart axis with the PR series; two implementations is how they drift
  by a day.
- **A transcript `pr-link` outranks the branch join, but does not replace it.** Both sources
  fold into the same PR row. Letting the stronger tier win outright would drop a session that
  branch-matched the same PR — counted in no row and in no unmatched bucket.
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
- **`core/test/telemetry.independent.test.ts` shares no code with `core/src/telemetry.ts`**, for
  the same reason as its metrics counterpart.
- **`factory_dev` and `factory_test` are separate databases, and the db suite refuses anything
  not named `*_test`.** The suite truncates `metric_point` and `session_branch` in
  `beforeEach`, so a shared database means one test run wipes every backfilled session — and
  the tests still pass, which is what makes it worth a guard rather than a comment.
- **The scatter plots `linked` and `exact`, not `exact` alone.** Filtering to `exact` blanked
  the panel entirely on real data, where nearly every PR is attributed by transcript pr-link.
  Types passed, the fixture passed, and only a browser showed it.
