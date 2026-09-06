# AGENTS.md

Guidance for agents working in this repository. This file holds only what applies to every task —
commands, build coupling, and the map below. Everything else lives in `docs/`, one file per
concern. **Read the matching `docs/` file before you touch the code it covers**; each one is a list
of decisions that look like cruft and are not, and most are guarded by a test that fails obscurely.

## Read before you touch

| Touching | Read |
| --- | --- |
| Data flow, forge adapters, `server/src/index.ts` wiring, fixtures | [docs/architecture.md](docs/architecture.md) |
| `core/src/metrics.ts`, `canonical.ts`, the GraphQL query, cache/TTL constants | [docs/metrics.md](docs/metrics.md) |
| Anything named `org_id`, `005_organizations.sql`, the org selector | [docs/organizations.md](docs/organizations.md) |
| `server/src/auth/*`, `010_auth.sql`, the session cookie, the worker token, which routes need a credential | [docs/auth.md](docs/auth.md) |
| `server/src/github/app-*`, `repo-source.ts`, `GITHUB_MODE`, the App private key | [docs/configuration.md](docs/configuration.md) |
| `attribute()` keys, `004_pull_requests.sql` keys, per-repo rendering | [docs/repos.md](docs/repos.md) |
| `config.ts`, compose env blocks, `.env.example` | [docs/configuration.md](docs/configuration.md) |
| `server/src/workspace/*`, `011_user_workspace.sql`, `ORG_WORKSPACE_ROOT`, the `git` install in the runtime image | [docs/workspace.md](docs/workspace.md) |
| `driver/src/k8s.ts`, `EXECUTOR`, `charts/factory/`, `scripts/test-k8s.sh` | [docs/kubernetes.md](docs/kubernetes.md) |
| `server/src/telemetry/*`, OTLP routes, SQL views, collector config | [docs/telemetry.md](docs/telemetry.md) |
| `server/src/routes/jobs.ts`, `db/job-store.ts`, `006_jobs.sql`, `driver/*` | [docs/jobs.md](docs/jobs.md) |
| `filterPrs()`, `parseRange`, `revertForRange()`, the range selector, charts | [docs/date-range.md](docs/date-range.md) |
| `server/src/store/*`, `stats-service.ts`, the sync watermark, migrations | [docs/persistence.md](docs/persistence.md) |
| Routes, status codes, query parameters | [docs/api.md](docs/api.md) |
| Bind addresses, headers, PAT scopes, `OTEL_LOG_*` | [docs/security.md](docs/security.md) |
| Reporting a number as measured | [docs/limits.md](docs/limits.md) |

Metric definitions and the reasoning behind them live in `../factory-stats/SPEC.md`, outside this
repo.

## Commands

```bash
npm install

# All of these need a database; there is no in-memory mode. `docker compose up -d timescale` first.
# They also need a decision about GitHub: GITHUB_MODE defaults to `app` and is fatal without an App
# id and private key. `GITHUB_MODE=none` serves whatever is already stored and fetches nothing —
# that is a supported way to run, but not one you reach by forgetting a variable.
npm run dev            # builds core, then API on 127.0.0.1:8080 + Vite on 5173 (/api proxied)
npm run dev:server     # tsx watch, server only
npm run dev:web        # vite only (needs the API running for /api)

npm run build          # core -> server -> web -> driver, in that order
npm start              # node server/dist/index.js (requires build)

# The job driver: claims jobs from the board and spawns a runner container per job (claude-executor,
# or opencode-executor under RUNNER_CLI=opencode). Needs a docker daemon and the runner image or
# images (`docker build -t claude-executor docker/claude-executor`, `docker build -t
# opencode-executor docker/opencode-executor`). It talks to the board over HTTP only — never to the
# database — so JOB_BOARD_URL is all it needs to find.
npm run driver

npm test               # vitest run — offline, no token, no quota, no database, no docker
npm run typecheck      # tsc -b across all four project references

# Real browser (chromium, headless). Builds, SEEDS factory_e2e, serves the SPA from the API on
# 8123 and walks every date range. Still offline — no token, no quota, no network — but by way of
# a seeded database rather than a replayed payload. Screenshots to artifacts/ui/ — read them; a
# passing assertion says the DOM was right, only the image says the layout was.
#
# Two projects, two servers. `chromium` is the open board on 8123 and is the visual check; `auth`
# is a second board on 8124 with AUTH_MODE=github pointed at e2e/stub-idp.mjs, which drives a real
# sign-in round trip offline. Needs factory_e2e AND factory_auth_e2e to exist.
npm run verify:ui      # needs: a running timescale, and `npx playwright install chromium` once

# Fill a disposable database with synthetic PRs, base-branch history and agent sessions. Refuses
# any database whose name does not mark it disposable: synthetic rows are indistinguishable from
# real ones once written, and there is no way to separate them afterwards.
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_seed npm run seed

# The repo list is whatever the GitHub App installation reports; ORG_REPOS is gone and is fatal if
# set. Under GITHUB_MODE=none the list falls back to the repos the database already holds rows for,
# which is what keeps a seeded database browsable with no credential.

# Compose is an infrastructure wrapper, not a shipping vehicle. It runs the same `npm run dev` as
# above against the bind-mounted working tree: API on 127.0.0.1:8080 (tsx watch), Vite on 5173
# (HMR), plus TimescaleDB and the OTEL collector. Edits are live with no rebuild — the image carries
# no source. node_modules lives in named volumes, so a restart is ~10s and `down -v` forces a clean
# reinstall. There is no `--build` to remember and no baked image to go stale.
docker compose up

# What deploys, and what compose does NOT run: the baked `runtime` stage, SPA and API on one port.
docker build -f docker/Dockerfile --target runtime -t factory-ai .

# The driver is behind a profile, so the line above never starts it: it mounts the docker socket,
# which is root on the host. See docs/security.md.
docker compose --profile driver up -d driver

# factory_dev holds real data; *_test, *_seed, *_synthetic, *_demo and *_e2e are disposable. The db
# suite TRUNCATES its tables, so it refuses any database not named *_test — pointing it at
# factory_dev would silently destroy backfilled history, and the tests would still pass. loadConfig
# mirrors that: a process in GITHUB_MODE=app refuses to run against any disposable name at all.
docker compose up -d timescale
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test npm run test:db

# The job board and its driver, end to end: a real board on 8129 against a real factory_jobs_test,
# a real driver, and real containers — but no Claude and no credential. The runners are two stub
# images that echo and exit, which is what makes the whole path assertable offline. Everything it
# creates it drops. Needs docker and a free 8129.
npm run test:jobs

# The same board and driver, on Kubernetes. Phase one is offline helm lint/template assertions;
# --cluster installs the chart into minikube with a stub echo executor and watches a queued job
# come back succeeded through real pods. Needs helm; --cluster additionally needs minikube.
npm run test:k8s

# Accounts. AUTH_MODE defaults to `none`, where every route is open and the bind address is the
# access control — that is what `npm run dev`, seed, verify:ui and test-jobs run. `docker compose`
# is the exception and pins `github`, uncontestable by .env, because that stack holds the
# checkouts. Somebody has to be invited before they can sign in — and after 010 an existing database
# has nobody in it, which presents as "auth is broken" rather than "nobody has been invited".
# auth.bootstrap_admin covers the first person.
npm run invite -- --login <github-login> [--role admin|member] [--remove]
npm run invite -- --list

# The driver's credential, printed once — only its hash is stored. A CLI and not a route, because it
# issues something that claims work and reports results with no human anywhere.
npm run worker-token -- --name driver-1 [--revoke]

# Import history from ~/.claude/projects/*/*.jsonl. Idempotent; safe to re-run.
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_dev npm run backfill

# Regenerate core/test/fixtures/sample-canonical.json from the raw GitHub capture. Run after any
# change to toCanonical(); the core suite measures its output.
npm run fixture:canonical
```

Single test file / single case:

```bash
npx vitest run core/test/metrics.invariants.test.ts
npx vitest run -t 'matches the measured headline figures'
```

There is no linter or formatter configured. Match existing style: 4-space indent, single quotes,
semicolons.

## Build coupling to know about

`server` and `web` resolve `@factory-ai/core` to `core/dist`, not `core/src`. **`core` must be
built before the server or web can typecheck or run** — that is why `npm run dev` and
`npm run build` build it first. A stale `core/dist` produces type errors that look like source
bugs. Fix with `npm run build -w core`.

`driver` is the exception: it depends on nothing, `core` included, and its tsconfig has no project
references. That is deliberate — it is a client of the HTTP board, and sharing types with the server
would give a process that only needs `fetch` and `docker` the whole server dependency tree, plus a
build order. If a type has to be shared, copy it.

All four packages are ESM with `verbatimModuleSyntax`; relative imports carry a `.js`
extension even in `.tsx` files.

Tests import `core/src` directly (`../src/metrics.js`), so `core/test` does not need the build.
`vitest.config.ts` includes `core/test`, `server/test` and `web/test`. The web suite is a
**render smoke test only** — it renders the telemetry panels with `react-dom/server`, so no DOM
and no browser is needed, but it will not tell you the SPA looks right.

A new file in `core/src` must be re-exported from `core/src/index.ts` or the server sees
"module has no exported member" — the same failure mode as a stale `core/dist`, and it looks
just as much like a source bug.

**`server/migrations/*.sql` are not compiled by `tsc`**, so `docker/Dockerfile` copies them
explicitly — by directory, so a new migration needs no Dockerfile edit. Forgetting that fails only
in the container, never in dev. The GitHub capture no longer needs copying: nothing reads it at
runtime any more.
