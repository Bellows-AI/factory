# Known limits

Read before: reporting a number as measured, or "fixing" something in this list.

- Charts are fixed-width; below ~700px the weekly axis labels become illegible.
- **Seeded data is deterministic but not stable across changes to the generator.** The browser
  check asserts structure, not figures, for that reason. A spec that pins a seeded number will
  break on an unrelated change to `synthetic.ts` and look like a UI regression.
- Token and line counts are what the agent wrote, not what survived. There is no SHA in the
  telemetry, so no "AI share of this diff" number is possible.
- AI usage only covers sessions after the plugin was installed, on machines that have it. A quiet
  week is not necessarily a week without AI.
- The branch is sampled roughly every 20s, not tracked. A session shorter than one interval can be
  missed entirely, and the sample is allowed to fail silently.
- `POST /api/otlp/v1/logs` accepts and discards. `prompt.id` and `message.uuid` are only worth
  storing once there is a per-prompt view to spend them on.
- **The caches `cache.ts` builds are per organization, not process-global.** Each organization gets
  its own runtime in the org registry (`server/src/orgs.ts`), with its own `createRepoSource` and
  `createStatsService`, so the telemetry snapshot and the repo list are cached per org. A built
  runtime is held for the life of the process (only a failed or missing build is dropped), so
  memory grows with the number of organizations that have been served.
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
- n is small. Weekly points are noisy and a single large session moves a total — which is exactly
  why the page says so instead of smoothing it.
