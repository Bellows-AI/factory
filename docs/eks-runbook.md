# EKS runbook — a cloud install, by hand

The cloud twin of [the chart README's kind walkthrough](../charts/factory/README.md#a-local-cluster-end-to-end);
no lane validates this chart against a cloud cluster. **Last walked 2026-10-01** (EKS
`internal-utils`, eu-central-1, v1.34, chart `v0.0.0`, offline entry): steps 2, 3, 4 and 7's
ingress half held; 1, 6 and 7's job half were not walked.

## 1. Cluster prerequisites

Reasoning: [docs/kubernetes.md](kubernetes.md), "EKS prerequisites".

- EKS ≥ 1.30, EC2 Linux nodes. **Fargate is out entirely** — no NetworkPolicy, no metrics API.
- VPC CNI add-on with `enableNetworkPolicy: true`.
- `httpPutResponseHopLimit: 1` (or IMDS disabled) on the runner node group.
- The metrics-server add-on, or a running job's vitals degrade to null.
- The AWS Load Balancer Controller (step 7 uses it).
- A tainted **runner node group**, so agent-written code never shares a node with the dashboard pod
  holding the App key.

## 2. Storage: EFS under uid 1000

The workspaces claim is `ReadWriteMany`; EBS cannot serve that on EKS. Install the EFS CSI driver
(its controller needs IRSA), create the file system with one mount target in a subnet in each node
Availability Zone, then
a StorageClass, then set `workspaces.storageClass`:

```yaml
provisioner: efs.csi.aws.com
parameters:
    provisioningMode: efs-ap
    fileSystemId: fs-…
    directoryPerms: "0775"
    uid: "1000"
    gid: "1000"
```

`uid`/`gid`/`directoryPerms` are not optional: everything writing the claim runs as uid 1000, and
the driver's `fsGroupPolicy` does not apply `fsGroup` to an RWX NFS mount. Without them the access
point comes out `root:root` `0700` and sign-in provisioning fails `EACCES`.

**Measured** (2026-09-30, eu-central-1, v1.34): binds in ~16s; the access point reports `Uid 1000`,
`Gid 1000`, `OwnerUid 1000`, `Permissions 0775`; two pods in different AZs share the `subPath` over `nfs4`.

## 3. Images: one registry prefix

Bare defaults resolve to `docker.io/library/*` and every pod lands in `ImagePullBackOff`. Push a
`v*` tag ([ci.md](ci.md)), make the five GHCR packages public — the first push creates them
private — then set `global.imageRegistry` once.

- `database.waitImage` is the one reference the prefix never touches: mirror it, set it whole.
- **Tag the two executor values.** They are bare repository strings, so a packaged chart cannot
  resolve them from `AppVersion`; tagless reads `:latest` and the node reuses its first cached pull.
- The same tag publishes the chart to `oci://ghcr.io/<owner>/charts/factory`, versioned with the
  tag minus its leading `v` — what a GitOps controller resolves.

Observe: a wrong executor reference fails the run fast naming the image (`readImagePullStatus`).

## 4. Database: any managed PostgreSQL 17

Set `database.url` — RDS and Aurora both work, the schema loads no extension
([persistence.md](persistence.md)). Observe: the `pg_isready` init container passes and
`GET /api/ready` answers 200 once migrations land.

**`charts/factory-local-state` cannot back a cloud install.** It mounts its claim at
`/var/lib/postgresql/data`; a real ext4 volume carries a `lost+found`, `initdb` refuses, and the
StatefulSet crash-loops — kind's hostPath provisioner hides this. Use a managed instance, or set
`PGDATA=/var/lib/postgresql/data/pgdata`, which the next `helm upgrade` reverts. A private-address
database sits inside `isolation.blockedCidrs` and the runner never needs it; a runner that must
reach another private host needs it as a /32 in `isolation.allowedCidrs`.

## 5. Install: the values shape

`scripts/test-k8s.sh`'s offline EKS lane renders this shape as assertions (`EKS_SETS`); a mismatch
is a bug in one of them.

- `runner.nodeSelector` / `runner.tolerations` — onto step 1's tainted group.
- `driver.runnerDoNotDisrupt` — off by default; an undisruptable pod pins its node for up to
  `driver.jobTimeoutMs`.
- `auth.publicUrl` — the real public origin, with `auth.cookieSecure: 'true'`.
- `secret.existingSecret` or the chart-created Secret, carrying `database-url` and
  `job-board-token`. On the External Secrets path: a remote path outside the controller's IAM
  scope fails with `could not get secret data from provider` and the `AccessDeniedException` is in
  the controller's events, not the ExternalSecret's status; a missing remote key fails the whole
  sync, so spell optional keys `{{ default "" (index . "SOME_KEY") }}`; and one remote per owner,
  since Terraform owns an entire `SecretString` and its next apply deletes a hand-written key
  beside it. `GITHUB_APP_PRIVATE_KEY` may be raw or base64 (`loadConfig` discriminates on
  `-----BEGIN`), and a tool reading that secret must do the same.

## 6. Isolation: enforced, not just admitted

Observe from inside a runner pod: no egress to `169.254.169.254`, none to the private ranges, DNS
only through kube-dns, the dashboard, collector and driver reachable by podSelector, and a
declared-service pod resolving by its declared name.

## 7. Exposing the dashboard, and a job end to end

ALB annotations: the chart README's
[Exposing the dashboard](../charts/factory/README.md#exposing-the-dashboard). The ACM certificate
and Route53 record are outside the chart; `ingress.hosts` must contain the host of
`auth.publicUrl` or the render is refused.

Observe: the ALB provisions, `http://` redirects to `https://`, `/api/health` passes, sign-in
completes. Then add an executor and queue a task — the runner pod schedules onto the runner node
group, `kubectl get pod -o yaml` carries no credential values, vitals render, output and status
arrive, a follow-up resumes the session. Stop one mid-run if you can afford the redo: the lease
expires, the board re-offers, the replacement fences the checkout, `attempts` is the only trace.
An offline deployment's driver 503s with `JOBS_UNAVAILABLE` (no org materialized yet); a 401 there
would be the credential instead.

## 8. Teardown

Runner Jobs first — a runner pod still mounting the workspaces claim holds its delete under
pvc-protection — then `helm uninstall`, the claim, the EFS file system and access points, the ACM
certificate and the DNS record.

**Stated limit:** this catches nothing about EFS permissions, add-on enforcement or policy
behaviour on any cluster but the one walked, and `scripts/test-k8s.sh`'s render lane only keeps the
value shape from drifting. Gaps: [docs/executor-testing.md](executor-testing.md), "What no lane covers".
