---
title: Choose a deployment
description: Select the supported Factory setup for development, evaluation, or production operation.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/getting-started/deployment-options.md
---

Factory's deployment paths have different purposes.

| Path | Intended use | What runs |
| --- | --- | --- |
| Host development | Day-to-day product development | API on `127.0.0.1:8080`, Vite on `5173`, Dockerized TimescaleDB |
| Docker Compose | Full development stack with live source mounts | Dashboard dev processes, driver, TimescaleDB, and OTEL collector |
| Runtime image | Building the deployable API and SPA artifact | One image serving the compiled API and SPA on port `8080` |
| Helm chart | Production-like and Kubernetes operation | Dashboard, driver, runner Jobs, shared workspaces, optional TimescaleDB and collector |

:::note[Compose is development infrastructure]
`docker compose up` runs source from the checkout with watchers and named `node_modules` volumes. It is
not the deployable Factory image. Build the `runtime` stage or use the Helm chart for deployment.
:::

## Requirements shared by live deployments

- A PostgreSQL/TimescaleDB database. There is no in-memory mode.
- A GitHub App ID and private key. Live application startup refuses to continue if either is absent.
- Persistent workspace storage when tasks will modify repositories.
- A Factory driver and an executor image when tasks will be run.
- GitHub OAuth, session, and worker credentials when the dashboard is reachable by other users.

Use [local development](./local-development.md) for a source checkout. Use
[Kubernetes and Helm](./kubernetes.md) for a deployable stack.
