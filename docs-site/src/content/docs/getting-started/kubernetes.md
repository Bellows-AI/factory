---
title: Kubernetes and Helm
description: Install Factory's dashboard, driver, workspaces, runners, and telemetry collector on Kubernetes.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/getting-started/kubernetes.md
---

Kubernetes is Factory's primary executor platform. The `charts/factory` chart creates the
dashboard, driver, shared workspace claim, optional OTEL collector, service accounts, the RBAC
required to launch runner and gate Jobs, and the isolation policies that confine runner pods.

The chart deploys **no database**. Point it at a TimescaleDB you operate: through the
`database-url` key of an existing Secret, or through `database.url` when the chart creates the
Secret.

## Requirements

- Kubernetes **1.30 or newer**. The driver is fenced by a `ValidatingAdmissionPolicy`
  (`isolation.admissionPolicy`, on by default), and the installer must be allowed to create
  cluster-scoped admission policies.
- A CNI that enforces `NetworkPolicy` if you want runner network isolation
  (`isolation.networkPolicy`, on by default). Without one the policy object is inert.
- A storage class that can serve the workspace claim's access mode (`ReadWriteMany` by default).
- A reachable TimescaleDB database.

## Prepare images and credentials

Build and publish the dashboard image, the driver image, and the executor images to a registry the
cluster can pull from. One driver serves both executor types; each task's executor profile chooses
Claude Code or OpenCode per run, so publish both executor images if you use both profile types. For
a private registry, create a pull Secret and list its name in `imagePullSecrets` (a list of Secret
names, not `name:` objects); the chart applies it to
its own pods and forwards it to every runner, gate, and service pod the driver creates.

Create the namespace and secrets before installing the chart:

```bash
kubectl create namespace factory --dry-run=client -o yaml | kubectl apply -f -

kubectl -n factory create secret generic factory-secrets \
  --from-literal=database-url='postgres://<user>:<password>@<host>:5432/<database>' \
  --from-file=github-app-private-key=./factory.private-key.pem \
  --from-literal=github-oauth-client-secret='<oauth-client-secret>' \
  --from-literal=session-secret='<at-least-32-characters>' \
  --from-literal=github-webhook-secret='<at-least-32-characters>' \
  --from-literal=ingest-token='<telemetry-ingest-token>' \
  --from-literal=job-board-token='<at-least-32-characters>'

kubectl -n factory create secret generic factory-runner-credentials \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN='<runner-token>' \
  --from-literal=ANTHROPIC_API_KEY='<runner-api-key>'
```

`database-url` is the one key the pods cannot start without. Do not commit secret values or pass
them through Helm command-line arguments.

## Create production values

```yaml
imagePullSecrets:
  - registry-credentials

dashboard:
  image:
    repository: registry.example.com/factory-ai
    tag: VERSION

auth:
  mode: github
  publicUrl: https://factory.example.com
  cookieSecure: '1'
  oauthClientId: YOUR_OAUTH_CLIENT_ID

github:
  appId: 'YOUR_GITHUB_APP_ID'

secret:
  create: false
  existingSecret: factory-secrets

driver:
  image:
    repository: registry.example.com/factory-driver
    tag: VERSION
  executorImages:
    claudeCode: registry.example.com/claude-executor:VERSION
    opencode: registry.example.com/opencode-executor:VERSION
  imagePullPolicy: IfNotPresent

runner:
  credentialsExistingSecret: factory-runner-credentials
```

With `secret.existingSecret`, the database URL comes from that Secret's `database-url` key. If the
chart creates the Secret instead (`secret.create: true`), set `database.url` and the chart stores it
there. Image tags default to the chart's `appVersion` when left empty.

### Runner network isolation

The runner `NetworkPolicy` blocks egress to private and link-local ranges (`10.0.0.0/8`,
`172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16`), which includes the cloud
metadata endpoint. DNS is allowed only to the `k8s-app: kube-dns` pods and `isolation.dnsCidrs`
(default `169.254.20.10/32`, NodeLocal DNSCache). Adjust these before installing if:

- runners must reach an internal git server or registry mirror: add it as a `/32` to
  `isolation.allowedCidrs`, or trim `isolation.blockedCidrs`;
- your cluster DNS carries other labels or listens elsewhere: list the resolver in
  `isolation.dnsCidrs`, or runners lose DNS.

## Install and verify

```bash
helm upgrade --install factory charts/factory \
  --namespace factory \
  --create-namespace \
  -f values.production.yaml

kubectl -n factory wait --for=condition=available deployment/factory-factory --timeout=300s
kubectl -n factory get pods,jobs,pvc
```

Confirm that `GET /api/ready` returns `200` through the service or ingress. It stays `503` until the
database migrations have applied, which is what the chart's startup and readiness probes wait for;
`GET /api/health` only reports that the process is up. Then complete the
[GitHub authentication setup](/factory/getting-started/github-authentication/).

The workspace claim is mounted by the dashboard and every runner. Its storage class must support the
configured `workspaces.accessModes`; the chart defaults to `ReadWriteMany`. To reuse an
operator-managed claim, set `workspaces.existingClaim`.

## Local evaluation

A local cluster runs as two releases. `charts/factory-local-state` provides a TimescaleDB and a
`ReadWriteOnce` workspace claim for a single node, in its own release so the app can be reinstalled
without losing either. It is local-only and not a production shape. `values-local.yaml` points the
app chart at that release's objects, runs the dashboard offline with `AUTH_MODE=none`, and uses a
stub executor image. With [kind](https://kind.sigs.k8s.io/):

```bash
kind create cluster --name factory

docker build -f docker/Dockerfile --target runtime -t factory-ai .
docker build -f docker/driver.Dockerfile -t factory-driver .
printf 'FROM alpine:3\nENTRYPOINT ["echo"]\n' | docker build -t echo-executor -
docker pull otel/opentelemetry-collector-contrib:0.161.0
for image in factory-ai factory-driver echo-executor otel/opentelemetry-collector-contrib:0.161.0; do
  kind load docker-image "$image" --name factory
done

helm install factory-state charts/factory-local-state
helm install dev charts/factory -f charts/factory/values-local.yaml
kubectl wait --for=condition=available deployment/dev-factory --timeout=300s
```

The state release must be named `factory-state`: `values-local.yaml` refers to
`factory-state-timescale` and `factory-state-workspaces` by name.
