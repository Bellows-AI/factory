# EKS runbook — a cloud install, by hand

The cloud twin of [the chart README's kind walkthrough](../charts/factory/README.md#a-local-cluster-end-to-end).
`scripts/test-k8s.sh --cluster` refuses every kubectl context that is not bound to a kind cluster
of the matching name — deliberately: the phase deletes every runner Job in the namespace, and the
two fingerprints it could check independently (a docker label on this daemon, node objects over the
wire) could each pass against a different cluster, so the endpoint check is the guard. That guard
is correct and stays; the cost is that nothing validates this chart against a cloud cluster
automatically. This runbook is the by-hand pre-release walk that closes the gap. The offline phase
of the same script renders an EKS-shaped value set as assertions — it pins value-shape drift, and
it cannot catch EFS permissions, add-on enforcement or any other platform behaviour; only this walk
can. A real cloud lane in CI is an open decision (epic #365); whatever admitting fingerprint it
grows must be at least as hard to spoof as the kind endpoint check above, because it would delete
Jobs too.

**Walk record: not yet walked.** Everything below is an expectation to observe, except where marked
measured. When the walk happens, record here the date, the cluster, the region, the Kubernetes
version, and every step whose observation differed from its expectation; fold what it found back
into the epic (#365) and into this file, so the next walk starts from what is known rather than
what was assumed.

Everything the walk creates should be disposable: one dedicated namespace, one release, one EFS
file system and access point, one ACM certificate on a hostname that exists to be deleted. The
teardown at the end mirrors the kind one — runner Jobs before the claims, everything after.

## 1. Cluster prerequisites

The node- and add-on-level settings the chart cannot make for itself are documented, with their
reasoning, in [docs/kubernetes.md](kubernetes.md), "EKS prerequisites" — that section is the
checklist; this step runs it and watches it hold:

- EKS ≥ 1.30, EC2 Linux nodes, nothing on Fargate (no NetworkPolicy, no metrics API — Fargate is
  out entirely).
- The VPC CNI add-on configured with `enableNetworkPolicy: true`. Observe: after install, the
  runner NetworkPolicy (step 6) actually confines — a runner pod cannot reach an address in
  `isolation.blockedCidrs`, not merely carry a policy that says so.
- `httpPutResponseHopLimit: 1` (or IMDS disabled) on the runner node group. Observe: a runner pod
  cannot read `169.254.169.254` even if the policy were inert.
- The metrics-server add-on. Observe: a running job's vitals render on the dashboard; without it
  they degrade to null honestly, but the walk wants the numbers.
- The AWS Load Balancer Controller installed (step 7 uses it).
- A **runner node group** — tainted, IMDS-hardened, nothing else schedules onto it. This is what
  `runner.nodeSelector` / `runner.tolerations` (step 5) are for: agent-written code never shares a
  node with the dashboard pod holding the App key.

## 2. Storage: EFS under uid 1000

The workspaces claim is `ReadWriteMany` — the dashboard writes checkouts and every runner mounts
the same claim across nodes — and EBS cannot serve that on EKS. Install the EFS CSI driver (its
controller needs IRSA), create the file system with mount targets in every node subnet, and give
the chart a StorageClass like:

```yaml
provisioner: efs.csi.aws.com
parameters:
    provisioningMode: efs-ap
    fileSystemId: fs-…
    directoryPerms: "0775"
    uid: "1000"
    gid: "1000"
```

The `directoryPerms`, `uid` and `gid` parameters are the whole fix. Everything that writes the
workspaces claim runs as uid 1000 — the dashboard by its securityContext, the runner and the aux
Jobs through the executor images' `USER node` — and the EFS CSI driver's `fsGroupPolicy` does not
apply `fsGroup` to an RWX NFS mount, so the only thing that makes the volume writable by uid 1000
is the access point's POSIX user. A class without `uid`/`gid` mints its access points `root:root`
`0700`, and the dashboard's sign-in provisioning (`mkdir -p <org>/<user id>` on the volume root)
fails `EACCES`.

**Measured** (2026-09-30, a real EKS cluster, eu-central-1, Kubernetes v1.34 — the observation
behind #357): a class carrying `uid`/`gid` 1000 and `directoryPerms: "0775"` binds a
`ReadWriteMany` claim in ~16s and mints an access point reporting `Uid 1000`, `Gid 1000`,
`OwnerUid 1000`, `Permissions 0775`; a pod running as uid 1000 with no `fsGroup` then created
`<org>/<user>` on the volume root and got both directories back owned `1000:1000`; a second pod in
another availability zone mounted the `subPath` and read and wrote beside the first; the mount
reports itself as `nfs4`, confirming the RWX-NFS shape the reasoning above predicts.

Then set `workspaces.storageClass: <the class above>` and observe: the claim binds; a pod in each
of two AZs can mount its `<org>/<user>` `subPath` and see the other's writes.

## 3. Images: one registry prefix

The bare image defaults are the kind story (`kind load docker-image`); on EKS they resolve to
`docker.io/library/*` and every pod lands in `ImagePullBackOff`. Follow the chart README's
"Images on a remote cluster": build and push the four images (dashboard, driver, both executors)
plus the collector mirror, then set `global.imageRegistry` once — it prefixes every reference the
chart renders, executor values included. Tag the executor values — the tags are what let the
kubelet pull a new build once under `IfNotPresent`; tagless reads `:latest`, and the node reuses
whatever it cached first. `database.waitImage` is the one reference the prefix never touches: a
cluster without Docker Hub egress needs it mirrored and set whole.

Observe: every pod pulls; an intentionally wrong executor reference fails the run fast naming the
image (`readImagePullStatus`), not as a burned deadline.

## 4. Database: any managed PostgreSQL 17

Since #371 the schema loads no extension — `metric_point` is a declaratively-partitioned table —
so RDS and Aurora PostgreSQL are fine, and Timescale Cloud is no longer the only managed answer.
Set `database.url`; the chart puts it in the Secret and the `pg_isready` init container waits on
it. Observe: the init container passes; `GET /api/ready` answers 200 once the migrations land.

A database on a private address sits inside `isolation.blockedCidrs` — the defaults block the
whole VPC — and the runner never needs it anyway: the dashboard, collector and driver it does
reach are reached by podSelector, not by CIDR. A runner that must reach any other private host
(an internal git mirror, a VPC endpoint) needs that host as a /32 in `isolation.allowedCidrs`.
Observe: runner egress to the listed host works; to the rest of the VPC it does not.

## 5. Install: the values shape

The EKS-specific value shape — storage class, registry prefix, ingress, runner scheduling,
do-not-disrupt, allowed CIDRs — is the shape `scripts/test-k8s.sh`'s offline EKS lane renders as
assertions (its `EKS_SETS`); the two must not drift, and a mismatch is a bug in one of them. The
decisions and where they are already argued:

- `runner.nodeSelector` / `runner.tolerations` — onto the tainted runner node group of step 1
  (docs/kubernetes.md, issue #361). Observe: the runner Job's pod lands on that group; chart pods
  do not.
- `driver.runnerDoNotDisrupt` — the opt-in that keeps consolidation and scale-down from evicting a
  running job; off by default because an undisruptable pod pins its node for up to
  `driver.jobTimeoutMs` (docs/kubernetes.md, issue #362). Decide, set, and observe the
  annotations on a runner pod.
- `auth.publicUrl` — the real public origin (step 7), with `auth.cookieSecure: 'true'`.
- `secret.existingSecret` or the chart-created Secret — the EKS path is External Secrets over
  Secrets Manager; either way the Secret must carry `database-url` and `job-board-token`.

## 6. Isolation: the policy has to be enforced, not just admitted

Everything the chart renders here is asserted offline (admission policy, NetworkPolicy, the runner
Secret's shape). What only a real cluster shows: that the VPC CNI enforces it. Observe, from
inside a runner pod: no egress to `169.254.169.254` (step 1's hop limit is the second layer), no
egress to the private ranges, DNS resolving only through kube-dns, and the dashboard, collector and
driver reachable by podSelector. A declared-service pod carries an ownerReference to its headless
Service so the CNI's managed-pod caveat has nothing here to bite — confirm the Service and its
pods come up and resolve by the declared name.

## 7. Exposing the dashboard, and a job end to end

The chart README's "Exposing the dashboard" carries the ALB annotation set that works (`scheme`,
`target-type: ip`, the ACM `certificate-arn`, `listen-ports` with `ssl-redirect`,
`healthcheck-path: /api/health`); the ACM certificate and the Route53 record to the ALB's DNS name
are outside the chart. `ingress.hosts` must contain the host of `auth.publicUrl` or the render is
refused. Observe: the ALB provisions; `http://` redirects to `https://`; `/api/health` passes the
health check; the GitHub sign-in round trip completes against `auth.publicUrl`.

Then the kind walkthrough's twin: add an executor on the workspace page, queue a task, and watch
it end to end. Observe: the runner pod schedules onto the runner node group; its env references
only per-attempt Secrets (`kubectl get pod -o yaml` carries no credential values); vitals render;
the job's output and status arrive on the board; a follow-up resumes the session. Stop one mid-run
if you can afford the redo: a node drain or consolidation must not corrupt anything — the lease
expires, the board re-offers, the replacement fences the checkout — but the `attempts` count is
the only trace, and the walk is where that claim is watched rather than trusted.

## 8. Teardown

Runner Jobs first — a runner pod still mounting the workspaces claim holds the claim's delete
under pvc-protection, exactly as the kind teardown's comment says — then `helm uninstall`, then
the claim, then the EFS file system and access points, the ACM certificate and the DNS record.

## 9. What this runbook cannot catch

It is a hand walk, not a gate: it proves the chart on one cluster on one day, and only for whoever
walked it. The render lane in `scripts/test-k8s.sh` keeps the value shape from drifting between
walks; it cannot catch EFS permissions, add-on enforcement, or policy behaviour. The standing
gaps live in [docs/executor-testing.md](executor-testing.md), "Remaining gaps"; a real cloud lane
in CI remains an open decision on the epic (#365), with the spoof-hardness requirement stated at
the top of this file.
