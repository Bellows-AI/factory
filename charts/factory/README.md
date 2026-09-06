# The `factory` chart

The Factory stack on Kubernetes: the dashboard (API + SPA on one port), an in-chart TimescaleDB,
the workspaces claim the checkouts live on, and the driver — whose runners are batch Jobs in the
namespace the release is installed to, selected with `EXECUTOR=kubernetes`.

Configuration is the repository's usual environment-only contract (`docs/configuration.md`): the
chart is a way to set the containers' environment, not a second config system. Every value maps to
a variable documented in `docs/kubernetes.md`.

## What it creates

| Object | Purpose |
| --- | --- |
| `Deployment <release>-factory` | The dashboard. `AUTH_MODE` defaults to `github` here, as compose pins it — this deployment holds checkouts and serves a route that runs shell commands. |
| `Service <release>-factory` | ClusterIP. The driver reaches the board by this name; people reach it through whatever the operator deliberately puts in front. |
| `Deployment <release>-factory-driver` + `ServiceAccount` + `Role`/`RoleBinding` | The "operator for runners": watches the board and reconciles one runner Job per claimed job. The Role is namespace-scoped and carries only the four calls the runner makes — create/delete Jobs, read pods, read pod logs. Never a ClusterRole. |
| `Job <release>-factory-job-…` (per job, at runtime) | One runner pod, `restartPolicy: Never`, `backoffLimit: 0` — the cluster never re-runs a job; the board owns retries. `automountServiceAccountToken: false`, so a runner holds no API credentials. |
| `PersistentVolumeClaim <release>-factory-workspaces` | The checkouts. The dashboard writes them, every runner mounts the same claim. `ReadWriteMany` by default; single-node clusters override `ReadWriteOnce`. |
| `Deployment/Service/PVC <release>-factory-timescale` | The in-chart database — `timescale.enabled=false` plus `database.url` for a managed one. |

Credentials travel by reference only: the pod specs carry `valueFrom.secretKeyRef`, so nothing
readable appears in `kubectl get pods -o yaml` — the k8s form of the driver passing `-e NAME`
rather than `-e NAME=value`. The runner pod additionally gets **no ServiceAccount token**: a
Claude container holding the driver's job-creating identity would be the docker socket riding
along with the dashboard, refused for the same reason.

## Minikube, end to end

```bash
minikube start

docker build -f docker/Dockerfile --target runtime -t factory-ai .
docker build -f docker/driver.Dockerfile -t factory-driver .
printf 'FROM alpine:3\nENTRYPOINT ["echo"]\n' | docker build -t echo-executor -
minikube image load factory-ai factory-driver echo-executor

helm install dev charts/factory -f charts/factory/values-minikube.yaml
kubectl wait --for=condition=available deployment/dev-factory --timeout=300s
```

`values-minikube.yaml` is the offline profile: `GITHUB_MODE=none` (serves whatever the database
holds, fetches nothing), `AUTH_MODE=none` + `AUTH_ALLOW_PUBLIC_BIND=1` — the ClusterIP is the
perimeter, the k8s analogue of the `127.0.0.1` bind every open stack here runs behind — and the
stub executor image, so a queued job runs a real pod and echoes its prompt back.

Then:

```bash
kubectl port-forward svc/dev-factory 8080:8080 &

curl -s -X POST localhost:8080/api/jobs -H 'content-type: application/json' \
    -d '{"command":"hello from minikube"}'
# → {"id":"…"}

# the driver claims it, a pod runs the stub image, the board records the result
curl -s localhost:8080/api/jobs/<id>
# → {"status":"succeeded","output":"--session-id … -p hello from minikube", …}
```

`scripts/test-k8s.sh` runs the same walkthrough as assertions (`npm run test:k8s`), plus
`helm lint`/`helm template` checks that do not need a cluster at all.

## Uninstall

`helm uninstall dev` removes everything the release created, including both claims — and the
checkouts and history on them. The claims are deliberately not annotated to survive; a dev install
is disposable by construction.
