---
title: Security
description: Understand Factory's authentication modes, credentials, runner authority, and deployment boundaries.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/operations/security.md
---

## Authentication modes

`AUTH_MODE=github` requires a signed-in member for protected API routes. `AUTH_MODE=none` leaves every
route open to anyone who can reach the port, including task creation, which ultimately runs commands in
a repository. Factory refuses a non-loopback unauthenticated bind unless
`AUTH_ALLOW_PUBLIC_BIND=1` is explicitly set.

The SPA document and assets remain open so an unauthenticated browser can render the sign-in screen.
`/api/health`, `/api/auth/*`, and the HMAC-authenticated GitHub webhook are also outside the session wall.

## Credential classes

- Session cookies and `fat_` personal tokens act as a person.
- `oat_` organization tokens are read-only and do not name a person.
- `JOB_BOARD_TOKEN` authenticates the driver on worker routes.
- `INGEST_TOKEN` optionally authenticates OTLP writes.
- Attempt ID plus lease token authenticates a runner's branch samples.

Do not interchange these credentials. Their separation preserves authorship and prevents a member from
claiming worker leases or a driver from creating unattributed tasks.

## Protect high-impact secrets

The GitHub App private key can mint installation tokens until the key is revoked. Keep it in a secret
manager or Kubernetes Secret, exclude it from images and source control, and rotate it immediately after
suspected exposure. Treat `SESSION_SECRET`, OAuth client secret, webhook secret, board token, runner
tokens, and database credentials the same way.

Runner secrets are write-only in the UI but stored as plaintext in PostgreSQL. Database readers and
backup readers can access them.

## Runner authority

Authentication is not a sandbox. Any organization member who can queue a task can cause an executor to
work against their checkout with the credentials injected into that runner. Keep membership narrow,
limit runner credentials, use gates, and avoid `RUNNER_SKIP_PERMISSIONS` unless its effect is understood.

The Docker driver mounts `/var/run/docker.sock`, which is root-equivalent on the Docker host. Run that
stack only on a dedicated machine. Kubernetes narrows the driver to namespace-scoped Job, Pod, ConfigMap,
and Secret operations, but runner code still has the workspace and credentials assigned to it.

Terminate TLS before any non-local deployment, set `COOKIE_SECURE=1`, keep the board and collector on
private networks, and do not expose PostgreSQL or OTLP receivers without network controls.
