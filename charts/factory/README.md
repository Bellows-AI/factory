# The `factory` chart

The Factory stack on Kubernetes: the dashboard (API + SPA on one port), the workspaces claim the
checkouts live on, and the driver — whose runners are batch Jobs in the namespace the release is
installed to, selected with `EXECUTOR=kubernetes`. The chart deploys **no database**: `database.url`
is required when the chart creates the Secret, and with `secret.existingSecret` that Secret must
carry `database-url` instead. Either way the URL must, **today**, name a PostgreSQL that can load
the `timescaledb` extension — `server/migrations/001_init.sql` runs `create extension timescaledb`
and makes `metric_point` a hypertable, so RDS and Aurora PostgreSQL reject the first migration. The
extension requirement is decided against and on its way out (issue #356): `metric_point` becomes a
plain declaratively-partitioned table and the extension retires, after which any managed PostgreSQL
serves the chart. Issue #371 is that work — until it lands, read "managed TimescaleDB", not "managed
Postgres". Local clusters get a database, plus a workspaces claim that survives an app reinstall,
from the separate [`factory-local-state`](../factory-local-state) chart.

Configuration is the repository's usual environment-only contract (`docs/configuration.md`): the
chart is a way to set the containers' environment, not a second config system. Every value maps to
a variable documented in `docs/kubernetes.md`. Half-configured values (no `auth.publicUrl`, a
short `secret.sessionSecret`, no App id outside `dashboard.offline`, …) are
refused at render time by `templates/validate.yaml` rather than crash-looping at boot.

Requires **Kubernetes ≥ 1.30** (the driver's `ValidatingAdmissionPolicy`, see below) and an
installer allowed to create cluster-scoped admission policies. Images default to the chart's
`appVersion` tag (`dashboard.image.tag`, `driver.image.tag`); the collector is pinned.

## What it creates

| Object | Purpose |
| --- | --- |
| `Deployment <release>-factory` | The dashboard. `AUTH_MODE` is always `github` — there is no value to change it: this deployment holds checkouts and serves a route that runs shell commands. Exactly one replica, `Recreate`: the server is the single in-process writer of the checkouts and its migrations take no lock. An init container (`pg_isready -d "$DATABASE_URL"`, bounded by `database.waitTimeoutSeconds`) holds the server back until the database accepts connections; the startup and readiness probes read `/api/ready` (503 until the migrations land), liveness reads `/api/health`. |
| `Service <release>-factory` | ClusterIP. The driver reaches the board by this name; people reach it through whatever the operator deliberately puts in front. |
| `Ingress <release>-factory` | Only when `ingress.enabled` (default off). Fronts the dashboard Service; `className`, `annotations`, `hosts` and `tls` pass through verbatim — the annotations are the whole cloud-specific part. See "Exposing the dashboard". |
| `Deployment <release>-factory-driver` + the shared `ServiceAccount`/`Role`/`RoleBinding` | The "operator for runners": watches the board and reconciles one runner Job per claimed job. The Role is namespace-scoped and carries only the calls the runner makes — create/delete Jobs (runners, gate runs and the services readout), create/delete the per-attempt env Secret, create/get/delete the per-job checkout-claim ConfigMap that makes the re-claim fence atomic, create/delete/list pods (service fleets; list is discovery), create/delete Services (a service's DNS name), read pod logs. Never a ClusterRole, and never `pods/exec`. The driver also runs the **orphan reaper** (`driver.reapIntervalMs` / `driver.reapGraceMs`, issue #301): a periodic sweep of service objects whose owning job is terminal, board-unknown, or running under another lease — no new verbs needed, the grants above already cover it. The gate endpoint is advertised at the driver pod's own IP (`GATE_ADVERTISE_URL=http://$(POD_IP)`), so more than one driver replica is safe. Liveness is a heartbeat file the driver touches every 10s. |
| `ValidatingAdmissionPolicy <namespace>-<release>-factory-driver-{pods,objects}` + bindings | The fence the Role cannot draw (`isolation.admissionPolicy`). RBAC cannot scope by name, so `create pods` would be `read every Secret` in the namespace — the dashboard's App key included — and `delete secrets` would reach them all. Bound to the driver's ServiceAccount: pod specs may reference only the driver's per-attempt Secrets (`factory-{job,sync,publish,helper,gate}-…-env`), the runner credentials and the chart's pull secrets; no hostPath, host namespaces, privilege or ServiceAccount token; creates and deletes only of objects labelled `factory.job`; Secrets only Opaque, Services only headless. |
| `NetworkPolicy <release>-factory-runners` | Confines every pod this release's driver specs (`isolation.networkPolicy`): ingress only from each other, egress to DNS (port 53 only to the `k8s-app: kube-dns` pods in kube-system and `isolation.dnsCidrs`, default NodeLocal DNSCache's 169.254.20.10/32 — list your resolver there if your cluster DNS carries other labels, or runners lose DNS), this release's dashboard/collector/driver, each other, and anything outside `isolation.blockedCidrs` — the private ranges and the cloud metadata endpoint. Inert without a CNI that enforces NetworkPolicy. |
| `Deployment/Service/ConfigMap <release>-factory-collector` | The OTLP collector. Runner pods export to it over the cluster network — the driver names it in every spec via `RUNNER_OTEL_ENDPOINT` — and it forwards to this release's dashboard ingest route with the same processors the compose collector runs. |
| `Job factory-runner-…` (per job, at runtime) | One runner pod, `restartPolicy: Never`, `backoffLimit: 0` — the cluster never re-runs a job; the board owns retries. `automountServiceAccountToken: false`, so a runner holds no API credentials. The name is `factory-runner-<hash16(id and lease token)>` — the apiserver stamps a Job's name onto its pod template as the `job-name` label, and label values cap at 63 bytes, which the raw id-and-token form exceeds. |
| `PersistentVolumeClaim <release>-factory-workspaces` | The checkouts. The dashboard writes them, every runner mounts the same claim. `ReadWriteMany` by default. Not created when `workspaces.existingClaim` names one — the local profile names the state release's. Annotated `helm.sh/resource-policy: keep`: `helm uninstall` leaves it. The class behind it must serve RWX and a root writable by uid 1000, which EKS's default is documented not to — see [The workspaces volume](#the-workspaces-volume) before installing. |
| `Secret <release>-factory-dashboard` | The dashboard credentials, `database-url` among them (the URL carries the password). With `secret.existingSecret`, that Secret must carry `database-url` and `job-board-token` (both required in the pod specs) plus the auth and App keys — those are `optional` in the dashboard's pod spec, and the server names any still missing at boot. |
| `Secret <release>-factory-runner-credentials` | One key per `runner.env` name, valued from `runner.credentials`. Not created when `runner.credentialsExistingSecret` names one. |

Credentials travel by reference only: the pod specs carry `valueFrom.secretKeyRef`, so nothing
readable appears in `kubectl get pods -o yaml` — the k8s form of the driver passing `-e NAME`
rather than `-e NAME=value`. The runner pod additionally gets **no ServiceAccount token**: a
Claude container holding the driver's job-creating identity would be the docker socket riding
along with the dashboard, refused for the same reason.

Every chart pod runs as non-root on a read-only root filesystem with all capabilities dropped and
the `RuntimeDefault` seccomp profile; only the driver mounts a ServiceAccount token. A changed
chart Secret or collector config rolls the pods that read it (`checksum/*` annotations).
`imagePullSecrets`, `nodeSelector`, `tolerations`, `affinity` and `podAnnotations` apply to every
chart pod; `imagePullSecrets` is also forwarded to every pod the driver specs.

## The workspaces volume

The chart provisions the claim; it cannot provision what the claim needs from the cluster. Two
requirements, both defaulted for a kind cluster and met by neither of EKS's defaults. **Every
AWS-side statement below comes from AWS's documentation and has not been observed on a real EKS
cluster from this repository** — they are prerequisites to satisfy, not a run that was watched
(`docs/limits.md`):

- **`ReadWriteMany`.** The dashboard mounts the volume root and every pod the driver specs mounts
  the same claim at its own `subPath`, from whichever node it landed on. `workspaces.storageClass`
  is empty by default, meaning the cluster's default class — on EKS that is single-AZ
  `ReadWriteOnce` EBS, so the claim never binds and the dashboard sits `Pending`.
- **Writable by uid 1000.** Every pod that touches the volume runs as uid/gid 1000 and nothing
  sets `fsGroup`, which on EFS would not help anyway — only the access point's POSIX user does,
  and a dynamically provisioned one defaults to `root:root 0700`. The failure is silent: sign-in
  succeeds, the member tree is never created, and runner pods hang in `ContainerCreating`.

On EKS: install the EFS CSI driver (its controller needs IRSA), create a file system with a mount
target in every node subnet, and point `workspaces.storageClass` at a `StorageClass` with
`provisioningMode: efs-ap`, `uid: "1000"`, `gid: "1000"`, `directoryPerms: "0775"`. The manifest,
the single-AZ EBS fallback and why that fallback is not reachable yet are in
[The workspaces volume](../../docs/kubernetes.md#the-workspaces-volume).

## Exposing the dashboard

The Service is ClusterIP on purpose and stays that way: the port carries the job board, and an
unauthenticated `POST /api/jobs` is remote code execution (docs/security.md). `ingress.enabled`
(default off) is the deliberate act of putting something in front — the chart renders one Ingress
fronting the dashboard Service, with `className`, `annotations`, `hosts` and `tls` passed through
verbatim: the annotations are the whole cloud-specific part, so none of it is chart fields. When
enabled, the render is refused unless the host of `auth.publicUrl` is among `ingress.hosts` —
GitHub redirects to `auth.publicUrl`, and an origin the Ingress does not answer is a sign-in that
never comes back.

On EKS (AWS Load Balancer Controller installed; the ACM certificate and the Route53 record to the
ALB's DNS name are outside the chart):

```yaml
ingress:
    enabled: true
    className: alb
    hosts:
        - factory.example.com
    annotations:
        alb.ingress.kubernetes.io/scheme: internet-facing
        alb.ingress.kubernetes.io/target-type: ip
        alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:eu-west-1:…:certificate/…
        alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80},{"HTTPS":443}]'
        alb.ingress.kubernetes.io/ssl-redirect: '443'
        alb.ingress.kubernetes.io/healthcheck-path: /api/health
auth:
    publicUrl: https://factory.example.com
    cookieSecure: 'true'
```

`listen-ports` opens an HTTP listener so `ssl-redirect` has something to redirect — with only
`{"HTTPS":443}` declared, plain `http://` fails to connect instead of redirecting to https.
`target-type: ip` routes to pod IPs on `dashboard.port`, so no NodePort is published anywhere;
`/api/health` touches no database. `auth.publicUrl` must name the origin as the controller
actually serves it — with this ALB set, `https://factory.example.com`, no port. For an in-cluster
controller (nginx and friends) drop the `alb.*` annotations and name the certificate's Secret in
`tls` instead.

## A local cluster, end to end

With [kind](https://kind.sigs.k8s.io/):

```bash
kind create cluster --name factory

docker build -f docker/Dockerfile --target runtime -t factory-ai .
docker build -f docker/driver.Dockerfile -t factory-driver .
make runners   # claude-executor, opencode-executor
docker pull otel/opentelemetry-collector-contrib:0.161.0   # the chart's pin
for image in factory-ai factory-driver claude-executor opencode-executor otel/opentelemetry-collector-contrib:0.161.0; do
    kind load docker-image "$image" --name factory
done

helm install factory-state charts/factory-local-state
node scripts/k8s-local-values.mjs | helm install dev charts/factory -f charts/factory/values-local.yaml -f -
kubectl wait --for=condition=available deployment/dev-factory --timeout=300s
kubectl port-forward svc/dev-factory 8081:8080
```

The chart always runs GitHub sign-in, locally too. `values-local.yaml` carries no credential: the
App, the OAuth client, the session secret, the board token and — when set — the model credential
(`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) come from the repo-root `.env`, which
`scripts/k8s-local-values.mjs` renders as a values document on stdout (it names any required value
missing). The origin is `K8S_PUBLIC_URL`, default `http://127.0.0.1:8081` — the forward above.
The executors are the real runner images, so a queued job runs the agent in a pod. Its
`database.url` and `workspaces.existingClaim` name the `factory-state` release's objects
(`factory-state-timescale`, `factory-state-workspaces`), so that release name is fixed.
`make start` does all of the above.

Then open `http://127.0.0.1:8081`, sign in with GitHub, add an executor on the workspace page — a
task runs only under one of its author's executors, there is no global fallback — and queue a
task. The driver claims it, a pod runs the runner image, the board records the result.

`scripts/test-k8s.sh` runs the same walkthrough as assertions (`npm run test:k8s`), plus
`helm lint`/`helm template` checks that do not need a cluster at all. Its cluster phase runs
against kind and refuses any other kubectl context.

## Uninstall

`helm uninstall dev` (`make stop`) removes the app (a chart-created workspaces claim is kept —
delete it by hand to reclaim the space) and leaves the `factory-state` release — the
database and the checkouts — so the next install picks up where it left off. Runner Jobs are the
driver's, not the release's; `make stop` deletes those too. `make reset` also uninstalls
`factory-state` and deletes its claims, runner Jobs first: a runner pod still mounting the
workspaces claim would hold its delete forever. `kind delete cluster --name factory`
(`make cleanup`) removes the cluster itself.
