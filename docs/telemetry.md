# Telemetry

OTLP ingest from the two executors, the SQL views over it, and the states the read degrades into.

| Concern | Code | Test |
| --- | --- | --- |
| OTLP parse, attribute allowlist, metric denylist | `server/src/telemetry/otlp.ts`, `metric-map.ts` | `server/test/telemetry.otlp.test.ts` |
| Ingest routes and the branch report | `server/src/routes/ingest.ts` | `server/test/routes.ingest.test.ts` |
| Writes and dedupe | `server/src/telemetry/store.ts` | `server/test-db/telemetry.sql.test.ts` |
| Read client, `ok`/`empty`/`stale`/`disabled` | `server/src/telemetry/postgres-client.ts`, `client.ts`, `errors.ts` | `server/test/routes.telemetry.test.ts` |
| Views: `metric_point_used`, `session_source`, `session_branch_slice` | `server/migrations/002_views.repeatable.sql` | `server/test-db/telemetry.sql.test.ts` |
| Run-activity bucketing (`GET /api/jobs/:id/activity`) | `server/src/telemetry/run-activity.ts` | `server/test/run-activity.test.ts`, `server/test-db/run-activity.test.ts` |
| Executor emission, collector config, branch reporter | `docker/{claude,opencode}-executor/`, `docker/otel-collector.yaml` | `docker/claude-executor/test.sh`, `driver/test/branch-reporter.test.ts` |

Aggregation: [metrics.md](metrics.md). Schema and migration rules: [persistence.md](persistence.md).

## Invariants

- **A cumulative counter is reduced with `max(value)` per `start_time`, never `sum(value)`.** A
  plain `SUM` over a cumulative series produces a plausible, wildly wrong token count with no error
  anywhere. Guarded by `server/test-db/telemetry.sql.test.ts`, whose fixture sums to 2.5× its real
  total; `run-activity.ts` repeats the reduction in TypeScript for the same reason.
- **Every view reads `metric_point_used`, never `metric_point`.** `session_source` picks one source
  per session, OTEL over transcript; reading the table reintroduces the double count.
- **Nanosecond timestamps divide by `1e6`, not `1e9`** — the `1e9` mistake puts every datapoint in
  1970 and the symptom looks like a broken hook.
- **Attribute keys are allowlisted; metric names are denylisted.** Keep the asymmetry: a new
  identity attribute must be dropped by default, while an unknown metric must still land in
  `metric_point` unmapped so its data accumulates before support is written.
- **Per-user attribution is a read-side join, not a stored identity.** No user column exists on
  `metric_point` or `session_branch`; `byUser` joins `session_branch` to `job` on
  `(org_id, session_id)` at read time.
- **There is no monetary field anywhere, on purpose** — `claude_code.cost.usage` and
  `opencode.cost.usage` are refused at the collector and again at the ingest route.
- **`on conflict do nothing` on `metric_point`, never `do update`.** OTLP delivery is at-least-once,
  and an update would move `received_at`, destroying the only way to tell a retry from a second export.
- **The ingest route returns 5xx only for a genuine write failure.** Exporters retry 5xx forever,
  so an unparseable body gets 200 and a malformed branch report gets 400.
- **A branch report's organization comes from the attempt's job id + lease token headers, never
  from the report's `repo` field** (CWE-862). A refused report is a silent no-op.
- **Both executors honor `RUNNER_OTEL_ENDPOINT` by rewriting the file their agent reads.** Claude's
  entrypoint rewrites `/etc/claude-code/managed-settings.json` (its `env` block overrides the
  container environment, defeating a forwarded `OTEL_EXPORTER_OTLP_ENDPOINT`); opencode's rewrites
  `otel.json`'s `endpoint`, since its plugin reads neither the var nor a settings envelope. Managed
  scope, never user scope — a checkout's `.claude/settings.json` and a member's executor config
  both outrank user scope, and managed outranks both.
- **The collector exporter sets `compression: none`.** It gzips by default and Fastify's JSON
  parser does not decompress: a flat 400 on every export, and an `empty` dashboard.
- **Transcripts carry only token usage** — no edit decisions, no active time (null for backfilled
  sessions), and their `input_tokens` excludes cache reads, which `cacheRead` holds.
