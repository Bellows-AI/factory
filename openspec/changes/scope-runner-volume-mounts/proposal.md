# Proposal: Scope runner volume mounts to the job's own workspace subtree

## Why

Finding 1 of #137: the shared workspaces volume is mounted whole, read-write, into every
runner, gate and sync container of every organization. Org A's agent — frequently under
skip-permissions — can read and write org B's source, transcripts and session DBs. The code
itself calls handing a container a parent tree "a cross-tenant read" (`driver/src/docker.ts`
workspace assertions), yet the mount hands every container the whole tree. The board and API
layer are multitenant-ready (org = installation, #99); the execution plane's volume boundary
is the gap this change closes.

## What Changes

- Kubernetes runner and aux-job volume mounts gain `subPath: <workspacePath>`
  (`<orgId>/<userId>`), scoping each container's mount to its own workspace subtree —
  enforced by the kernel bind mount, not by convention. (User level, per review decision.)
- Docker executor parity in the same change: named-volume mounts scoped with the
  `volume-subpath` mount option (docker ≥ 26.1). No docker-only behavior.
- The mount target must exist before the pod starts (kubelet fails loud with a stuck
  `ContainerCreating` otherwise). Provisioning (`ensureUserWorkspace`) already creates the
  directory at sign-in / first poll; a test pins that ordering.
- Docs: `docs/security.md`'s "isolation is a path… a boundary against accident" concession
  becomes a kernel-enforced boundary; `docs/kubernetes.md` executor-table rows updated.
- Explicitly out of scope: namespace-per-org split (findings 4 and 5), per-org storage
  ceilings (quotas work item), any provisioning change — the dashboard keeps its whole-volume
  mount as the trusted provisioning and org-level aggregation plane (disk stats, transcript
  analysis read every org's tree by design).

## Capabilities

### New Capabilities

- `executor-volume-isolation`: containers the driver starts (runners, gates, sync, readouts,
  publish steps) see only their own job's workspace subtree of the workspaces volume, on both
  executors, with the dashboard's cross-org visibility stated as the deliberate exception.

### Modified Capabilities

- None. `executor-transcripts` requirements are unaffected: transcript paths
  (`<workspacePath>/.factory/transcripts/<rootJobId>/`) already live inside the scoped
  subtree, so transcript persistence behaves identically under the smaller mount.

## Impact

- `driver/src/k8s.ts` — `subPath` on the volumeMount in `runnerJobSpec` and the aux-job specs
  (gate, sync, bellows readout, opencode readout, publish steps).
- `driver/src/docker.ts` — `dockerArgs` and aux argv parity via `volume-subpath`.
- `driver/test/` — the runner Job spec is pinned field by field; those pins grow the `subPath`
  assertion, plus new scoping tests for aux jobs and the provisioning-ordering guarantee.
- `docs/security.md`, `docs/kubernetes.md` — boundary language and executor-table rows.
- No chart changes (the driver Deployment never mounts the volume; the dashboard's whole mount
  is deliberate). No server, DB or API changes.
