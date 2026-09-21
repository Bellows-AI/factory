---
title: Health and observability
description: Check Factory's process health, database readiness, telemetry pipeline, driver, and runners.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/operations/health-observability.md
---

## Process health

`GET /api/health` is open in every authentication mode and returns:

```json
{
  "status": "ok",
  "uptimeSeconds": 42
}
```

This is a liveness check, not a database readiness check. It deliberately avoids GitHub and PostgreSQL
so a process can remain healthy while startup migrations retry.

## Database and dashboard readiness

Watch dashboard logs for `[migrate]` messages. The server starts listening before migrations finish;
database-backed routes wait for the migration promise. A cold `GET /api/stats` can answer `202` while
the first telemetry read runs or `503` when that first read fails. After a successful read, a temporary
failure serves the stale snapshot with metadata explaining that it is stale.

## Driver and runner health

The driver is healthy when it polls the board, receives `204` while idle, and renews leases for running
tasks. Investigate repeated authentication failures, lease loss, image pulls, worktree preparation, or
runner exit messages in driver logs.

Docker development logs:

```bash
docker compose logs -f dashboard driver collector timescale
```

Kubernetes logs and objects:

```bash
kubectl -n factory logs deployment/factory-factory
kubectl -n factory logs deployment/factory-factory-driver
kubectl -n factory get pods,jobs,secrets,pvc
kubectl -n factory describe job <runner-or-gate-job>
```

Adjust names when the Helm release is not `factory`.

## Telemetry pipeline

Check the path in order:

1. The runner has an OTLP endpoint it can resolve.
2. The collector listens on `4317`/`4318` and can reach Factory.
3. `INGEST_TOKEN` and `X-Factory-Ingest-Token` agree when authentication is enabled.
4. The session produces a repository/branch sample.
5. `/api/stats` reports `ok`, `empty`, or a named unavailable state.

`POST /api/otlp/v1/logs` currently acknowledges and discards logs. Use process and platform logs for
operational diagnosis.
