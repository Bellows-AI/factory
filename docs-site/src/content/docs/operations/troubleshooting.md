---
title: Troubleshooting
description: Diagnose common Factory startup, authentication, workspace, executor, and telemetry failures.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/operations/troubleshooting.md
---

## The server refuses to start

- **`DATABASE_URL is required`** — start TimescaleDB or point to an existing database.
- **GitHub App ID/private key missing** — configure both; live mode has no no-fetch fallback.
- **Private key is not PEM** — provide the PEM contents, their base64 form, or
  `GITHUB_APP_PRIVATE_KEY_FILE`.
- **Half-configured GitHub auth** — when `AUTH_MODE=github`, provide OAuth client ID/secret,
  `SESSION_SECRET`, `PUBLIC_URL` for a non-loopback host, and `JOB_BOARD_TOKEN`.
- **Public unauthenticated bind refused** — bind to loopback, enable GitHub auth, or place a trusted
  authentication layer in front and explicitly set `AUTH_ALLOW_PUBLIC_BIND=1`.
- **A retired variable is rejected** — remove it and follow the replacement named in the error. Factory
  does not silently ignore previously meaningful configuration.

## The UI loads but data does not

Check `[migrate]` logs and `/api/stats`. `202` means the first read is still running. `503` means the
first read is disabled or failed. A `200` with `empty` means the pipeline is connected but has no
in-scope sessions.

Confirm that the GitHub App is installed on the expected organization, the current session selected
that organization, repository filters are not hiding data, and branch samples exist for the time range.

## Repositories do not clone

Confirm `ORG_WORKSPACE_ROOT` is absolute, writable by the dashboard, and mounted at the same path in the
driver and runners. Verify the repository is visible to the App installation. Existing failed or
orphaned checkout directories are not automatically overwritten or pruned.

## Tasks stay queued

Check that the driver can reach `JOB_BOARD_URL`, presents the same `JOB_BOARD_TOKEN` as the server, and
has capacity under `DRIVER_CONCURRENCY`. On Kubernetes, inspect driver RBAC, image pull policy, namespace,
workspace PVC, and runner credential Secret.

## A runner cannot reach a dependency

Do not use `127.0.0.1` for a sibling service. Use the `.bellows.yaml` service name, Compose network name,
Kubernetes Service, or an explicit host-gateway address. Declared services start without a readiness
wait, so clients should tolerate a short startup interval.

## Gates fail before the agent runs

A malformed or unreadable `.bellows.yaml` is a task error, not “no gates.” Validate its environment
image, named commands, size, and YAML shape. On Kubernetes, inspect the short-lived gate Job and ensure
the workspace storage supports writes by UID/GID 1000.
