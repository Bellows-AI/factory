# The `factory` chart

The Factory stack on Kubernetes: the dashboard (API + SPA on one port), the workspaces claim the
checkouts live on, and the driver — whose runners are batch Jobs in the namespace the release is
installed to, selected with `EXECUTOR=kubernetes`. The chart deploys **no database**: `database.url`
names a managed TimescaleDB and is required. Local clusters get one, plus a workspaces claim that
survives an app reinstall, from the separate [`factory-local-state`](../factory-local-state) chart.

For the operator-focused installation and upgrade guide, see the
[Factory documentation](https://bellows-ai.github.io/factory/getting-started/kubernetes/).

Configuration is the repository's usual environment-only contract (`docs/configuration.md`): the
chart is a way to set the containers' environment, not a second config system. Every value maps to
a variable documented in `docs/kubernetes.md`. Half-configured values (github mode without
`auth.publicUrl`, a short `secret.sessionSecret`, no App id outside `dashboard.offline`, …) are
refused at render time by `templates/validate.yaml` rather than crash-looping at boot.

Requires **Kubernetes ≥ 1.30** (the driver's `ValidatingAdmissionPolicy`, see below) and an
installer allowed to create cluster-scoped admission policies. Images default to the chart's
`appVersion` tag (`dashboard.image.tag`, `driver.image.tag`); the collector is pinned.

## What it creates

| Object | Purpose |
| --- | --- |
| `Deployment <release>-factory` | The dashboard. `AUTH_MODE` defaults to `github` here, as compose pins it — this deployment holds checkouts and serves a route that runs shell commands. Exactly one replica, `Recreate`: the server is the single in-process writer of the checkouts and its migrations take no lock. An init container (`pg_isready -d "$DATABASE_URL"`, bounded by `database.waitTimeoutSeconds`) holds the server back until the database accepts connections; the startup and readiness probes read `/api/ready` (503 until the migrations land), liveness reads `/api/health`. |
| `Service <release>-factory` | ClusterIP. The driver reaches the board by this name; people reach it through whatever the operator deliberately puts in front. |
| `Deployment <release>-factory-driver` + the shared `ServiceAccount`/`Role`/`RoleBinding` | The "operator for runners": watches the board and reconciles one runner Job per claimed job. The Role is namespace-scoped and carries only the calls the runner makes — create/delete Jobs (runners, gate runs and the services readout), create/delete the per-attempt env Secret, create/get/delete the per-job checkout-claim ConfigMap that makes the re-claim fence atomic, create/delete/list pods (service fleets; list is discovery), create/delete Services (a service's DNS name), read pod logs. Never a ClusterRole, and never `pods/exec`. The gate endpoint is advertised at the driver pod's own IP (`GATE_ADVERTISE_URL=http://$(POD_IP)`), so more than one driver replica is safe. Liveness is a heartbeat file the driver touches every 10s. |
| `ValidatingAdmissionPolicy <namespace>-<release>-factory-driver-{pods,objects}` + bindings | The fence the Role cannot draw (`isolation.admissionPolicy`). RBAC cannot scope by name, so `create pods` would be `read every Secret` in the namespace — the dashboard's App key included — and `delete secrets` would reach them all. Bound to the driver's ServiceAccount: pod specs may reference only the driver's per-attempt Secrets (`factory-{job,sync,publish,helper,gate}-…-env`), the runner credentials and the chart's pull secrets; no hostPath, host namespaces, privilege or ServiceAccount token; creates and deletes only of objects labelled `factory.job`; Secrets only Opaque, Services only headless. |
| `NetworkPolicy <release>-factory-runners` | Confines every pod this release's driver specs (`isolation.networkPolicy`): ingress only from each other, egress to DNS (port 53 only to the `k8s-app: kube-dns` pods in kube-system and `isolation.dnsCidrs`, default NodeLocal DNSCache's 169.254.20.10/32 — list your resolver there if your cluster DNS carries other labels, or runners lose DNS), this release's dashboard/collector/driver, each other, and anything outside `isolation.blockedCidrs` — the private ranges and the cloud metadata endpoint. Inert without a CNI that enforces NetworkPolicy. |
| `Deployment/Service/ConfigMap <release>-factory-collector` | The OTLP collector. Runner pods export to it over the cluster network — the driver names it in every spec via `RUNNER_OTEL_ENDPOINT` — and it forwards to this release's dashboard ingest route with the same processors the compose collector runs. |
| `Job factory-runner-…` (per job, at runtime) | One runner pod, `restartPolicy: Never`, `backoffLimit: 0` — the cluster never re-runs a job; the board owns retries. `automountServiceAccountToken: false`, so a runner holds no API credentials. The name is `factory-runner-<hash16(id and lease token)>` — the apiserver stamps a Job's name onto its pod template as the `job-name` label, and label values cap at 63 bytes, which the raw id-and-token form exceeds. |
| `PersistentVolumeClaim <release>-factory-workspaces` | The checkouts. The dashboard writes them, every runner mounts the same claim. `ReadWriteMany` by default. Not created when `workspaces.existingClaim` names one — the local profile names the state release's. Annotated `helm.sh/resource-policy: keep`: `helm uninstall` leaves it. |
| `Secret <release>-factory-dashboard` | The dashboard credentials, `database-url` among them (the URL carries the password). With `secret.existingSecret`, that Secret must carry `database-url` and whichever other keys its auth mode needs — every other key is `optional` in the pod specs, and the server names any still missing at boot. |
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

## A local cluster, end to end

With [kind](https://kind.sigs.k8s.io/):

```bash
kind create cluster --name factory

docker build -f docker/Dockerfile --target runtime -t factory-ai .
docker build -f docker/driver.Dockerfile -t factory-driver .
printf 'FROM alpine:3\nENTRYPOINT ["echo"]\n' | docker build -t echo-executor -
docker pull otel/opentelemetry-collector-contrib:0.161.0   # the chart's pin
for image in factory-ai factory-driver echo-executor otel/opentelemetry-collector-contrib:0.161.0; do
    kind load docker-image "$image" --name factory
done

helm install factory-state charts/factory-local-state
helm install dev charts/factory -f charts/factory/values-local.yaml
kubectl wait --for=condition=available deployment/dev-factory --timeout=300s
```

`values-local.yaml` is the offline profile: the dashboard boots the code-only no-fetch entry
(serves whatever the database holds, fetches nothing), `AUTH_MODE=none` + `AUTH_ALLOW_PUBLIC_BIND=1`
— the ClusterIP is the perimeter,
the k8s analogue of the `127.0.0.1` bind every open stack here runs behind — and the stub executor
image, so a queued job runs a real pod and echoes its prompt back. Its `database.url` and
`workspaces.existingClaim` name the `factory-state` release's objects (`factory-state-timescale`,
`factory-state-workspaces`), so that release name is fixed. `make start` does all of the above.

Then:

```bash
kubectl port-forward svc/dev-factory 8080:8080 &

# a task runs only under one of its author's executors — there is no global fallback
curl -s -X PUT localhost:8080/api/workspace/executors -H 'content-type: application/json' \
    -d '{"executors":[{"name":"claude","type":"claude-code","config":{},"isDefault":true}]}'
curl -s -X POST localhost:8080/api/jobs -H 'content-type: application/json' \
    -d '{"command":"hello from the cluster","executor":"claude"}'
# → {"id":"…"}

# the driver claims it, a pod runs the stub image, the board records the result
curl -s localhost:8080/api/jobs/<id>
# → {"status":"succeeded","output":"--session-id … -p hello from the cluster", …}
```

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
