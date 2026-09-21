---
title: Kubernetes and Helm
description: Install Factory's dashboard, driver, workspaces, runners, and telemetry collector on Kubernetes.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/getting-started/kubernetes.md
---

Kubernetes is Factory's primary executor platform. The chart creates the dashboard, driver, shared
workspace claim, optional TimescaleDB, optional OTEL collector, service accounts, and the RBAC required
to launch runner and gate Jobs.

## Prepare images and credentials

Build and publish the dashboard, driver, and chosen executor image to a registry reachable by the
cluster. Create the namespace and secrets before installing the chart:

```bash
kubectl create namespace factory --dry-run=client -o yaml | kubectl apply -f -

kubectl -n factory create secret generic factory-secrets \
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

Do not commit secret values or pass them through Helm command-line arguments.

## Create production values

```yaml
dashboard:
  image: registry.example.com/factory-ai:VERSION

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
  image: registry.example.com/factory-driver:VERSION
  executorImage: registry.example.com/claude-executor:VERSION
  imagePullPolicy: IfNotPresent

runner:
  credentialsExistingSecret: factory-runner-credentials
```

For a real deployment, either provision durable TimescaleDB storage deliberately or set
`timescale.enabled: false` and configure `database.url` for an operator-managed database. The default
in-chart database credentials are suitable only for local evaluation.

## Install and verify

```bash
helm upgrade --install factory charts/factory \
  --namespace factory \
  --create-namespace \
  -f values.production.yaml

kubectl -n factory wait --for=condition=available deployment/factory-factory --timeout=300s
kubectl -n factory get pods,jobs,pvc
```

Confirm that `GET /api/health` returns `{"status":"ok", ...}` through the service or ingress. Then
complete the [GitHub authentication setup](./github-authentication.md).

The workspace claim is mounted by the dashboard and every runner. Its storage class must support the
configured access mode; the chart defaults to `ReadWriteMany`, while `values-local.yaml` selects
`ReadWriteOnce` for a single-node local cluster.
