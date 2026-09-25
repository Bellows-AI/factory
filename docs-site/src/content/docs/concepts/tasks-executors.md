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
- `succeeded` or `failed` — the executor reported a terminal outcome.
- `dead` — retries or recovery could not produce another viable attempt.
- `stopped` — a person stopped the run while it was queued or running. The session is kept, so a
  follow-up can continue the conversation.

The driver renews a lease with heartbeats. Worker writes include the lease token so a superseded
attempt cannot overwrite the winning attempt's output or verdict.

A workflow thread can also wait on GitHub with no run at all. For example, the review
reconciliation block waits for pull request reviews after publishing. The task list shows such a
thread under **Needs review**, not as running, because nothing is executing until a matching GitHub event
makes the next run claimable.

## Executor choices

The agent CLI is chosen per task. Each member defines executor profiles under **Settings →
Executors**, each with a type of `claude-code` or `opencode`. A task carries the name of one
profile. At claim time the board looks that name up in the task author's profiles and tells the
driver which CLI to run. A name that matches no profile fails the task rather than falling back to
a guess.

`EXECUTOR` selects the transport:

- **Kubernetes** is the primary executor and the one to deploy. It launches attempt-scoped Jobs and
  Secrets in `K8S_NAMESPACE` and supports Claude Code, OpenCode, services, gates, publishing,
  session readout, cancellation, and reclaim behavior.
- **Docker** is for local development. It launches runner containers against named volumes on the
  driver's Docker daemon.

The OpenCode cache watch (`RUNNER_CACHE_WATCH`) is Docker-only. The driver refuses to start with it
under Kubernetes, because each watch tick would be a pod admission.

## Separation of authority

Human routes create, follow up, stop, finish, and remove tasks. Worker routes claim leases and
report execution state with `JOB_BOARD_TOKEN`. Keeping those credentials separate prevents a
dashboard member from acting as a driver and prevents a driver from creating unattributed work.
