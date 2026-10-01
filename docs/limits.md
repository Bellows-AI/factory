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
- **The workspace checkout total is null until every included checkout has a measurement.** It sums
  the selected `ready` clones and the on-disk orphans — the driver's `.worktrees/` and other
  workspace files are not checkouts and are not counted — and a cold or failed `du` for any one of
  them keeps the whole figure null rather than imply a partial sum is the whole (issue #92).
  `purging` rows are excluded, on their way out. The per-checkout sizes share the same doctrine:
  null is unmeasured, never zero.
- `POST /api/otlp/v1/logs` accepts and discards. `prompt.id` and `message.uuid` are only worth
  storing once there is a per-prompt view to spend them on.
- **The caches `cache.ts` builds are process-global** — the telemetry snapshot and the repo list
  both. Correct for one organization, and the actual blocker for multi-tenancy — not the store
  signatures, which are already org-bound. A second organization needs a slot per organization, or
  every request serves the first one's snapshot.
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
- **The EFS storage contract is measured; the chart on EKS is not.** The prerequisites in
  [kubernetes.md](kubernetes.md)'s "The workspaces volume" were stood up on a real EKS cluster
  (`internal-utils`, eu-central-1, v1.34) on 2026-09-30 and observed: an `efs-ap` class with
  `uid`/`gid` 1000 binds an RWX claim, mints an access point owned `1000:1000 0775`, and a pod
  running as uid 1000 with no `fsGroup` provisions a member tree on the volume root that a second
  pod in another availability zone reads and writes through a `subPath`. The mount is `nfs4`, so
  the `fsGroup`-does-not-apply reasoning is confirmed rather than quoted. Also observed there, and
  the reason the prerequisite names the controller's pods: a `CSIDriver` object can outlive its
  install by years with nothing behind it.
  **What is still unobserved is the chart.** Those were probe pods reproducing the access pattern,
  not the dashboard's sign-in provisioning and not a runner Job — and no Factory release has ever
  been installed on EKS, because `scripts/test-k8s.sh` refuses every non-kind context, so the cloud
  lane does not exist. A real sign-in and a real runner write on EFS remain the thing nobody has
  watched.
- n is small. Weekly points are noisy and a single large session moves a total — which is exactly
  why the page says so instead of smoothing it.
