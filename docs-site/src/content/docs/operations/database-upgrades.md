---
title: Database and upgrades
description: Operate Factory's required database, schema migrations, workspace data, backups, and releases.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/operations/database-upgrades.md
---

TimescaleDB is Factory's source of truth. The server applies pending SQL migrations automatically and
tracks them in `schema_migrations`. Applied versioned migrations are immutable; repeatable migrations
are reapplied by the migration runner.

## Data to protect

Back up both:

- PostgreSQL/TimescaleDB, including schema and data.
- The workspace volume, which holds member checkouts, task worktrees, and persisted agent session data.

Factory does not provide a backup scheduler or a restore command. Use PostgreSQL and storage-platform
tools appropriate to the deployment. Test restores into an isolated environment; never point tests or
the seed command at a real database.

## Upgrade procedure

1. Read release notes and configuration changes. Retired variables are often fatal rather than ignored.
2. Stop or scale the driver to zero so no new runner mutates worktrees during the backup.
3. Back up the database and workspace storage.
4. Deploy the new dashboard. Watch `[migrate]` logs until migrations finish.
5. Verify `/api/health`, an authenticated API read, repository discovery, and `/api/stats`.
6. Deploy or resume the matching driver and executor images.
7. Run one disposable task through checkout, execution, gates, and publishing as applicable.

For Helm:

```bash
kubectl -n factory scale deployment/factory-factory-driver --replicas=0
helm upgrade factory charts/factory -n factory -f values.production.yaml
kubectl -n factory rollout status deployment/factory-factory
kubectl -n factory scale deployment/factory-factory-driver --replicas=1
```

If upgrading from a release with per-organization worker tokens, populate the deployment-wide
`job-board-token` Secret key before starting the new dashboard and driver.

:::caution[Rollback]
Factory does not promise old binaries will understand a schema migrated by a newer release. A reliable
rollback restores the matching database and workspace backup together with the earlier images.
:::
