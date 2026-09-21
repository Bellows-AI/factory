---
title: Known limitations
description: Review the current measurement, storage, interface, and executor limitations.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/operations/known-limitations.md
---

- Weekly charts are fixed-width and become hard to read below roughly 700 pixels.
- Seeded data is deterministic for one revision but may change when the generator changes. Tests should
  assert structure rather than published sample figures.
- Token and line counts describe what the agent produced, not what survived in a final Git diff.
- Telemetry covers only sessions recorded after the plugin or runner integration was installed.
- Repository branches are sampled roughly every 20 seconds. A shorter session can finish without a
  branch sample.
- The OTLP logs endpoint acknowledges and discards logs; there is no per-prompt log view yet.
- Telemetry and repository-list caches are process-global. Multi-organization deployments require care
  because the current cache design is not a per-organization tenancy boundary.
- Detached-HEAD branch samples currently conflict with a database primary-key constraint and can be
  rejected.
- Workspace selection is additive. Deselecting a repository does not delete its checkout, and task
  worktrees require an explicit done/remove lifecycle before reclaim.
- Remote Control is Claude Code plus Docker only. The OpenCode cache watch is Docker only. Kubernetes
  rejects both combinations at driver startup.
- Small weekly samples are intentionally not smoothed; one large session can visibly move a total.
