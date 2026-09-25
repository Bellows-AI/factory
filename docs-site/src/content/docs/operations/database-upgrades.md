---
title: Database and upgrades
description: Operate Factory's required database, schema migrations, workspace data, backups, and releases.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/operations/database-upgrades.md
---

TimescaleDB is Factory's source of truth. The server applies pending SQL migrations automatically and
tracks them in `schema_migrations`. Versioned migrations are recorded by file name only, with no
checksum, so editing a migration that has already been applied has no effect on an existing database:
it is skipped, not rejected. Treat applied migrations as immutable. Repeatable migrations
(`*.repeatable.sql`) are reapplied on every boot.

## Data to protect

Back up both:

- PostgreSQL/TimescaleDB, including schema and data.
- The workspace volume, which holds member checkouts, task worktrees, and persisted agent session data.

Factory does not provide a backup scheduler or a restore command. Use PostgreSQL and storage-platform
tools appropriate to the deployment. Test restores into an isolated environment; never point tests or
the seed command at a real database.

## Upgrade procedure

1. Read release notes and configuration changes. Retired variables are often fatal rather than ignored.
2. Stop or scale the driver to zero so it claims no new tasks.
3. Wait for in-flight runners, gates, and declared services to finish, or stop those tasks. Stopping the
   driver does not stop them: on Kubernetes each runner Job keeps running under its own deadline (up to
   `driver.jobTimeoutMs`, two hours by default) after the driver exits, and can still write worktrees.
4. Back up the database and workspace storage.
5. Deploy the new dashboard. Watch `[migrate]` logs, or wait for `/api/ready` to return `200`.
6. Verify `/api/health`, `/api/ready`, an authenticated API read, repository discovery, and
   `/api/stats`.
7. Deploy or resume the matching driver and executor images.
8. Run one disposable task through checkout, execution, gates, and publishing as applicable.

For Helm:

```bash
kubectl -n factory scale deployment/factory-factory-driver --replicas=0
# Wait until no runner Jobs or pods remain.
kubectl -n factory get jobs,pods -l factory.job
# Keep the driver at zero through the upgrade: the chart always sets driver.replicas (default 1).
helm upgrade factory charts/factory -n factory -f values.production.yaml --set driver.replicas=0
kubectl -n factory rollout status deployment/factory-factory
# After verifying migrations, restore the driver by upgrading again without the override.
helm upgrade factory charts/factory -n factory -f values.production.yaml
```

The chart always renders `driver.replicas`, so a plain `helm upgrade` would bring the driver back
before migrations are verified. The second upgrade restores the count your values set.

### Chart requirements

- The `charts/factory` chart deploys no database. When the chart creates the Secret it refuses to
  render without `database.url`; with `secret.existingSecret`, that Secret must carry `database-url`.
  Point it at a managed TimescaleDB, or at the separate `charts/factory-local-state`
  release, which holds the local TimescaleDB Deployment and the workspaces claim.
- If an existing installation ran TimescaleDB from inside the app chart, `helm upgrade` to a release
  without it removes that database Deployment. Back up the database first and move it to a separate
  release or a managed instance before upgrading.
- The driver admission policy (`isolation.admissionPolicy`, on by default) needs Kubernetes 1.30 or
  later. On an older cluster the install fails.

:::caution[Rollback]
Factory does not promise old binaries will understand a schema migrated by a newer release. A reliable
rollback restores the matching database and workspace backup together with the earlier images.
:::
