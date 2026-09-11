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
| Publish | sibling containers over the workspaces volume, one per step | aux Jobs over the workspaces PVC, one per step — the same `publishCheckout` workflow over both |
| Runner vitals | `docker stats --no-stream` | the metrics API (`metrics.k8s.io`), read from the runner's pod; null when the cluster runs no metrics-server |

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
checkout, the fence's own rule. When that best-effort delete itself fails, the Job is left
to the kubelet's deadline AND the claim stays held — the checkout is never handed over
voluntarily while this attempt's runner may still be on it; the next claimant takes over via
the stale-holder path.

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
- **The chart ships the collector, and the driver names it in every runner spec.** A docker runner
  joins the compose network and its baked `collector:4318` resolves; a pod cannot join a network,
  so the kubernetes form of `RUNNER_NETWORK` is the driver setting `OTEL_EXPORTER_OTLP_ENDPOINT`
  on the runner container, from `RUNNER_OTEL_ENDPOINT`. The docker runner takes the same variable
  and forwards it the same way, so an operator who wants a collector the compose network cannot
  name gets it on both executors. The chart contributes both halves: a
  `Deployment <release>-factory-collector` (an OTLP collector forwarding to this release's
  dashboard ingest route, with the compose file's strip-identity and drop-cost processors and its
  `compression: none`), and the driver env that points runner pods at
  `http://<release>-factory-collector:4318`. `collector.enabled=false` removes the collector;
  runners then keep the driver's default `http://collector:4318`, which resolves nowhere unless
  `RUNNER_OTEL_ENDPOINT` points elsewhere — the "off the network"
  mode, documented as "the CLI still works, the sessions just go unrecorded". The dashboard
  ingest token, when one is set, reaches the collector as `INGEST_TOKEN` from the same Secret key
  the dashboard reads and lands in the exporter's header via `${env:INGEST_TOKEN}` — a reference
  in the ConfigMap, never a value in it. The driver reads the same key as `RUNNER_INGEST_TOKEN`
  and forwards it to every runner pod's per-attempt Secret, so the branch reporter's
  attribution reports authenticate the way the OTLP export does.

## Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `EXECUTOR` | `docker` | `kubernetes` selects the Job runner. Explicit enum: anything else is fatal — a typo must not read as "docker is fine" and quietly claim jobs while spawning nothing. |
| `K8S_NAMESPACE` | `default` | Where runner Jobs are created. The chart sets it via the downward API, so the driver follows whichever namespace it landed in. |
| `RUNNER_CREDENTIALS_SECRET` | unset | The Secret holding runner credentials, one key per `RUNNER_ENV` name. Unset forwards nothing — an image with a login baked into a volume needs none, the same answer as the docker driver's missing-credentials warning. |
| `RUNNER_OTEL_ENDPOINT` | `http://collector:4318` | Where a runner's telemetry is pointed, as `OTEL_EXPORTER_OTLP_ENDPOINT` in the pod spec. Always provided, so a pod never relies on an image-baked default that nothing in a cluster resolves; the default names the compose collector and the chart overrides it with the in-chart collector. |
| `RUNNER_IMAGE_PULL_POLICY` | `IfNotPresent` | The runner image's pull policy. Kubernetes reads a missing or `:latest` tag as `Always`, which reaches past the node's local images for a registry copy of `claude-executor` — where the docker runner would have used what the daemon holds. The chart passes `driver.imagePullPolicy` through. |

Refused combinations, fatal at startup: `EXECUTOR=kubernetes` + `RUNNER_REMOTE_CONTROL=1` — Remote
Control needs a tty held open, an auth volume and an idle-parking loop that only the docker runner
has; and `EXECUTOR=kubernetes` + `RUNNER_CACHE_WATCH=1` — each watch tick is one throwaway
container on the docker daemon, and the kubernetes form would be a Job per tick, pod admission
every poll period. The alternative to refusing either was a driver that claims jobs and burns
attempts running nothing.

**opencode runs under this executor** (with `RUNNER_CLI=opencode` and an image that speaks it):
the runner Job's argv is opencode's headless form — `run [--session <id>] <command>`, no session
minted by the driver — and the Job carries `XDG_DATA_HOME=<mount>/<org>/<user>/.opencode` so the
session database persists on the workspaces PVC, which is what makes a follow-up's `--session`
resumable at all. The close-time session scrape is the docker readout as an aux Job: the
`opencode-readout.cjs` script passed by content to `node -e` over a READ-WRITE PVC mount — the
database path as an env value, the mount read-write because a WAL needing recovery has to write —
polled to terminal and read from its pod log, its JSON line parsed into the outcome the same way
`parseOpencodeRunOutcome` does on docker. A failed scrape never fails the verdict: the session id,
finish reason and context stats are the run's follow-up-ability, not its work. What stays
unported for opencode here is the cache watch above, refused with claude-code's.

## Gates and services on this platform

**A gate run is a Job.** The docker manager keeps a warm environment container per checkout and
`docker exec`s gates into it; this executor has no exec grant and wants none, so each gate run is
a batch Job in the declared image — `sh -c` with the command as one argv element, `workingDir` at
the checkout over the same workspaces PVC, the env as a per-run Secret read by `envFrom` (never
literals: anyone who can `get pods` reads a pod spec). `activeDeadlineSeconds` carries
`GATE_TIMEOUT_MS`, and a `DeadlineExceeded` Job is reported exit 124, the convention the docker
manager's own timeout kill uses. Gate Jobs carry the attempt's `factory.job`/`factory.lease`
labels, which is what puts them inside the re-claim fence's sweep. What is deliberately not
ported is the docker cooldown's warm start: pod admission per gate run costs seconds, and a
per-checkout sleeper pod would buy back only that. `pods/exec` stays ungranted — running a
container this process specs itself is the capability the design uses, and exec into an existing
one is the escalation it never needed.

**A declared service is a Pod with a headless Service as its DNS name.** The `.bellows.yaml`
readout is a throwaway Job over a read-only PVC mount — the same script the docker readout
container runs — and each service then starts as a `restartPolicy: Never` pod (docker's detached
container never restarts either) with the environment as literal pod env, exactly as public as
the author's file already was. The DNS half is the whole trick: the runner resolves
`postgres://db:5432` through a headless Service named `db`, whose A records point at the
attempt's pod — no port list needed, which the strict parser's refusal of `ports:` requires.
The name is namespace-global, so a collision with a concurrent job's service answers 409 and
fails the job terminally, naming the conflict — the "wrong database came up" rule, one platform
later. The fleet is attempt-scoped by lease label, swept by the fence, and torn down when the
run ends, the same three moments docker's is.

**Publishing runs here too — one aux Job per step.** The decisions live in `publishCheckout`
(`driver/src/publish.ts`), shared with the docker runner so the two executors cannot drift on
what a publish is: probe, branch, commit, push, PR — same order, same failure messages. The
transport is this platform's: each step a batch Job whose `command` is exactly the argv the
docker runner passes after the image name (the executable as its head, the credential-helper
CODE as one `-c` element — a program, not a credential, the same class as the sync's
`CRED_HELPER` literal), `workingDir` at the task worktree, the claim env by a per-attempt
Secret read through `envFrom`, and the verdict off the pod's exit code and log — a nonzero exit
carries the log tail as its reason, the role git's stderr plays on docker. The step Jobs carry
the attempt's `factory.job`/`factory.lease` labels, which puts them inside the re-claim fence's
sweep: a driver that dies mid-publish leaves Jobs the next claimant deletes (Foreground, before
its own sync touches the tree) — a cleaner handover than docker's anonymous publish containers
get. The checkout claim is not re-taken for the publish, exactly as docker takes nothing: the
publish runs in the loop's post-run position where the heartbeat is still live, so the lease —
not the ConfigMap — is what excludes a replacement writer.

**The startup sync is ported the same way.** The task worktree (`docs/jobs.md`, issue #35) does
not exist until something creates it, the loop syncs on every claim, and a refusal there would
fail every claimed job.
The sync is the first writer on the tree, so the checkout CLAIM is taken before the sync Job —
the same acquireClaim protocol the runner's prepare runs, and the claim is then held through
the run (prepare's acquire recognizes its own holder). A claim held against a live newer
attempt throws the stand-down, the loop leaves the job to its lease, and a sync that fails
after taking the claim releases it, holder-checked and uid-preconditioned — but only after
the sync Job has been deleted with Foreground propagation and the delete has ANSWERED
(Foreground returns once the pod is gone): a failed sync hands the checkout over, and the
handover must be clean. Two terminal pre-run refusals — a `.bellows.yaml` that cannot be read,
gates this driver cannot run — complete the job without ever reaching the runner, whose
cleanup is the ordinary release path, so the loop hands the fence back explicitly through the
Runner's optional `releaseFence` (this executor's ownership-checked claim release; docker
implements nothing, its sweep leaves nothing behind).
The
sync is the worktree script as an aux Job — the executor image (which carries node and git) over
a read-WRITE PVC mount, the three paths the script needs as literal env, the claim env by a
per-attempt Secret read through `envFrom` (omitted entirely when the claim resolves to nothing —
a pod that references a missing Secret sits in `CreateContainerConfigError`), the kubelet's
`activeDeadlineSeconds` as its wall
clock, the verdict scraped off the pod log — and it is attempt-scoped (`factory.job` /
`factory.lease`) like everything else, so the re-claim fence sweeps a dead attempt's sync Job
like anything else. When the claim env carries `GITHUB_TOKEN`, the pod's env grows one more
literal: `CRED_HELPER`, the push's credential-helper CODE (a value that is a program, not a
credential — the token itself travels the Secret, which git's spawned helper reads from the
environment; git reads no token from the environment itself). Without the token the env stays
the three paths, and the fetch runs plain — a public repo's unauthenticated fetch, which a
helper answering an empty password would break. The sync Job is also deleted on every exit
path — success, a failed
verdict, a poll that never answered, a throw — best-effort, fire-and-forget: the name carries
the lease token, so the delete can never reach a replacement's Job, and a delete that misses
is swept by the next attempt's fence anyway. Leaving it to its kubelet deadline would let it
overlap a replacement's sync on the shared worktree, which is the overlap the claim exists to
close; on the failure arms the Foreground delete above has already taken it down, and this
Background delete then answers 404 and is swallowed.

The terminal reclaim (issue #47, the full story in `docs/jobs.md`) is ported as the sync's twin:
the remove script as an aux Job over the same read-write PVC, attempt-scoped like everything
else. It runs UNDER the checkout claim — the same `acquireClaim` protocol, held for the
reclaim's whole duration — because a thread that looked terminal to the board can gain a
follow-up before the removal lands, and that follow-up's startup sync is a writer on the same
root-scoped tree. The claim is taken before the reclaim Job is created and released on every
exit path, after a Foreground delete on the failure arms so a mid-flight removal pod never
outlives the claim it runs under. An acquire that answers 409 — a live attempt holds the
checkout, a follow-up mid-sync most likely — SKIPS the reclaim (`ok: false`, the held tree
named): costing the reclaim is fine by contract, costing a live run is not. The same-driver
half of that race is closed in the loop itself: an in-driver barrier keyed by the thread root
makes a follow-up claimed while a reclaim is in flight wait out the removal before its startup
sync. Docker's documented bound is one driver per daemon, so the barrier is all docker needs;
the claim is what makes the exclusion hold across drivers under kubernetes.

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
