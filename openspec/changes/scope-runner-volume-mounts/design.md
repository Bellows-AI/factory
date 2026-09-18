# Design: Scope runner volume mounts

## Context

The workspaces volume is one RWX claim (`charts/factory/templates/pvc.yaml`); the dashboard
pod mounts it whole at `ORG_WORKSPACE_ROOT`, and the driver mounts it whole into every runner
and aux Job it creates (`driver/src/k8s.ts`, `volumes: [{ persistentVolumeClaim: … }]`).
The board computes each claim's `workspacePath` as `<orgId>/<userId>`
(`server/src/db/job-store.ts`) and the driver already asserts both segments before joining
them into container paths (`runWorkingDir`, `transcriptDir` in `driver/src/docker.ts`). The
driver Deployment itself never mounts the volume. The dashboard is a direct filesystem
consumer of every org's tree: it provisions directories and breadcrumbs
(`server/src/workspace/provision.ts`) and clones repositories in-process
(`server/src/workspace/reconcile.ts`, queue in `workspace/queue.ts`). See proposal.md — Why.

## Goals / Non-Goals

**Goals:**

- A kernel-enforced mount boundary per job container: the container's volume root is its own
  `<orgId>/<userId>` subtree, on both executors.
- Keep the dashboard's whole-volume access as the provisioning and org-level analysis plane.
- Fail loud when a mount target is missing — never fall back to a broader mount.

**Non-Goals:**

- Namespace-per-org, per-namespace RBAC, per-org credentials (findings 4 and 5 of #137).
- Per-org storage ceilings and disk budgets (the quotas work item; app-level du/prune).
- Kernel-level separation of uid 1000 within a subtree (existing accepted medium).
- Any change to provisioning, cloning, or the board's claim shape.

## Decisions

### D1: subPath on the shared claim — not per-org PVCs

Alternatives considered:

- **Per-org PVCs, static helm values.** Rejected: k8s attaches PVCs only at pod-spec time, so
  every new org needs a values edit + `helm upgrade` + dashboard pod roll, and the values map
  becomes a drift-prone mirror of DB org state. Its one advantage — free per-org storage
  ceilings — belongs to the quotas item anyway.
- **Per-org PVCs, dynamic.** Rejected for now: unavoidable only if the dashboard stops being a
  filesystem consumer (provisioning and cloning move to Jobs). That rearchitecture pays for
  multi-replica (finding 9) later; it is not needed to close finding 1, and subPath composes
  with it — a future per-job PVC keeps the same scoped-mount semantics.

### D2: User-level subPath (`<orgId>/<userId>`), not org-level

The mount root is the full `workspacePath`. Nothing in the driver crosses members within an
org today: gates, sync, readouts and publish steps all operate on the job's own checkout and
its `.factory` state, and the board scopes gate reads per `workspacePath`. User level is the
same one-line change as org level and is strictly tighter: an agent sees only its own
checkouts. The org boundary the issue asks for is contained in it.

### D3: Docker parity via `volume-subpath`, not a docker exemption

`docker --mount type=volume,src=<volume>,volume-subpath=<orgId>/<userId>,target=/workspaces`
(docker ≥ 26.1) gives the dev executor the same boundary. Leaving docker whole-volume was
considered (dev-only, single tenant) and rejected: executor parity is a standing rule, the
mechanism exists, and the spec's "both executors scope identically" is testable only if both
implement it.

### D4: The subPath value carries the same assertions as container paths

The value becomes part of the pod spec / argv, so it is asserted exactly where
`runWorkingDir`/`transcriptDir` assert the org and user segments — a claim with a malformed
`workspacePath` is refused before any container is created, not after a mount names
something unintended.

### D5: Missing target fails loud, and provisioning makes that unreachable

No fallback mount on a missing directory. `ensureUserWorkspace` creates
`<root>/<orgId>/<userId>` at sign-in and on the `GET /api/workspace` poll, and the board
reports `workspacePath` on a claim only for a provisioned member — so the loud path is
reachable only through a provisioning regression, which is exactly what a stuck
`ContainerCreating` surfaces.

## Risks / Trade-offs

- [Online PVC expansion is slow or blocked while pods use subPath mounts] → The shared 20Gi
  then resizes offline (pod roll). Rare, loud, and the quotas item owns per-org budgets;
  documented in `docs/kubernetes.md`.
- [Docker hosts older than 26.1 cannot run the dev executor] → Version floor documented next
  to the other runner-image requirements; `docker version` check in the dev docs, not code.
- [No per-org disk ceiling under the shared claim] → Deferred by decision to the quotas work
  item; stated in the proposal so it is not rediscovered as a gap.
- [Provisioning regression now blocks job containers instead of exposing the volume] →
  Deliberate: loud-stuck is the desired failure mode; the ordering test pins it.

## Migration Plan

1. Land driver change with tests; `npm test`, `npm run typecheck`, `npm run lint`, then
   `npm run test:k8s` phase one (helm templates unchanged; chart needs no edit — the driver
   Deployment never mounts the volume).
2. Deploy: a rolling driver restart suffices — in-flight jobs keep their already-created pod
   specs; every newly claimed job gets the scoped mount. Rollback is the previous driver
   image. No data migration: the on-disk layout is unchanged.

## Open Questions

- None blocking. The docker version floor on active dev hosts is a deploy-time verification,
  not a design input.
