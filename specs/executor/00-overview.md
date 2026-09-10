# 00 — Kubernetes agent executor: overview

Read this before any other spec in `specs/executor/`. It holds the context, the architecture, the
four decisions every other spec inherits, the cross-workspace wiring, and the list of things that
will bite. The other eight specs are independently implementable; this one is not implementable at
all, it is the shared premise.

## Context

This repo measures AI-assisted engineering output: it pulls PRs from a forge, ingests Claude Code
OTEL telemetry, and reports metrics. Everything it knows is *observed after the fact* — a human ran
an agent on their laptop, and the dashboard counted the result.

The executor adds the missing half: a way to **originate** agent work. An operator submits a text
prompt (or a slash command / skill name) against a configured repo; a controller running in
Kubernetes launches `claude-code` or `opencode` as a Job on a fresh checkout; the agent does the work
and pushes; the resulting PR flows back into the existing measurement pipeline, and the pod's token
spend lands in `metric_point` on the path the dashboard already ingests.

Intended outcome: the dashboard stops being read-only. Same data model, same telemetry path, same org
partitioning — one new workspace and one new migration.

The dangerous part, stated plainly: **this introduces a route that executes arbitrary model-chosen
shell commands on a machine holding git push credentials, in a codebase whose entire security posture
is "we bind to 127.0.0.1".** [06](06-api-and-auth.md) §Auth is not optional.

## Architecture

```
operator ──POST /api/tasks──> server (Fastify)  ──insert──> agent_task (queued)
                                                                 │ poll
                                                                 v
                                                    executor controller (Deployment, replicas: 1)
                                                      │  RWO PVC /mirror/<owner>-<repo>.git
                                                      │  git fetch upstream
                                                      │  git-http-backend on ClusterIP :8081
                                                      │
                                                      └──create Job──> agent pod (ns factory-agent)
                                                                        init: git clone http://mirror/... /work
                                                                        main: claude -p / opencode run
                                                                        push ──> real forge (short-lived token)
                                                                        OTEL ──> existing collector ──> metric_point
```

## The four shaping decisions

1. **Task state is in TimescaleDB, not in Kubernetes.** No CRDs, no operator framework. Jobs are
   plain `batch/v1`, and the DB row is the source of truth. Kubernetes is a process launcher.
   *Rejected:* a Task CRD with a reconcile loop — it duplicates state the database already holds and
   makes `kubectl` and the dashboard two disagreeing sources of truth.
2. **The controller serves git over HTTP.** It owns a bare mirror on its own RWO volume and pods
   clone from it. No RWX PVC, no MinIO, no shared filesystem — so this runs on any cluster, and one
   pod's `.git` cannot corrupt another's. *Rejected:* an RWX PVC with `git worktree` per task (needs
   NFS/EFS/Longhorn, and every worktree shares one `.git`, so an agent running `git gc` corrupts
   every concurrent task); MinIO mounted via s3fs (git needs atomic rename and `flock`, s3fs has
   neither); cloning from the forge every time (rate limits, no offline story).
3. **The server never talks to Kubernetes; the controller never serves the SPA.** Cluster credentials
   stay out of the process listening on port 8080.
4. **The outcome is the invoked command's business.** The controller grants git access and measures
   what happened (`base_sha`, `head_sha`, commit count). It does not decide to open a PR. Whether a
   run ends in a push, a PR or just a diff is determined by the skill or slash command the task named.

### Why pods clone instead of sharing worktrees

The original framing was "controller fetches latest repo state and branches off a worktree on a
shared volume". Under decision 2 that becomes:

- Controller keeps the mirror current and resolves `base_branch` → a concrete SHA, recorded on the
  attempt so the run is reproducible.
- Init container: `git clone --filter=blob:none --no-checkout --branch <base> http://mirror/... /work`,
  then `git checkout <base_sha>`, then `git switch -c fx/<task-id-short>`.
- Branch creation moves into the pod. The mirror stays read-only to pods (`upload-pack` only); the
  push goes to the real forge.
- Lost: nothing that matters. `git worktree` was only a way to avoid re-copying objects, and
  `--filter=blob:none` against an in-cluster mirror is cheaper than that anyway.

## Spec map

| Spec | Covers | Depends on |
| --- | --- | --- |
| [01-schema-and-store](01-schema-and-store.md) | `006_agent_tasks.sql`, `007_agent_tasks.repeatable.sql`, the two status machines, `task-store.ts`, the `skip locked` claim, `memoryTaskStore`, both `test-db` files | 00 |
| [02-adapters](02-adapters.md) | `core/src/executor.ts` contract, claude-code and opencode adapters, `RunEnvelope`, result extraction, CLI-flag drift gate | 00 |
| [03-controller](03-controller.md) | Loop, launch ordering, boot reconciliation, leases, timeouts, retry classification, cancellation, `RunnerBackend` seam, the local backend | 01, 02 |
| [04-git-mirror](04-git-mirror.md) | Mirror lifecycle, locking, gc, `git-http-backend` CGI bridge, upload-pack-only enforcement | 00 |
| [05-job-and-runtime](05-job-and-runtime.md) | Job/Pod spec, init container, volumes, security context, `entrypoint.mjs`, result and log capture, short-lived git token delivery, agent image | 02, 03, 04 |
| [06-api-and-auth](06-api-and-auth.md) | `POST`/`GET`/cancel `/api/tasks`, check ordering, status codes, the auth mechanism, the CLI | 01 |
| [07-config](07-config.md) | `ExecutorIntakeConfig`, the executor env keys, `loadExecutorConfig` | 00 |
| [08-deploy](08-deploy.md) | `deploy/k8s/` kustomize tree, RBAC verbs, NetworkPolicy, quotas, compose profile, `e2e-cluster.sh` | 03, 05 |

## Build order, and why

1. **01** — workspace wiring, `core/src/executor.ts`, migrations, store. *Verify:* `npm test`,
   `npm run test:db`, `npm run typecheck`.
2. **02** — adapters, pure `plan`/`parseResult`, offline tests. Nothing runs yet; this is the half
   that is fully testable with no cluster.
3. **03** — `RunnerBackend`, the **local** backend, the controller loop. *Verify:* a task runs end to
   end on the developer's machine with `RUNNER_BACKEND=local`, no cluster involved.
4. **06 + 07** — intake route, auth, config, CLI. *Verify:* `server/test/routes.tasks.test.ts`, then
   submit a real task through the CLI against the local backend.
5. **04** — git mirror, HTTP backend, controller image.
6. **05 + 08** — Kubernetes backend, agent image, manifests. *Verify:* `executor/scripts/e2e-cluster.sh`.
7. Docs — `docs/executor.md` plus the seven files listed under Flag I.

**Specs 01–03, 06 and 07 deliver a working executor with no Kubernetes at all.** That is also the
answer to "how do I develop this without a cluster": the `RunnerBackend` seam has a `local` backend
that `child_process.spawn`s the same wrapper script a pod would run.

## Workspace wiring — do this first, it breaks silently

Owned by [01](01-schema-and-store.md), listed here because every spec assumes it.

| File | Change |
| --- | --- |
| `package.json` | `workspaces: ["core","server","web","executor"]`; `build` → `core && server && executor && web`; add `"task": "node executor/dist/cli/task.js"` |
| `tsconfig.json` | add `{ "path": "./executor" }` |
| `vitest.config.ts` | add `'executor/test/**/*.test.ts'` to `include` |
| `vitest.db.config.ts` | add `'server/test-db/**/*.test.ts'` (new directory) |
| `docker/Dockerfile` | **`COPY executor/package.json executor/`** in the `deps` *and* `runtime` stages |
| `server/src/config.ts` | add the `executor` intake keys — see [07](07-config.md) |

The Dockerfile line is the trap: root `npm ci` needs every workspace manifest, so adding the
workspace **breaks the existing dashboard image** until it lands, and only in the container — never
in dev, never in CI.

Two further couplings, both already documented in `AGENTS.md` for other packages and both applying
here unchanged:

- `executor` resolves `@factory-ai/core` to `core/dist`, not `core/src`. **Core builds first.**
  Anything new in `core/src` must be re-exported from `core/src/index.ts` or the executor and the
  server both see "module has no exported member" — a failure that looks exactly like a source bug.
- `executor/scripts/*` and `executor/runner/*` are not compiled by `tsc`, so the agent and controller
  Dockerfiles must `COPY` them **by directory** — the same trap the existing Dockerfile documents for
  `server/migrations/`, and it fails only in the container.

`executor` must **not** depend on `@factory-ai/server`. See [07](07-config.md) for how config avoids
it.

## Flags — decisions that will bite

- **A. Auth.** Intake on the unauthenticated Fastify server is the single largest risk here.
  `docs/security.md` says "the `127.0.0.1` bind is the access control", and three things break that
  argument for this route: the posture does not transfer to a cluster; every existing route is a
  *read*, so a browser-origin POST is harmless against `/api/refresh` and catastrophic here (the CORS
  preflight forced by the JSON content-type is currently the *only* thing between a malicious page in
  the operator's browser and a pod with push credentials); and there is no audit identity at all. The
  four mitigations in [06](06-api-and-auth.md) are not optional, and the highest-value one is that
  **`repo` must be one of `config.repoNames`** — the request never carries a clone URL, because an
  arbitrary URL is how an attacker gets the pod's credential to push somewhere they control.
  `docs/security.md` must be **rewritten**, not appended to.
- **B. `replicas: 1` is forced by the RWO mirror volume**, not by the claim logic. The claim is
  correct for N replicas, but a `ReadWriteOnce` PVC pins the controller to one pod, so the controller
  is a single point of failure for *launching*. Not for *running*: SIGTERM leaves Jobs alone and boot
  reconciliation re-adopts them, so a restart costs launch latency, not work. Going multi-replica
  later means splitting the mirror into its own Deployment; the claim design is already ready for it.
- **C. The prompt must not reach the Job spec.** `kubectl get job -o yaml` prints `args` and `env`,
  and etcd is unencrypted by default. The prompt goes in the per-task Secret as a file; the plan's
  argv never contains it. Asserted offline in [02](02-adapters.md).
- **D. "Token spend lands in `metric_point` via the existing path" holds for both executors now.**
  The opencode image ships `@gcornut/opencode-otel`, which mirrors Claude Code's metric surface
  under the `opencode.` prefix, and `metric-map.ts`'s `RULES` carries those names — so `agentOf()`
  resolves them to `'opencode'` and `session_field_total` prices them like any other session.
  Anything newer than those rows still stores with a null field and accumulates before support is
  written, and `opencode.cost.usage` is refused exactly like `claude_code.cost.usage`.
- **E. `recordAttemptSession` is load-bearing.** `metric_point` has no `org_id`; without the
  controller's `session_branch` write, an executor pod's metrics belong to no organization —
  invisible today, wrong the day there are two. Also `session_branch.branch` sits in the primary key
  despite being documented nullable, so the executor must always supply a branch name. It always has
  one; do not generalise this to detached HEAD.
- **F. Short tasks undercount tokens** unless the runner sleeps for the OTEL flush window after the
  CLI exits. A 40-second task with a 60-second export interval reports zero spend and **nothing errors
  anywhere.** Hence `EXECUTOR_OTEL_FLUSH_MS`, a shortened `OTEL_METRIC_EXPORT_INTERVAL`, and
  `tokens: null` rather than 0 for a window after `finished_at`.
- **G. The timeout is enforced twice and the two must not disagree.** If the lease reaper marks an
  attempt `lost` while the pod is still running and holding push credentials, a retry launches a
  **second** agent on the same branch. Invariant, validated in `loadExecutorConfig`:
  `grace ≥ 2 × lease`, `lease < taskTimeout`, and the controller **deletes the Job before requeueing**.
- **H. A container is not a sandbox** against code the model chose to run. Stated, not solved.
  gVisor/Kata is the real answer and is out of scope; what actually holds the line is Flag A.
- **I. Docs that must change** or the next reader is misled:

  | File | Change |
  | --- | --- |
  | `docs/executor.md` | New. The operator-facing runbook plus the decisions that look like cruft. |
  | `AGENTS.md` | New rows in "Read before you touch" (`executor/src/git/*`, `deploy/k8s/*`, `specs/executor/*`) and in "Build coupling" (core/dist coupling; `executor/scripts` copied by directory). |
  | `docs/api.md` | Four routes, the 201-vs-202 reasoning, the check ordering. |
  | `docs/security.md` | **Rewrite** the access-control paragraph. |
  | `docs/configuration.md` | `[executor]`, the new `bool` kind, deployment-only keys. |
  | `docs/persistence.md` | A second reader of the database, one migration runner, `memoryTaskStore`. |
  | `docs/telemetry.md` | The controller, not an in-pod hook, writes `session_branch` for executor runs. |
  | `docs/limits.md` | Skill-is-a-request; opencode tokens mapped; CLI capture versions; short-task export lag. |
