---
title: Tasks and executors
description: Understand task threads, leases, statuses, and the Docker and Kubernetes runners.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/concepts/tasks-executors.md
---

A task is a command waiting for a driver. A task thread contains the original run plus workflow
successors and human follow-ups. The thread is the durable audit unit; each run records its author,
executor, repository, output tail, session, gates, runtime measurements, and outcome.

## Lifecycle

Runs use these board statuses:

- `queued` — waiting for a driver.
- `running` — held by a live lease.
- `standby` — an executor session is parked for supported remote-control behavior.
- `succeeded` or `failed` — the executor reported a terminal outcome.
- `dead` — retries or recovery could not produce another viable attempt.
- `stopped` — a person stopped queued, parked, expired, or actively cancelling work.

The driver renews a lease with heartbeats. Worker writes include the lease token so a superseded attempt
cannot overwrite the winning attempt's output or verdict.

## Executor choices

`RUNNER_CLI` selects `claude-code` or `opencode`. `EXECUTOR` selects the transport:

- **Docker** launches runner containers against named volumes and can support Remote Control and the
  OpenCode cache watch.
- **Kubernetes** launches attempt-scoped Jobs and Secrets in `K8S_NAMESPACE`. It supports Claude Code,
  OpenCode, services, gates, publishing, session readout, cancellation, and reclaim behavior.

Kubernetes intentionally refuses Remote Control and the OpenCode cache watch because their long-lived
TTY and Docker polling mechanics have no supported pod equivalent.

## Separation of authority

Human routes create, follow up, stop, finish, and remove tasks. Worker routes claim leases and report
execution state with `JOB_BOARD_TOKEN`. Keeping those credentials separate prevents a dashboard member
from acting as a driver and prevents a driver from creating unattributed work.
