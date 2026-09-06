# Kubernetes

Read before: touching `driver/src/k8s.ts`, the `EXECUTOR`/`K8S_NAMESPACE`/`RUNNER_CREDENTIALS_SECRET`
variables, anything under `charts/factory/`, or `scripts/test-k8s.sh`.

The stack runs on Kubernetes three ways at once, and the issue that asked for it named all three:
a **kubernetes executor** (runners are Jobs, not `docker run`), a **helm chart** for the whole
factory, and an **operator for runners** — which, deliberately, is not a CRD controller; see
[The operator is the driver](#the-operator-is-the-driver).

## The executor

`EXECUTOR` selects the platform runners run on: `docker` (the default, the original path) or
`kubernetes`. The seam is the `Runner` interface in `driver/src/docker.ts` — `run`, `kill`,
`remoteSessionId` — which `driver/src/k8s.ts` implements a second time. **The loop, the board
contract and the server change not at all**: `loop.ts` cannot tell which executor is under it, and
that is the point. A third platform would add a third `Runner`, nothing else.

The two implementations decide the same things and are pinned the same way:

| | docker (`dockerArgs`) | kubernetes (`runnerJobSpec`) |
| --- | --- | --- |
| Workspace | `-v factory-ai_workspaces:/workspaces`, `WORKDIR=<mount>/<org>/<uuid>` | PVC `<claim>` mounted at `<mount>`, same `WORKDIR` env |
| Credentials | `-e NAME`, value read from the driver's own env | `valueFrom.secretKeyRef` against `RUNNER_CREDENTIALS_SECRET`, one key per `RUNNER_ENV` name |
| Orphan visibility | `--label factory.job=<id>` | the same label on the Job and its pod template |
| Timeout | the driver kills the container after `DRIVER_JOB_TIMEOUT_MS` | `activeDeadlineSeconds` = that value, enforced by the kubelet |
| A failed run | the container exits, `--rm` cleans it | the pod terminates, `restartPolicy: Never`, `backoffLimit: 0`, object reaped by `ttlSecondsAfterFinished` |
| What a runner must never hold | the docker socket (it does not) | a ServiceAccount token (`automountServiceAccountToken: false`) |

Two decisions in that table deserve their own paragraph:

**Credentials go by reference, never by value.** `-e NAME` keeps the value out of a `docker run`
argv that every `ps` on the host can read; `valueFrom.secretKeyRef` keeps it out of a pod spec that
everyone who can `get pods` can read. Same threat, same answer, different syntax. A literal
`value:` on a credential env is the one thing `runnerJobSpec` must never grow — the test suite
pins that `WORKDIR` (a path, not a secret) is the only literal value in the runner env.

**The runner gets no ServiceAccount token.** Pods automount one by default, and a driver-spawned
pod would automount the *driver's own* identity — the identity that may create Jobs. A Claude
container that may run `--dangerously-skip-permissions` holding job-creating credentials is the
docker socket riding along with the dashboard, which `docs/security.md` refuses for exactly that
reason. Runner pods set `automountServiceAccountToken: false`; the driver's own pod keeps its
token and its namespace-scoped Role.

**Re-claims fence by replacing.** A job id is only reused when a lease expired and the row was
reclaimed, so a `409 AlreadyExists` on create means the previous attempt's Job object still
exists. The runner deletes it and creates its own — the same rule the docker runner obeys when a
409 heartbeat says *kill the container*: two writers on one checkout is the thing actually worth
preventing. `docs/jobs.md` calls that the single most important line in the board contract.

## The operator is the driver

"Operator for runners" is satisfied by running the driver in-cluster, not by a CRD controller. The
driver already **is** a reconciler: claim → spawn runner → heartbeat → complete, pull-based
against the board instead of watch-based against etcd. A CRD would add code generation and a
second control loop that duplicates the board, whose lease/attempt/dead machinery already answers
"what happens when a worker dies".

What a CRD would have bought, and what covers it instead:

| The CRD story | The answer here |
| --- | --- |
| self-heal orphaned runners when the controller dies | the lease expires and the job is re-offered (`attempts` shows it); the kubelet's `activeDeadlineSeconds` kills a zombie runner; `ttlSecondsAfterFinished` reaps the object |
| a declarative API for "run this command" | `POST /api/jobs` — the board already is one, with authentication and an author recorded |
| per-runner reconciliation | the driver's poll loop, one Job per claim |

If a use case appears that genuinely needs a CRD (external systems creating work without the
board, say), that is a new decision, made then.

## The chart

`charts/factory/` — see [its README](../charts/factory/README.md) for the object list and the
minikube walkthrough. Decisions that look like cruft and are not:

- **The in-chart TimescaleDB is a plain Deployment, not the upstream chart dependency.** One
  deployment, one claim, no subchart; it mirrors compose running a plain timescale container. For
  anything real, `timescale.enabled=false` and `database.url` point at a managed instance — which
  is also why the helper fails the template when that combination is asked for without a URL.
- **`AUTH_MODE` defaults to `github` in the chart**, as compose pins it, because the chart's
  dashboard holds checkouts and serves a route that runs shell commands. The minikube values file
  turns it off explicitly (`none` + `AUTH_ALLOW_PUBLIC_BIND=1`, the ClusterIP being the perimeter —
  the k8s analogue of the loopback bind). Under `github`, `auth.publicUrl` is required; the server
  refuses to boot without it, by design.
- **`values-minikube.yaml` points the executor at a stub echo image**, the same trick
  `scripts/test-jobs.sh` uses: a queued job runs a real pod that echoes its prompt, which proves
  the whole board → driver → Job → pod → complete path offline, with no Claude and no credential.

## Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `EXECUTOR` | `docker` | `kubernetes` selects the Job runner. Explicit enum: anything else is fatal — a typo must not read as "docker is fine" and quietly claim jobs while spawning nothing. |
| `K8S_NAMESPACE` | `default` | Where runner Jobs are created. The chart sets it via the downward API, so the driver follows whichever namespace it landed in. |
| `RUNNER_CREDENTIALS_SECRET` | unset | The Secret holding runner credentials, one key per `RUNNER_ENV` name. Unset forwards nothing — an image with a login baked into a volume needs none, the same answer as the docker driver's missing-credentials warning. |
| `RUNNER_IMAGE_PULL_POLICY` | `IfNotPresent` | The runner image's pull policy. Kubernetes reads a missing or `:latest` tag as `Always`, which reaches past the node's local images for a registry copy of `claude-executor` — where the docker runner would have used what the daemon holds. The chart passes `driver.imagePullPolicy` through. |

Refused combinations, fatal at startup: `EXECUTOR=kubernetes` + `RUNNER_REMOTE_CONTROL=1` — Remote
Control needs a tty held open, an auth volume and an idle-parking loop that only the docker runner
has; and `EXECUTOR=kubernetes` + `RUNNER_CLI=opencode` — the Job spec is `--session-id`/`--resume`
argv, which an opencode job (no session at all) can never fill. The alternative to refusing either
was a driver that claims jobs and burns attempts running nothing.

## Testing

- `driver/test/k8s.test.ts` — the whole executor, offline. The request function is injected (the
  way `createBoard` takes `fetch`), so the suite spawns nothing and needs no cluster; `runnerJobSpec`
  is pure and pinned like `dockerArgs`, including the no-literal-credential and no-service-account
  pins above.
- `npm run test:k8s` — `helm lint`/`helm template` assertions plus the minikube walkthrough as a
  script, mirroring `scripts/test-jobs.sh`. Needs helm; the minikube phase needs a cluster.
