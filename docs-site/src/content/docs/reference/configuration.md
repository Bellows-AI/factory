---
title: Configuration
description: Reference Factory server and driver environment variables, defaults, and required combinations.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/reference/configuration.md
---

Factory configuration is environment-only. `.env`, Compose, and Helm are delivery mechanisms for the
same contract.

## Server

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL/TimescaleDB connection string. |
| `DB_POOL_MAX` | `50` | Maximum shared PostgreSQL connections. |
| `HOST` | `127.0.0.1` | API bind address. |
| `PORT` | `8080` | API and production SPA port. |
| `GITHUB_APP_ID` | required | GitHub App identifier. |
| `GITHUB_APP_PRIVATE_KEY` | one key source required | PEM contents or base64 private key. |
| `GITHUB_APP_PRIVATE_KEY_FILE` | unset | File read into the private-key value before validation. |
| `ORG_WORKSPACE_ROOT` | unset | Absolute root for per-member checkouts; unset disables workspaces. |
| `WEB_ROOT` | unset | Directory of the built SPA the API serves; unset serves no SPA. |
| `TELEMETRY_SOURCE` | `postgres` | `postgres`, `fixture`, or `off` (telemetry disabled). |
| `TELEMETRY_TTL_SECONDS` | `30` | Snapshot cache duration; minimum `5`. |
| `INGEST_TOKEN` | unset | Expected `X-Factory-Ingest-Token` for OTLP writes. |

## Authentication

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTH_MODE` | `none` | Explicitly `none` or `github`. |
| `GITHUB_OAUTH_CLIENT_ID` | required in GitHub mode | Human sign-in OAuth App ID. |
| `GITHUB_OAUTH_CLIENT_SECRET` | required in GitHub mode | OAuth App secret. |
| `SESSION_SECRET` | required in GitHub mode | Cookie-signing secret, at least 32 characters. |
| `SESSION_TTL_HOURS` | `336` | Absolute session lifetime. |
| `PUBLIC_URL` | loopback origin when possible | External origin used in GitHub redirects; required in GitHub mode on a non-loopback `HOST`. |
| `COOKIE_SECURE` | false | Add the cookie `Secure` attribute; enable behind HTTPS. |
| `JOB_BOARD_TOKEN` | required in GitHub mode | Shared server/driver worker secret, at least 32 characters. |
| `GITHUB_WEBHOOK_SECRET` | unset | HMAC secret enabling the installation webhook route, at least 32 characters. |
| `AUTH_ALLOW_PUBLIC_BIND` | false | Explicit assertion for unauthenticated non-loopback binds. |

## Driver and runners

| Variable | Default | Purpose |
| --- | --- | --- |
| `JOB_BOARD_URL` | `http://127.0.0.1:8080` | Factory API polled by the driver. |
| `JOB_BOARD_TOKEN` | unset | Worker bearer; required when the board uses GitHub auth. |
| `EXECUTOR` | `docker` | `docker` or `kubernetes`. |
| `CLAUDE_EXECUTOR_IMAGE` | `claude-executor` | Runner image for tasks whose executor profile is Claude Code. |
| `OPENCODE_EXECUTOR_IMAGE` | `opencode-executor` | Runner image for tasks whose executor profile is OpenCode. |
| `DRIVER_WORKER` | `driver-<pid>` | Worker name the driver claims under. |
| `DRIVER_CONCURRENCY` | `2` | Concurrent attempts, range 1–32. |
| `DRIVER_POLL_MS` | `5000` | Idle board polling interval. |
| `DRIVER_LEASE_SECONDS` | `300` | Attempt lease duration, range 10–3600. |
| `DRIVER_JOB_TIMEOUT_MS` | `7200000` | Maximum attempt runtime. |
| `WORKSPACE_VOLUME` | `factory-ai_workspaces` | Docker workspace volume name. |
| `WORKSPACE_MOUNT` | `/workspaces` | Workspace path inside driver and runners. |
| `RUNNER_NETWORK` | unset | Docker network joined by runners. |
| `RUNNER_OTEL_ENDPOINT` | `http://collector:4318` | Runner OTLP destination. |
| `RUNNER_STATS_URL` | `JOB_BOARD_URL` | Where runners post session branch samples. |
| `RUNNER_ENV` | `CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY` | Host/Secret names forwarded to runners. |
| `RUNNER_SKIP_PERMISSIONS` | false | Run the agent without permission prompts; a deliberate trust decision. |
| `K8S_NAMESPACE` | `default` | Namespace for Kubernetes runner Jobs. |
| `K8S_RELEASE` | unset | Helm release label stamped on runner objects, scoping cleanup and the runner `NetworkPolicy` to one release. |
| `RUNNER_CREDENTIALS_SECRET` | unset | Kubernetes Secret containing `RUNNER_ENV` keys. |
| `RUNNER_IMAGE_PULL_POLICY` | `IfNotPresent` | Kubernetes runner image pull policy. |
| `RUNNER_IMAGE_PULL_SECRETS` | unset | Comma-separated pull Secret names for every pod the driver creates. |
| `GATE_TIMEOUT_MS` | `600000` | Maximum gate runtime. |
| `GATE_COOLDOWN_MS` | `600000` | How long a gate environment outlives its task; `0` tears it down at once. |
| `GATE_LISTEN_HOST` | `127.0.0.1` | Bind address of the driver's gate server. |
| `GATE_ADVERTISE_URL` | unset | URL runners use to reach the gate server when loopback will not do. |
| `DRIVER_HEARTBEAT_FILE` | unset | File touched periodically for a liveness probe. |
| `RUNNER_SERVICES` | true | Enable repository-declared auxiliary services. |
| `RUNNER_CACHE_WATCH` | false | Docker and OpenCode only: stop a run whose prompt cache keeps missing. Fatal under `EXECUTOR=kubernetes`. |
| `RUNNER_CACHE_WATCH_POLL_MS` | `30000` | Cache watch interval, 250 to 300000 ms. |

The validator rejects retired variables such as `GITHUB_TOKEN`, `GITHUB_OWNER`, `ORG_REPOS`,
`GITHUB_REPOS`, `DATA_SOURCE`, `BASE_BRANCH`, `BOTS`, `SYNC_TTL_SECONDS`, and `CACHE_TTL_SECONDS`.
Follow the replacement named in the startup error rather than retaining an alias.
