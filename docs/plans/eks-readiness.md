# EKS readiness of `charts/factory`

Assessment date: 2026-09-29. Chart version 0.1.0, branch `fix/265-pressed-state`.
Method: read every template, `helm lint` + `helm template` with production-shaped values (both
clean), read `driver/src/k8s-*.ts` for what the driver specs at runtime, cross-checked EKS
platform behaviour against AWS docs (VPC CNI network policy considerations, EFS CSI dynamic
provisioning).

**Verdict: renders and installs on EKS, does not run on EKS unprepared.** The chart is unusually
well built — admission-fenced driver, no ServiceAccount token on runners, credentials by reference
only, render-time refusals, every decision documented. Its gap is not quality, it is that every
platform assumption it makes is a *kind* assumption: side-loaded images, a local RWX-capable
provisioner, a TimescaleDB next door, and a CNI that enforces NetworkPolicy. Five of those are
blockers on a stock EKS cluster; none of them are hard to close, and none is covered by a test or
a doc today (`scripts/test-k8s.sh` refuses any non-kind context, so cloud coverage is zero).

---

## Blockers — a stock EKS install will not come up

### 1. Storage class: `ReadWriteMany` with no EFS

`workspaces.accessModes: [ReadWriteMany]`, `workspaces.storageClass: ''`. EKS's default class is
EBS (gp2/gp3), `ReadWriteOnce` and single-AZ. The PVC binds never; the dashboard pod sits Pending
and the driver claims jobs whose runner pods cannot mount anything.

Required, none of it mentioned anywhere in `charts/` or `docs/kubernetes.md`:
install the EFS CSI driver (its controller needs IRSA), create an EFS file system with mount
targets in every node subnet, a `StorageClass` with `provisioningMode: efs-ap`, then
`workspaces.storageClass: efs-sc`.

Fallback if one AZ is acceptable: EBS gp3 + `accessModes: [ReadWriteOnce]` + a nodeSelector
pinning dashboard, driver and runners to that AZ. Runner pods have no scheduling knob (see §7), so
this fallback is not actually reachable today.

### 2. EFS + uid 1000: nothing sets `fsGroup`, and on EFS it would not help

Every chart pod runs `runAsUser: 1000 / runAsGroup: 1000` with `readOnlyRootFilesystem: true`.
Runner, gate, sync, publish and helper pods run as the executor image's `USER node` (uid 1000);
gate Jobs set it explicitly. **No `fsGroup` appears anywhere** — not in
`charts/factory/templates/_helpers.tpl`, not in `driver/src/k8s-podspec.ts`.

On EFS that is the right call and a trap at once: the EFS CSI driver's `fsGroupPolicy` does not
apply `fsGroup` to an RWX NFS mount, so the only thing that makes the volume writable by uid 1000
is the access point's POSIX user. Dynamic provisioning's default access-point root is `root:root`
`700` — the dashboard's sign-in provisioning (which creates `<org>/<user id>` under the volume
root) fails `EACCES`, and every runner subPath mount under it is unusable.

Fix belongs in operator docs, not the chart: StorageClass parameters `uid: "1000"`, `gid: "1000"`,
`directoryPerms: "0775"` (or a static PV over an access point with that POSIX user). Untested on
this repo's side — worth one real EKS smoke run before anyone relies on it.

### 3. TimescaleDB is a hard extension requirement — RDS cannot serve it

`server/migrations/001_init.sql` opens with `create extension if not exists timescaledb;` and
`create_hypertable('metric_point', …)`. RDS PostgreSQL and Aurora PostgreSQL do not offer the
`timescaledb` extension. The README's "managed TimescaleDB" reads, to an EKS operator, as "RDS" —
it is not.

Real options: Timescale Cloud on AWS (VPC peering / PrivateLink), self-hosted TimescaleDB on EKS
(EBS-backed StatefulSet — `charts/factory-local-state` is a Deployment and explicitly not a
production shape), or accept the work of making `metric_point` a plain partitioned table. Decide
before anything else; it drives the VPC design.

### 4. Nothing exposes the dashboard, and GitHub OAuth needs a real origin

`Service` is ClusterIP by deliberate design (an unauthenticated `POST /api/jobs` would be cluster
RCE), and there is **no Ingress template and no hostname value**. But `AUTH_MODE=github` is
rendered as a literal and `auth.publicUrl` is refused at render time when empty — so a working
install *requires* a public HTTPS origin that the chart does not create.

On EKS the operator must hand-write: AWS Load Balancer Controller + IngressClass, an Ingress with
`target-type: ip` at port 8080, ACM cert, Route53 record, then `auth.publicUrl=https://…` and
`auth.cookieSecure=true`. Recommend adding an optional `ingress:` block (disabled by default, with
`className`/`annotations`/`hosts`/`tls` passthrough) — it is the single most-copied thing missing.

### 5. Image references are bare names

Defaults: `factory-ai`, `factory-driver`, `claude-executor`, `opencode-executor`, all with
`imagePullPolicy: IfNotPresent`. Bare names resolve to `docker.io/library/*` — `ImagePullBackOff`
on every one. Four images must be built, pushed to ECR and named in full (including
`driver.executorImages.*`, which are handed to the driver and never derived from the chart's own
registry). No `global.imageRegistry` knob exists, so that is four separate values.

Mitigating: issue #302's `readImagePullStatus` makes this fail fast with the kubelet's message
instead of burning a deadline. Pulling from ECR needs no `imagePullSecrets` — the node role covers
it.

---

## Major gaps — it will run, and then hurt

### 6. Runner pods have no resource requests or limits

`runnerJobSpec` (and the gate/sync/publish/helper/service specs) set no `resources` at all, and
there is no chart value for them. Consequences on EKS specifically:

- Every runner pod is **BestEffort**: first to be evicted under node memory pressure, and able to
  OOM a node that also hosts the dashboard.
- **Karpenter / Cluster Autoscaler cannot size for them.** A zero-request pod schedules onto any
  node with a free pod slot; no capacity is ever provisioned for an agent run, and `DRIVER_CONCURRENCY`
  × replicas of them land wherever they fit.

This is the highest-value chart change for a cloud cluster: `runner.resources` in values, forwarded
to the driver (e.g. `RUNNER_CPU_REQUEST` / `RUNNER_MEMORY_REQUEST` / limits) and rendered by
`k8s-podspec.ts`. Note the docker executor has the same hole, so parity is preserved by doing both.

### 7. Runner pods cannot be scheduled anywhere in particular

`nodeSelector` / `tolerations` / `affinity` apply to chart pods only (`factory.podScheduling`).
Pods the driver specs get none, and the admission policy explicitly forbids `nodeName`. So
agent-written code lands on the same nodes as the dashboard pod holding the GitHub App private key,
the session secret and the board token.

The standard EKS answer — a tainted, IMDS-hardened runner node group — is not expressible. Needs
`runner.nodeSelector` / `runner.tolerations` values wired through the driver into every specced pod.
(The admission policy must then admit them; today it constrains volumes, secrets and privilege, not
scheduling fields, so that is additive.)

### 8. Node consolidation will kill long agent runs

No `karpenter.sh/do-not-disrupt` annotation and no PDB on anything, while `driver.jobTimeoutMs`
defaults to 2 hours. Karpenter consolidation or a managed-nodegroup upgrade evicts a running runner
pod mid-job. Nothing is corrupted — the lease expires, the board re-offers, the checkout claim
fences the replacement — but the work is redone, silently, on every node churn. The driver's own
600s termination grace protects the driver, not the runners.

### 9. IMDS is only blocked if the CNI enforces the policy

`isolation.blockedCidrs` includes `169.254.0.0/16`, which is the right instinct: a runner reaching
`169.254.169.254` gets the **node IAM role**. But the NetworkPolicy is inert without enforcement
(§10), and defence in depth here is a node-level setting the chart cannot make: set
`httpPutResponseHopLimit: 1` (or disable IMDS) on the runner node group. Not documented anywhere.

### 10. NetworkPolicy on EKS: an add-on flag, and one shape AWS does not promise to enforce

VPC CNI enforces NetworkPolicy only when the add-on is configured with `enableNetworkPolicy: true`
(EC2 Linux nodes only — not Fargate, not Windows; IPv4-only clusters ignore IPv6 rules and vice
versa, and the chart's egress rule is IPv4 `0.0.0.0/0`, so an IPv6 cluster is uncovered — the
template says so).

The sharper one: AWS states enforcement is optimized for pods with `metadata.ownerReferences`, and
that standalone pods created without a controller "might not work reliably". The driver's
**declared-service pods are standalone Pods** (`k8s-services.ts`), as are nothing else — runner,
gate, sync, reclaim, publish and helper are all Jobs. So on EKS the one pod class that may escape
the policy is the one started from a repo's `.bellows.yaml`. Either run Cilium, or give service
pods an owner, or state the limit.

Positive checks: EKS CoreDNS pods do carry `k8s-app: kube-dns` in `kube-system`, and
`kubernetes.io/metadata.name` is set on every namespace, so the DNS egress rule matches as written.
NodeLocal DNSCache is not installed on EKS by default, so the `169.254.20.10/32` default in
`isolation.dnsCidrs` is harmless. AWS's "service port must equal container port" constraint is
satisfied by both Services the chart ships (8080→8080, 4317/4318→same).

### 11. `blockedCidrs` blocks the VPC — check what runners need there

10/8, 172.16/12, 192.168/16, 100.64/10 covers every plausible VPC CIDR. The dashboard, collector
and driver are reachable by podSelector, so in-cluster traffic is fine. What breaks: a runner that
must reach a VPC endpoint (CodeArtifact, an internal registry mirror, an internal git host, a
PrivateLink'd Timescale) — all private IPs. Those go in `isolation.allowedCidrs` as /32s, per host.
Worth stating in the EKS runbook.

### 12. metrics-server is not installed on EKS by default

The Role grants `metrics.k8s.io` and the code treats a missing sample as null, so this degrades
honestly — runner vitals just stay empty. Install the metrics-server add-on to get them.

### 13. Availability and operations

- One dashboard replica, `strategy: Recreate` — deliberate (single writer, unlocked migrations),
  but it means seconds of downtime per upgrade and no survival of a node loss until reschedule. No
  PDB anywhere; an EKS node drain can take the dashboard and the driver at once.
- Secrets default to plaintext in values. `secret.existingSecret` +
  `runner.credentialsExistingSecret` are supported and are the right EKS path (External Secrets /
  Secrets Store CSI over Secrets Manager or SSM). That Secret must carry `database-url` and
  `job-board-token` — both non-optional in the pod specs.
- No `values.schema.json`; the render-time `fail`s in `templates/validate.yaml` cover the
  credential-shaped mistakes but nothing about storage or images.
- VAPs are cluster-scoped and their names carry the namespace, but per-attempt Secret names do not
  carry the release — **one release per namespace**, as the template says. On a shared EKS cluster
  that is a hard rule, not a preference.
- Requires Kubernetes ≥ 1.30 for `admissionregistration.k8s.io/v1` VAP: fine for any supported EKS
  version today, and the installer needs cluster-scoped create rights.
- **Fargate is out**: no VPC CNI network policy, no metrics API, and the whole isolation story
  assumes a node.

---

## What is already right for EKS

Worth stating, because it is most of the chart: the driver's Role is namespace-scoped with no
`pods/exec` and no wildcard; the two ValidatingAdmissionPolicies close the "create pods = read
every Secret" hole that RBAC cannot; runners carry no ServiceAccount token; every credential
travels by `secretKeyRef`, never as a literal in a pod spec; every chart pod is non-root,
read-only-root, all capabilities dropped, `RuntimeDefault` seccomp; the workspaces claim is mounted
only at a per-member `subPath` and is kept on uninstall; the database init container closes the
migration-giving-up failure mode; probes distinguish "no schema" from "database down"; images are
tagged from `appVersion` and the collector is pinned; a changed Secret rolls its readers.

## Suggested order of work

1. Decide the TimescaleDB story (§3) — it gates the VPC design.
2. EFS: CSI driver, access point with POSIX 1000, `workspaces.storageClass` (§1, §2). Smoke-test a
   real sign-in provisioning, not just a bound PVC.
3. Push four images to ECR, set all four references (§5).
4. Add the optional `ingress:` block, or write the ALB Ingress by hand and set
   `auth.publicUrl` / `auth.cookieSecure` (§4).
5. Chart+driver change: `runner.resources` and `runner.nodeSelector`/`tolerations` (§6, §7) —
   docker-executor counterparts in the same change, per the parity rule in AGENTS.md.
6. Node-group hardening: IMDS hop limit 1, `enableNetworkPolicy: true` on the VPC CNI add-on,
   metrics-server (§9, §10, §12).
7. `karpenter.sh/do-not-disrupt` on driver-specced pods + a PDB for the dashboard (§8, §13).
8. An EKS lane for `scripts/test-k8s.sh`, or at minimum a documented manual EKS runbook — today
   the script refuses every non-kind context, so nothing has ever validated this on a cloud
   cluster.
