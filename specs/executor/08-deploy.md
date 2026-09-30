# 08 — Deployment

**Depends on:** [03-controller](03-controller.md), [05-job-and-runtime](05-job-and-runtime.md),
[04-git-mirror](04-git-mirror.md).
**Blocks:** nothing.

## Scope

Kubernetes manifests, RBAC, network policy, quotas, the compose story for people who are not working
on this, and the one end-to-end test that genuinely needs a cluster.

## Non-goals

Anything about how the controller behaves — that is [03](03-controller.md). This spec is YAML plus one
script.

---

## 1. Layout

The repo has **zero** Kubernetes files today.

```
deploy/k8s/base/namespace.yaml         factory-executor, factory-agent
deploy/k8s/base/rbac.yaml              §2
deploy/k8s/base/controller.yaml        Deployment (replicas: 1) + Service
deploy/k8s/base/mirror-pvc.yaml        RWO, 50Gi
deploy/k8s/base/networkpolicy.yaml     §3
deploy/k8s/base/quota.yaml             ResourceQuota + LimitRange on factory-agent
deploy/k8s/base/kustomization.yaml
deploy/k8s/overlays/local/             k3d; database and collector via the host gateway
deploy/k8s/overlays/prod/
deploy/k8s/secrets.example.yaml        shape only, never real values
executor/scripts/e2e-cluster.sh        §6
```

**Kustomize**, not plain YAML and not Helm. Plain YAML cannot parameterise the image tag without
`sed`; Helm's templating is a second language for a five-manifest deployment, and the two overlays
here differ only in image tag, endpoints and resource sizes.

Secrets (`github-app-key`, `agent-api-keys`, `database-url`) are **not** in the repo.
`secrets.example.yaml` carries the shape, and `docs/executor.md` carries the `kubectl create secret`
lines.

---

## 2. RBAC — the exact verbs

Two ServiceAccounts, and the asymmetry is the point.

**`factory-controller`** (in `factory-executor`), with a **Role in `factory-agent`** — namespaced, so
nothing is cluster-scoped:

| Resource | Verbs | Why |
| --- | --- | --- |
| `jobs` | `create`, `get`, `list`, `watch`, `delete` | the launcher |
| `pods` | `get`, `list`, `watch` | **`OOMKilled` is only visible on the pod, not the Job** — and it is the classification that most changes what the controller does ([03](03-controller.md) §7) |
| `pods/log` | `get` | the fallback capture path ([05](05-job-and-runtime.md) §5) |
| `secrets` | `create`, `delete` | the per-task Secret |

No `secrets: get/list` — the controller writes them and never reads them back.

**`factory-agent`** (in `factory-agent`): **no permissions at all**, and
`automountServiceAccountToken: false` on the pod. A compromised agent must not be able to create more
Jobs, read another task's Secret, or enumerate anything.

---

## 3. NetworkPolicy

On `factory-agent`, default-deny egress, then allow:

| Destination | Why |
| --- | --- |
| the mirror Service in `factory-executor` | `git clone` |
| the controller Service in `factory-executor` | the credential helper and the result POST |
| the OTEL collector | token spend |
| the forge (443) | `git push`, and whatever the invoked command does |
| package registries (443) | the agent runs `npm install` |
| cluster DNS | everything above |

**Denied, explicitly: the database and the Kubernetes API.** The agent has no business reaching
either, and the day one of them is reachable is the day a prompt-injected agent can read every other
task's row.

This is a real constraint on the agent, not a formality: an agent that needs a service not on this
list will fail in a way that looks like a flaky network. Say so in `docs/executor.md`.

---

## 4. Controller Deployment

- `replicas: 1`. **Forced by the RWO mirror PVC**, not by the claim logic — Flag B in
  [00](00-overview.md). The claim is correct for N replicas; a `ReadWriteOnce` volume is what pins it.
  Going multi-replica later means splitting the mirror into its own Deployment.
- `strategy: Recreate`, not `RollingUpdate`. Two controllers briefly sharing an RWO volume is either a
  stuck rollout or, worse, a second writer.
- `terminationGracePeriodSeconds: 30`, matching the SIGTERM drain in [03](03-controller.md) §9.
- Probes: `/readyz` gates on the database being reachable **and** the mirror path being writable;
  `/healthz` does neither — same reasoning as the existing `/api/health`, which "never calls GitHub or
  the database" so the compose healthcheck does not fail during a migration.
- Image `docker/Dockerfile.executor` ([04](04-git-mirror.md) §5) — it needs `git`, which
  `node:24-alpine` does not have.
- Service exposes the mirror and internal routes on a ClusterIP. **Not** an Ingress, and not a
  LoadBalancer. Nothing in this system should be reachable from outside the cluster.

### Mirror PVC

`ReadWriteOnce`, 50Gi. Sizing is a guess that will be wrong for a monorepo; the failure mode is that
every fetch fails and every task fails as `infra`, so **alert on PVC usage** rather than discovering it
through a task backlog. [04](04-git-mirror.md) §3 covers the `gc` policy that keeps it from growing
without bound.

---

## 5. Quota and limits

`ResourceQuota` and `LimitRange` on `factory-agent`.

This is the backstop for a wrong `EXECUTOR_MAX_CONCURRENT`: with a quota, a bug becomes a **rejected
create** that the controller classifies as `infra` and retries with backoff. Without one, it becomes a
cluster outage. Also the backstop for Flag A's cost dimension — an accidentally-open intake endpoint
that spawns pods is a cloud-bill DoS, and the quota is the only thing that bounds it independently of
the application.

`LimitRange` sets a default CPU/memory request so a Job created with none does not schedule as
best-effort and get evicted first.

---

## 6. Where the database and the collector live

The **local overlay** assumes the existing compose stack: PostgreSQL and the OTEL collector stay
where they are, reached from k3d via the host gateway. That keeps `docker compose up` meaningful and
avoids running a database in the dev cluster.

The **prod overlay** points `DATABASE_URL` and `EXECUTOR_OTEL_ENDPOINT` at whatever runs them, and
takes no position on where that is.

### `docker-compose.yml`

The controller joins under `profiles: [executor]` with `RUNNER_BACKEND=local`, so
`docker compose up` is **unchanged** for everyone not working on this, and
`docker compose --profile executor up` gets a working executor with no Kubernetes.

---

## 7. `executor/scripts/e2e-cluster.sh`

Not in CI, not in `npm test`, not in `npm run test:db`. A script an operator runs.

1. `k3d cluster create factory-e2e`
2. Build and `k3d image import` the controller and agent images.
3. `kubectl apply -k deploy/k8s/overlays/local`
4. Wait for `/readyz`.
5. Submit one task through the CLI: clone the seeded repo, make a trivial edit, push.
6. Assert: the branch exists on the forge stub; `agent_task` reads `succeeded`; `head_sha` is
   non-null; `commits` is 1.
7. `k3d cluster delete factory-e2e`.

### What this covers that nothing else can

| Only testable here | Why |
| --- | --- |
| Job admission and RBAC | The verbs in §2 are either sufficient or they are not, and only the API server knows |
| `terminationMessage` really arriving | And `FallbackToLogsOnError` behaving on a crash |
| The pod reaching the collector | Under the NetworkPolicy in §3 |
| The init container reaching the mirror Service | Same |
| The credential helper round-trip | The pod → controller → forge chain |
| `OOMKilled` appearing where `classify.ts` expects it | The fixture in `executor/test/classify.test.ts` is a *claim* about the API's shape |
| The image actually containing both CLIs | Also gated at image-build time by `verify-cli-flags.sh` |

Everything else is covered offline. That is deliberate: `npm test` must stay offline, and a test suite
that needs a cluster is a test suite nobody runs.

---

## 8. Acceptance criteria

- `kubectl apply -k deploy/k8s/overlays/local --dry-run=server` succeeds against a real cluster.
- `kubectl apply -k deploy/k8s/overlays/prod --dry-run=client` succeeds with no cluster.
- `executor/scripts/e2e-cluster.sh` completes, and step 6's assertions hold.
- `docker compose up` (no profile) behaves exactly as before this spec.
- `docker compose --profile executor up` runs a task end to end with `RUNNER_BACKEND=local`.
- **A deliberately over-broad RBAC Role is not shipped**: remove one verb from §2 at a time and
  confirm the e2e fails. If removing a verb changes nothing, it should not be in the Role.

## Files

**Create:** everything in §1.

**Modify:** `docker-compose.yml` (the `executor` profile), `.dockerignore` (exclude `deploy/`,
`specs/` and `executor/test*` from the build context, so the agent image carries no fixtures and no
throwaway RSA test key), `AGENTS.md` (a "Read before you touch" row for `deploy/k8s/*`),
`docs/security.md` (the RBAC and NetworkPolicy posture).
