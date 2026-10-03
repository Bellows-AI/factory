# Architecture

The hub: what each package is, how a measurement reaches a panel, and where the detail lives.

| Package | Role |
| --- | --- |
| `core/` | Telemetry aggregation, ranges, shared types. No I/O, no dependencies. |
| `server/` | Fastify API: telemetry store, GitHub App credential and repo list, job/workspace/env/auth stores, static SPA hosting. |
| `web/` | Vite + React 19 SPA, polls `/api/stats` and `/api/tasks`. |
| `plugins/agent-telemetry/` | Installable Claude Code plugin; reports `session -> (repo, branch)`. |
| `driver/` | Claims jobs from the board over HTTP and runs one runner per job. |
| `cli/` | Board CLI: HTTP client that queues and inspects tasks. |

Data flow: agent → OTEL collector → `POST /api/otlp/v1/metrics` → `flattenMetrics()` → PostgreSQL
(`metric_point`, `session_branch`) → `createPostgresTelemetryClient()` → `TelemetryInput` →
`filterTelemetryInput()` → `telemetryStats()` → `{ telemetry, tasks, meta }` → panels.

| Concern | Code | Test |
| --- | --- | --- |
| Boot wiring and start order | `server/src/main.ts` | `server/test/helpers-harness.ts` drives `buildApp` |
| Per-org runtimes (repo source, telemetry, stats cache, stores) | `server/src/orgs.ts` | `server/test/orgs.test.ts` |
| Read-time aggregation and the cache slot | `server/src/stats-service.ts`, `server/src/cache.ts` | `server/test/routes.stats.get.test.ts` |
| Telemetry sources (`postgres`/`fixture`/`off`) | `server/src/telemetry/client.ts` | `server/test/telemetry.fixture-client.test.ts` |
| Installation token, repo listing, repo source | `server/src/github/app-token.ts`, `app-client.ts`, `repo-source.ts` | `server/test/github.app-token.test.ts`, `server/test/repo-source.test.ts` |
| Range parsing, filtering, bucketing | `core/src/range.ts` (`parseRange` lives in `routes/stats.ts`) | `core/test/range.test.ts` |
| The shared payload contract the SPA imports | `core/src/types.ts` | `core/test/metrics.invariants.test.ts` |

Then: [api.md](api.md) · [auth.md](auth.md) · [organizations.md](organizations.md) ·
[repos.md](repos.md) · [configuration.md](configuration.md) · [date-range.md](date-range.md) ·
[jobs.md](jobs.md) · [metrics.md](metrics.md) · [persistence.md](persistence.md) ·
[telemetry.md](telemetry.md) · [workspace.md](workspace.md) · [limits.md](limits.md).

## Invariants

- **Aggregation is read-time, over one read.** The cache slot holds the whole fetched
  `TelemetryInput`; every range and scope re-filters it, so no cache key names a range and a scope
  switch never refetches. `server/test/routes.stats.scope.test.ts`.
- **`buildApp` does not `listen`** — that is what lets `server/test/` drive the whole app
  in-process with `app.inject()` and stubbed clients.
- **Every module in `core/src` must be re-exported from `core/src/index.ts`**, or the server sees
  "module has no exported member". `core/test/core-index.test.ts`.
- **The session id is the only join key** between a metric and a checkout:
  `OTEL_METRICS_INCLUDE_SESSION_ID` must stay true, or every session reads as hook-less. A session
  counts only when the hook tagged it with an in-list repo; the other outcomes are named buckets,
  never drops ([repos.md](repos.md)).
- Metric definitions live in `../factory-stats/SPEC.md`, outside this repo.
