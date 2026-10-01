# factory-ai

**Scale your workflows. Remote-first harness for your SDLC.**

A control plane for coding agents. Queue a task against a repository; the board hands it to a
driver; the driver runs it in a pod (Kubernetes, primary) or a container (docker, development)
against the member's own workspace checkout, and reports back. The dashboard spawns no runner, the
driver never touches the database, and HTTP is the only thing between them.

| Surface | What it is | Docs |
| --- | --- | --- |
| Tasks | A prompt plus a repo, run by the executor profile it names (`claude-code` or `opencode`). | [jobs](docs/jobs.md) |
| Workflows | A graph of agent nodes the board walks between verdicts, instead of a prompt. | [workflows](docs/workflows.md) |
| Workspaces | Per-member checkouts at `/workspaces/<org>/<user>/<repo>`. | [workspace](docs/workspace.md) |
| Stats | Delivery measured from agent telemetry: sessions, tokens, lines, active time, coverage. | [metrics](docs/metrics.md) |

## Quickstart

Needs a database (no in-memory mode) and a GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`);
either credential missing refuses to boot.

```bash
npm install
docker compose up -d timescale
cp .env.example .env          # set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY
npm run dev                   # API on 127.0.0.1:8080, Vite on 5173 with /api proxied
```

No credential? Seed a disposable database and browse it offline:

```bash
docker compose exec timescale psql -U factory -d postgres -c 'create database factory_seed'
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_seed npm run seed
npm run verify:ui
```

`docker compose up` runs the same `npm run dev` against the bind-mounted tree — plus the database,
the collector and the driver. `docker build -f docker/Dockerfile --target runtime -t factory-ai .`
is what deploys; compose never builds it.

## Running tasks

```bash
make runners                 # build the executor images
docker compose up -d driver  # development: containers on the local docker socket
npm run dev -w cli -- job create "fix the flaky test" --repo owner/name
npm run dev -w cli -- job list --limit 5
```

`EXECUTOR=kubernetes` makes each task a pod instead; `charts/factory/` is what deploys
([kubernetes](docs/kubernetes.md), [EKS runbook](docs/eks-runbook.md)). The driver mounts the
docker socket, which is root on the host — read [security](docs/security.md) before running it
anywhere shared.

## Configuration

Everything lives in `.env` ([configuration](docs/configuration.md); full list in `.env.example`).
The ones that decide behaviour:

| Variable | Default | Effect |
| --- | --- | --- |
| `DATABASE_URL` | — | The only source the dashboard reads. Names ending `_test` / `_seed` / `_synthetic` / `_demo` / `_e2e` are disposable and refused in `app` mode. |
| `AUTH_MODE` | `none` | `none` opens every route and relies on the loopback bind. `docker compose` pins `github`, and `.env` cannot override it. |
| `EXECUTOR` | `docker` | `kubernetes` for anything real. |
| `JOB_BOARD_URL` / `JOB_BOARD_TOKEN` | — | How the driver finds and authenticates to the board. One shared secret, set once. |
| `FACTORY_URL` / `FACTORY_TOKEN` | — | The CLI's own credentials: the board, and your personal access token (`fat_…`), unset against an open board. |
| `DRIVER_CONCURRENCY` | `2` | Tasks in flight per driver (max 32). |
| `ORG_WORKSPACE_ROOT` | unset (compose sets `/workspaces`) | Where per-member checkouts live; unset switches them off. Nothing is cloned at boot. |
| `TELEMETRY_TTL_SECONDS` | `30` | Telemetry read cache (floor 5s). |

**There is no repo list to configure.** The GitHub App's installation is both the credential and
the list, so they cannot drift ([repos](docs/repos.md)). Sign-in is a separate **OAuth App**
(`read:org` only) — one credential doing both would make every sign-in grant repository access
([auth](docs/auth.md)).

## Layout

| Package | Purpose |
| --- | --- |
| `core/` | Telemetry aggregation and shared types. No dependencies, no I/O. |
| `server/` | Fastify API: ingest and store, the GitHub App credential and repo list, SPA hosting. |
| `web/` | Vite + React SPA. |
| `driver/` | Claims jobs from the board and runs a runner per job. Depends on nothing. |
| `cli/` | Board CLI over HTTP: `job create/list/investigate/wait/follow-up/stop/done/remove`. |

`core` must be built before `server` or `web` can typecheck — a stale `core/dist` reads as a source
bug. See [AGENTS.md](AGENTS.md) for the rest of the build coupling.

## Tests

```bash
npm test               # offline: no token, no quota, no database, no docker
npm run typecheck
npm run lint
npm run verify:ui      # real chromium against a seeded database
npm run test:db        # needs a *_test database
npm run test:jobs      # board + driver + real containers, no Claude
npm run test:k8s       # helm assertions; --cluster installs into kind
```

What each suite guards, and the coverage gates: [executor testing](docs/executor-testing.md),
[architecture](docs/architecture.md).

## API

`GET /api/health` never calls GitHub, so a rate-limited container still reports healthy.
`GET /api/stats` answers `200` with `{ telemetry, tasks, meta }`, `202` while the first read runs,
`503` if telemetry is off or that read failed. Full surface: [api](docs/api.md).

## Docs

[architecture](docs/architecture.md) · [jobs](docs/jobs.md) · [workflows](docs/workflows.md) ·
[kubernetes](docs/kubernetes.md) · [auth](docs/auth.md) · [workspace](docs/workspace.md) ·
[configuration](docs/configuration.md) · [persistence](docs/persistence.md) ·
[telemetry](docs/telemetry.md) · [security](docs/security.md) · [api](docs/api.md) ·
[design system](docs/design-system.md)

Metric definitions and the reasoning behind them are specified in `../factory-stats/SPEC.md`;
simplifying one silently makes the number wrong.
