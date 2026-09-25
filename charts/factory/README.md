# The `factory` chart

The Factory stack on Kubernetes: the dashboard (API + SPA on one port), the workspaces claim the
checkouts live on, and the driver — whose runners are batch Jobs in the namespace the release is
installed to, selected with `EXECUTOR=kubernetes`. The chart deploys **no database**: `database.url`
names a managed TimescaleDB and is required. Local clusters get one, plus a workspaces claim that
survives an app reinstall, from the separate [`factory-local-state`](../factory-local-state) chart.

Configuration is the repository's usual environment-only contract (`docs/configuration.md`): the
chart is a way to set the containers' environment, not a second config system. Every value maps to
a variable documented in `docs/kubernetes.md`.

## What it creates

| Object | Purpose |
| --- | --- |
| `Deployment <release>-factory` | The dashboard. `AUTH_MODE` defaults to `github` here, as compose pins it — this deployment holds checkouts and serves a route that runs shell commands. An init container (`pg_isready -d "$DATABASE_URL"`) holds the server back until the database accepts connections. |
| `Service <release>-factory` | ClusterIP. The driver reaches the board by this name; people reach it through whatever the operator deliberately puts in front. |
| `Service <release>-factory-driver` | Headless. The runner's DNS name for the driver — the ad-hoc gate endpoint binds an ephemeral port, and a headless Service resolves straight to the pod, so `GATE_ADVERTISE_URL` plus the bound port is the whole URL. |
| `Deployment <release>-factory-driver` + the shared `ServiceAccount`/`Role`/`RoleBinding` | The "operator for runners": watches the board and reconciles one runner Job per claimed job. The Role is namespace-scoped and carries only the calls the runner makes — create/delete Jobs (runners, gate runs and the services readout), create/delete the per-attempt env Secret, create/get/delete the per-job checkout-claim ConfigMap that makes the re-claim fence atomic, create/delete/list pods (service fleets; list is discovery), create/delete Services (a service's DNS name), read pod logs. Never a ClusterRole, and never `pods/exec`. |
| `Deployment/Service/ConfigMap <release>-factory-collector` | The OTLP collector. Runner pods export to it over the cluster network — the driver names it in every spec via `RUNNER_OTEL_ENDPOINT` — and it forwards to this release's dashboard ingest route with the same processors the compose collector runs. |
| `Job factory-runner-…` (per job, at runtime) | One runner pod, `restartPolicy: Never`, `backoffLimit: 0` — the cluster never re-runs a job; the board owns retries. `automountServiceAccountToken: false`, so a runner holds no API credentials. The name is `factory-runner-<hash16(id and lease token)>` — the apiserver stamps a Job's name onto its pod template as the `job-name` label, and label values cap at 63 bytes, which the raw id-and-token form exceeds. |
| `PersistentVolumeClaim <release>-factory-workspaces` | The checkouts. The dashboard writes them, every runner mounts the same claim. `ReadWriteMany` by default. Not created when `workspaces.existingClaim` names one — the local profile names the state release's. |
| `Secret <release>-factory-dashboard` | The dashboard credentials, `database-url` among them (the URL carries the password). With `secret.existingSecret`, that Secret must carry the same keys. |

Credentials travel by reference only: the pod specs carry `valueFrom.secretKeyRef`, so nothing
readable appears in `kubectl get pods -o yaml` — the k8s form of the driver passing `-e NAME`
rather than `-e NAME=value`. The runner pod additionally gets **no ServiceAccount token**: a
Claude container holding the driver's job-creating identity would be the docker socket riding
along with the dashboard, refused for the same reason.

## A local cluster, end to end

With [kind](https://kind.sigs.k8s.io/):

```bash
kind create cluster --name factory

docker build -f docker/Dockerfile --target runtime -t factory-ai .
docker build -f docker/driver.Dockerfile -t factory-driver .
printf 'FROM alpine:3\nENTRYPOINT ["echo"]\n' | docker build -t echo-executor -
kind load docker-image factory-ai --name factory
kind load docker-image factory-driver --name factory
kind load docker-image echo-executor --name factory

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

`helm uninstall dev` (`make stop`) removes the app and leaves the `factory-state` release — the
database and the checkouts — so the next install picks up where it left off. Runner Jobs are the
driver's, not the release's; `make stop` deletes those too. `make reset` also uninstalls
`factory-state` and deletes its claims, runner Jobs first: a runner pod still mounting the
workspaces claim would hold its delete forever. `kind delete cluster --name factory`
(`make cleanup`) removes the cluster itself.
