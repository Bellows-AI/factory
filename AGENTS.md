# AGENTS.md

Guidance for agents working in this repository. This file holds only what applies to every task —
commands, build coupling, and the map below. Everything else lives in `docs/`, one file per
concern. **Read the matching `docs/` file before you touch the code it covers**; each one is a list
of decisions that look like cruft and are not, and most are guarded by a test that fails obscurely.

This application is under initial construction. Do not provide backward compatibility — no
deprecation shims, no migration aliases, no preserving old payloads or config shapes. When a
change breaks something, update the callers and delete the old path in the same change.
Prioritize speed and cleanliness over compatibility.

## Executor parity: kubernetes is primary

**Kubernetes is the primary executor; docker is only for development.** Anything built or changed
for the docker executor — runner behavior, gates, services, publish/sync, env forwarding, any new
`RUNNER_*` feature — must land its kubernetes counterpart in the same change (see
[docs/kubernetes.md](docs/kubernetes.md) for the platform shapes). A docker-only feature is a
refusal to read, and a refusal message in the kubernetes path is a TODO, not a decision: if a
capability genuinely cannot be ported (no exec grant, no docker volume), the limit is stated in
docs and tests, never discovered by a user. When you touch `driver/`, ask "what does this do to
`EXECUTOR=kubernetes`?" before you finish.

## Read before you touch

| Touching | Read |
| --- | --- |
| Data flow, `server/src/main.ts` wiring, fixtures | [docs/architecture.md](docs/architecture.md) |
| `core/src/telemetry.ts`, `range.ts`, `metrics.ts`, cache/TTL constants | [docs/metrics.md](docs/metrics.md) |
| Anything named `org_id`, `005_organizations.sql`, the org selector | [docs/organizations.md](docs/organizations.md) |
| `server/src/auth/*`, `010_auth.sql`, the session cookie, the worker token, which routes need a credential | [docs/auth.md](docs/auth.md) |
| `server/src/github/app-*`, `repo-source.ts`, the App credential, `offline.ts` | [docs/configuration.md](docs/configuration.md) |
| The repo list, `repo-source.ts`, `db/stored-repos.ts`, session scoping, per-repo rendering | [docs/repos.md](docs/repos.md) |
| `config.ts`, compose env blocks, `.env.example` | [docs/configuration.md](docs/configuration.md) |
| `server/src/workspace/*`, `011_user_workspace.sql`, `ORG_WORKSPACE_ROOT`, the `git` install in the runtime image | [docs/workspace.md](docs/workspace.md) |
| `driver/src/k8s-*.ts`, `EXECUTOR`, `charts/factory/`, `scripts/test-k8s.sh` | [docs/kubernetes.md](docs/kubernetes.md) |
| Executor/runner tests, coverage gates, `scripts/test-jobs.sh`, `scripts/test-k8s.sh` | [docs/executor-testing.md](docs/executor-testing.md) |
| `server/src/telemetry/*`, OTLP routes, SQL views, collector config | [docs/telemetry.md](docs/telemetry.md) |
| `server/src/routes/jobs.ts`, `db/job-store.ts`, `006_jobs.sql`, `driver/*` | [docs/jobs.md](docs/jobs.md) |
| `workflow`, `027_workflows.sql`, `db/workflow-*.ts`, `routes/workflows.ts`, the claim's `publish` flag | [docs/workflows.md](docs/workflows.md) |
| `env_var`, `routes/env.ts`, the claim's `env`, the driver's env forwarding, the `/env` page | [docs/env.md](docs/env.md) |
| `filterTelemetryInput()`, `parseRange`, the range selector, charts | [docs/date-range.md](docs/date-range.md) |
| `web/src/styles.css`, tokens and primitives, any component, panel or page under `web/src` | [docs/design-system.md](docs/design-system.md) |
| `server/src/db/*`, `stats-service.ts`, migrations | [docs/persistence.md](docs/persistence.md) |
| Routes, status codes, query parameters | [docs/api.md](docs/api.md) |
| Bind addresses, headers, PAT scopes, `OTEL_LOG_*` | [docs/security.md](docs/security.md) |
| Reporting a number as measured | [docs/limits.md](docs/limits.md) |

Metric definitions and the reasoning behind them live in `../factory-stats/SPEC.md`, outside this
repo.

## Commands

```bash
npm install

# All of these need a database; there is no in-memory mode. `docker compose up -d timescale` first.
# They also need the GitHub App: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required, and either
# one missing refuses to boot. There is no no-fetch mode; the offline tooling boots
# server/dist/offline.js instead, which is code, not configuration.
npm run dev            # builds core, then API on 127.0.0.1:8080 + Vite on 5173 (/api proxied)
npm run dev:server     # tsx watch, server only
npm run dev:web        # vite only (needs the API running for /api)

npm run build          # core -> server -> web -> driver, in that order
npm start              # node --env-file-if-exists=.env server/dist/index.js (requires build)

# The job driver: claims jobs from the board and spawns the runner selected by each task's executor
# profile (claude-executor or opencode-executor). Needs a docker daemon and the runner image or
# images (`docker build -t claude-executor docker/claude-executor`, `docker build -t
# opencode-executor docker/opencode-executor`). It talks to the board over HTTP only — never to the
# database — so JOB_BOARD_URL is all it needs to find.
npm run driver

npm test               # vitest run — offline, no token, no quota, no database, no docker
npm run test:executors # focused offline board/driver/runner/telemetry suites
npm run test:coverage:executors # the same surface with executor-specific coverage thresholds
npm run typecheck      # tsc -b across all four project references (plus server/tsconfig.test.json,
                       # which typechecks server/test-db and its harness — the suites drift quietly otherwise)
npm run lint           # biome check — lint + format verification over the four packages, offline
npm run format         # biome format --write — fixes format drift
npm run lint:fix       # biome check --write — fixes what lint flags

# Real browser (chromium, headless). Builds, RESETS and seeds factory_e2e — the seed is additive,
# so the reset is what keeps one run's data from stacking on the last run's — then serves the SPA
# from the API on 8123 and walks every date range. Still offline — no token, no quota, no network — but by way of
# a seeded database rather than a replayed payload. Screenshots to artifacts/ui/ — read them; a
# passing assertion says the DOM was right, only the image says the layout was.
#
# Two projects, two servers. `chromium` is the open board on 8123 and is the visual check; `auth`
# is a second board on 8124 with AUTH_MODE=github pointed at e2e/stub-idp.mjs, which drives a real
# sign-in round trip offline. Needs factory_e2e AND factory_auth_e2e to exist.
npm run verify:ui      # needs: a running timescale, and `npx playwright install chromium` once

# Fill a disposable database with synthetic agent sessions. Refuses
# any database whose name does not mark it disposable: synthetic rows are indistinguishable from
# real ones once written, and there is no way to separate them afterwards.
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_seed npm run seed

# The repo list is whatever the GitHub App installation reports; ORG_REPOS is gone and is fatal if
# set. Without an App client — the offline entry's code-only no-fetch arm — the list falls back to
# the distinct repos already in session_branch, which is what keeps a seeded database browsable
# with no credential.

# Compose is an infrastructure wrapper, not a shipping vehicle. It runs the same `npm run dev` as
# above against the bind-mounted working tree: API on 127.0.0.1:8080 (tsx watch), Vite on 5173
# (HMR), plus TimescaleDB and the OTEL collector. The job driver runs from the tree too (#174) —
# all three long-running processes do, so no restart can serve code older than the checkout. Edits
# are live with no rebuild — the image carries no source. node_modules lives in named volumes, so
# a restart is ~10s and `down -v` forces a clean reinstall. There is no `--build` to remember and
# no baked image to go stale.
docker compose up

# What deploys, and what compose does NOT run: the baked `runtime` stage, SPA and API on one port.
docker build -f docker/Dockerfile --target runtime -t factory-ai .

# The driver mounts the docker socket, which is root on the host — see docs/security.md before
# running this file anywhere shared. `docker compose up` starts it with the stack.
docker compose up -d driver

# factory_dev holds real data; *_test, *_seed, *_synthetic, *_demo and *_e2e are disposable. The db
# suite resets and reseeds EVERY table before each test and truncates again at the end, so it
# refuses any database not named *_test — pointing it at factory_dev would silently destroy
# backfilled history, and the tests would still pass. Suites seed their own fakes (shared harness,
# server/test-db/harness.ts), so a fresh empty database works; nothing survives a run.
# loadConfig mirrors that: a fetching process refuses to run against any disposable name at all.
docker compose up -d timescale
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test npm run test:db

# The job board and its driver, end to end: a real board on 8129 against a real factory_jobs_test,
# a real driver, and real containers — but no Claude and no credential. The runners are four stub
# images, two of which echo and exit — those prove the whole path offline. Everything it
# creates it drops. Needs docker and a free 8129.
npm run test:jobs

# The same board and driver, on Kubernetes. Phase one is offline helm lint/template assertions;
# --cluster installs the chart into a local kind cluster with a stub echo executor and watches a
# queued job come back succeeded through real pods. Needs helm; --cluster additionally needs kind.
npm run test:k8s

# Organizations are the GitHub App's installations (#99): anyone who can see an installation signs
# in, and sign-in materializes the org, the membership and the session's binding. AUTH_MODE defaults
# to `none` — one local org, every route open, the bind address the access control — which is what
# `npm run dev`, seed, verify:ui and test-jobs run. `docker compose` pins `github`, uncontestable by
# .env, because that stack holds the checkouts. Set the App's Setup URL to
# <PUBLIC_URL>/api/auth/github/setup so the install round trip returns.

# The driver's credential is one shared secret: JOB_BOARD_TOKEN in .env, read by BOTH the
# dashboard (validates it on the worker routes) and the driver (presents it). Set it once —
# openssl rand -hex 32 — and a fresh `docker compose up` just works.

# Import history from ~/.claude/projects/*/*.jsonl. Idempotent; safe to re-run.
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_dev npm run backfill
```

Single test file / single case:

```bash
npx vitest run core/test/metrics.invariants.test.ts
npx vitest run -t 'matches on each token type'
```

Watch mode is tuned for low idle CPU: `isolate: false`, forks capped at `minWorkers: 1` /
`maxWorkers: 2`, and `watchExclude` covers `**/dist/**` so a core watch build does not invalidate
the module graph for every server/web test. Do not undo these to chase a flaky-looking failure.
Prefer watching one package (`npx vitest watch core/test`) over the whole suite. If CPU pins
again, look for orphaned `node (vitest N)` workers (parent = 1) left by a killed session —
`pkill -f 'node (vitest'` clears them.

Biome is the linter and formatter: `biome.json` at the root, covering the four packages and the
root config files. `npm run lint` is `biome check .` — lint and format verification in one offline
pass — and `npm run format` is the fixer. The enforced style is the one the tree was already
written in: 4-space indent, single quotes (double in JSX attributes), semicolons, 120-column
lines, `es5` trailing commas; `core/test/biome.test.ts` pins all of it. Recommended rules run with
deliberate carve-outs in `biome.json`, added because they fire on existing code that the
enablement PR chose not to churn: non-null assertions are the house style under
`noUncheckedIndexedAccess`, index keys drive chart ticks, bracket access preserves raw-JSON
contracts (`otlp.ts` reads OTEL payloads field by field), `stripAnsi` in `driver/src/runner.ts`
matches control characters on purpose, and the `.cjs` container scripts carry their own quirks.
Every carve-out is a re-enable candidate: turn a rule back on only with the
source change that retires its hits. Import sorting (assist) and CSS formatting are off; neither
is a convention here.

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

**Container scripts are files, never inline strings.** Every script the driver hands to a
container — the git probe, the worktree sync, the `.bellows.yaml` readout, the opencode session
readout and cache probe, the push credential helper, the remote-session read — lives as a real
file under `driver/src/scripts/` (`.cjs` for node, `.sh` for shell), is read at load time via
`import.meta.url`, and is passed to the container by content (`node -e`, `sh -c`), never by
mounting a path (the driver talks to a remote daemon and has no host path into the volumes it
names). Script parameters travel as env values or plain argv, never interpolated into the script
text. The driver build copies the directory into `dist` (`driver/package.json`); forgetting that
copy fails only in the container, never in dev — the same trap as `server/migrations` below.

**Container shell scripts are POSIX-portable, and their VALUES are code too.** The runner images
ship `dash` as `sh`; a script that only the macOS dev host's `sh` parses is a container-only
failure (the credential helper carried a `!f(){ …` line for weeks: bash accepted it, dash
rejected it, and the `sh -n` gate only ran under the host shell). Write `.sh` files to POSIX sh,
not bash. And when a file's content is loaded as a VALUE — the credential helper becomes git's
`-c credential.helper=`, which git executes as `sh -c '<value> <op>'` with the operation appended
verbatim — trailing whitespace is code: the constant is trimmed at load, and the scripts suite
pins the exact spawn shape and exit status, not a lookalike. Test the bytes that ship.

Tests import `core/src` directly (`../src/metrics.js`), so `core/test` does not need the build.
`vitest.config.ts` includes `core/test`, `server/test`, `driver/test` and `web/test`. The web
suite is mostly a **render smoke test** — it renders the telemetry panels with `react-dom/server`,
so no DOM and no browser is needed, but it will not tell you the SPA looks right — plus
non-component suites (executor config validation, tab transitions).

A new file in `core/src` must be re-exported from `core/src/index.ts` or the server sees
"module has no exported member" — the same failure mode as a stale `core/dist`, and it looks
just as much like a source bug.

**`server/migrations/*.sql` are not compiled by `tsc`**, so `docker/Dockerfile` copies them
explicitly — by directory, so a new migration needs no Dockerfile edit. Forgetting that fails only
in the container, never in dev.
