---
title: What is Factory?
description: Understand Factory's telemetry dashboard, task board, and execution model.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/overview.md
---

Factory is a software engineering control plane for AI-assisted delivery. It gives an organization one
place to observe agent activity, prepare repository workspaces, launch tasks, and review how those tasks
ran.

Factory has four cooperating parts:

1. **Dashboard and API** — the browser application and HTTP board used by people, telemetry producers,
   and workers.
2. **TimescaleDB** — the required source of truth for telemetry, organizations, workspaces, tasks,
   workflows, credentials metadata, and audit history.
3. **Driver** — a stateless HTTP client that claims queued work and creates runners. It never connects
   directly to the database.
4. **Executors** — Claude Code or OpenCode runners launched as Docker containers or Kubernetes Jobs
   against repository worktrees.

Telemetry follows a separate path from task execution:

```text
Agent -> OpenTelemetry collector -> Factory ingest API -> TimescaleDB -> dashboard

Person -> Factory task board -> driver -> executor -> gates/publish -> task history
```

The GitHub App installation supplies both repository read credentials and the repository inventory.
Members select which available repositories are checked out into their own workspace. A separate GitHub
OAuth App signs people into the dashboard when `AUTH_MODE=github`.

## Where to go next

- Review the [capability map](./capabilities.md).
- Compare [development and production deployments](./getting-started/deployment-options.md).
- Learn the [system architecture](./concepts/architecture.md).
- Read the [security model](./operations/security.md) before exposing a deployment.
