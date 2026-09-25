---
title: Organizations and workspaces
description: Learn how GitHub installations, members, repositories, and checkout storage are scoped.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/concepts/organizations-workspaces.md
---

## Organizations come from installations

Each GitHub App installation is a Factory organization. On sign-in, Factory materializes the
installations the account chooses. An account that can see two or more installations picks them on
a selection screen at first sign-in, and later sign-ins reuse that choice. The session is bound to
one selected organization, which scopes repository lists, telemetry, tasks, variables, workflows,
and access tokens. With `AUTH_MODE=none` there is a single local organization and the organization
selector is disabled.

The repository list is what the App installation reports, narrowed by the organization's tracked
repositories chosen during onboarding. If onboarding left every repository selected, granting the
App another repository makes it available without further changes. If onboarding narrowed the
list, a newly granted repository appears only once it is tracked. The installation inventory is
cached for ten minutes.

## Repository selection is personal

Every member chooses which available repositories to add to their workspace under **Settings →
Repositories**, up to 20 per member. With `ORG_WORKSPACE_ROOT` set, checkouts use this layout:

```text
<workspace root>/<organization installation id>/<user id>/<repository name>
```

The root must be absolute or start with `~/`. The dashboard mounts the whole workspace volume.
Runners, gates, sync, publish, and readout containers mount only the member's own
`<organization>/<user>` subtree, at the same path, so a run cannot see other members' checkouts.
Kubernetes uses a PVC `subPath`; Docker uses `volume-subpath`, which requires Docker 26.1 or later.

Two operator consequences follow on Kubernetes. A pod whose member subtree does not exist yet
stays in `ContainerCreating` with a volume error. Online PVC expansion is slow or blocked while
pods hold subPath mounts, so resize the workspace volume with a pod roll.

Provisioning is additive. Factory clones a newly selected repository but does not automatically
fetch, overwrite, or prune the member's existing checkout. Deselecting a repository removes it from
the UI selection but does not reclaim its files.

## Task worktrees

The driver prepares a task-specific worktree from the member's repository checkout. Follow-up runs
in a task thread reuse the same worktree so fixes and reviews see the existing changes. Only one
run from a thread can hold a lease at a time.

Workspace storage therefore contains durable source data and agent session state. Size it for the
number of members, repositories, concurrent tasks, and retained worktrees, and include it in the
operator's backup and cleanup policy.
