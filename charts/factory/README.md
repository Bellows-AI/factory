# The `factory` chart

The Factory stack on Kubernetes: dashboard, driver, OTLP collector, and the workspaces claim the
checkouts live on. Values are documented in `values.yaml`; the platform shapes and the variables
each value sets are in [docs/kubernetes.md](../../docs/kubernetes.md).

| Concern | Code | Test |
| --- | --- | --- |
| Every value, with its comment | `values.yaml` | `driver/test/k8s-docs.test.ts` |
| Dashboard, driver, collector | `templates/deployment.yaml`, `templates/driver-deployment.yaml`, `templates/collector.yaml` | `scripts/test-k8s.sh` |
| Refusals at render time | `templates/validate.yaml` | `scripts/test-k8s.sh` |
| Runner RBAC and the admission fence | `templates/driver-rbac.yaml`, `templates/driver-admission.yaml` | `driver/test/k8s-admission.test.ts`, `scripts/test-k8s.sh` |
| Runner egress | `templates/runner-networkpolicy.yaml` | `scripts/test-k8s.sh` |
| Workspaces claim, PDBs, Ingress, Secrets | `templates/pvc.yaml`, `templates/pdb.yaml`, `templates/ingress.yaml`, `templates/secret.yaml` | `scripts/test-k8s.sh` |
| Local-cluster values from `.env` | `scripts/k8s-local-values.mjs`, `values-local.yaml` | `scripts/test-k8s.sh` |

## Invariants

- The chart deploys **no database**. `database.url` is required, or `secret.existingSecret` must
  carry `database-url`. Any managed PostgreSQL 17 works; no extension is needed.
- Requires **Kubernetes ≥ 1.30** and an installer allowed to create cluster-scoped
  `ValidatingAdmissionPolicy` objects (`isolation.admissionPolicy`).
- `AUTH_MODE` is always `github`; the Service is ClusterIP. The port carries the job board, and an
  unauthenticated `POST /api/jobs` is RCE — [docs/security.md](../../docs/security.md). With
  `ingress.enabled`, the render is refused unless `auth.publicUrl`'s host is in `ingress.hosts`.
- Image defaults are bare names for the kind walkthrough. On a remote cluster set
  `global.imageRegistry`; it prefixes every rendered reference, both executor images included, and
  refuses one that already names a registry. `database.waitImage` is the full reference it never
  touches.
- `NetworkPolicy` is inert without a CNI that enforces it — on EKS, the VPC CNI add-on with
  `enableNetworkPolicy: true`, EC2 Linux nodes only ([docs/kubernetes.md](../../docs/kubernetes.md),
  "EKS prerequisites").
- `driver.runnerDoNotDisrupt` (default off) pins a runner's node for the run, up to
  `driver.jobTimeoutMs`. It does not protect against spot interruption or `kubectl drain`.

## The workspaces volume

`workspaces.storageClass` must serve `ReadWriteMany` and a root writable by uid 1000 — neither of
EKS's defaults does. On EKS: install the EFS CSI driver and check its controller pods are running
(a `CSIDriver` object can outlive its install), bind it to an IAM role, create a mount target in
every availability zone the nodes run in, and point `workspaces.storageClass` at a class with
`provisioningMode: efs-ap`, `uid: "1000"`, `gid: "1000"`, `directoryPerms: "0775"`. Without
explicit `uid`/`gid` the access point's identity comes from the driver's allocation range and EFS
enforces it over the client's; the failure is silent. Manifest and reasoning:
[docs/kubernetes.md](../../docs/kubernetes.md#the-workspaces-volume). The chart itself has
**never been installed on EKS** (`docs/limits.md`).

## Commands

```bash
make start                     # kind cluster, build, load, install factory-state + factory
make stop                      # helm uninstall; keeps factory-state and the claim
make reset                     # also uninstalls factory-state and deletes its claims
make cleanup                   # kind delete cluster
npm run test:k8s               # helm lint/template offline; --cluster installs into kind
git tag v1.2.3 && git push origin v1.2.3   # publishes all images (docs/ci.md)
```

The cloud walkthrough — EKS, EFS, a registry prefix, an ALB, a managed database — is
[docs/eks-runbook.md](../../docs/eks-runbook.md).
