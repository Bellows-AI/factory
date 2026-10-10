# Persistence

PostgreSQL is the only store. A process without `DATABASE_URL` refuses to boot; there is no in-memory
mode and no degraded-persistence state on the payload. The offline suite stays database-free through
the in-memory stores in `server/test/helpers*.ts`.

| Concern | Code | Test |
| --- | --- | --- |
| Migration runner, boot seeding, session reaping | `server/src/db/migrate.ts` | `core/test/migrations.sql.test.ts` |
| Schema (ingest and views: [telemetry.md](telemetry.md)) | `server/migrations/*.sql` | `server/test-db/telemetry.sql.test.ts`, the `job-store.*` suites |
| Read cache warm-up and degradation | `server/src/stats-service.ts` | `server/test/routes.stats.get.test.ts` |
| Job and thread reads and writes | `server/src/db/job-store*.ts` | `server/test-db/job-store.*.test.ts` |
| Agent questions, one row per asked tool call (migration 050) | `server/migrations/050_job_question.sql`, `server/src/db/job-store-questions.ts` | `server/test-db/job-store.questions.test.ts` |
| Named-profile reviews, a job row of its own thread linked by `review_of` and unique per caller and key, plus the profiles stamped on the caller (migration 056) | `server/migrations/056_job_review.sql`, `server/src/db/job-store-reviews.ts` | `server/test-db/job-store.reviews.test.ts` |
| The never-refunded claim sequence the kubernetes checkout claim orders by (migration 057) | `server/migrations/057_job_claim_seq.sql`, `server/src/db/job-store-claim.ts` | `server/test-db/job-store.requeue.test.ts` |
| Idempotency keys, stamped on the `job` row a create, follow-up or retry inserted and unique per org, caller and operation (migration 058) | `server/migrations/058_job_idempotency.sql`, `server/src/db/job-store-idempotency.ts` | `server/test-db/job-store.idempotency.test.ts` |
| Database-name guards | `server/src/config.ts`, `server/src/seed/cli.ts` | `server/test/config.persistence.test.ts` |
| db-suite harness: name guard, migrate, truncate and reseed per test | `server/test-db/harness.ts` | `server/test/test-db.harness.test.ts` |

## Invariants

- **Applied migrations are never edited.** They are skipped by filename, so an edit changes nothing
  for an existing database. Every schema change is a new file; a feature's schema is removed by a
  new `drop` migration (`023_drop_pull_requests.sql`), children listed before parents.
- **Versioned migrations run before repeatable ones, regardless of filename order.** Otherwise a
  new versioned file adding a column the views read fails purely on sort order.
- **`*.repeatable.sql` files are re-applied every boot and drop their views first.** Recording them
  would strand a view fix until a volume is deleted, and `create or replace` cannot retype a column.
- **The schema names no extension** — `metric_point` is `partition by range (time)` with a single
  DEFAULT partition, which is what lets `database.url` point at RDS or Aurora.
- **Removing that DEFAULT partition breaks every write.** A range-partitioned table rejects any row
  no partition covers, and neither writer can promise a range: `npm run backfill` imports
  transcripts of arbitrary age and an OTLP client's clock can run ahead. Every unique index on the
  table must keep `time` among its columns.
- **Migrations are not awaited before `listen()`.** They retry with backoff while the database
  container starts; every store gates its own queries on `ready` and degrades until then.
- **`migrate()` also seeds the `AUTH_MODE=none` org and its stand-in account, and reaps expired
  sessions, at boot only.** Those parts are TypeScript beside the `.sql` runner because a `.sql`
  file cannot see the config; the read path checks `expires_at` regardless.
- **Synthetic data reaches a database only through `npm run seed`, into a disposable one.** Both
  halves matter: the seeding CLI refuses any name not ending `_seed`/`_synthetic`/`_demo`/`_e2e`/
  `_test`, and `loadConfig` refuses a disposable name for a fetching (App-mode) process — the
  `none` arm is exempt by construction, which is how seed and `verify:ui` run
  ([configuration.md](configuration.md)).
- **Every stored read is scoped by the repo list and by `org_id`**, or it renders another
  organization's or another repo's sessions as this dashboard's.
- A data directory initialised by `timescale/timescaledb` cannot start under `postgres:17` — it exits
  with "could not access file \"timescaledb\"" and compose crash-loops; `docker compose down -v`
  discards it. On a local cluster: `make reset`, or `helm uninstall factory-state` then
  `kubectl delete pvc -l app.kubernetes.io/instance=factory-state,app.kubernetes.io/component=postgres`
  in that order (pvc-protection holds a claim its pod still mounts). The component label keeps the
  delete off the `factory-state-workspaces` checkouts claim.
- **Stated limit:** the SQL, the views and the migration runner have no coverage in `npm test`; they
  are covered by `npm run test:db`, which refuses any database not named `*_test`.
