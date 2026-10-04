# Kubernetes

The primary executor — runners are Jobs, not `docker run` — plus the Helm chart that deploys the whole factory. The
"operator for runners" is the driver itself, reconciling claim → spawn → heartbeat → complete against the board, so
there is no CRD and no second control loop.

## Where things live

| Concern | Code | Test |
| --- | --- | --- |
| The `Runner` seam both executors implement | `driver/src/runner.ts`, `driver/src/k8s-runner.ts` | `driver/test/k8s.test.ts` |
| Executor-neutral state: paths, claim env, outcome parsing, container scripts, argv plan | `driver/src/claim.ts`, `close-read.ts`, `container-scripts.ts`, `runner-plan.ts` | `driver/test/scripts.test.ts` |
| Wire types, the transport, protocol constants and status thresholds | `driver/src/k8s-transport.ts` | `driver/test/k8s-transport.test.ts` |
| Job specs: runner, gates, readouts, transcript; sync/reclaim/publish/service; per-attempt Secret naming; resource, scheduling and disruption fields | `driver/src/k8s-podspec.ts`, `k8s-auxspec.ts`, `k8s-podfields.ts` | `driver/test/k8s.test.ts` |
| The re-claim fence (checkout-claim ConfigMap, sweep, create brackets), the polling it brackets, and what a Stop mid-run leaves them (`k8s-kill.ts`) | `driver/src/k8s-fence.ts`, `k8s-poll.ts`, `k8s-kill.ts` | `driver/test/k8s.test.ts` |
| Gates as Jobs; declared services as pods under the attempt's headless Service | `driver/src/k8s-gates.ts`, `k8s-services.ts` | `driver/test/k8s.test.ts` |
| The orphan reaper | `driver/src/reaper.ts`, `driver/src/k8s-reaper.ts` | `driver/test/k8s-reaper.test.ts` |
| Every `EXECUTOR`, `K8S_*` and `RUNNER_*` variable, with its boot-time validation | `driver/src/config.ts` | `driver/test/config.test.ts` |
| The app chart: dashboard, driver, collector, RBAC, PDBs, Ingress | `charts/factory/` | `scripts/test-k8s.sh` |
| The admission policies that fence the driver | `charts/factory/templates/driver-admission.yaml` | `driver/test/k8s-admission.test.ts` |
| Runner network confinement | `charts/factory/templates/runner-networkpolicy.yaml` | `scripts/test-k8s.sh --netpol` |
| Local Postgres, the workspaces claim, and the `.env`-fed local values | `charts/factory-local-state/`, `charts/factory/values-local.yaml`, `scripts/k8s-local-values.mjs` | `scripts/test-k8s.sh` |

Object list, kind walkthrough and registry push: [chart README](../charts/factory/README.md). What a run does once
started — sync, gates, services, publish, helpers, reclaim — is one contract over both executors
([jobs.md](jobs.md)); lanes are [executor-testing.md](executor-testing.md).

## Invariants

- **Executor parity** (AGENTS.md): a docker feature lands its kubernetes counterpart in the same change, and a
  `k8s-*.ts` importing from `docker*.ts` means the shared name belongs in a neutral file.
- **Credentials go by reference, never by value** — the only literal `value:`s in a runner pod spec are paths and
  URLs — and **runner pods hold no ServiceAccount token** (`automountServiceAccountToken: false`), which would be the
  driver's own job-creating identity. Both pinned in `driver/test/k8s.test.ts`.
- **Every driver-owned object carries `factory.job`**, every driver-owned Secret follows the
  `factory-{job,sync,publish,helper,gate}-…-env` naming, and every workspaces mount uses `workspaceMount()`'s
  `<org>/<user id>` subPath — or admission refuses it. `driver/test/k8s-admission.test.ts` pins each `*SecretName`
  builder and the subPath pattern against the template itself.
- **The fence orders contenders by the board's attempt counter, never by a clock.** Creating the
  `factory-job-<id>-claim` ConfigMap is the mutex; a loser stands down and burns an attempt.
- **The driver never reads a Secret back** — the Role grants `create`/`delete` and no `get`/`list`, so attempt Secrets
  are reaped by derived name rather than enumerated.
- **`make start` refuses a state claim initialised without `PGDATA`**, and refuses to upgrade a state release still
  running the pre-StatefulSet Deployment (`state-preflight`, the Makefile). Both name `make reset`;
  `core/test/makefile.state-preflight.test.ts` guards the refusals.

## Operational facts

- `make reset` destroys the local state release and its data. A StatefulSet's `volumeClaimTemplate` claim survives
  `helm uninstall`, so that delete is the only thing removing it. A data directory initialised by
  `timescale/timescaledb` cannot be upgraded to `postgres:17`.
- The app chart deploys no database (`database.url` names any managed PostgreSQL 17, and the schema loads no
  extension) and exposes no `auth.mode`: it renders `AUTH_MODE=github`, because its dashboard holds checkouts.
- `EXECUTOR=kubernetes` with `RUNNER_CACHE_WATCH=1` is fatal at startup: it would be one Job per watch tick.

## EKS prerequisites

Each is silent when wrong, so the isolation story reads as enforced and is not. Walk and record:
[eks-runbook.md](eks-runbook.md); measured claims: [limits.md](limits.md).

- **Node-level IMDS defence** — `httpPutResponseHopLimit: 1` on the runner node group; `isolation.blockedCidrs`
  covers `169.254.0.0/16` only where a CNI enforces.
- **The VPC CNI add-on needs `enableNetworkPolicy: true`**, and enforces only on EC2 Linux nodes — not Fargate, not
  Windows. Without the flag the NetworkPolicy object is admitted and inert.
- **Declared-service pods are owned**, closing AWS's caveat that standalone pods "might not work reliably":
  `startFleet` stamps an `ownerReference` to the headless Service into each service pod and refuses the fleet when a
  create answers without a uid. Every other driver-specced pod is a Job, so already owned.
- **metrics-server is not installed by default** (runner vitals then read null), and **`blockedCidrs` blocks the VPC
  too** — a runner that must reach a VPC endpoint needs that host in `isolation.allowedCidrs` as a /32.

### The workspaces volume

The checkouts claim is the chart's only hard requirement, and its defaults (`workspaces.accessModes: [ReadWriteMany]`,
`storageClass: ''`) are true of kind and of nothing on EKS. Both failures are quiet: on an EBS default class the claim
never binds; a member tree the dashboard could not create leaves runner pods in `ContainerCreating` on a missing
`subPath`. What it needs instead:

1. **The EFS CSI driver, actually running** — its controller needs an IAM role bound by IRSA or by EKS Pod Identity.
   Check for the controller pods, **never for the `CSIDriver` object**: a stale registration leaves a PVC `Pending`.
2. **A mount target in every availability zone the nodes run in** — EFS allows one per zone, and a zone without one
   cannot mount the volume at all.
3. **A StorageClass owned by uid 1000** — `provisioner: efs.csi.aws.com` with `provisioningMode: efs-ap`,
   `directoryPerms: "0775"`, `uid: "1000"`, `gid: "1000"` and the file-system id; then
   `workspaces.storageClass: efs-sc`.

**No pod spec sets `fsGroup`** (asserted against the sources themselves in `core/test/docs.eks-storage.test.ts`), and
adding one would not help — the EFS CSI driver does not apply it to an RWX NFS mount, so the access point's POSIX user
is the only thing making the tree writable by the uid 1000 every pod runs as. Dynamic provisioning always applies
EFS's identity enforcement, and a class omitting `uid`/`gid` draws from the driver's allocation range.

That contract was **observed on a real EKS cluster** — `internal-utils`, eu-central-1, v1.34, on **2026-09-30**: an
access point reporting `Uid 1000` / `Permissions 0775`, a pod with no `fsGroup` creating the member tree, a pod in a
second zone mounting its `subPath`, the mount reporting `nfs4`. Those were probe pods; the chart itself has
**never been installed on EKS**. The single-AZ `ReadWriteOnce` gp3 fallback trades a zone outage for a full outage; it
was once unreachable because driver-specced pods had **no scheduling knob**, and `runner.nodeSelector`/`tolerations`/
`affinity` now forward as `RUNNER_NODE_SELECTOR`/`_TOLERATIONS`/`_AFFINITY`. Admission still refuses `nodeName`.

## Isolation: assumptions and residuals

Every pod the driver specs runs untrusted code; [security.md](security.md) carries the controls and the statement that
none of this is kernel or VM isolation. The deployment must provide: **A CNI that enforces NetworkPolicy** (kindnet and
an unconfigured VPC CNI do not); **ValidatingAdmissionPolicy, Kubernetes ≥ 1.30** (`failurePolicy: Fail` — what makes
the hardening an invariant of the namespace rather than a habit of one client); and the IMDS defence above. Residuals,
named rather than discovered:

- **IPv6 egress is not covered** by the runner policy at all; every rule is IPv4.
- A runner can **reach the driver pod on any port** — the gate endpoint is at the pod IP on an ephemeral port, so the
  rule is portless; closing it needs a fixed gate port. Cross-attempt network isolation (**#257**) and
  declared-service DNS shadowing (**#296**) are owned elsewhere; `--netpol` pins the former reachable on purpose.
- `blockedCidrs` covers private ranges by CIDR, so an apiserver or node address that is
  **PUBLIC is not covered**. A NetworkPolicy also **says nothing about HTTP routes**; every endpoint authorizes its
  own callers.
- Same-member tasks share a workspace subtree ([workspace.md](workspace.md)). A runner Job whose pod is gone before the
  verdict read uploads no log — a pod log does not survive its pod. A `helm upgrade` denies the old driver's pods until
  its rollout finishes; those attempts re-offer.

Deliberate docker divergences: no cpu-request flag (docker has no absolute CPU floor), no node
scheduling, no `imagePullSecrets` twin, no cache watch under kubernetes, and no admission
equivalent — nothing outside the driver checks the argv. The docker fence keeps its label-sweep
shape: the docker API has neither conditional delete nor unique-name arbitration.
