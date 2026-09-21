# factory-ai

Software engineering factory control plane for observable, repository-aware AI delivery.

Factory combines an agent telemetry dashboard with a task board, workspace manager, workflow engine,
and Docker/Kubernetes executors. It tracks sessions, tokens, cache use, lines written, active time,
task outcomes, verification gates, and publishing activity.

## Documentation

The public documentation covers installation, configuration, capabilities, operation, security, and
the HTTP API:

- [Factory documentation](https://bellows-ai.github.io/factory/)
- [Choose a deployment](https://bellows-ai.github.io/factory/getting-started/deployment-options/)
- [Local development](https://bellows-ai.github.io/factory/getting-started/local-development/)
- [Kubernetes and Helm](https://bellows-ai.github.io/factory/getting-started/kubernetes/)

The Markdown source lives under [`docs-site/src/content/docs`](docs-site/src/content/docs). The root
[`docs/`](docs) directory contains internal engineering decisions that must be read before changing the
subsystems named in [`AGENTS.md`](AGENTS.md).

## Repository layout

| Path | Responsibility |
| --- | --- |
| `core/` | Shared telemetry types, ranges, and metrics |
| `server/` | API, authentication, persistence, GitHub integration, and migrations |
| `web/` | React dashboard and task interface |
| `driver/` | HTTP worker and Docker/Kubernetes execution |
| `charts/factory/` | Helm deployment |
| `docs-site/` | Public Starlight documentation site |

## Contributor bootstrap

Node.js 22.12 or newer, npm, Docker, and a TimescaleDB database are required.

```bash
npm install
docker compose up -d timescale
cp .env.example .env
npm run dev
```

Live application mode also requires a GitHub App ID and private key. See the
[local development guide](https://bellows-ai.github.io/factory/getting-started/local-development/) for
credentialed and offline seeded paths.

## Common commands

```bash
npm run build
npm test
npm run typecheck
npm run lint

npm run docs:dev
npm run docs:check
npm run docs:preview
```

Database, browser, Docker executor, and Kubernetes integration suites have additional prerequisites;
their guarded commands and safety constraints are documented in [`AGENTS.md`](AGENTS.md).

Factory is under initial construction. Configuration and payload changes update all callers directly;
there are no compatibility shims for retired behavior.
