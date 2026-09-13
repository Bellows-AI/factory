# Architecture

Read before: changing the data flow, touching `server/src/main.ts` wiring, or touching anything
under `server/src/github/`.

| Package | Role |
| --- | --- |
| `core/` | Telemetry aggregation + shared types. No I/O, no dependencies. |
| `server/` | Fastify API: telemetry store, the GitHub App credential and repo list, job/workspace/env stores, static SPA hosting. |
| `web/` | Vite + React 19 SPA, polls `/api/stats`. |
| `plugins/agent-telemetry/` | Installable Claude Code plugin. Reports `session -> (repo, branch)`. |
| `driver/` | Job driver: claims jobs from the board and spawns a runner container per job. |

Data flow: Claude Code → OTEL collector → `POST /api/otlp/v1/metrics` → `flattenMetrics()` →
TimescaleDB (`metric_point`, `session_branch`) → `createPostgresTelemetryClient()` → `TelemetryInput`
→ `telemetryStats()` → `{ telemetry, meta }` → panels. **There is one stats pipeline.** The
pull-request fetch, PR store, PR aggregation and their panels were removed with issue #62 —
`023_drop_pull_requests.sql` drops the schema they owned — and `telemetry` is the whole payload
rather than the sibling of a `Stats` object. `core/src/types.ts` is the contract the SPA imports
rather than redeclares; `core/src/canonical.ts` is gone with the forge adapters that fed it.

**Aggregation happens at read time, over one read.** The cache slot holds the fetched
`TelemetryInput` — every session in the store, unfiltered — and `current(range)` re-runs
`filterTelemetryInput()` and `telemetryStats()` per request. Every range is served from the one
database read the TTL paid for, and no cache key mentions a range. Pre-aggregating per range would
either bucket the cache by range or force the selector to be cosmetic.

Server wiring (`server/src/main.ts`): `resolveConfig()` → GitHub App client (or the code-only `none`
arm) → pool + `migrate()` (un-awaited) → telemetry client (`postgres`, `fixture` or `off`) → ingest
store → repo source → job/workspace/env/auth stores → `createStatsService()` → `buildApp()` →
`ensureFresh()` (warms the cache so the first visitor does not eat the cold read) →
`cloneQueue.start()` (un-awaited) → `listen()`. `buildApp` deliberately does not `listen`, which is
what lets `server/test/` drive the whole app in-process via `app.inject()` with stubbed clients.

**The GitHub App stack stays, and none of it fetches pull requests any more.** `github/app-token.ts`
signs an RS256 JWT with the App's private key and exchanges it for an installation token, refreshed
five minutes before expiry; that token is what the clone queue clones private source with and what
rides the claim env as the runner's `GITHUB_TOKEN`. `github/app-client.ts` reads the installation's
repository list, and `github/repo-source.ts` caches it behind the two accessors the rest of the
server needs: an async `list()` for the refresh path and a synchronous `snapshot()` for
`StatsService.current()`, which aggregates an already-fetched payload and must never become a fetch.
The list is what scopes every stored read (`meta.repos`, `telemetryStats({ repos })`), what
`/api/repos` serves to the picker, and what the env and workspace routes validate a repo label
against. Without an App client — the offline tooling's code-only `none` arm — the source falls back
to the distinct repos in `session_branch` (`db/stored-repos.ts`), which is what keeps a seeded
database browsable with no credential, since every stored read is scoped by that list.

`TelemetryClient` (`server/src/telemetry/client.ts`) has three sources, and `postgres` is the
default. `fixture` replays `core/test/fixtures/telemetry-sessions.json` — **synthetic**, generated
by `generate-telemetry.mjs` next to it — so the read path runs with no database and no collector,
and the UI badges it loudly, because invented token counts are exactly what the limitations panel
exists to warn about. `off` is a product choice — render no AI panels — not a way to avoid the
database, which is why the ingest store's registration, not the route, is what follows it.

## How a session reaches a repo

Claude Code's OTEL metrics carry **no branch and no repo** — only the standard attributes, of which
the only useful one is `session.id`. So the scoping needs a side channel: the `agent-telemetry`
plugin samples the current checkout and posts `session -> (repo, branch)` to
`POST /api/sessions/branch`, and `telemetryStats()` counts a session in its totals only when the
hook tagged it with a repo in the installation list.

Two things about that channel are not obvious:

- **The session id is the only join key there is.** `OTEL_METRICS_INCLUDE_SESSION_ID` must stay
  true (it is the default). Disabling it severs the only link between a metric and a checkout:
  every session reads as hook-less, `sessionsWithoutHook` grows without bound — indistinguishable
  from the plugin being broken — and no scoping filter can place the sessions it drops.
- **A repo outside the installation list is a distinct bucket, not a dropped session.**
  `otherRepoSessions` counts it, so a repo removed from the installation shows up as a move into
  that bucket rather than as a silent loss of history.

The plugin is installed at **user scope**, not into this repo, because the dashboard reports on
`bellows.ai` and the sessions that matter happen there. See
`plugins/agent-telemetry/README.md`.

Metric definitions and the reasoning behind them live in `../factory-stats/SPEC.md` (outside this
repo). Every definition corrects a specific measurement distortion.
