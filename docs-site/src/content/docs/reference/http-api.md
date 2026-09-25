---
title: HTTP API
description: Reference Factory's API groups, credentials, and core client-facing routes.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/reference/http-api.md
---

All API paths are under `/api`. JSON errors use a named error code and message. In `AUTH_MODE=github`,
protected routes require a session cookie or an accepted bearer token.

## Credential map

| Route group | Credential |
| --- | --- |
| `GET /api/health`, `GET /api/ready`, `/api/auth/*`, SPA assets | Open |
| Human and organization reads/actions | Session cookie or personal `Bearer fat_...`; organization `oat_...` tokens are read-only |
| Job claims and worker reports | `Bearer $JOB_BOARD_TOKEN` |
| OTLP metrics and logs | Optional `X-Factory-Ingest-Token` |
| Runner branch samples | Attempt ID plus lease token, or personal bearer |
| GitHub webhook | GitHub HMAC signature using `GITHUB_WEBHOOK_SECRET` |

## Core routes

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | Process liveness and uptime; never touches GitHub or PostgreSQL. |
| `GET /api/ready` | `200` once database migrations have applied; `503` while they are pending or after they failed. |
| `GET /api/auth/me` | Current authentication, user, organization, and workspace state. |
| `GET /api/stats` | Telemetry and task-usage aggregates with range and scope filters. |
| `GET /api/repos` | Repositories visible to the current App installation. |
| `GET /api/workspace` | Current member's checkout and executor summary. |
| `PUT /api/workspace/repos` | Replace the member's selected repository list; cloning is asynchronous. |
| `GET /api/env` | Organization, workspace, and repository runner variables; secret values are null. |
| `PUT /api/env/org` | Replace organization-scoped runner values. |
| `PUT /api/env/workspace` | Replace the caller's workspace-scoped values. |
| `PUT /api/env/repo` | Replace values for one visible repository. |
| `GET /api/tasks` | Paginated, one-row-per-thread task navigation and search model. |
| `POST /api/jobs` | Queue a task, optionally resolving a workflow and parameters. |
| `GET /api/jobs/:id` | Detailed state for one run. |
| `GET /api/jobs/:id/thread` | The complete task thread, oldest first. |
| `POST /api/jobs/:id/follow-up` | Queue a command that resumes a finished run's session. |
| `POST /api/jobs/:id/stop` | Stop queued work or request cancellation of a live attempt. |
| `POST /api/jobs/:id/done` | Record the human verdict that a terminal thread is complete. |
| `POST /api/jobs/:id/remove` | Delete a non-running thread and queue worktree reclaim. |
| `GET`, `POST /api/workflows` | List and create visible workflow definitions. |
| `DELETE /api/workflows/:id` | Delete a workflow definition without rewriting task snapshots. |
| `POST /api/tokens` | Mint a personal token; plaintext is returned once. |
| `POST /api/tokens/org` | Mint a read-only organization token. |

## Worker and ingest routes

The driver uses `/api/jobs/claim`, the heartbeat/session/output/gates/gates-reread/publish-token/suspend/complete
routes under `/api/jobs/:id`, and `/api/reclaims/*`. These endpoints are lease-sensitive automation
contracts, not general user APIs.

OTLP producers send JSON to `/api/otlp/v1/metrics` and `/api/otlp/v1/logs`. Branch reporters send
session/repository samples to `/api/sessions/branch` with an organization-bound credential.

For exact request limits, response bodies, and named error codes, consult the version-matched
[API contract in the repository](https://github.com/Bellows-AI/factory/blob/main/docs/api.md).
