# Known limits

Capabilities deliberately absent, and figures that are narrower than they look. Read before
reporting a number as measured, or "fixing" anything listed here.

## What the numbers do not cover

- AI usage only covers sessions after the plugin was installed, on machines that have it. A quiet
  week is not necessarily a week without AI.
- Token and line counts are what the agent wrote, not what survived: there is no SHA in the
  telemetry, so no "AI share of this diff" is possible.
- The branch is sampled roughly every 20s, not tracked (`plugins/agent-telemetry/`). A session
  shorter than one interval can be missed, and the sample may fail silently.
- n is small. Weekly points are noisy and one large session moves a total — the page says so
  instead of smoothing it.
- **Null is unmeasured, never zero** across the payload: the workspace checkout total stays null
  until every included checkout has a size (`server/test/routes.workspace.test.ts`).
- Seeded data is deterministic but not stable across changes to `server/src/seed/synthetic.ts`, so
  the browser check asserts structure, not figures.

## Capabilities that are absent

- `POST /api/otlp/v1/logs` accepts and discards (`server/src/routes/ingest.ts`).
- Charts are fixed-width; below ~700px the weekly axis labels become illegible.
- Telemetry needs the executor image to reach a collector — off the compose network, opencode runs
  go unrecorded ([telemetry.md](telemetry.md)).

## Known defects

- **`session_branch.branch` is documented nullable but sits in the primary key**, so postgres has
  rejected detached-HEAD rows since `001_init.sql`. `recordBranch` and
  `server/src/backfill/transcripts.ts` both try to write them, and
  `server/test/routes.ingest.test.ts` cannot catch it because it asserts against a stub. The repair
  is a unique index over `coalesce(branch, '')`, which changes the `on conflict` target in three
  write paths and deserves its own review.

## Measured versus assumed

- The EFS storage contract in [kubernetes.md](kubernetes.md) was observed on a real EKS cluster
  (`internal-utils`, eu-central-1, 2026-09-30), not quoted. What is still unobserved is the chart:
  `scripts/test-k8s.sh` refuses every non-kind context, so no Factory release has been
  installed there and a real sign-in and a real runner write on EFS remain unwatched. See
  [eks-runbook.md](eks-runbook.md).
