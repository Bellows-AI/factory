---
title: System architecture
description: Understand Factory's data, control, telemetry, and execution paths.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/concepts/architecture.md
---

## Dashboard and API

The Factory server is the control plane. It serves the compiled browser application, exposes the
`/api/*` routes, validates credentials, runs schema migrations, and reads and writes TimescaleDB.
The browser never talks directly to the database or driver.

The database is mandatory. On startup, the server begins listening while migrations retry in the
background; each database-backed store waits for the migration promise before querying. This allows
the open health route to answer while a database container is still starting.

## Telemetry path

Supported agents export OpenTelemetry data to a collector. The collector forwards metrics and logs to
Factory's OTLP routes. Factory flattens metric payloads into `metric_point`, associates sessions with
repository and branch samples, and serves aggregated dashboard views from PostgreSQL.

```text
runner or laptop plugin
  -> OTEL collector
  -> POST /api/otlp/v1/metrics and /api/otlp/v1/logs
  -> TimescaleDB
  -> GET /api/stats
```

Repository and branch samples bypass the collector. The runner's branch reporter and the laptop
plugin post them directly to `POST /api/sessions/branch`.

## Task path

People create tasks through the dashboard or API. The driver polls the board over HTTP, claims a task
with a lease, prepares its worktree, and launches the chosen executor. Output, heartbeats, session
identity, gate results, and completion travel back through lease-guarded HTTP calls.

The driver deliberately shares no server package or database connection. Kubernetes is the primary
executor for deployments; Docker is for local development. Both implement the same runner behavior,
so the executor changes transport, not the board contract.

## GitHub path

The server mints short-lived installation tokens from the GitHub App private key. Installations
define the organizations; each organization's repositories are those the installation reports,
narrowed by the repositories tracked during onboarding. A task claim receives only the credentials
and scoped environment required for its attempt. Publishing requests a fresh installation token
immediately before the final push so a long run does not depend on the claim-time token still being
valid; if that request returns nothing, the driver falls back to the claim-time token.
