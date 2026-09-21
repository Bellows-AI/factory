---
title: Helm values
description: Reference the supported values for Factory's Kubernetes chart.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/reference/helm-values.md
---

The chart maps values to the same environment contract used by host and Compose deployments.

| Group | Important values |
| --- | --- |
| `dashboard` | `image`, `imagePullPolicy`, `replicas`, `port`, `workspaceRoot`, `resources` |
| `auth` | `mode`, `publicUrl`, `cookieSecure`, `allowPublicBind`, `oauthClientId` |
| `github` | `appId`, `appPrivateKey` |
| `telemetry` | `source`, `ttlSeconds`, `ingestToken` |
| `database` | `url` for an external database |
| `timescale` | `enabled`, image, user, password, database, storage size, resources |
| `workspaces` | storage size, storage class, or `existingClaim` |
| `secret` | create a chart Secret or name an `existingSecret`; OAuth, session, webhook, and board secrets |
| `driver` | image, executor image, CLI, concurrency, polling, lease, timeout, OTLP, services, resources |
| `collector` | enabled, image, pull policy |
| `runner` | forwarded env names, credential Secret, Claude token, Anthropic key |

## External dashboard Secret

When `secret.create: false`, `secret.existingSecret` must contain the keys the dashboard references:

```text
github-app-private-key
github-oauth-client-secret
session-secret
github-webhook-secret
ingest-token
job-board-token
```

The runner credential Secret contains one key for every comma-separated name in `runner.env`. The
default names are `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`.

## Storage and database choices

`workspaces.existingClaim` reuses an operator-managed claim. Otherwise the chart creates one and
defaults to `ReadWriteMany`, because dashboard and runner pods may mount it across nodes.

`timescale.enabled: true` creates an in-chart database. When it is false, `database.url` is required.
Use durable storage and non-default credentials for any environment whose history matters.

See [Kubernetes and Helm](../getting-started/kubernetes.md) for an installation example.
