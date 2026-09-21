---
title: Capabilities
description: See what Factory can observe, configure, and execute today.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/capabilities.md
---

## Observe engineering activity

- Receive OTLP metrics and logs from supported agent runners.
- Attribute sessions to a repository and branch.
- Report sessions, token input and output, cache reads and creation, lines written, active time, and
  telemetry coverage.
- Filter dashboard data by organization, repository, person, and date range.
- Preserve the last good telemetry snapshot when a database read temporarily fails.

## Manage repositories and workspaces

- Discover repositories from GitHub App installations rather than a static repository list.
- Let each member select repositories for their own workspace.
- Provision one checkout per organization, member, and repository on shared storage.
- Configure a member's executor choice and executor-specific settings.

## Run and govern agent tasks

- Queue tasks from the dashboard or HTTP API.
- Execute with Claude Code or OpenCode through Docker or Kubernetes.
- Stream output, heartbeats, session identifiers, gate reports, and final outcomes into the task audit.
- Follow up in the existing agent session or start a fresh workflow node.
- Stop, mark done, or remove tasks through explicit human actions.
- Run repository-defined verification gates and publish successful work to a remote branch.

## Configure automation

- Stack runner variables and secrets at organization, workspace, and repository scopes.
- Define graph-based workflows with launch parameters, fresh or resumed sessions, bounded loops, gates,
  and per-node publishing policy.
- Use personal and organization access tokens for supported API clients.

## Deliberate boundaries

Factory does not provide an in-memory database, silently fall back when required credentials are absent,
or make Docker-only runner features appear to work on Kubernetes. See
[Known limitations](./operations/known-limitations.md) for current constraints.
