# AGENTS.md

What applies to every task: the commands, the build coupling, and the map to `docs/`. The code and
the tests are the source of truth — `docs/` is an index to them, one file per concern, each a table
of concern → code → test. Read the matching file before you touch the code it covers.

Under initial construction: **no backward compatibility.** No deprecation shims, no migration
aliases, no preserved payload or config shapes. Update the callers and delete the old path in the
same change.

**Kubernetes is the primary executor; docker is development only.** Anything built for the docker
executor — runner behavior, gates, services, publish/sync, env forwarding, any `RUNNER_*` feature —
lands its kubernetes counterpart in the same change. A capability that genuinely cannot be ported
is stated as a limit in `docs/kubernetes.md` and pinned by `driver/test/k8s-docs.test.ts`, never
left as a refusal message. Touching `driver/`? Ask what it does to `EXECUTOR=kubernetes`.

## Read before you touch

| Touching | Read |
| --- | --- |
| Data flow, `server/src/main.ts` wiring, fixtures | [docs/architecture.md](docs/architecture.md) |
| `core/src/telemetry.ts`, `metrics.ts`, cache/TTL constants | [docs/metrics.md](docs/metrics.md) |
| `org_id`, `005_organizations.sql`, the org selector | [docs/organizations.md](docs/organizations.md) |
| `server/src/auth/*`, `010_auth.sql`, session cookie, worker token, route credentials | [docs/auth.md](docs/auth.md) |
| `config.ts`, `.env.example`, compose env blocks, `server/src/github/app-*`, `offline.ts` | [docs/configuration.md](docs/configuration.md) |
| The repo list, `repo-source.ts`, `db/stored-repos.ts`, session scoping | [docs/repos.md](docs/repos.md) |
| `server/src/workspace/*`, `011_user_workspace.sql`, `ORG_WORKSPACE_ROOT` | [docs/workspace.md](docs/workspace.md) |
| `driver/src/k8s-*.ts`, `EXECUTOR`, `charts/`, `scripts/test-k8s.sh` | [docs/kubernetes.md](docs/kubernetes.md) |
| EKS installs, the EFS storage class, the pre-release cloud walk | [docs/eks-runbook.md](docs/eks-runbook.md) |
| Executor/runner tests, coverage gates, `scripts/test-jobs.sh` | [docs/executor-testing.md](docs/executor-testing.md) |
| `server/src/telemetry/*`, OTLP routes, SQL views, collector config | [docs/telemetry.md](docs/telemetry.md) |
| `server/src/routes/jobs.ts`, `db/job-store*.ts`, `006_jobs.sql`, `driver/*`, `cli/*` | [docs/jobs.md](docs/jobs.md) |
| `workflow`, `027_workflows.sql`, `db/workflow-*.ts`, `routes/workflows.ts` | [docs/workflows.md](docs/workflows.md) |
| `env_var`, `routes/env.ts`, the claim's `env`, driver env forwarding | [docs/env.md](docs/env.md) |
| `parseRange`, `filterTelemetryInput()`, the range selector | [docs/date-range.md](docs/date-range.md) |
| `web/src/styles/`, any component, panel or page under `web/src` | [docs/design-system.md](docs/design-system.md) + [lanes](docs/design-system/) |
| `server/src/db/*`, `stats-service.ts`, migrations | [docs/persistence.md](docs/persistence.md) |
| Routes, status codes, query parameters | [docs/api.md](docs/api.md) |
| `.github/workflows/*`, CI triggers, the release image build | [docs/ci.md](docs/ci.md) |
| Bind addresses, container hardening, PAT scopes, `OTEL_LOG_*` | [docs/security.md](docs/security.md) |
| Reporting a number as measured | [docs/limits.md](docs/limits.md) |

Metric definitions live in `../factory-stats/SPEC.md`, outside this repo.

## Commands

Booting the board — `npm run dev`, `npm run dev:server`, `npm start` — needs PostgreSQL
(`docker compose up -d postgres`) and the GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`);
either missing refuses to boot. Offline tooling boots `server/dist/offline.js`, which is code, not
a flag. `npm install`, `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` need
none of it; the `DATABASE_URL=…` commands below name the database they need.

```bash
npm install
npm run dev                     # core, then API on 127.0.0.1:8080 + Vite on 5173
npm run dev:server              # tsx watch, server only
npm run dev:web                 # vite only
npm run build                   # core -> server -> web -> driver -> cli
npm start                       # server/dist/index.js (requires build)

make runners                    # build both executor images
npm run driver                  # claims jobs; needs a docker daemon and JOB_BOARD_URL
npm run dev -w cli -- job list --limit 5

npm test                        # offline: no token, no quota, no database, no docker
npm run test:executors          # focused board/driver/runner/telemetry suites
npm run typecheck               # tsc -b, plus server/tsconfig.test.json and e2e/tsconfig.json
npm run lint                    # biome check; npm run format / lint:fix are the fixers
npm run verify:ui               # real chromium; needs postgres + playwright install chromium

DATABASE_URL=…/factory_seed npm run seed        # synthetic sessions, disposable names only
DATABASE_URL=…/factory_test  npm run test:db    # resets every table
DATABASE_URL=…/factory_dev   npm run backfill   # import ~/.claude/projects/*/*.jsonl, idempotent
npm run test:jobs               # board + driver + real containers on 8129, no Claude
npm run test:k8s                # helm assertions; --cluster installs into kind

docker compose up               # the same npm run dev against the bind-mounted tree
docker compose up -d driver     # mounts the docker socket — see docs/security.md
docker build -f docker/Dockerfile --target runtime -t factory-ai .   # what deploys

npx vitest run core/test/metrics.invariants.test.ts
npx vitest run -t 'matches on each token type'
```

Operational facts behind those:

- **Disposable database names are load-bearing.** `*_test`, `*_seed`, `*_synthetic`, `*_demo`,
  `*_e2e` are wiped without warning; `npm run test:db` refuses anything not ending `_test`, and a
  fetching process refuses a disposable name entirely. `server/test-db/harness.ts`,
  `server/test/config.*.test.ts`.
- **Run the CLI through ONE npm layer** — `npm run dev -w cli -- job …`. A second npm eats
  `--timeout`/`--json`/`--yes` as its own configuration and drops the flag silently.
  `core/test/skills.task-control.test.ts`.
- `verify:ui` needs `factory_e2e` **and** `factory_auth_e2e` to exist; Playwright boots every
  webServer whatever `--project` says. `E2E_PORT_BASE` (default 8123) and `E2E_DB_PREFIX` let two
  worktrees run at once — one checkout cannot, since both write `web/dist` and `artifacts/`.
  Screenshots land in `artifacts/ui/`: read them, a passing assertion only says the DOM was right.
- `AUTH_MODE` defaults to `none` (one local org, every route open, the loopback bind is the access
  control). `docker compose` pins `github`, uncontestable by `.env`.
- `JOB_BOARD_TOKEN` is one shared secret read by both the dashboard and the driver.
- Watch mode is tuned for low idle CPU (`isolate: false`, 1–2 forks, `**/dist/**` excluded in
  `vitest.config.ts`). Do not undo that to chase a flaky-looking failure; prefer
  `npx vitest watch core/test`. Orphaned `node (vitest N)` workers: `pkill -f 'node (vitest'`.

## Lint

`biome.json` at the root covers the five packages, `e2e/` and the root config files;
`core/test/biome.test.ts` pins the style (4-space, single quotes, semicolons, 120 columns, `es5`
trailing commas) and every carve-out. Read the config, not a summary of it — but three things it
cannot tell you:

- **Measure one rule at a time** (`--only`). A whole-config sweep reports false zeros for the
  type-aware rules: `noUnnecessaryConditions` reads 0 in a sweep and 35 under `--only`.
- **A Grit plugin that fails to compile does not fail the run** — it logs `<plugin> errored:` at
  `info` and matches nothing, so a broken ratchet looks clean. `core/test/biome.test.ts` asserts
  that message is absent. Spell paths in a plugin as an `or` of whole regexes; an alternation group
  (`(src|test)`) binds to a variable and fails to compile.
- Every disabled rule in `biome.json` was measured, not assumed. Re-enable one only together with
  the source change that retires its hits; the nursery block is where a Biome upgrade breaks first.

## Build coupling

- **`core` must be built before `server` or `web` can typecheck or run** — both resolve
  `@factory-ai/core` to `core/dist`. A stale `core/dist` reads as a source bug;
  `npm run build -w core`.
- **A new `core/src` file must be re-exported from `core/src/index.ts`** or the server reports
  "module has no exported member". `core/test/core-index.test.ts`.
- **`driver/` and `cli/` depend on nothing, `core` included.** They are HTTP clients; a shared type
  is copied, never imported. `lint/no-cross-package-imports.grit`.
- All five packages are ESM with `verbatimModuleSyntax`: relative imports carry `.js`, even in
  `.tsx`.
- **Container scripts are files under `driver/src/scripts/`, never inline strings** — read via
  `import.meta.url` and passed by content, with parameters as env or argv.
  `lint/no-inline-container-scripts.grit`. `driver/package.json` copies the directory into `dist`;
  forgetting that fails only in the container.
- **`.sh` scripts are POSIX, and a script loaded as a VALUE is code** — the runner images ship
  `dash`, and the credential helper is appended to by git, so trailing whitespace matters.
  `driver/test/scripts-*.test.ts` pins the bytes that ship.
- **`server/migrations/*.sql` are not compiled by `tsc`** — `docker/Dockerfile` copies the
  directory. Forgetting that fails only in the container.
- `core/test` imports `core/src` directly, so it needs no build. The web suite is a `react-dom/server`
  render smoke test: it will not tell you the SPA looks right. `npm run verify:ui` does.
</content>
