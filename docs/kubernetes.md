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
| Claim env | `-e NAME` merged in, value in the child env | `secretKeyRef` against a per-attempt Secret (`factory-job-<id>-<lease token>-env`), created before the Job, reaped with it |
| Orphan visibility | `--label factory.job=<id>` plus `--label factory.lease=<token>` | the same two labels on the Job and its pod template — job for the fence's sweep, lease to scope every per-attempt operation |
| Timeout | the driver kills the container after `DRIVER_JOB_TIMEOUT_MS` | `activeDeadlineSeconds` = that value, enforced by the kubelet |
| A failed run | the container exits, `--rm` cleans it | the pod terminates, `restartPolicy: Never`, `backoffLimit: 0`, object reaped by `ttlSecondsAfterFinished` |
| What a runner must never hold | the docker socket (it does not) | a ServiceAccount token (`automountServiceAccountToken: false`) |

Two decisions in that table deserve their own paragraph:

**Credentials go by reference, never by value.** `-e NAME` keeps the value out of a `docker run`
argv that every `ps` on the host can read; `valueFrom.secretKeyRef` keeps it out of a pod spec that
everyone who can `get pods` can read. Same threat, same answer, different syntax. A literal
`value:` on a credential env is the one thing `runnerJobSpec` must never grow — the test suite
pins that `WORKDIR` (a path, not a secret) is the only literal value in the runner env.

**The claim env's per-attempt Secret is the third Secret object in the story, and it is reaped as
carefully as it is created.** The board resolves the stacked environment onto the claim
([env.md](env.md)); the runner posts it as `factory-job-<id>-<lease token>-env` (`stringData`,
`Opaque`) BEFORE the Job — a pod that references a Secret that is not there yet is a
`CreateContainerConfigError` and a burned attempt. The lease token is in the name because a
reclaimed job's superseded worker must not be able to delete the replacement attempt's Secret —
whose keys the pod references non-optionally, so a missing Secret fails loud instead of starting
silently without its env. The runner reaps the Secret with the run's own exit — once the verdict
and log have been read, on a throw, or on the kill-induced Job 404 — and never by `kill()` itself,
which can interleave the run's create() between the Secret POST and the Job POST; the re-claim
fence deletes only Jobs, never a Secret. Stated honestly: a stale attempt whose Job was deleted
before it existed runs to its natural end with its env intact and its report refused by the board
— the pre-feature semantics — rather than sitting in `CreateContainerConfigError`. The tradeoff:
a driver that crashes before cleanup leaks its attempt's Secret (Secrets have no TTL), and the
`factory.job: <id>` label is what a cleanup job would select. The chart's Role grows
`secrets: ['create', 'delete']` and nothing more on secrets — no `get`, no `list`; the driver
writes values it was handed and never reads one back. (The fence's checkout claim adds a
`configmaps` rule with `get` — see below for why that read is safe there and only there.)

**The runner gets no ServiceAccount token.** Pods automount one by default, and a driver-spawned
pod would automount the *driver's own* identity — the identity that may create Jobs. A Claude
container that may run `--dangerously-skip-permissions` holding job-creating credentials is the
docker socket riding along with the dashboard, which `docs/security.md` refuses for exactly that
reason. Runner pods set `automountServiceAccountToken: false`; the driver's own pod keeps its
token and its namespace-scoped Role.

**Re-claims fence by claiming the checkout, atomically.** A job id is only reused when a lease
expired and the row was reclaimed, so a re-claim means two attempts contending for one writable
checkout — and the fence that keeps them from ever running side by side is a creation-based
mutex, not a check-then-act sequence. Each attempt POSTs a ConfigMap named
`factory-job-<id>-claim` — one per JOB id, the one job-scoped name this runner writes; everything
else stays attempt-scoped, which is what keeps a superseded attempt's cleanup from ever reaching
the winner's objects — and the apiserver's name uniqueness arbitrates: `201` and the checkout is
ours; `409` and somebody holds it, so the claim is read. `data.attempt` is the board's per-job
attempt counter, and it orders the contenders with no clock anywhere — against a live claim it
only moves forward: every claim increments it, and the one decrement in the board (`suspend`'s
give-back) belongs to docker-side idle parking, which a kubernetes attempt can never reach
(Remote Control is refused under this executor, and this runner reports `idled: false` always);
even if an equal number ever arose, the rule below is the conservative direction — stand down and
burn one attempt, and the claim after that carries a strictly higher number. A claim whose
attempt is at or ahead of ours belongs to our own replacement, and this attempt STANDS DOWN
— it creates nothing, deletes nothing, and the loop leaves the job to its lease. A burned attempt
is the documented cost, and the heartbeat-409 kill (`docs/jobs.md`'s single most important line)
remains the backstop that bounds anything unaccounted for. A claim whose attempt is behind ours —
or that carries no attempt number at all, since garbage is never proof of a newer writer — is a
leftover from a driver that died holding it, and the next claimant RELEASES it: DELETE with a
`metadata.uid` precondition, so a stale attempt's release can only ever reach the exact
incarnation it read, never a newer one — then POST again. A driver that dies holding the claim
leaks the object (labeled `factory.job`, the same accepted-leak posture as the env Secret);
release-by-next-claimant is what makes the leak self-healing. It is a ConfigMap and not the
canonical Lease because the protocol needs `get` — granted here and never on secrets, whose
values the driver must never read back — and because a Lease's expiry semantics are
clock-derived, which this fence refuses by construction: the board's attempt counter is the
ordering, and the board's lease is the authority on liveness.

The label sweep survives as the janitor UNDER the claim: every Job the `factory.job=<id>`
selector answers is deleted by name, Foreground, until the selector answers nothing — safe to
sweep "everything" exactly because the claim is held (this attempt's own Job cannot exist yet;
its name carries its own lease token). No age filter and no cutoff, as before: a predecessor's
Job can be younger than any time-derived bound — its attempt's fencing waited on the kubelet's
unbounded garbage collector — so the sweep still classifies nothing. What changed is that the
claim is re-read before every deleting round: an attempt whose claim was taken over mid-sweep
STANDS DOWN having deleted nothing — never the winner's Job, which a fence that only
listed-then-deleted would kill on sight. And the Job POST is bracketed by claim verifies on
BOTH sides: a takeover already visible before the POST stands the attempt down having created
nothing, and a takeover landing in the one-round-trip window between the verifies is caught by
the one after the POST, where the loser removes its OWN attempt-scoped Job and stands down.
That single round trip IS the residual — a brief, bounded overlap of two schedulable Jobs,
never an unbounded one, and never a teardown of the winner; the cost is the loser's burned
attempt, the documented fenced-loser semantics (issue #32, both races). A verify that cannot
answer for the full patience leaves nothing behind either: the loser best-effort deletes its
own Job and burns the attempt — burning an attempt is the alternative to two writers on one
checkout, the fence's own rule — and only an apiserver that is truly gone leaves the Job to
the kubelet's deadline.

The docker runner's fence — sweep by label at execution time — keeps the old shape, deliberately:
the docker API has no conditional delete and no unique-name arbitration, so this protocol cannot
be ported there without reintroducing the race it exists to close, and the one-driver-per-daemon
topology leaves the loop's own heartbeat-409 kill as the arbiter between writers. The divergence
is stated, not hidden.

**Live output here is the pod log, re-read per poll.** The docker runner sees output as stream
chunks; this platform has no equivalent attach, so the runner reads the pod log's tail on each
status poll and hands it to the loop's flusher — doubling the API-server reads of a running job
from one per 2s to two, which is the price of the dashboard watching the work. Discovery is by
the same `job-name` label the final read uses, skipping terminating pods for the same reason (a
replaced attempt's log is not this run's), and every failed read is a skipped preview rather than
a verdict: the status poll owns the outcome, the final log read owns the report.

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
kind walkthrough. Decisions that look like cruft and are not:

- **The in-chart TimescaleDB is a plain Deployment, not the upstream chart dependency.** One
  deployment, one claim, no subchart; it mirrors compose running a plain timescale container. For
  anything real, `timescale.enabled=false` and `database.url` point at a managed instance — which
  is also why the helper fails the template when that combination is asked for without a URL.
- **`AUTH_MODE` defaults to `github` in the chart**, as compose pins it, because the chart's
  dashboard holds checkouts and serves a route that runs shell commands. The local values file
  turns it off explicitly (`none` + `AUTH_ALLOW_PUBLIC_BIND=1`, the ClusterIP being the perimeter —
  the k8s analogue of the loopback bind). Under `github`, `auth.publicUrl` is required; the server
  refuses to boot without it, by design.
- **`values-local.yaml` points the executor at a stub echo image**, the same trick
  `scripts/test-jobs.sh` uses: a queued job runs a real pod that echoes its prompt, which proves
  the whole board → driver → Job → pod → complete path offline, with no Claude and no credential.
- **The dashboard pod waits for the in-chart database before starting.** The server's migration
  retry gives up after ~55s — and then keeps serving with no tables, every DB-backed route a 500
  no client can poll away. On a cold cluster the database image pulls for minutes, so an init
  container runs the database pod's own readiness predicate (`pg_isready` against its service)
  until it passes; only then does the server start, inside its retry budget.

## Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `EXECUTOR` | `docker` | `kubernetes` selects the Job runner. Explicit enum: anything else is fatal — a typo must not read as "docker is fine" and quietly claim jobs while spawning nothing. |
| `K8S_NAMESPACE` | `default` | Where runner Jobs are created. The chart sets it via the downward API, so the driver follows whichever namespace it landed in. |
| `RUNNER_CREDENTIALS_SECRET` | unset | The Secret holding runner credentials, one key per `RUNNER_ENV` name. Unset forwards nothing — an image with a login baked into a volume needs none, the same answer as the docker driver's missing-credentials warning. |
| `RUNNER_IMAGE_PULL_POLICY` | `IfNotPresent` | The runner image's pull policy. Kubernetes reads a missing or `:latest` tag as `Always`, which reaches past the node's local images for a registry copy of `claude-executor` — where the docker runner would have used what the daemon holds. The chart passes `driver.imagePullPolicy` through. |

Refused combinations, fatal at startup: `EXECUTOR=kubernetes` + `RUNNER_REMOTE_CONTROL=1` — Remote
Control needs a tty held open, an auth volume and an idle-parking loop that only the docker runner
has; and `EXECUTOR=kubernetes` + `RUNNER_CLI=opencode` — the Job spec is the claude-code argv
(`--session-id`/`--resume`) and the session scrape after a run is a throwaway docker container
over the workspaces volume, neither of which this runner has an opencode form for. The
alternative to refusing either was a driver that claims jobs and burns attempts running nothing.

## Testing

- `driver/test/k8s.test.ts` — the whole executor, offline. The request function is injected (the
  way `createBoard` takes `fetch`), so the suite spawns nothing and needs no cluster; `runnerJobSpec`
  is pure and pinned like `dockerArgs`, including the no-literal-credential and no-service-account
  pins above.
- `npm run test:k8s` — `helm lint`/`helm template` assertions plus the kind walkthrough as a
  script, mirroring `scripts/test-jobs.sh`. Needs helm; the `--cluster` phase needs a real kind
  cluster and refuses any other kubectl context — kind contexts are always `kind-<name>`, and the
  context must be BOUND to the kind cluster of that name: kind publishes the control-plane API on
  host `127.0.0.1:<port>` and writes that same `server:` into the kubeconfig, so the guard accepts
  the context only if a control-plane container carrying kind's `io.x-k8s.kind.cluster=<name>`
  label publishes the port the context points at. Two independent fingerprints (a docker label on
  this daemon, node objects over the wire) could each pass against a different cluster; the
  endpoint cannot — and it must not, because the phase deletes every runner Job in the namespace.
