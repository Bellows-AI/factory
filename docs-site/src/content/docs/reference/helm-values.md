---
title: Helm values
description: Reference the supported values for Factory's Kubernetes chart.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/reference/helm-values.md
---

The chart maps values to the same environment contract used by host and Compose deployments.

| Group | Important values |
| --- | --- |
| top level | `imagePullSecrets` (also forwarded to every runner, gate, and service pod), `nodeSelector`, `tolerations`, `affinity`, `podAnnotations` |
| `dashboard` | `image.repository`, `image.tag`, `imagePullPolicy`, `port`, `workspaceRoot`, `offline`, `resources` |
| `auth` | `mode`, `publicUrl`, `cookieSecure`, `allowPublicBind`, `oauthClientId` |
| `github` | `appId`, `appPrivateKey` |
| `telemetry` | `source`, `ttlSeconds`, `ingestToken` |
| `database` | `url` (required when the chart creates the Secret), `waitImage`, `waitTimeoutSeconds` |
| `workspaces` | `storageSize`, `accessModes`, `storageClass`, `existingClaim` |
| `secret` | create a chart Secret or name an `existingSecret`; OAuth, session, webhook, and board secrets |
| `driver` | `image.repository`, `image.tag`, `imagePullPolicy`, `replicas`, `executorImages.claudeCode`, `executorImages.opencode`, `concurrency`, `pollMs`, `leaseSeconds`, `jobTimeoutMs`, `terminationGracePeriodSeconds`, `skipPermissions`, `runnerOtelEndpoint`, `services`, `resources` |
| `collector` | `enabled`, `image`, `imagePullPolicy`, `resources` |
| `isolation` | `admissionPolicy`, `networkPolicy`, `dnsCidrs`, `blockedCidrs`, `allowedCidrs` |
| `runner` | `env` (forwarded names), `credentialsExistingSecret`, `credentials` |

Image tags left empty default to the chart's `appVersion`. The dashboard always runs one replica.
`driver.executorImages` are full image references; each task's executor profile selects which one
a run uses.

## Render-time validation

`secret.create: false` without a `secret.existingSecret` is refused, and `auth.mode` must be
`github` or `none`.

`auth.mode` defaults to `github`. In that mode the chart refuses to render without `auth.publicUrl`
and `auth.oauthClientId`, and, when it creates the Secret, without `secret.oauthClientSecret`, a
`secret.sessionSecret` of at least 32 characters, and a `secret.jobBoardToken` of at least 32
characters. Unless `dashboard.offline` is true, `github.appId` is required, plus
`github.appPrivateKey` when the chart creates the Secret. `auth.mode: none` requires
`auth.allowPublicBind: '1'`.

## External dashboard Secret

When `secret.create: false`, `secret.existingSecret` must contain `database-url`; the pods cannot
start without it. The other keys are optional in the pod spec, so include those your auth mode
needs and the server names any it still misses at startup:

```text
database-url
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
defaults `workspaces.accessModes` to `ReadWriteMany`, because dashboard and runner pods may mount it
across nodes.

The chart deploys no database. `database.url` (or the `database-url` key of an existing Secret)
must point at a TimescaleDB you operate. An init container runs `pg_isready` with
`database.waitImage` and holds the dashboard back for up to `database.waitTimeoutSeconds` until the
database accepts connections. For local clusters, the separate `charts/factory-local-state` chart
provides a throwaway TimescaleDB and a `ReadWriteOnce` workspace claim; it is not a production
shape.

## Runner isolation

`isolation.admissionPolicy` installs a `ValidatingAdmissionPolicy` that limits what the driver may
create and delete, and needs Kubernetes 1.30 or newer. `isolation.networkPolicy` confines runner
pods: egress to `isolation.blockedCidrs` (private and link-local ranges by default) is denied
unless listed in `isolation.allowedCidrs`, and DNS is allowed only to kube-dns and
`isolation.dnsCidrs`. The policy needs a CNI that enforces `NetworkPolicy`.

See [Kubernetes and Helm](/factory/getting-started/kubernetes/) for an installation example.
