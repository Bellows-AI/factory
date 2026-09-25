# Persistence

Read before: touching `server/src/db/*`, `stats-service.ts`, or any migration under
`server/migrations/`.

Telemetry is **always** persisted; there is no other place for it to live, and no in-memory mode —
a process without `DATABASE_URL` refuses to boot rather than quietly forgetting. There is no
`persistence.status` on the payload and no degraded-persistence state to reason about: the ingest
store exists in the `postgres` source — the default — and is absent only when telemetry is switched
off outright or replaying the fixture. The read cache warms at boot via `ensureFresh()`, so a
restart with a warm database serves real data on the first request rather than a 202.

- **The offline suite needs no container, and that is a statement about persistence being the only
  source, not about PostgreSQL.** `stubTelemetryClient()` in `server/test/helpers.ts` feeds the read
  path a `TelemetryInput` directly, and the other features keep in-memory stores
  (`memoryUserRepoStore()`, `memoryUserExecutorStore()`, `memoryEnvVarStore()`, `memoryAuthStore()`)
  so `npm test` stays offline and database-free. Do not read the mandatory database as "tests need
  a container".
- **Applied migrations are never edited.** They are skipped by filename, so editing one changes
  nothing for an existing database and only lies about how the schema got there. Every schema change
  is a new file — 013 adding a check value and 023 removing the pull-request schema are the two
  precedents.
- **`023_drop_pull_requests.sql` is how a feature's schema is removed.** It drops
  `pull_request`, its four `pr_*` children, and `branch_commit`, `branch_history`, `sync_state` and
  `session_pr` — children listed before their parents, so the drops need no FK juggling. 004 and
  005 stay in place: a fresh database applies them and then drops what they made, which is the
  accepted cost of the filename-tracking rule. The telemetry tables and `002`'s views are untouched.
- **`migrate()` also seeds the AUTH_MODE=none org and its stand-in account, once, at boot.** The
  config-reading parts of the migration (the `AUTH_MODE=none` local org, the stand-in account) are
  TypeScript beside the `.sql` runner for one reason: a `.sql` file cannot see the config, and
  guessing wrong is silent.
- **`migrate()` also reaps expired sessions**, at boot only. The read path checks `expires_at`
  regardless, so this is about the table not growing without bound on a deployment whose users never
  log out — not about enforcement.
- **Migrations are not awaited before `listen()`.** They retry with backoff for the better part of a
  minute while the database container starts, and blocking would hold the whole dashboard hostage to
  it. Every store and the telemetry client gate their own queries on `ready` and degrade until then.
- **Synthetic data reaches a database only through `npm run seed`, into a disposable one.** The
  dangerous combination is inexpressible from two sides: the seeding CLI refuses any database whose
  name does not end in `_seed`/`_synthetic`/`_demo`/`_e2e`/`_test`, and `loadConfig` refuses a
  disposable database for every env-booted process. Both halves matter — one stops synthetic rows
  landing in `factory_dev`, the other stops real history landing somewhere `npm run test:db` will
  truncate.
- **Every stored read is scoped by the repo list and the organization.** The repo list comes from the
  GitHub App installation — or, with no credential, from the distinct repos already in
  `session_branch` — and `org_id` partitions every session row. A read that ignored either would
  render another partition's or another repo's sessions as this dashboard's.
- **`035_default_workflow_settings.sql` stores absence, not defaults.** `user_workflow_default`
  holds a row only for a member who has saved something; `createDefaultWorkflowSettingsStore().get()`
  answers both switches `true` with a null `updatedAt` for a missing row and never inserts one, so
  the default lives in one place — the read — instead of a column that would need migrating the day
  the default changes. Keyed `(org_id, user_id)`, the same argument 012 made for `user_executor`.
- **`040_user_executor_default.sql` is a flag on the row, not a settings table like 035's.** The
  difference is `replace()`: `user_executor` is deleted and re-inserted wholesale on every PUT
  (012's header), so a preference keyed by executor name in a separate table would lose its link on
  every save. A column travels with the row through that same replace, and a deleted row takes its
  flag with it for free. One default per member is a partial unique index, `027_workflows.sql`'s
  `workflow_default_uk` precedent.

**Tradeoff worth knowing:** the SQL, the views and the migration runner have **no coverage in
`npm test`**. That is the price of keeping the default suite offline and database-free; they are
covered by `npm run test:db`, which needs a running container — and refuses any database not named
`*_test`, because the suite resets and reseeds every table before each test. The suites share
`server/test-db/harness.ts`: one `_test`-name guard, one migration run, one truncate-everything
reset per test with the suite's declared fakes re-planted, and a final truncate teardown — so a
fresh empty database works and no suite can quietly depend on rows a previous run left behind
(which is how they once came to pass on a used database and fail on a fresh one).
