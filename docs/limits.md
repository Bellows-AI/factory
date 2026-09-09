# Known limits

Read before: reporting a number as measured, or "fixing" something in this list.

- Charts are fixed-width; below ~700px the weekly axis labels become illegible.
- The GitHub capture is post-backfill, so the oversized-PR path (#149, 397 reviews) is not
  exercised by it — `server/test-db/pr-store.test.ts` synthesises it instead. `npm run seed` does
  not produce one either: it never emits more children than it lists, so `truncated` is always
  empty and the truncation write path is untested by a seeded database.
- The capture predates `updatedAt`, commit `oid` and review-thread `id`, so `fixturePayload()`
  fills them in. That is safe now only because nothing at runtime reads it — it is test and tooling
  infrastructure, and the values never reach a database.
- **Seeded data is deterministic but not stable across changes to the generator.** The browser
  check asserts structure, not figures, for that reason. A spec that pins a seeded number will
  break on an unrelated change to `synthetic.ts` and look like a UI regression.
- An incremental sync cannot see a PR **deleted** upstream. A daily reconciliation reports rows it
  did not see, but does not remove them: losing expensively fetched history because a token lost a
  scope is worse than a stale count.
- The persisted PR store is single-writer. Two dashboards sharing one database would both sync and
  both advance the same watermark; nothing detects it.
- Token and line counts are what the agent wrote, not what survived to merge. There is no SHA in
  the telemetry, so no "AI share of this diff" number is possible.
- Attribution starts when the plugin is installed. A PR merged before that shows no usage, which
  is not the same as having used none.
- The branch is sampled roughly every 20s, not tracked. A branch held for less than one interval
  can be missed.
- `POST /api/otlp/v1/logs` accepts and discards. `prompt.id` and `message.uuid` are only worth
  storing once there is a per-prompt view to spend them on.
- **The two cache slots in `cache.ts` are process-global.** Correct for one organization, and the
  actual blocker for multi-tenancy — not the store signature, which is already org-bound. A second
  organization needs a slot per organization, or every request serves the first one's snapshot.
- **`session_branch.branch` is documented nullable ("null on detached HEAD") but sits in the
  primary key**, so postgres has rejected those rows since `001_init.sql`. `recordBranch` and
  `transcripts.ts` both try to write them and `routes.ingest.test.ts` cannot catch it because it
  asserts against a stub. `005_organizations.sql` preserves the constraint deliberately rather than
  fixing it in passing: the repair is a unique index over `coalesce(branch, '')`, which changes the
  `on conflict` target in three write paths and deserves its own review.
- **An opencode run prices under its own agent.** `metric-map.ts` carries `opencode.*` rows
  alongside `claude_code.*`, so `agentOf()` resolves opencode metrics to `'opencode'` instead of
  `'unknown'`, and an opencode session counts where `session_field_total` used to filter it out.
  The two agents still disagree by prefix on purpose — that is what `agentOf()` is for. A metric
  no row covers yet still accumulates with a null field. Telemetry depends on the executor image
  emitting into a reachable collector: the opencode image's plugin points at the compose network's
  `collector`, and off it the runs go unrecorded (see [telemetry.md](telemetry.md)).
