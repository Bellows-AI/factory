---
title: Security
description: Understand Factory's authentication modes, credentials, runner authority, and deployment boundaries.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/operations/security.md
---

## Authentication modes

`AUTH_MODE=github` requires a signed-in member for protected API routes. `AUTH_MODE=none` leaves every
route open to anyone who can reach the port, including task creation, which ultimately runs commands in
a repository. Factory refuses a non-loopback unauthenticated bind unless
`AUTH_ALLOW_PUBLIC_BIND=1` is explicitly set.

The SPA document and assets remain open so an unauthenticated browser can render the sign-in screen.
`/api/health`, `/api/ready`, and `/api/auth/*` are also outside the session wall. The GitHub webhook
route authenticates itself with an HMAC signature over the request body, and it exists only when
`GITHUB_WEBHOOK_SECRET` is configured.

## Credential classes

- Session cookies and `fat_` personal tokens act as a person.
- `oat_` organization tokens are read-only and do not name a person.
- `JOB_BOARD_TOKEN` authenticates the driver on worker routes.
- `INGEST_TOKEN`, when set, authenticates OTLP writes through the `X-Factory-Ingest-Token` header. It
  proves only that the caller holds the shared secret; it does not bind a write to an organization.
- A runner's branch samples are authenticated by its job ID plus lease token, sent in the
  `x-factory-job-id` and `x-factory-job-lease-token` headers. A member's `fat_` token is also
  accepted on that route (the laptop plugin uses it). In `AUTH_MODE=github`, `INGEST_TOKEN` does not
  authorize branch samples, because a shared secret cannot tie a report to an organization.

Do not interchange these credentials. Their separation preserves authorship and prevents a member from
claiming worker leases or a driver from creating unattributed tasks.

## Protect high-impact secrets

The GitHub App private key can mint installation tokens until the key is revoked. Keep it in a secret
manager or Kubernetes Secret, exclude it from images and source control, and rotate it immediately after
suspected exposure. Treat `SESSION_SECRET`, OAuth client secret, webhook secret, board token,
`INGEST_TOKEN`, runner tokens, and database credentials the same way.

Runner secrets are write-only in the UI but stored as plaintext in PostgreSQL. Anyone who can read the
database or its backups can read every runner credential. When a task runs, the claim environment,
which includes those secrets and a freshly minted `GITHUB_TOKEN`, is handed to the runner:

- On Docker, the driver writes it to a `0600` `--env-file` around the container spawn.
- On Kubernetes, the driver writes it to a per-attempt Secret (`factory-job-…-env` and similar) that
  lives for the attempt. Anyone who can read Secrets in the namespace can read these values while the
  attempt runs.

An agent can always read its own environment inside the runner.

## Keep prompt and code logging off

Keep `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, and `OTEL_LOG_TOOL_DETAILS` set to `0`
in the agent's settings. Enabling them puts prompt text and source code into OTLP log record bodies.
Factory currently discards logs at its ingest route, but the bundled collector configuration still
has a logs pipeline that forwards them, so that content leaves the agent's machine.

## Runner authority

Authentication is not a sandbox. Any organization member who can queue a task can cause an executor to
work against their checkout with the credentials injected into that runner. Keep membership narrow,
limit runner credentials, use gates, and avoid `RUNNER_SKIP_PERMISSIONS` unless its effect is understood.

Each runner mounts only its member's `<org>/<user id>` subtree of the workspace storage, not the
workspace root.

### Docker

The Docker driver mounts `/var/run/docker.sock`, which is root-equivalent on the Docker host. Run that
stack only on a dedicated machine. Docker runners have no egress restriction: they can reach anything
the Docker network can reach, including other hosts on your private network and cloud metadata
endpoints.

### Kubernetes

The driver runs under a namespace-scoped Role, not a ClusterRole. That Role grants create, get, delete,
and list on Jobs; create and delete on Secrets; create, get, and delete on ConfigMaps; create, delete,
and list on Pods and Services; get on `pods/log`; and get on `metrics.k8s.io` pods. It grants no
`pods/exec` and no `get` on Secrets.

The Role alone is not a fence. Kubernetes RBAC cannot scope a verb to a name prefix, so `delete` on
Secrets reaches every Secret in the namespace, and a pod the driver creates could mount any Secret in
the namespace, including the dashboard's GitHub App private key.

The fence is a pair of ValidatingAdmissionPolicies bound to the driver's ServiceAccount
(`isolation.admissionPolicy`, on by default, Kubernetes 1.30 or later). They admit only pod and Job
specs that:

- reference Secrets that are the driver's own per-attempt Secrets or the runner credential Secret
  (plus the chart's image pull secrets under `imagePullSecrets`);
- use only the workspaces claim, `emptyDir`, and such Secrets as volumes, with no `hostPath`, other
  claim, projected ServiceAccount token, or CSI volume;
- mount the workspaces claim only with a `<org>/<user id>` subPath;
- use no ServiceAccount token, host namespaces, privileged mode, or added capabilities.

They also let the driver create and delete only objects labelled `factory.job`, create only Opaque
Secrets under the per-attempt names, and create only headless Services.

If you turn the admission policy off, the driver's effective authority is the full Role described
above. Limits that remain with the policy on:

- Per-attempt Secret names do not carry the release name. Install one Factory release per namespace,
  or one release's driver can reach the other's per-attempt objects.
- The workspace subPath is checked by shape, not by owner. A compromised driver can still name another
  member's `<org>/<user id>` subtree.
- A mutating sidecar injector (for example a service mesh) adds volumes the policy refuses. Exclude
  the namespace from injection.
- The policies govern create and delete only. Reads stay as broad as the Role: the driver can `get`
  any ConfigMap and any pod's logs in the namespace, the dashboard's included. Keep secrets out of
  ConfigMaps and logs in that namespace.
- Seccomp, AppArmor, and sysctls are left to Pod Security Admission. Label the namespace
  `pod-security.kubernetes.io/enforce: baseline` for those.

### Runner network policy (Kubernetes only)

With `isolation.networkPolicy` (on by default), the chart applies a NetworkPolicy to every runner,
gate, auxiliary, and service pod the driver creates:

- **Ingress** only from other runner pods of the same release (for declared services).
- **Egress** only to DNS on port 53 (the `k8s-app: kube-dns` pods in `kube-system` and
  `isolation.dnsCidrs`), this release's dashboard, collector, and driver, other runner pods of the
  release, `isolation.allowedCidrs`, and any address outside `isolation.blockedCidrs`.

The default `blockedCidrs` are `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, and
`169.254.0.0/16`. That blocks the cluster's pod and service networks, private-address databases, and the
cloud metadata endpoint at `169.254.169.254`. Add a private host a run legitimately needs to
`allowedCidrs` as a `/32`, or trim `blockedCidrs`.

The policy has no effect unless the cluster's CNI enforces NetworkPolicy. It covers IPv4 only; an
IPv6-only cluster must add its own policy.

## Network exposure

Terminate TLS before any non-local deployment, set `COOKIE_SECURE=1`, keep the board and collector on
private networks, and do not expose PostgreSQL or OTLP receivers without network controls.
