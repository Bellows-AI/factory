# Persistence and incremental sync

Read before: touching `server/src/db/*`, `stats-service.ts`, the sync watermark, or any
migration under `server/migrations/`.

PR data is **always** persisted; there is no other place for it to live. On boot `prime()` seeds
the cache slot from the store, so a restart with a warm database serves real data on the first
request rather than a 202.

- **`store` is not optional, and there is no `if (!store)` branch anywhere.** The service used to
  have a second, silent behaviour — an in-process cache that lost everything on restart — reachable
  by forgetting `DATABASE_URL`. `StatsServiceDeps.store` is now required, `persistence.status` has
  no `'off'`, and a process without a database refuses to boot instead of quietly forgetting.
- **`memoryPrStore()` in `server/test/helpers.ts` is what keeps `npm test` offline.** Requiring a
  store is a statement about *persistence being the only source*, not about PostgreSQL: it
  implements `PrStore` in full and `harness()` defaults to it, so the offline suite needs no
  container. Do not read the requirement as "tests need a database". `memoryAuthStore()` does the
  same job for accounts, sessions and worker tokens.
- **`010_auth.sql` adds `organization`, `app_user`, `org_membership`, `session` and `worker_token`,
  plus `job.created_by`.** Only `org_membership` and `worker_token` lead with `org_id` — see
  [organizations.md](organizations.md) for why an identity is not org-owned. The parts of the
  migration that read the config (seeding the organization row, the bootstrap admin, the
  `AUTH_MODE=none` stand-in account) live in `db/migrate.ts` beside `adoptOrg()`, for the reason
  `adoptOrg()` is there: a `.sql` file cannot see the config, and guessing wrong is silent.
- **`011_user_workspace.sql` adds one table, `user_repo`.** Org-owned, because it carries a repo,
  which is `005`'s rule stated literally. One table rather than two: a separate "workspace" row
  would assert only that a user exists, and `app_user` already asserts that. A deselected repository
  is **marked**, never deleted — the row is the only record that a checkout exists on disk, so
  deleting it makes unbounded disk growth invisible. `on delete cascade` on the user, unlike
  `job.created_by`'s `set null`: a job is an audit record that must outlive the person, while this
  row describes a directory nobody can reach once the account is gone. The clone queue's restart
  recovery assumes one dashboard process, and that assumption is written into the migration's
  header along with the escape hatch — see [workspace.md](workspace.md).
- **`012_user_executors.sql` adds one table, `user_executor`.** Org-owned for the same reason
  `user_repo` is: the config describes work inside this deployment, scoped to the member's tree.
  Hard delete is safe here, and the whole-list PUT relies on it — unlike `user_repo` the row tracks
  no disk state, so deleting it loses nothing but the pasted JSON. `type` is check-constrained to
  the closed list in `core/src/executors.ts` and must be extended in both places in one change,
  because altering a check on a populated table is a rewrite (`006`'s `job_status_ck` rule).
  Nothing consumes the table yet; the driver wiring is future work.
- **`013_opencode_executor_type.sql` adds `opencode` to that check**, the rewrite 012's header
  warned about, by 008's drop-first pattern — 012 itself is never edited, exactly as 006 was not
  when 008 added `standby`: an applied migration is skipped by filename, so editing it would
  change nothing for an existing database and only lie about how the schema got there. The next
  type is the same two-step move again: the array in `core/src/executors.ts` and a new migration.
- **`migrate()` also reaps expired sessions**, at boot only. The read path checks `expires_at`
  regardless, so this is about the table not growing without bound on a deployment whose users never
  log out — not about enforcement.
- **Synthetic data reaches a database only through `npm run seed`, into a disposable one.** The
  dangerous combination is still inexpressible, just relocated: it used to be prevented by deriving
  `persistence` from `DATA_SOURCE`, and is now prevented by the seeding CLI's name allowlist plus
  `loadConfig` refusing a disposable database whenever a token is set. Both halves matter — one
  stops synthetic rows landing in `factory_dev`, the other stops real history landing somewhere
  `npm run test:db` will truncate.
- **`prime()` seeds with `last_sync_at`, never `now()`.** Seeding with `now()` reports
  `ageSeconds: 0, stale: false` off a three-day-old database, `ensureFresh()` then declines to
  sync, and the result is a permanently frozen dashboard that looks fresh.
- **`cache.seed()` only fills an empty slot.** A seed arriving after a live fetch landed is older
  by definition. And `ensureFresh()` returns early while `prime()` is in flight — otherwise the
  first sync races the seed, wins, and burns a full walk for nothing.
- **A persistence failure never propagates out of `produce()`.** It would set `lastFailureAt` and
  freeze the whole PR pipeline for 30s over a database fault. Every store call goes through
  `tryStore()`, which records `persistence.status = 'unavailable'` and returns null. Guarded by
  `server/test/stats.persistence.test.ts` → "does not set the fetch cooldown".
- **The watermark is a `sync_state` column, not `max(provider_updated_at)` over `pull_request`.**
  That maximum advances on every successful upsert, *including part-way through a walk that then
  died* — the next run would resume from the newest row it happened to write and skip everything
  in between, silently and permanently. It advances only for a repo whose `completed[repo]` is
  true.
- **The incremental cutoff is `min(watermark − 5min, now − 14d, oldest open PR's updatedAt)`.**
  Each term earns its place. The overlap covers GraphQL replica lag, without which an update is
  missed forever and invisibly. The other two exist because `updatedAt` does **not** reliably bump
  on a *child* change — a thread resolved, a label removed, a force push — and those feed
  `headline.unresolvedThreadRatio`, the most prominent number on the page. Do not replace them
  with a second query path.
- **An incremental walk orders `UPDATED_AT DESC` and stops only after a whole page falls below the
  cutoff.** `orderBy` is not a strict total order across equal timestamps, so a mid-page stop can
  drop a sibling of the node that triggered it. **Do not** instead keep `CREATED_AT DESC` and stop
  on `createdAt`: that never re-reads an old PR, so a thread resolved on a three-month-old one
  never lands and the unresolved ratio freezes.
- **A full reconciliation runs every 24h, or when `synced_epoch < SCHEMA_EPOCH`.** The epoch bump
  is the important half: it is the only repair for a newly selected field leaving old rows null,
  which is silently wrong for old PRs only. Bump `SCHEMA_EPOCH` when you add one.
- **A truncated child list is upserted, never delete-and-replaced.** This is the single most
  dangerous line in the write path. A degraded refetch of #149 returns 100 reviews with the total
  still reading 397; replacing 397 rows with 100 corrupts the resolution ratio with no error
  anywhere. The decision is **per connection**, because one PR can arrive with a complete commit
  list and a truncated review list in the same fetch. A *complete* list is delete-and-replaced,
  which is the only thing that ever makes a review deleted upstream stop being counted.
  `server/test-db/pr-store.test.ts` also asserts `count(*) from pr_review !== review_count` for
  #149 on purpose, so nobody "fixes" the discrepancy by making the total a `count(*)` — that would
  undercount by 297.
- **`truncated` is recomputed on every write, never unioned.** A union leaves a stale caveat on the
  page after a successful backfill has already filled the list in.
- **`branch_commit` stores `message_headline`, not a precomputed `is_revert`.** Same reason
  `metric_point` stores datapoints and not rollups: the classifier (`isRevertHeadline` in
  `core/src/config.ts`) will change, and a verdict cannot be re-derived. It also lives in `core`
  so the server and any slicing path share one definition.
- **A base-branch rescan resumes an hour behind the newest stored commit.** `since` is inclusive
  upstream, so the tip repeats and the primary key makes that a no-op. The overlap is not
  paranoia: a commit date is not monotonic with history order, so a rebase can place a commit
  behind its own parent and a zero-overlap resume genuinely skips it.
- **`branch_history.covered_from` only ever moves backwards.** A later scan starting from a newer
  bound has not lost the older commits, and moving it forward would make a range that *is* covered
  report as unavailable.
- **The PR slot's `ttlMs` is `syncTtlMs` (a store is always present), and the telemetry slot's is
  `config.telemetryTtlMs`**, and the history loop now has a `MAX_HISTORY_PAGES` cap it was
  missing — a first scan of a busy monorepo could page until the quota ran out.

**Tradeoff worth knowing:** the SQL, the views and the migration runner have **no coverage in
`npm test`**. That is the price of keeping the default suite offline and database-free; they are
covered by `npm run test:db`, which needs a running container. The offline suite covers the same
logic through `memoryPrStore()` in `server/test/helpers.ts`.
