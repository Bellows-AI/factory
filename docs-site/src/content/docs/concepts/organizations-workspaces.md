---
title: Organizations and workspaces
description: Learn how GitHub installations, members, repositories, and checkout storage are scoped.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/concepts/organizations-workspaces.md
---

## Organizations come from installations

Each GitHub App installation is a Factory organization. On sign-in, Factory materializes the
installations visible to that account and binds the session to one selected organization. The current
organization scopes repository lists, telemetry, tasks, variables, workflows, and access tokens.

The App installation reports the available repositories. Granting the App another repository makes it
available without editing a Factory repository list; the runtime inventory is cached for ten minutes.

## Repository selection is personal

Every member chooses which available repositories to add to their workspace. With
`ORG_WORKSPACE_ROOT` set, checkouts use this layout:

```text
<workspace root>/<organization installation id>/<user id>/<repository name>
```

The root must be absolute or start with `~/`. In Compose and the Helm chart, dashboard and runners mount
the same workspace volume at the same path.

Provisioning is additive. Factory clones a newly selected repository but does not automatically fetch,
overwrite, or prune the member's existing checkout. Deselecting a repository removes it from the UI
selection but does not reclaim its files.

## Task worktrees

The driver prepares a task-specific worktree from the member's repository checkout. Follow-up runs in a
task thread reuse the same worktree so fixes and reviews see the existing changes. Only one run from a
thread can hold a lease at a time.

Workspace storage therefore contains durable source data and agent session state. Size it for the
number of members, repositories, concurrent tasks, and retained worktrees, and include it in the
operator's backup and cleanup policy.
