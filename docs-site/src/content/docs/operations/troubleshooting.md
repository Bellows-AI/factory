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
- **Secret too short** — `SESSION_SECRET`, `JOB_BOARD_TOKEN`, and `GITHUB_WEBHOOK_SECRET` (when set)
  must be at least 32 characters. Generate one with `openssl rand -hex 32`.
- **Public unauthenticated bind refused** — bind to loopback, enable GitHub auth, or place a trusted
  authentication layer in front and explicitly set `AUTH_ALLOW_PUBLIC_BIND=1`.
- **A retired variable is rejected** — remove it and follow the replacement named in the error. Factory
  does not silently ignore previously meaningful configuration.

## The UI loads but data does not

Check `[migrate]` logs, `/api/ready`, and `/api/stats`. If `/api/ready` reports
`"migrations": "failed"`, the migration retry gave up; fix database connectivity and restart the
dashboard. For `/api/stats`, `202` means the first read is still running, `503` means the first read is
disabled or failed, and a `200` with `empty` means the pipeline is connected but has no in-scope
sessions.

Confirm that the GitHub App is installed on the expected organization, the current session selected
that organization, repository filters are not hiding data, and branch samples exist for the time range.

## Repositories do not clone

Confirm `ORG_WORKSPACE_ROOT` is absolute and writable by the dashboard. Verify the repository is
visible to the App installation. Existing failed or orphaned checkout directories are not automatically
overwritten or pruned.

The driver does not mount the workspace itself. It names the volume (`WORKSPACE_VOLUME`) and the path
runners mount it at (`WORKSPACE_MOUNT`), and each runner mounts only its member's `<org>/<user id>`
subtree. `WORKSPACE_VOLUME` must name the same volume or claim the dashboard writes to, and
`WORKSPACE_MOUNT` must match the dashboard's `ORG_WORKSPACE_ROOT`. The Helm chart sets both from the
same values.

## Tasks stay queued

Check that the driver can reach `JOB_BOARD_URL`, presents the same `JOB_BOARD_TOKEN` as the server, and
has capacity under `DRIVER_CONCURRENCY`. On Kubernetes, also check:

- driver RBAC, image pull policy, namespace, workspace PVC, and runner credential Secret;
- admission refusals in the driver logs or `kubectl describe job`: the driver admission policy rejects
  pods with volumes, Secrets, or host access it does not allow, for example volumes added by a service
  mesh sidecar injector, a `hostPath`, or a Secret that is not a per-attempt or runner credential
  Secret;
- the Kubernetes version: the admission policy needs Kubernetes 1.30 or later, and the install fails
  on older clusters;
- `helm install`/`helm upgrade` errors: the chart refuses to render invalid values (for example a
  missing `database.url`) with a message naming the problem.

## A runner cannot reach a dependency

Do not use `127.0.0.1` for a sibling service. Use the `.bellows.yaml` service name or the Compose
network name. Declared services start without a readiness wait, so clients should tolerate a short
startup interval.

On Kubernetes with the runner NetworkPolicy enabled (the default), runners cannot reach private or
link-local addresses: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, and
`169.254.0.0/16`. That includes in-cluster Services other than this release's dashboard, collector,
driver, and runner pods, host-gateway addresses, and databases or git servers on private IPs. Add the
host to `isolation.allowedCidrs` as a `/32`, or trim `isolation.blockedCidrs`.

If runners cannot resolve names at all, the cluster DNS pods may not carry the `k8s-app: kube-dns`
label the policy allows. Add the resolver's address to `isolation.dnsCidrs`.

## Gates fail before the agent runs

A malformed or unreadable `.bellows.yaml` is a task error, not “no gates.” Validate its environment
image, named commands, size, and YAML shape. On Kubernetes, inspect the short-lived gate Job and ensure
the workspace storage supports writes by UID/GID 1000.
