# Infra spec: EFS-backed workspaces volume for the Factory chart on EKS

**Status:** ready to pick up. **Owner:** infra. **Follow-up happens in another repository** — this
file is written to be self-contained, so nothing here assumes a `factory-ai` checkout.

**Closes:** [Bellows-AI/factory#357](https://github.com/Bellows-AI/factory/issues/357), whose
documentation half shipped in [PR #373](https://github.com/Bellows-AI/factory/pull/373). That PR
documents the prerequisites; this spec is the work of actually standing them up and observing
them, which is the only thing that lets #357 close.

---

## 1. Why

The Factory chart mounts one shared `PersistentVolumeClaim` — the "workspaces volume" — that holds
every member's git checkouts. The dashboard pod mounts its **root** and writes a
`<orgId>/<userId>` tree there at sign-in; every runner/gate/sync/publish pod mounts the **same
claim** at its own `subPath: <orgId>/<userId>`, from whichever node it landed on.

That shape needs two things from the cluster, and a stock EKS cluster provides neither:

1. **`ReadWriteMany`.** Many pods on many nodes read and write it at once. EKS's default
   StorageClass is EBS — `ReadWriteOnce`, single-AZ — so the claim never binds and the dashboard
   sits `Pending` forever.
2. **A volume root writable by uid 1000.** Every pod that touches the volume runs as uid/gid 1000,
   and the chart sets **no `fsGroup`** anywhere — deliberately, because the EFS CSI driver does not
   apply `fsGroup` to an RWX NFS mount. The only thing that makes the tree writable is the **EFS
   access point's POSIX user**, and a dynamically provisioned access point defaults to
   `root:root 0700`.

Failure mode #2 is the dangerous one because **nothing crashes**: sign-in still succeeds
(provisioning is deliberately non-fatal), one `workspace provisioning failed` line lands in the
dashboard log, the member tree is never created, and every runner pod for that member waits in
`ContainerCreating` on a `subPath` that does not exist. The board simply stops producing work.

---

## 2. Target environment, as measured

Read-only inspection on 2026-09-30. All values below are observed, not assumed.

| Fact | Value |
| --- | --- |
| AWS account | `311772925847` |
| Region | `eu-central-1` |
| EKS cluster | `internal-utils` |
| Kubernetes version | `v1.34.10-eks-cb19647` (chart needs ≥ 1.30 for `ValidatingAdmissionPolicy`) |
| VPC | `vpc-0a51fbb4c783ec2a0` |
| Node subnet, eu-central-1a | `subnet-011320ca23b2174cc` (10.0.64.0/18) |
| Node subnet, eu-central-1b | `subnet-02cac38fc33eb53fb` (10.0.128.0/20) |
| Node security group (all 6 nodes) | `sg-010f4d44700f584bd` |
| Cluster security group | `sg-0b700ac657d0b3729` |
| OIDC issuer | `https://oidc.eks.eu-central-1.amazonaws.com/id/3024D9FE625FD438B4A2D32FDA29BA37` |
| Nodes | 6, spanning eu-central-1a and 1b only |

### What already exists

- `aws-ebs-csi-driver`, `coredns`, `kube-proxy`, `vpc-cni`, **`eks-pod-identity-agent`** as EKS
  addons.
- StorageClasses: `gp3 (default)` on `kubernetes.io/aws-ebs`, and `dynamic` on `ebs.csi.aws.com`.
- **ArgoCD** (namespace `argocd`, 611d). Assume this cluster is GitOps-managed and land Kubernetes
  objects through Argo rather than `kubectl apply`, unless you know otherwise.

### What is missing — and one trap

- **No EFS file system exists in the account** (0 in eu-central-1, 0 in eu-west-1).
- **No EFS StorageClass.**
- **The EFS CSI driver is NOT installed, despite appearances.** An `efs.csi.aws.com` `CSIDriver`
  object has been registered on this cluster since **2023-07-10**, but there is no controller
  behind it: no `efs-csi-controller-sa`, no pods in any namespace, and EFS is absent from
  `aws eks list-addons`. It is a leftover that an uninstall did not sweep.

  > **Do not use `kubectl get csidrivers` as your installed-check.** It will show the driver as
  > present on this cluster and it is not. A PVC against an EFS StorageClass here would wait
  > `Pending` forever with no provisioner to answer it and nothing in its events naming the cause.
  > The honest check is `kubectl -n kube-system get pods | grep efs`.

---

## 3. Work

### 3.1 EFS file system

- One file system in `eu-central-1`, encrypted at rest.
- Performance mode `generalPurpose`; throughput mode `elastic` (the workload is bursty git I/O —
  clones and worktree syncs — not a steady stream).
- Tag it so it is obviously disposable if this stays a test: suggest
  `Name=factory-workspaces`, plus whatever ownership tags this account expects.
- Lifecycle policy is optional; if you set one, be aware that a checkout not touched for 30 days
  transitioning to IA is harmless but adds first-read latency to a resumed task.

### 3.2 Mount targets — one per node subnet, both required

| Subnet | AZ |
| --- | --- |
| `subnet-011320ca23b2174cc` | eu-central-1a |
| `subnet-02cac38fc33eb53fb` | eu-central-1b |

A node in a subnet with no mount target cannot mount the volume **at all**. With only one, the
install appears to work until the scheduler places a pod in the other AZ — an intermittent failure
that looks like a flaky runner, not a storage misconfiguration.

Attach a security group to the mount targets allowing **inbound TCP 2049 (NFS)** from the node
security group `sg-010f4d44700f584bd`. Nothing else needs to reach it.

### 3.3 EFS CSI driver, with a working controller

Install `aws-efs-csi-driver` (EKS addon preferred, since the addon path is what this cluster
already uses for everything else).

Its **controller** needs an IAM role carrying the file-system and access-point calls —
`elasticfilesystem:DescribeAccessPoints`, `DescribeFileSystems`, `DescribeMountTargets`,
`CreateAccessPoint`, `DeleteAccessPoint`, plus `ec2:DescribeAvailabilityZones`. AWS publishes this
as `AmazonEFSCSIDriverPolicy`; use it unless this account prefers hand-written policies.

Bind that role by **EKS Pod Identity** (this cluster already runs `eks-pod-identity-agent`, so it
is the path of least resistance) or by IRSA against the OIDC issuer above. Either works. **The node
role is not enough** — dynamic provisioning creates access points at claim time, which is a
control-plane call the controller makes on its own identity.

The node DaemonSet needs no special IAM.

### 3.4 The StorageClass — this is where the uid-1000 fix lives

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
    name: efs-sc
provisioner: efs.csi.aws.com
parameters:
    provisioningMode: efs-ap
    fileSystemId: fs-REPLACE_ME
    directoryPerms: "0775"
    uid: "1000"
    gid: "1000"
```

`uid`/`gid`/`directoryPerms` are the entire point of this spec. Without them the provisioner mints
an access point rooted at `root:root 0700` and every write from the workload fails `EACCES`.

Do **not** try to solve this with `fsGroup` on the pods. The EFS CSI driver does not apply
`fsGroup` to an RWX NFS mount, and the Factory chart deliberately sets none — a change that adds
one would be reverted.

A static PV over a hand-created access point with the same POSIX user is an equally valid
implementation if this account prefers not to grant `CreateAccessPoint`. Say so if you go that way,
because it changes the chart value from a StorageClass name to an `existingClaim`.

---

## 4. Acceptance criteria

Three tiers. **Tier 3 is what actually closes #357** — the issue is explicit that "the PVC bound"
is not sufficient evidence.

Run everything in a disposable namespace (suggest `factory-efs-test`) and delete it afterwards.

### Tier 1 — the claim binds

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
    name: workspaces-probe
spec:
    accessModes: [ReadWriteMany]
    storageClassName: efs-sc
    resources:
        requests:
            storage: 20Gi
```

Pass: `kubectl get pvc workspaces-probe` reports `Bound` within ~60s, and the provisioner created
an access point (`aws efs describe-access-points --file-system-id fs-…` shows one with
`PosixUser: {Uid: 1000, Gid: 1000}`).

### Tier 2 — uid 1000 can write the volume root and create a nested tree

This reproduces what the dashboard does at sign-in. **Note the securityContext: uid/gid 1000 and
deliberately no `fsGroup`** — a probe that sets `fsGroup` proves nothing, because the real
workload does not.

```yaml
apiVersion: v1
kind: Pod
metadata:
    name: provision-probe
spec:
    restartPolicy: Never
    securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
    containers:
        - name: probe
          image: public.ecr.aws/docker/library/busybox:1.36
          command:
              - sh
              - -c
              - |
                set -e
                id
                mkdir -p /workspaces/org-probe/user-probe
                echo provisioned > /workspaces/org-probe/user-probe/.factory-workspace.json
                ls -ln /workspaces /workspaces/org-probe
                cat /workspaces/org-probe/user-probe/.factory-workspace.json
          volumeMounts:
              - name: workspaces
                mountPath: /workspaces
    volumes:
        - name: workspaces
          persistentVolumeClaim:
              claimName: workspaces-probe
```

Pass: exit 0, `id` reports `uid=1000 gid=1000`, and the `ls -ln` shows the created directories
owned by `1000 1000`. **Failing here with `mkdir: can't create directory … Permission denied` is
the exact bug this spec exists to prevent** — it means the access point's POSIX user did not take.

### Tier 3 — a second pod mounts that member's subPath and writes into it

This is the runner's access pattern, and it must run **on a different node** from the Tier 2 pod to
prove RWX across AZs. Use a `podAntiAffinity` or just pin two pods to different nodes by name.

```yaml
apiVersion: v1
kind: Pod
metadata:
    name: runner-probe
spec:
    restartPolicy: Never
    securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
    containers:
        - name: probe
          image: public.ecr.aws/docker/library/busybox:1.36
          command:
              - sh
              - -c
              - |
                set -e
                test -f /workspaces/org-probe/user-probe/.factory-workspace.json
                echo "runner wrote this" > /workspaces/org-probe/user-probe/runner-output.txt
                cat /workspaces/org-probe/user-probe/runner-output.txt
          volumeMounts:
              - name: workspaces
                mountPath: /workspaces/org-probe/user-probe
                subPath: org-probe/user-probe
    volumes:
        - name: workspaces
          persistentVolumeClaim:
              claimName: workspaces-probe
```

Note the mount shape: the subtree is mounted **at its own full path**
(`mountPath == <root>/<subPath>`), which is the chart's real contract — every path the driver
composes for a job is `<mount>/<org>/<uuid>/…`, so mounting the subtree anywhere else breaks every
consumer path.

Pass: exit 0; the pod reads the file the *other* pod wrote and writes its own beside it. Confirm
the pods landed on different nodes (`kubectl get pods -o wide`); if they did not, the RWX claim is
untested — reschedule.

### Report back

Whoever runs this should report, for the follow-up commit that closes #357:

- the file system id, and the access point's `PosixUser` as AWS reports it;
- the `ls -ln` output from Tier 2 (the ownership is the evidence);
- confirmation that Tier 2 and Tier 3 pods ran on different nodes, and in which AZs;
- anything that had to differ from this spec, and why.

That report is what upgrades `docs/limits.md` in the factory repo from "stated from AWS's
documentation" to observed. The entry currently reads *"The EFS path for the workspaces claim is
mostly stated, not observed"* and names exactly what is missing.

---

## 5. Non-goals

Do not do these as part of this spec — each is its own tracked issue:

- **Installing the Factory chart itself.** This spec validates storage only. A full install
  additionally needs images in ECR (#358) and a public HTTPS origin with an ALB ingress (#359).
  The database blocker is gone — #371 dropped the `timescaledb` extension, so any managed
  PostgreSQL now serves it.
- **Runner resource requests** (#360) and **runner scheduling knobs** (#361). The latter matters
  here only as the reason the single-AZ EBS fallback is not a real option: pinning every pod to one
  AZ needs a nodeSelector on driver-specced pods, which does not exist yet.
- **Touching the `production` cluster.** Everything in this spec targets `internal-utils` only.
- **Adding `fsGroup` to the chart.** See §3.4.

## 6. Cost and teardown

EFS bills per GB-month stored plus throughput; the acceptance run stores kilobytes, so the test
itself is negligible. A real Factory install stores git checkouts — size it against the repos you
expect, not against 20Gi, which is only the claim request.

Teardown, in order — **the order matters**, a pod still mounting the claim holds its delete
forever:

1. Delete the probe pods.
2. Delete the PVC (this deletes the dynamically provisioned access point).
3. Delete the StorageClass if this stays a test.
4. Delete the mount targets, then the file system.
5. Leave or remove the CSI driver addon and its IAM role as you prefer — keeping it costs nothing
   and removes the single largest step if this is revisited.

If any of this becomes permanent, say so, and the factory repo's docs should stop describing it as
a prerequisite an operator must satisfy and start describing it as the environment that exists.
