# Proposal: dedicated executor transcript store

## Why

Headless claude-code runs — the default executor path — write session transcripts to the
container filesystem, and the container is `docker rm -f`'d at every run's end: every
claude-code job's transcript is destroyed. The other two paths already persist (opencode's
per-member sqlite on the workspaces volume, Remote Control's auth volume), so the loss is
confined to the default path. Issue #55 asks for transcripts in a dedicated place so later
efficiency analysis (the factory-stats dashboard's stated purpose) has ground truth to work
from — but analysis needs the bytes to exist first.

## What Changes

- **Runner images**: the entrypoint accepts a transcript directory from the driver (headless
  claude-code runs only) and points `CLAUDE_CONFIG_DIR` at
  `<workspaces>/<workspacePath>/.factory/transcripts/<rootJobId>/`, seeded from the baked
  config so the git-guard hook and baked settings ride along. Transcripts land on the
  workspaces volume the moment the CLI writes them — no post-run copy, no loss window.
  One image change covers both executors (docker and kubernetes run the same images).
- **Driver**: composes the per-attempt transcript directory from claim fields the same way
  `WORKDIR` is composed (`workspaceMount` + `workspacePath` + `rootJobId`) and passes it to
  both transports — the docker argv (`dockerArgs`) and the kubernetes Job spec — so executor
  parity is by construction. Remote Control is excluded: its `CLAUDE_CONFIG_DIR` must stay
  the auth volume, because standby/park depends on the transcript surviving its container
  for `--resume`.
- **Reserved env name** for the transcript directory on both sides (driver
  `RESERVED_ENV_NAMES`, board mirror in `routes/env.ts`), so member configuration cannot
  steer where transcripts are written.
- **Docs**: `docs/jobs.md` documents the transcript store — layout, what already persists
  (opencode, Remote Control), and what stays out of scope.
- Deliberately out of scope: reading or analyzing transcripts, board ingestion, retention
  policy (unbounded for now), re-homing opencode's sqlite, organizing the Remote Control
  auth-volume pile.

## Capabilities

### New Capabilities

- `executor-transcripts`: executor session transcripts are persisted to a dedicated location
  on the workspaces volume and survive the run's container teardown, keyed for later
  analysis (thread root, session id).

### Modified Capabilities

<!-- None: openspec/specs/ is empty; no existing capability's requirements change. -->

## Impact

- `docker/claude-executor/entrypoint.sh` — the guarded redirect; the opencode image needs no
  change (the driver never sends the transcript-store name to an opencode run).
- `driver/src/docker.ts` (`dockerArgs`, `RESERVED_ENV_NAMES`), `driver/src/k8s.ts` (Job spec
  twin), `driver/src/config.ts` if any config surface emerges.
- `server/src/routes/env.ts` — mirrored reserved-name list.
- `docs/jobs.md` — the transcript store contract.
- Tests: pinned argv/pod-spec suites in `driver/test/` (the transcript env rides the same
  pinning), executor-image checks for the seeded redirect.
- No API changes, no database migration, no new volumes: the store reuses the workspaces
  volume and the reconcile's existing dot-directory protection (leading-dot names are
  never mistaken for checkouts).
