---
title: Known limitations
description: Review the current measurement, storage, interface, and executor limitations.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/operations/known-limitations.md
---

## Measurement and interface

- Weekly charts are fixed-width and become hard to read below roughly 700 pixels.
- Seeded data is deterministic for one revision but may change when the generator changes. Tests should
  assert structure rather than published sample figures.
- Token and line counts describe what the agent produced, not what survived in a final Git diff.
- Telemetry covers only sessions recorded after the plugin or runner integration was installed.
- Repository branches are sampled, not tracked. Factory runners report as soon as a session starts and
  then roughly every 20 seconds; with the laptop plugin, a session shorter than one sampling interval
  can finish without a branch sample.
- The OTLP logs endpoint acknowledges and discards logs; there is no per-prompt log view yet.
- Detached-HEAD branch samples currently conflict with a database primary-key constraint and can be
  rejected.
- Small weekly samples are intentionally not smoothed; one large session can visibly move a total.

## Workspaces and executors

- Workspace selection is additive. Deselecting a repository does not delete its checkout, and task
  worktrees require an explicit done/remove lifecycle before reclaim.
- The OpenCode cache watch (`RUNNER_CACHE_WATCH`) is Docker only. The driver refuses to start with it
  under `EXECUTOR=kubernetes`.
- Docker runners have no network egress restriction. Only the Kubernetes chart ships a runner
  NetworkPolicy.

## Kubernetes deployments

- The driver admission policy needs Kubernetes 1.30 or later; the install fails on older clusters.
- The runner NetworkPolicy has no effect without a CNI that enforces NetworkPolicy, and it covers IPv4
  only.
- Install one Factory release per namespace. Per-attempt Secret names do not carry the release name,
  so one release's driver could reach another's per-attempt objects in a shared namespace.
- The admission policy checks the workspace subPath by shape, not by owner. A compromised driver can
  still mount another member's `<org>/<user id>` subtree.

See [Security](/factory/operations/security/) for the full runner isolation model.
