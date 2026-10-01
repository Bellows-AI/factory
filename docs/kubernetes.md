# Kubernetes

Read before: touching `driver/src/k8s-*.ts`, the `EXECUTOR`/`K8S_NAMESPACE`/`RUNNER_CREDENTIALS_SECRET`
variables, anything under `charts/factory/`, or `scripts/test-k8s.sh`.

The stack runs on Kubernetes three ways at once, and the issue that asked for it named all three:
a **kubernetes executor** (runners are Jobs, not `docker run`), a **helm chart** for the whole
factory, and an **operator for runners** — which, deliberately, is not a CRD controller; see
[The operator is the driver](#the-operator-is-the-driver).

## The executor

`EXECUTOR` selects the platform runners run on: `docker` (the default, the original path) or
`kubernetes`. The seam is the `Runner` interface in `driver/src/runner.ts` — `run`, `kill`,
`sampleRuntime` — which `driver/src/k8s-runner.ts` implements a second time. **The loop, the
board contract and the server change not at all**: `loop.ts` cannot tell which executor is under
it, and that is the point. A third platform would add a third `Runner`, nothing else.

What both executors share lives in executor-neutral files: `runner.ts` (the `Runner` contract,
`RunOutcome`/`RunSession`/`RuntimeSample`, output tails), `claim.ts` (workspace and working-dir
paths, transcript and opencode-db locations, gate identity, claim env), `close-read.ts` (the
outcome and turn-count parsers, the cache watch's policy and probe parser) and
`container-scripts.ts` (the script loader and the run-time scripts). `docker.ts` and `docker-*.ts` are docker-only; a
`k8s-*.ts` file importing from them is a parity smell — move the shared name to a neutral file.

The kubernetes executor is split across `driver/src/k8s-*.ts`; import from the file that owns a
name, there is no barrel:

- `k8s-transport.ts` — the wire types (`K8sRequest`/`K8sResponse`), the real transport
  (`inClusterRequest`), and the protocol constants and status thresholds every other file reads.
- `k8s-podspec.ts` — the runner's own pure Job spec (`runnerJobSpec`, the `dockerArgs`
  analogue) plus the gate/bellows/claude-turns/opencode-readout/transcript-export spec builders
  and naming.
- `k8s-auxspec.ts` — the sync/reclaim/publish/service spec builders, and the shared checkout
  claim / per-attempt Secret naming and path helpers.
- `k8s-podfields.ts` — the pod-spec field builders both spec files spread: the resource
  requests/limits (`resourcesField`, issue #360), the runner group's scheduling knobs
  (`schedulingField`, issue #361) and the voluntary-disruption opt-out (`doNotDisruptField`,
  issue #362) — config in, one optional field out, absent when unconfigured.
- `k8s-fence.ts` — the re-claim fence: claim acquire/release, the leftover sweep, and the
  pre/post-create claim verifies around the runner Job POST.
- `k8s-poll.ts` — Job-status polling to a terminal state, the live-output tail, and the
  sync/reclaim aux Job runners built on it.
- `k8s-services.ts` — the declared-service fleet: the `.bellows.yaml` readout, starting the
  attempt's headless Service and each service as a Pod under it, and the lease-scoped teardown.
- `k8s-runner.ts` — `createKubernetesRunner` itself, composing the above into the `Runner`.
- `k8s-gates.ts` — `createKubernetesGateManager`, the second `GateManager`.

The two implementations decide the same things and are pinned the same way:

| | docker (`dockerArgs`) | kubernetes (`runnerJobSpec`) |
| --- | --- | --- |
| Workspace | `--mount type=volume,src=…,volume-subpath=<org>/<uuid>,target=<mount>/<org>/<uuid>`, `WORKDIR=<mount>/<org>/<uuid>` | PVC `<claim>`'s `<org>/<uuid>` subtree mounted at `<mount>/<org>/<uuid>` via `subPath`, same `WORKDIR` env |
| Credentials | `-e NAME`, value read from the driver's own env | `valueFrom.secretKeyRef` against `RUNNER_CREDENTIALS_SECRET`, one key per `RUNNER_ENV` name |
| Claim env | `-e NAME` merged in, value in the child env | `secretKeyRef` against a per-attempt Secret (`factory-job-<id>-<lease token>-env`), created before the Job, reaped with it |
| Orphan visibility | `--label factory.job=<id>` plus `--label factory.lease=<token>` | the same two labels on the Job and its pod template — job for the fence's sweep, lease to scope every per-attempt operation |
| Timeout | the driver kills the container after `DRIVER_JOB_TIMEOUT_MS` | `activeDeadlineSeconds` = that value, enforced by the kubelet |
| A failed run | the container exits, `--rm` cleans it | the pod terminates, `restartPolicy: Never`, `backoffLimit: 0`, object reaped by `ttlSecondsAfterFinished` |
| What a runner must never hold | the docker socket (it does not) | a ServiceAccount token (`automountServiceAccountToken: false`) |
| Publish | sibling containers over the workspaces volume, one per step | aux Jobs over the workspaces PVC, one per step — the same `publishCheckout` workflow over both |
| Runner vitals | `docker stats --no-stream` | the metrics API (`metrics.k8s.io`), read from the runner's pod; null when the cluster runs no metrics-server |
| Master prompt (issue #244) | Claude: `--append-system-prompt`/`--system-prompt-snapshot off` in `dockerArgs`. OpenCode: reserved `factory` agent merged into `OPENCODE_CONFIG_CONTENT` by `envFileBody(job, config)` | identical: `claudeRunnerPlan`/`opencodeRunnerPlan` build the same argv, and `runnerCredentialEnv` merges the same `OPENCODE_CONFIG_CONTENT` through the shared `driver/src/claim.ts` `runnerClaimEnv` — one merge function, never two |
| Resources (issue #360) | `--cpus`/`--memory` from the limits, `--memory-reservation` from the memory request, on the **runner container only** (the aux containers stay unthrottled — docker is the dev executor), translated from the same quantities by `cpuQuantityToCores`/`memoryQuantityToBytes` — and **no cpu-request flag**, stated: docker has no absolute CPU floor (`--cpu-shares` is a relative weight), and capping a runner at its request would throttle builds the kubernetes side leaves free | `resources.requests`/`resources.limits` from the same four variables, verbatim, on every pod the driver specs — runner, aux Jobs, gates, services — via the one `resourcesField` |

Two decisions in that table deserve their own paragraph:

**Credentials go by reference, never by value.** `-e NAME` keeps the value out of a `docker run`
argv that every `ps` on the host can read; `valueFrom.secretKeyRef` keeps it out of a pod spec that
everyone who can `get pods` can read. Same threat, same answer, different syntax. A literal
`value:` on a credential env is the one thing `runnerJobSpec` must never grow — the test suite
pins that the only literal values in the runner env are paths and URLs — `WORKDIR`, the OTLP
endpoint, the board URL, the transcript store (`FACTORY_TRANSCRIPT_DIR`, the same name the docker
argv passes for the same claim) — never a credential.

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
writes values it was handed and never reads one back. The Role alone does not make that true —
RBAC cannot scope a verb to a name, and `create` on pods is `read` on any Secret a pod may mount —
which is what the chart's admission policy is for (see [The chart](#the-chart)). (The fence's checkout claim adds a
`configmaps` rule with `get` — see below for why that read is safe there and only there.)

**The runner gets no ServiceAccount token.** Pods automount one by default, and a driver-spawned
pod would automount the *driver's own* identity — the identity that may create Jobs. A Claude
container that may run `--dangerously-skip-permissions` holding job-creating credentials is the
docker socket riding along with the dashboard, which `docs/security.md` refuses for exactly that
reason. Runner pods set `automountServiceAccountToken: false`; the driver's own pod keeps its
token and its namespace-scoped Role.

**Every workspaces mount is scoped to the job's own `<orgId>/<userId>` subtree.** The runner, the
gates, the sync, the reclaim, the readouts and the publish steps all set `subPath: <org>/<uuid>` on
their `workspaces` volumeMount, and the subtree is mounted AT its own volume path —
`<mount>/<org>/<uuid>` — which is the container-facing path contract: every path the driver
composes for a job (`WORKDIR`, the sync's `REPO`/`WORKTREE`, the readouts' database and transcript
paths, `BELLOWS_ROOT`, a gate's `workingDir`) is the string `<mount>/<org>/<uuid>/…`, so mounting
the subtree there keeps every consumer path resolving while the rest of the volume is absent from
the container's filesystem entirely — `/workspaces` holds only the member's own `bellows/<user>`,
and no sibling or foreign path resolves. Docker's twin is `volume-subpath` with the same nested
`target` (docker ≥ 26.1; see [jobs.md](jobs.md)). The boundary is the kernel's bind mount, so
agent code inside the container cannot cross it, and the dashboard pod's whole-volume mount stays
as the deliberate exception: provisioning and org-level analysis are the dashboard's own job. Two
consequences worth knowing before they surprise an operator. A missing target fails loud — the
kubelet cannot start a pod whose `subPath` does not exist yet and leaves it stuck in
`ContainerCreating` with a volume error; the board only reports a `workspacePath` for a provisioned
member (the tree is created at sign-in), so a stuck pod is a provisioning regression, surfaced
honestly rather than papered over with a broader mount. And online PVC expansion is slow or
blocked while pods hold subPath mounts of the claim — resize the shared 20Gi with a pod roll
(offline expansion), which is also why per-org storage budgets are the quotas work item, not this.
The chart needs no edit for any of this: the driver Deployment never mounts the volume, and the
dashboard's whole mount is the exception above.

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
give-back) lands the row `stopped`, which is terminal and never claimed again;
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
its name is attempt-scoped, `factory-runner-<hash16(id|lease token)>` — hashed, because the
apiserver stamps the Job's name onto the pod template as the `job-name` label and a label value
is capped at 63 bytes, which the raw `<id>-<lease token>` form at 85 blows through and the
create answers 422). No age filter and no cutoff, as before: a predecessor's
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

**The orphan reaper is the fence's clock-free counterpart (issue #301).** The fence acts on the
`factory.job` label at CLAIM time, under the checkout claim — so it never runs for a job that
ends `dead`, a later attempt that dies before `prepare()`, or an attempt whose driver crashed
after starting its fleet. The reaper (`driver/src/reaper.ts` + `driver/src/k8s-reaper.ts`) is a
periodic watcher that acts on the same label when the BOARD says no attempt can ever come: it
lists pods and Services carrying BOTH `factory.job` and `factory.service` — the runner, gate,
sync, publish and helper pods carry only the job label and are excluded by construction, which is
also why they stay the fence's to sweep — plus `app.kubernetes.io/instance=<K8S_RELEASE>` when
one is configured, so two releases sharing a namespace against different boards can never reap
each other's fleets as "unknown jobs". Groups by `factory.job` + `factory.lease`, asks the board
in one batched call (`POST /api/jobs/leases`), and deletes Foreground by name when the job is
terminal, unknown, or running under another lease — 404/409 read as "already going away", exactly
like the fence's sweep. The attempt-scoped env Secrets (`factory-job-…-env`,
`factory-sync-…-env`, `factory-gate-…-env`, `factory-publish-…-env`) are reaped by DERIVED NAME,
never enumerated: `list` on secrets stays deliberately ungranted, and every one of those names
hashes the same (job id, lease token) pair the labels carry. The HELPER env Secret's name carries
a caller-minted nonce and is not derivable — it remains the stated residual, holding bytes rather
than CPU, memory and disk. The checkout-claim ConfigMap is job-scoped, so it is deleted only when
the job is
provably GONE — a superseded attempt's group never touches it, because a live replacement holds
it right now. The reaper's scan discovers jobs through pods and Services, so a claim-only leak
(a driver that died holding the claim, its fleet long since swept) is invisible to it; that
shape is the reclaim loop's to clean, when the leaked holder's thread is later removed — the
orphaned-claim proof and reap below (issue #344). No new verbs anywhere: `list` on pods/services is the fence's grant, `delete` on
all four kinds is the chart's Role, and the admission policy already admits deletes of
`factory.job`-labelled objects.

**Live output here is the pod log, re-read per poll.** The docker runner sees output as stream
chunks; this platform has no equivalent attach, so the runner reads the pod log's tail on each
status poll and hands it to the loop's flusher — doubling the API-server reads of a running job
from one per 2s to two, which is the price of the dashboard watching the work. Discovery is by
the same `job-name` label the final read uses, skipping terminating pods for the same reason (a
replaced attempt's log is not this run's), and every failed read is a skipped preview rather than
a verdict: the status poll owns the outcome, the final log read owns the report.

**Every poll that gates the run names an unpullable image (issue #302).** The gate poll was
first; the runner, sync and reclaim polls now read the pod's waiting reason through the same
`readImagePullStatus` (`driver/src/k8s-poll.ts`), and on `ImagePullBackOff`/`ErrImagePull` fail
right away naming the image and the kubelet's message — `the executor image "claude-executor"
cannot be pulled: ImagePullBackOff — …` — instead of burning the deadline and reporting a timeout
or "answered nothing readable" over what is really "no such image". A container that is running
or terminated has answered the image question and the check stops; one still waiting —
`ContainerCreating` covers the whole first pull — has not, so the watch keeps reading. A
pod-list blink is never the verdict. (The other aux polls — the `.bellows.yaml` readout, the
opencode session scrape, the publish steps and the block helpers — do not watch: on an
unpullable image the sync poll fails before any of them can run.)

**A plain-text `400 Bad Request` from the API server is transient (issue #308).** The driver
observed seven of them in twelve hours, on GETs and POSTs alike, with nothing in the apiserver
logs: the body is Go's `net/http` pre-handler answer — `400 Bad Request`, no kubernetes `Status`
JSON — which names the request bytes or the connection, never the API. Three layers answer it.
The transport (`inClusterRequest`, `driver/src/k8s-transport.ts`) runs on ONE dedicated
`https.Agent` with `keepAlive: false` — Node's global agent keeps sockets alive, and a request
written onto a connection the apiserver has just idle-closed is the suspected source; the
per-request TLS handshake is the accepted cost. Every refused answer (status ≥ 300, the
transport's own refusal threshold) is logged
with its method, path, status, response headers and the first 500 bytes of body — the body IS
the diagnosis; when one of these recurs, read that line first. `readVerdict`
(`driver/src/k8s-poll.ts`) retries a non-JSON `400 Bad Request` within the same bounded patience
as a 5xx (`isMalformedRequest400`; deliberately prefix-matched to Go's answer, because a broad
"any non-JSON 400" would retry permanent kubelet refusals — widen only with a logged body as
evidence), while a genuine JSON `Status` 400 stays an immediate refusal. A POST answered the same
pre-handler 400 throws too (`postRefusal` on the sync's Secret and Job creates and the reclaim's
Job create), into the same leave-to-lease arms. And a poll whose
patience runs out — transport failures, 429s, 5xx, this 400 — THROWS: infrastructure is never a
verdict, so `syncCheckout`'s exhaustion reaches the loop's catch and the job goes back to its
lease instead of a terminal `failed` with attempts left (the opencode session scrape is the one
caller that wraps the poll, because its throw must never burn a completed run's verdict; the
fence's claim POST already threw on every refusal — leave to the lease is its standing answer).
Stated residual: the gate env Secret/Job and helper Secret/Job POSTs keep the plain `refusal`
channel — a pre-handler 400 there fails the gate or the helper step rather than leaving anything
to a lease; the dedicated agent above is the only fix those sites get, which is the trade of the
issue's mandated retry scope being the sync path.

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

- **The app chart deploys no database.** Production points `database.url` at a database the chart
  does not manage; the URL carries the password, so it lands in the dashboard Secret as
  `database-url` and reaches the pod by `secretKeyRef`, and the template refuses to render without
  one when it is the thing creating that Secret — under `secret.existingSecret` the key has to be
  there already, and it is the one key the pod spec does not mark optional. There is no
  `timescale.enabled` switch to leave on by accident.
- **`database.url` names any managed PostgreSQL 17 — RDS and Aurora included (#356, done in
  #371).** The schema loads **no extension**: `metric_point` is declared
  `partition by range (time)` with a single DEFAULT partition, so a cloud install needs no
  Timescale Cloud, no self-run TimescaleDB, and the VPC has no database peering to design.

  The DEFAULT partition is the whole strategy, and it is deliberate. A range-partitioned table
  **rejects** any row no partition covers — a failure mode the hypertable did not have — and the
  writers cannot promise a range: `npm run backfill` imports transcripts of arbitrary age and an
  OTLP client's clock can skew ahead. Nothing prunes by partition here (the views filter on time;
  bucketing lives in core, `docs/metrics.md`), so there is no read traded away. Attaching a real
  range later is possible but not free: `attach partition` fails while the default holds a row the
  new range covers, so it means moving those rows first. No `pg_partman`: an extension is the thing
  this schema stopped requiring.

  **An existing local database must be destroyed, not upgraded.** A data directory initialised by
  `timescale/timescaledb` preloads the library in its own `postgresql.conf`, so `postgres:17`
  exits at startup and the pod crash-loops — delete the database claim (it outlives `make stop`
  deliberately) along with the image change. `make reset` is that delete. By hand it is two steps,
  and the order is the whole point: `helm uninstall factory-state` first — `make stop` leaves the
  database StatefulSet running, and pvc-protection holds a claim its pod still mounts, so a delete
  issued before the uninstall sits in `Terminating` forever — then
  `kubectl delete pvc -l app.kubernetes.io/instance=factory-state,app.kubernetes.io/component=timescale`.
  Select by label, not by name: the claim is the StatefulSet's `volumeClaimTemplate`, so it is named
  `data-<release>-timescale-0`. Both labels, not just the instance: on its own that one also matches
  `factory-state-workspaces`, the checkouts claim, which an image change has no business deleting.
  (`make reset` drops the whole local state deliberately, so it selects by instance alone.)
  `docs/persistence.md` carries the same warning for compose.

  **The database claim is a StatefulSet's, which changes what uninstall means.** Helm deleted the
  standalone PVC with the release; a `volumeClaimTemplate` claim is Retain by default and survives
  `helm uninstall`, so `make reset`'s explicit delete is now the only thing that removes the data
  rather than a second safety net. The set is also what makes "one writer" structural instead of
  requested: `strategy: Recreate` on a Deployment asked for it; `replicas: 1` on a StatefulSet whose
  claim is bound to the pod identity means an update cannot produce a second writer at all. A
  StatefulSet carries no `available` condition, so `make start` and `scripts/test-k8s.sh` wait on it
  with `kubectl rollout status` while the three Deployments keep the condition wait.

  **`make start` refuses to upgrade a pre-#371 state release** (`state-preflight`, the Makefile).
  The old release's standalone PVC is a resource this manifest does not contain and carries no
  `helm.sh/resource-policy: keep`, so `helm upgrade --install` would delete it — and its data —
  and bring the StatefulSet up on a fresh claim. That contradicts start's promise that a re-run
  keeps the release's data, so the target stops on a `deployment/factory-state-timescale` it finds
  and names `make reset` as the way through. The check is a Deployment lookup rather than a chart
  version, because the Deployment is exactly the shape that cannot be upgraded.

  Dropping Timescale cost nothing because it earned nothing: there was no retention policy and no
  compression, the views in `002_views.repeatable.sql` are *deliberately* not continuous
  aggregates, and `time_bucket()` never had a caller. The query path is unchanged. The migration
  runner keeps its non-transactional shape (`server/src/db/migrate.ts`) — postgres already wraps
  each multi-statement file in an implicit transaction, so an explicit one would only pull the
  `schema_migrations` insert into that scope.
- **Local state is its own release: `charts/factory-local-state`.** A plain Postgres **StatefulSet**
  (not the upstream chart — one replica, one claim, mirroring compose) plus the workspaces
  claim, installed as `factory-state`; `values-local.yaml` names both objects (`database.url`,
  `workspaces.existingClaim`). Split out so `make stop` uninstalls the app and keeps the database
  and the checkouts that database records — the two are kept together, since rows describing a
  worktree that is gone are worse than no rows. `make reset` removes the state release too. Its
  image is a superset of PostgreSQL, so #371 does not break it; swapping it is cleanup there.
- **The chart renders `AUTH_MODE=github` as a literal, and has no `auth.mode` value.** The chart's
  dashboard holds checkouts and serves a route that runs shell commands, so there is no open mode
  to select — not even locally, where "the ClusterIP is the perimeter" once justified one. There is
  no `AUTH_ALLOW_PUBLIC_BIND` either: it exists only to except an open mode. `auth.publicUrl`,
  `auth.oauthClientId`, the OAuth client secret, a 32-character session secret and a 32-character
  `secret.jobBoardToken` are refused at render time when missing; the driver's `JOB_BOARD_TOKEN`
  reference is not `optional`, because a driver without it would poll into 401s forever.
- **The chart can put an Ingress in front, and nothing else.** `ingress.enabled`, off by default
  (the ClusterIP is the perimeter, docs/security.md), renders one Ingress fronting the dashboard
  Service with `className`/`annotations`/`hosts`/`tls` passed through verbatim — the annotations
  are the cloud-specific part (ALB on EKS; see the chart README for the set that works), so the
  template carries no cloud fields. When enabled, the render is refused unless `auth.publicUrl`'s
  host is among `ingress.hosts`: GitHub redirects to publicUrl and the Ingress answers hosts —
  independent values, checked to agree rather than one derived from the other.
- **The local profile carries no credentials; `.env` does.** `values-local.yaml` holds only the
  local shape (image tags, the state release's objects, the runner images);
  `scripts/k8s-local-values.mjs` reads the repo-root `.env` — the App, the OAuth client, the
  session secret, the board token, and the optional model credential for the runner Secret — and prints them as a values document that `make start` pipes
  to `helm -f -`, so no secret lands in a file or on a command line. It exits naming anything
  missing before an image is built. `.env`'s `PUBLIC_URL` is not read (it is the dev stack's);
  the origin is `K8S_PUBLIC_URL`, defaulting to `http://127.0.0.1:$K8S_PORT` — GitHub accepts any
  port on a loopback redirect, so the dev stack's OAuth App serves the cluster too.
- **`values-local.yaml` points the executor at the real runner images** (`claude-executor`,
  `opencode-executor`, built by `make runners`), not a stub. A stub cannot run a repository job:
  the pre-run worktree sync runs `node` inside the executor image, so an echo image fails every
  such job at the sync with `StartError: exec: "node": executable file not found`. The stub
  survives only in `scripts/test-k8s.sh --cluster`, which `--set`s it over this file and queues a
  job with no repository.
- **`dashboard.offline` survives only for `scripts/test-k8s.sh --cluster`.** It boots the
  code-only no-fetch entry under the same auth wall; with no App nobody can sign in, so the
  cluster test mints a personal access token straight into the database and queues through it.
  That is also what makes the test exercise the driver's board token end to end.
- **The dashboard pod waits for the database before starting.** The server's migration retry
  gives up after ~55s — and then keeps serving with no tables, every DB-backed route a 500 no
  client can poll away. A cold local node pulls the database image for minutes and a managed
  instance can be mid-failover, so an init container runs `pg_isready -d "$DATABASE_URL"` — the
  same URL, from the same Secret key, the server reads — until it passes. `database.waitImage` is
  any image with the postgres client; the local profile reuses the database image already on the
  node.
- **The driver is fenced by admission, not by its Role alone.** Runners run agent-written code in
  the release's namespace — they have to: the workspaces claim is namespaced and the dashboard
  mounts it too — and RBAC cannot scope a verb to a name prefix, so the driver's `create pods`
  would be "mount any Secret here" and its `delete secrets` would reach the dashboard's. Two
  `ValidatingAdmissionPolicy` objects bound to the driver's ServiceAccount (`templates/driver-admission.yaml`,
  `isolation.admissionPolicy`, Kubernetes ≥ 1.30) close that: a pod spec the driver submits
  (runner, aux Job, service pod) may let a container read (volume, env, envFrom) only the
  per-attempt Secrets — `factory-{job,sync,publish,helper,gate}-…-env`, the naming every
  `*SecretName` in `driver/src/k8s-*.ts` follows — and the runner credentials; the chart's pull
  secrets only under `imagePullSecrets`, where the kubelet and never a container reads them; may
  mount only the workspaces claim, emptyDir and those Secrets, and the claim only with a `subPath`
  of the `WORKSPACE_PATH` shape (`<org>/<user id>`, no `subPathExpr`), never its root; and carries
  no ServiceAccount token, host namespace, privilege or added capability. Creates and deletes reach
  only objects labelled `factory.job`; Secrets only Opaque, Services only headless. **A new
  driver-owned Secret must follow the naming, every new driver-owned object must carry
  `factory.job`, and every workspace mount must use `workspaceMount()`'s subPath**, or the
  apiserver refuses it. `driver/test/k8s-admission.test.ts` pins every `*SecretName` builder
  against the policy's own pattern, and the subPath pattern against `WORKSPACE_PATH`, both read
  from the template. Limits, stated in the template: the names carry no release (one release per
  namespace), the subPath is fenced by shape and not by owner (a compromised driver can still name
  another member's subtree), and a mesh sidecar injector's volumes are refused on service pods.
- **Runner pods land where the operator's scheduling values send them** (`runner.nodeSelector`, `runner.tolerations`, `runner.affinity`, issue #361). The chart's own `nodeSelector`/`tolerations`/`affinity` reach the chart's pods only — the driver specs every runner, gate, sync, reclaim, publish, helper and service pod, and those got none, so agent-written code shared nodes with the dashboard pod holding the App key, the session secret and the board token. The values forward as JSON (`RUNNER_NODE_SELECTOR`/`RUNNER_TOLERATIONS`/`RUNNER_AFFINITY`), the driver parses them fail-loud at boot, and a `schedulingField()` beside `pullSecretsField()` spreads them onto every pod spec it emits. The standard cloud answer this buys: a tainted, IMDS-hardened runner node group that nothing else schedules onto — and, without it, an RWO workspaces claim cannot be kept to one node's AZ. The admission policy stays deliberately silent on these fields: it pins placement to the scheduler by refusing `nodeName` (a driver that could pin pods could reach the dashboard's node whatever the values say), and constrains nothing else scheduling-shaped — pinned in `driver/test/k8s-admission.test.ts`. Docker parity is a stated nothing: the docker executor has no node concept, the daemon decides placement, there is nothing to forward.
- **Runner pods are confined by a NetworkPolicy** (`templates/runner-networkpolicy.yaml`,
  `isolation.networkPolicy`), selected by `factory.job` plus the release label — every pod the
  driver specs carries `app.kubernetes.io/instance: <K8S_RELEASE>` for exactly this, so one
  release's policy never confines a neighbor's runners. Ingress only from each other (declared
  services); egress to DNS (port 53 only to the `k8s-app: kube-dns` pods in kube-system and
  `isolation.dnsCidrs`, default the NodeLocal DNSCache address 169.254.20.10/32 — a cluster whose
  DNS carries other labels must list its resolver there, or runners lose DNS), this release's
  dashboard, collector and driver, each other, and anything outside `isolation.blockedCidrs` (the private ranges and 169.254.0.0/16, the cloud
  metadata endpoint). IPv4 only; inert without an enforcing CNI. On EKS that CNI needs setting up
  first — see [EKS prerequisites](#eks-prerequisites).
- **The gate endpoint is advertised at the driver pod's IP.** `GATE_ADVERTISE_URL=http://$(POD_IP)`
  from the downward API: a Service name would resolve to every driver replica — and to the old and
  new pod both during a rollout — while the ephemeral port the driver appends is open on exactly
  one. There is no driver Service. With `DRIVER_WORKER` set to the pod name — defaulted, every
  container's `driver-<pid>` is `driver-1`, and the board's `claimed_by` fences could not tell
  replicas apart — `driver.replicas` above one is safe. IPv4 pod IPs only: an IPv6 address would
  need brackets the URL does not add.
- **One dashboard, recreated.** The server is the single in-process writer of the checkouts, its
  migrations take no lock, and an RWO claim cannot attach twice, so the Deployment runs one
  replica with `strategy: Recreate`. Startup and readiness read `/api/ready` — 503 until the
  migrations land, 503 for good if they gave up — so a pod whose schema never arrived is restarted
  instead of left Ready; liveness stays on `/api/health`, which touches no database.
- **Voluntary disruption is two decisions, both written down (issue #362).** The driver-specced
  pods' opt-in is `driver.runnerDoNotDisrupt` (`RUNNER_DO_NOT_DISRUPT`): both disruption
  annotations on every pod the driver specs, off by default because an undisruptable pod pins its
  node for up to `jobTimeoutMs` — an operator's cost-benefit, not the chart's. The chart's own
  pods get PDBs in `templates/pdb.yaml`: the dashboard `maxUnavailable: 1` — one `Recreate`
  replica means a drain is a brief gap, while `minAvailable: 1` could never be satisfied
  mid-eviction and would block every drain and nodegroup update forever — and the driver
  `minAvailable: 1` only above one replica, where a single-replica PDB would block drains exactly
  the same way. The driver's own pod carries no do-not-disrupt annotation: a never-exiting
  Deployment pinned to a node holds it indefinitely, strictly worse than a runner's
  timeout-bounded pin.
- **Images carry tags.** `dashboard.image.tag`/`driver.image.tag` default to the chart's
  `appVersion`, so an upgrade to a new build changes the pod spec and rolls; the collector is
  pinned, its config keys moving between releases. `values-local.yaml` uses `latest`, the tag the
  local builds produce. A changed chart Secret or collector config rolls its readers via
  `checksum/*` pod annotations.
- **`global.imageRegistry` prefixes every image the release names (#358).** The bare defaults
  (`factory-ai`, `factory-driver`, the two executor names) are the kind story — side-loaded with
  `kind load docker-image`, resolved by `IfNotPresent`. On a remote cluster a bare name resolves
  to `docker.io/library/*` and every pod lands in `ImagePullBackOff`. The executor images are the
  sharp half: they are opaque strings handed to the driver, not pod-spec fields derived from any
  chart registry, so four separate values are four chances to set two — which is why the prefix
  is one value applied at `factory.image` (dashboard, driver, collector) and at the two executor
  env values, never a rule the operator re-implements per value. `database.waitImage` is excluded
  on purpose: it is a full reference (`postgres:17-alpine`) an operator sets whole. A repository
  that already names a registry under a set prefix is refused at render — the prefix composes
  with bare repositories only, by docker's own registry rule (first component containing `.`/`:`
  or `localhost`), so `claude-executor:v1.2.3` stays legal. The recommended registry is GHCR with
  public packages — nodes pull anonymously, no `imagePullSecrets`, no node-role change — and the
  build/push walkthrough lives in the chart README. When an image cannot be pulled anyway,
  `readImagePullStatus` (issue #302) fails the run fast with the kubelet's own message instead of
  burning the deadline.
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
   in the ConfigMap, never a value in it. The branch reporter's credential no longer rides that
   key: the driver puts the attempt pair itself — `RUNNER_JOB_ID` and `RUNNER_LEASE_TOKEN`, the
   job and the lease it claimed — into every runner pod's per-attempt Secret, so the reports
   authenticate as the attempt rather than as the deployment.
- **The workspaces claim is the one thing the chart cannot provision for you.** Its defaults are a
  kind assumption; what a cloud cluster's default class is documented to do with them is two
  separate quiet stalls — see [The workspaces volume](#the-workspaces-volume), which states what is
  read off this repository and what is only taken from AWS's documentation.

## The workspaces volume

The claim the checkouts live on is the chart's only hard platform requirement, and its two
defaults — `workspaces.accessModes: [ReadWriteMany]` and `workspaces.storageClass: ''`, meaning
the cluster's default class — are true of a kind cluster and of nothing on EKS. Both failures are
quiet, which is why they are written down here rather than discovered.

**The AWS half of this section was measured, once, and the measurement has an edge.** What this
repository does — which pods mount the claim, as which uid, with which `subPath`, and what happens
when the tree is missing — is read off the source and stated flatly. The platform half was
**observed on a real EKS cluster** on 2026-09-30 (`internal-utils`, eu-central-1, Kubernetes
v1.34): the EFS prerequisites below were stood up, an `efs-ap` claim bound, and pods running as
uid 1000 with no `fsGroup` provisioned a member tree on the volume root and wrote into it through
a `subPath` from a second availability zone. [limits.md](limits.md) records what that run covered.

The edge, stated rather than buried: those were **probe pods reproducing the access pattern, not
the dashboard and a runner**. The storage contract is measured; the chart itself has
still **never been installed on EKS**, so the sentences below about sign-in and about the board
going quiet remain derived from the source, not watched.

**It must be `ReadWriteMany`, and the default class on EKS is not.** The dashboard mounts the
claim's root and every pod the driver specs mounts the same claim at its own `subPath`, so the
volume is read and written by many pods on many nodes at once. EKS's default StorageClass is EBS —
`ReadWriteOnce`, and single-AZ — so the claim never binds, the dashboard Deployment sits `Pending`,
and the driver, which never mounts the volume itself, keeps claiming jobs whose runner pods can
mount nothing. Observed on `internal-utils`: its default class is `gp3`, provisioner
`kubernetes.io/aws-ebs`, and its six nodes span two availability zones — so even the fallback
below would strand half the fleet.

**It must be writable by uid 1000, and nothing in this repository makes it so.** The dashboard and
driver pods run `runAsUser: 1000 / runAsGroup: 1000`; runner, sync, reclaim, publish, helper and
readout pods run the executor image's `USER node`, which is uid 1000; gate Jobs set 1000
explicitly. **No `fsGroup` is set anywhere** — `fsGroup` is a pod-level field, and the chart's
pod-level `securityContext` blocks are inline in `deployment.yaml`, `driver-deployment.yaml` and
`collector.yaml`, none of which carry one. Neither does `driver/src/k8s-podspec.ts`, which holds
the shared Job skeleton — the one place a pod-level `securityContext` is emitted for every pod the
driver specs, whose workspaces mounts are composed next door in `k8s-auxspec.ts`. Adding one would
not help on EFS: the EFS CSI driver does not
apply `fsGroup` to an RWX NFS mount, so the only thing that makes the tree writable is the
**access point's POSIX user**. Dynamic provisioning always applies EFS's user identity enforcement: the
client's uid/gid are replaced with the access point's for every filesystem operation — and a
StorageClass that omits `uid`/`gid` gets an access point whose identity the driver selects from its
allocation range (default 50000–7000000, used as both uid and gid), not `root:root`. The
`1000:1000` recipe below is that identity pinned to the uid every pod already runs as, so ownership
is predictable — not a rescue from a root default.

What that costs, in the order an operator meets it: sign-in still **succeeds** — provisioning is
deliberately non-fatal (`docs/workspace.md`: a full disk must not become "you cannot log in") — so
the only trace is one `workspace provisioning failed` line in the dashboard log. The member tree
`<orgId>/<userId>` is never created, `GET`/`PUT /api/workspace` fail behind the route's guard, and
every runner pod for that member is left waiting on a `subPath` that does not exist — the
`ContainerCreating` stall the `subPath` paragraph above describes, which `driver/src/k8s-podspec.ts`
records as the kubelet failing a missing `subPath` loudly. Nothing crashes; the board just stops
producing work.

### EFS prerequisites

Stood up and observed on `internal-utils` — see the caveat above and the entry in
[limits.md](limits.md):

1. **The EFS CSI driver, actually running.** Its controller needs an IAM role carrying the
   access-point and file-system calls, bound either by IRSA (annotate the controller's service
   account) or by EKS Pod Identity; the node role is not enough.

   **Check for the controller, never for the `CSIDriver` object** — observed on `internal-utils`,
   which has carried an `efs.csi.aws.com` `CSIDriver` registration since 2023 with no controller
   behind it: no `efs-csi-controller-sa`, no pods in any namespace, and EFS absent from
   `aws eks list-addons`. A `CSIDriver` object is a leftover an uninstall does not always sweep, so
   a PVC against an `efs-sc` class on such a cluster waits `Pending` forever with no provisioner to
   answer it and nothing in its events naming the cause. `kubectl -n kube-system get pods | grep
   efs` is the honest check.
2. **An EFS file system with a mount target in every availability zone the nodes run in.** EFS
   allows one mount target per availability zone — a second node subnet in a zone that already
   has one cannot carry its own, and does not need to: every node in the zone shares it, so what
   each subnet needs is network access to the zone's mount target. A zone with no mount target
   cannot mount the volume at all, and on EKS that is how a working install becomes an
   intermittent one as the autoscaler picks a new AZ.
3. **A `StorageClass` whose access points are owned by uid 1000**, which is the whole fix for the
   permission half:

   ```yaml
   apiVersion: storage.k8s.io/v1
   kind: StorageClass
   metadata:
       name: efs-sc
   provisioner: efs.csi.aws.com
   parameters:
       provisioningMode: efs-ap
       fileSystemId: fs-xxxxxxxxxxxxxxxxx
       directoryPerms: "0775"
       uid: "1000"
       gid: "1000"
   ```

   Then `workspaces.storageClass: efs-sc`; `workspaces.accessModes` stays at its `ReadWriteMany`
   default. A static PV over an access point created by hand with the same POSIX user works
   equally well.

### What the run proved

On 2026-09-30, against the shape above on `internal-utils`:

- The claim **bound in 16s**, RWX, and the provisioner minted an access point reporting
  `Uid 1000`, `Gid 1000`, `OwnerUid 1000`, `Permissions 0775`. Those four are the whole fix — a
  class without the `uid`/`gid` pair leaves the access point's identity to the driver's
  allocation range instead of pinning it to 1000.
- A pod with `runAsUser: 1000` and **no `fsGroup`** ran `mkdir -p <org>/<user>` on the volume root
  and wrote into it. Both directories came back owned `1000:1000`. That `mkdir` is the operation
  that returns `EACCES` when the access point's POSIX user is wrong, and it is the one the
  dashboard performs at sign-in.
- A second pod **in the other availability zone** mounted `subPath: <org>/<user>`, read the file
  the first had written, and wrote its own beside it — the runner's access pattern, across nodes,
  which is what `ReadWriteMany` has to mean here.
- The mount reported itself as `nfs4`. That is the direct confirmation of the `fsGroup` point
  above: this is an RWX NFS mount, the shape the EFS CSI driver does not apply `fsGroup` to, and
  nothing needed one because the access point already owned the tree.

### The single-AZ EBS fallback, and why it is not reachable

If one availability zone is acceptable, EBS gp3 with `workspaces.accessModes: [ReadWriteOnce]`
serves the same volume, and `fsGroup` *would* work there — the EBS CSI driver applies it to a
block filesystem. The cost is availability: every pod that mounts the claim must land in that one
AZ, so a zone outage is a full outage, and the dashboard, the driver and every runner compete for
one node's attachment.

It is **not reachable today** regardless. Pinning all three to one AZ needs a nodeSelector on the
runner pods, and pods the driver specs have **no scheduling knob** — `nodeSelector`, `tolerations`
and `affinity` are chart values that apply to chart pods only, and the admission policy forbids
`nodeName`. See issue #361. Until those values exist and are forwarded through the driver, EFS is
the only shape that runs.

## EKS prerequisites

Four node- and add-on-level settings the chart cannot make for itself (issue #363), plus the
ownership answer that closes the one caveat the settings cannot. Each is silent
when wrong — the isolation story reads as enforced and is not — so these are prerequisites, not
recommendations.

- **IMDS is defended at the node, not only by the policy.** `isolation.blockedCidrs` includes
  `169.254.0.0/16`, so a runner cannot reach the cloud metadata endpoint — but only where a CNI
  actually enforces the policy. The node-level defence has to exist beside it: set
  `httpPutResponseHopLimit: 1` on the runner node group, or disable IMDS there outright. A
  container that reaches `169.254.169.254` gets the node's IAM role, which no chart value scopes.
- **The VPC CNI enforces NetworkPolicy only when told to.** The add-on must be configured with
  `enableNetworkPolicy: true`, and then only on EC2 Linux nodes — not Fargate, not Windows.
  A policy is one IP family per rule and the chart's egress rule is IPv4 `0.0.0.0/0`, so an
  IPv6 cluster is uncovered (the template says so). Without the flag the NetworkPolicy object is
  admitted and inert.
- **Declared-service pods are owned, so the enforcement caveat has nothing here to bite.** AWS
  states VPC CNI enforcement is "optimized for" pods carrying `metadata.ownerReferences` and that
  standalone pods "might not work reliably" — and every other pod the driver specs is a Job and
  therefore owned. The declared-service pods are the one class that is not a Job, so each carries
  an ownerReference to the attempt's own headless Service: `startFleet` creates the Service first,
  reads the uid off its create response, and `servicePodSpec` stamps it into every pod — a create
  answered without a uid refuses to start the fleet rather than leave standalone pods behind.
  `blockOwnerDeletion: false` (no write on the owner needed) and `controller: false` (the Service
  is an owner, not a manager); deleting the Service garbage-collects the pods, the direction the
  lease teardown already goes. What the ownerReference buys is managed-pod status with the VPC CNI;
  AWS's wording stays a caveat, not a promise — a cluster that wants a harder guarantee runs
  Cilium.
- **metrics-server is not installed on EKS by default.** The driver reads runner vitals from the
  metrics API and treats a missing sample as null, so its absence degrades honestly: the dashboard
  renders no vitals and nothing false. Install the add-on when you want the numbers.
- **`blockedCidrs` blocks the VPC too.** The defaults — 10/8, 172.16/12, 192.168/16, 100.64/10 —
  cover every plausible VPC CIDR. In-cluster traffic is fine, the dashboard, collector and driver
  are reached by podSelector rather than by CIDR, but a runner that must reach a VPC endpoint
  (CodeArtifact, a registry mirror, an internal git host, a PrivateLink'd database) needs that
  host in `isolation.allowedCidrs` as a /32, one per host.

Checks that pass as written, recorded so nobody re-derives them: EKS CoreDNS pods carry
`k8s-app: kube-dns` in `kube-system`; every namespace carries `kubernetes.io/metadata.name`;
NodeLocal DNSCache is not installed by default, so the `169.254.20.10/32` default in
`isolation.dnsCidrs` is harmless; both chart Services satisfy the "service port must equal
container port" shape; the admission policies need Kubernetes ≥ 1.30, which every supported EKS
version meets. **Fargate is out entirely** — no network policy, no metrics API, and the whole
isolation story assumes a node.

Exercising these on a real cluster is a by-hand pre-release walk — [eks-runbook.md](eks-runbook.md)
(issue #364), which carries the walk record; the script's cluster phase refuses every non-kind
context on purpose, and its offline phase renders the EKS value shape as assertions instead.

## Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `EXECUTOR` | `docker` | `kubernetes` selects the Job runner. Explicit enum: anything else is fatal — a typo must not read as "docker is fine" and quietly claim jobs while spawning nothing. |
| `K8S_NAMESPACE` | `default` | Where runner Jobs are created. The chart sets it via the downward API, so the driver follows whichever namespace it landed in. |
| `RUNNER_CREDENTIALS_SECRET` | unset | The Secret holding runner credentials, one key per `RUNNER_ENV` name. Unset forwards nothing — an image with a login baked into a volume needs none, the same answer as the docker driver's missing-credentials warning. |
| `RUNNER_OTEL_ENDPOINT` | `http://collector:4318` | Where a runner's telemetry is pointed, as `OTEL_EXPORTER_OTLP_ENDPOINT` in the pod spec. Always provided, so a pod never relies on an image-baked default that nothing in a cluster resolves; the default names the compose collector and the chart overrides it with the in-chart collector. |
| `RUNNER_IMAGE_PULL_SECRETS` | unset | Comma-separated Secret names set as `imagePullSecrets` on every pod the driver specs (runner, aux Jobs, gates, services). The chart forwards its own `imagePullSecrets`. Docker has no twin: the daemon's login is what `docker run` pulls with. |
| `RUNNER_NODE_SELECTOR` / `RUNNER_TOLERATIONS` / `RUNNER_AFFINITY` | unset | JSON-encoded scheduling fields set on every pod the driver specs (issue #361) — the chart forwards `runner.nodeSelector` / `runner.tolerations` / `runner.affinity` with `toJson`. Parsed at boot; malformed JSON or the wrong shape is fatal there, never a per-attempt refusal. Absent, pods schedule wherever the workspaces claim can attach. Docker has no twin: the daemon decides placement, there is nothing to forward. |
| `K8S_RELEASE` | unset | The Helm release; labels every runner Job and every driver-specced pod `app.kubernetes.io/instance`, which scopes bulk cleanup and the runner NetworkPolicy to one release. |
| `K8S_CLUSTER_DOMAIN` | `cluster.local` | The cluster's DNS domain. The runner and gate pods resolve a declared service's bare name through the search domain `<attempt subdomain>.<namespace>.svc.<domain>`, and a search domain is absolute. The chart forwards `driver.clusterDomain`. |
| `DRIVER_HEARTBEAT_FILE` | unset | A file the driver rewrites every 10s from a timer, so a liveness probe can tell a turning event loop from a wedged one — the driver serves no HTTP. Timer-driven on purpose: a drain stops polling for as long as its jobs take. The chart sets `/tmp/heartbeat` and probes its age. Executor-neutral. |
| `RUNNER_IMAGE_PULL_POLICY` | `IfNotPresent` | The runner image's pull policy. Kubernetes reads a missing or `:latest` tag as `Always`, which reaches past the node's local images for a registry copy of `claude-executor` — where the docker runner would have used what the daemon holds. The chart passes `driver.imagePullPolicy` through. |
| `RUNNER_CPU_REQUEST` | unset | A kubernetes cpu quantity (`500m`, `2`) rendered as `resources.requests.cpu` on every pod the driver specs — the runner, every aux Job, every declared service pod. Requests make the pods Burstable and are what Karpenter and the Cluster Autoscaler size for; a pod without one is BestEffort — first evicted under node pressure, and invisible to the autoscaler. Fatal at boot when not a cpu quantity, because the apiserver would refuse it only at job-create time. The chart forwards `runner.resources.requests`. Docker renders nothing from it: there is no absolute CPU floor in docker, a stated limit (see the Resources row of the decisions table). |
| `RUNNER_MEMORY_REQUEST` | unset | A kubernetes memory quantity (`1Gi`, `1G`, plain bytes) rendered as `resources.requests.memory` on every pod the driver specs. Docker renders it as `--memory-reservation` — the soft floor, translated to bytes. Same boot-time validation. |
| `RUNNER_CPU_LIMIT` | unset | A kubernetes cpu quantity rendered as `resources.limits.cpu`, and as docker's `--cpus` (translated to decimal cores). Limits are off by default: a memory limit on an agent run turns a big build into an OOM kill mid-work, so a limit is something an operator types. |
| `RUNNER_MEMORY_LIMIT` | unset | A kubernetes memory quantity rendered as `resources.limits.memory`, and as docker's `--memory` (translated to bytes). Off by default, per above. A quantity that is not a whole number of bytes is refused at boot rather than silently floored for docker. |
| `RUNNER_DO_NOT_DISRUPT` | unset | Opts every pod the driver specs — runner, aux Jobs, declared services — out of voluntary disruption: both `karpenter.sh/do-not-disrupt: "true"` and `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"` on the pod's metadata (Karpenter reads pods, not Job objects), because Karpenter consolidation and cluster-autoscaler scale-down evicting a runner mid-job means the work is redone under a higher `attempts` (issue #362). The guarantee stops there: a Spot interruption reclaims the node regardless — Karpenter explicitly excludes interruption from `do-not-disrupt`, and it does not drain on rebalance recommendations — and an external drain (`kubectl drain`, a managed-nodegroup upgrade) proceeds all the same, so a two-hour job can still be redone. Off by default, and the cost is real: an undisruptable pod pins its node for as long as the run lasts — up to `DRIVER_JOB_TIMEOUT_MS` — so an operator on on-demand-only nodes may not want it. The chart forwards `driver.runnerDoNotDisrupt`. |

Refused combination, fatal at startup: `EXECUTOR=kubernetes` + `RUNNER_CACHE_WATCH=1` — each
watch tick is one throwaway container on the docker daemon, and the kubernetes form would be a Job
per tick, pod admission every poll period. The alternative to refusing it was a driver that claims jobs and burns
attempts running nothing.

**An OpenCode task runs under this executor** when its selected executor profile type is `opencode`:
the runner Job's argv is opencode's headless form — `run [--session <id>] <command>`, no session
minted by the driver — and the Job carries `XDG_DATA_HOME=<mount>/<org>/<user>/.opencode` so the
session database persists on the workspaces PVC, which is what makes a follow-up's `--session`
resumable at all. The close-time session scrape is the docker readout as an aux Job: the
`opencode-readout.cjs` script passed by content to `node -e` over a READ-WRITE PVC mount — the
database path and the directory scope (`OPENCODE_DIR`, the run's working directory, the same
string the docker readout passes: the per-member database is shared by concurrent tasks, and the
scope is what keeps a scrape answering its own task's session) as env values, the mount read-write
because a WAL needing recovery has to write —
polled to terminal and read from its pod log, its JSON line parsed into the outcome the same way
`parseOpencodeRunOutcome` does on docker. A failed scrape never fails the verdict: the session id,
finish reason and context stats are the run's follow-up-ability, not its work. What stays
unported for opencode here is the cache watch above, refused with claude-code's.

**The run artifacts ride the same close (issue #325).** The full-run log is cut from the same
pod-log read the verdict comes from (`readRunnerVerdict`), tail-kept at the 512 KiB artifact cap
beside the 16 KiB report tail; the transcript export is the docker twin as one more aux Job —
`claude-transcript.cjs` / `opencode-transcript.cjs` passed by content (`factory-ctrans-` /
`factory-otrans-`, attempt-scoped names like every Job here), the same env VALUES, the byte cap
among them, polled to terminal and parsed by the same `parseTranscriptRead` both executors
share. The upload lands in the shared loop, before the verdict — executor parity by
construction. One stated limit: a runner Job whose pod is gone before the verdict read (deleted
mid-run on a kill, reaped by its TTL) uploads no log — docker's streamed accumulator survives
its container, a pod log does not survive its pod, and the absent-artifact 404 is the documented
answer, tested as the nothing-retained path (docs/jobs.md, "Run artifacts").

## Gates and services on this platform

**A gate run is a Job.** The docker manager keeps a warm environment container per checkout and
`docker exec`s gates into it; this executor has no exec grant and wants none, so each gate run is
a batch Job in the declared image — `sh -c` with the command as one argv element, `workingDir` at
the checkout over the same workspaces PVC, the env as a per-run Secret read by `envFrom` (never
literals: anyone who can `get pods` reads a pod spec). The Job runs under a `securityContext` of
`runAsUser`/`runAsGroup` 1000, with `HOME=/tmp` — the same uid:gid the docker gate env is given
(`--user 1000:1000`) and the executor images' `USER node`: the gate is a writer on the shared
task worktree, and a gate writing as the declared image's default (root, usually) would leave
files the uid-1000 sync and reclaim Jobs can never remove (observed 2026-09-13 on the docker
twin: a gate-built `core/dist` left a worktree whose reclaim died with EACCES).
`activeDeadlineSeconds` carries
`GATE_TIMEOUT_MS` (the chart's `driver.gateTimeoutMs`; thirty minutes in the local profile), and
a `DeadlineExceeded` Job is reported exit 124, the convention the docker manager's own timeout
kill uses. A current cluster (observed on v1.37) first marks the deadline `FailureTarget`, the
pod still terminating and `Failed` only later; `timedOutOf` reads both, because the poll acts on
the first terminal status and reading only `Failed` reported a long gate as "exit 1, empty
output". The runner's and the helpers' deadlines go through the same function. Gate Jobs carry the attempt's `factory.job`/`factory.lease`
labels, which is what puts them inside the re-claim fence's sweep. What is deliberately not
ported is the docker cooldown's warm start: pod admission per gate run costs seconds, and a
per-checkout sleeper pod would buy back only that. `pods/exec` stays ungranted — running a
container this process specs itself is the capability the design uses, and exec into an existing
one is the escalation it never needed.

**A declared service is a Pod under the attempt's own headless Service.** The `.bellows.yaml`
readout is a throwaway Job over a read-only PVC mount — the same script the docker readout
container runs — and each service then starts as a `restartPolicy: Never` pod (docker's detached
container never restarts either) with the environment as literal pod env, exactly as public as
the author's file already was. Each pod is an OWNED pod, never a standalone one: it carries an
`ownerReference` to that headless Service, whose uid `startFleet` reads off the Service's create
response — the one driver-specced pod that is not a Job, kept from being the one pod an enforcing
CNI may skip ([EKS prerequisites](#eks-prerequisites), issue #363). The DNS half is the whole
trick, and it is attempt-scoped the way
docker's per-job network is: the attempt gets ONE headless Service named
`factory-svc-<hash of job id + lease>`, each service pod sets `hostname: <declared name>` and
`subdomain: <that Service>` (and carries `factory.fleet: <that Service>`, which is all the Service
selects), so kubernetes publishes `db.factory-svc-….<namespace>.svc.<domain>` for it. The runner
and gate pods carry that domain in `dnsConfig.searches`, so `postgres://db:5432` resolves to this
attempt's pod — no port list needed, which the strict parser's refusal of `ports:` requires. Two
concurrent jobs can both declare `db`: nothing ever creates an object named after the declared
service. The search domain is merged after the ClusterFirst defaults, so a non-factory Service in
the namespace spelled like a declared service shadows it — do not name your own Services after
`.bellows.yaml` entries. The fleet is attempt-scoped by lease label, swept by the fence, and torn
down by the loop's `releaseServices` once the declared gates are done — never inside `run()`,
because the gate Jobs resolve the same names and test against them (docs/jobs.md, "The fleet
outlives `run()`") — the same three moments docker's is. A refused start (the parser rejects the
file) runs no gates: there was no agent work to check. Its states ride the vitals flush
(`runtime.services`), read off the lease-scoped pod list — pod phases lowercased, `unknown`
before the API has phased a pod. The CPU/mem numbers need the metrics API; the fleet does not,
so a cluster with no metrics-server still reports its services — the sample carries null numbers
beside real states rather than going silent.

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
not exist until something creates it, the loop syncs on every claim — fetch-and-rebase for
starting claims, restore-without-fetch for claims that continue a session (`docs/jobs.md`,
issue #58) — and a refusal there would
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
implements nothing, its sweep leaves nothing behind). A stop that lands mid-sync (issue #126)
abandons the sync Job to its own cleanup instead: a failed sync releases itself as above, and a
SUCCESSFUL one has nothing left live, so the loop chains the same `releaseFence` onto the
sync's answer — until then the claim stays held, which is what keeps a replacement's sync off
the tree this one may still be writing.

**An unreadable sync/reclaim verdict names why it was unreadable (issue #344).** Both aux Jobs
print one JSON line as their verdict, and every way that line can fail to arrive used to
collapse into the bare `the worktree sync answered nothing readable` — with the Job reaped by
`ttlSecondsAfterFinished` and its pod events expired before anyone looked, the cause was simply
gone. The verdict reader now returns the cause beside the empty log, and the reported reason
carries it: `…nothing readable: no live pod for factory-sync-… (2 listed, all terminating)`,
`…: the pod list of … answered 500: …`, `…: the pod list of … could not be read: …`,
`…: the log of <pod> answered 404: gone`, `…: the live pod of … has no name`,
`…: the container printed nothing (pod …, phase Succeeded)`, or — a log that was read but is
not the verdict line — `…: last log line "fatal: …"`. A container that never started keeps its
older, stronger verdict (`the worktree sync container failed: StartError: …`), which is why the
read checks the container status first. The docker runner folds the same detail into its twin
(`…nothing readable: exit 0, last log line "…"`, or `exit 0, the container printed nothing` — a
nonzero exit never reaches that arm, because it already reports the daemon's stderr as
`container failed:`).
The
sync is the worktree script as an aux Job — the executor image (which carries node and git) over
a read-WRITE PVC mount, the three paths the script needs as literal env, the claim env by a
per-attempt Secret read through `envFrom` (omitted entirely when the claim resolves to nothing —
a pod that references a missing Secret sits in `CreateContainerConfigError`), the kubelet's
`activeDeadlineSeconds` as its wall
clock, the verdict scraped off the pod log — and it is attempt-scoped (`factory.job` /
`factory.lease`) like everything else, so the re-claim fence sweeps a dead attempt's sync Job
like anything else. The script's per-checkout sync lock (docs/jobs.md, issue #307) is a
lockfile in the clone's git dir ON the workspaces PVC, so concurrent sync Jobs of one checkout
serialize across pods exactly as docker's sibling sync containers do — and its `SYNC_LOCK_WAIT_MS`
wait bound (120 s) sits well inside this Job's 600 s deadline. When the claim env carries `GITHUB_TOKEN`, the pod's env grows one more
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
named), and the refusal carries the claim's identity (`heldClaim`: the ConfigMap's name, the
holder attempt it carries, and the apiserver's creation stamp), so the loop can name what held
it off (issue #344). When the board's batched lease lookup (`POST /api/jobs/leases`, the
reaper's own route) proves the holder job GONE — no row, or a terminal row, the reaper's
`gone` vocabulary exactly — the claim is a leak from a driver that died holding it, the one
shape the fence's release-by-next-claimant cannot heal because no later claimant ever comes:
the loop has the runner DELETE it (uid-preconditioned, the exact incarnation the read named) and
retries the removal once, logging one `orphaned checkout claim …` line with the claim name, the
holder attempt and the claim's age. A live row or a refused lookup proves nothing and reaps
nothing — the refusal is logged, throttled to state changes (see `docs/jobs.md`'s reclaim
queue), and the next offer asks the board again. A verdict-time reclaim of the same root that
is still in flight is the one live holder this path can race (a second done queued a row while
the removal ran), and the loop's own barrier answers that: the orphan arm skips while the
barrier holds, and the in-flight reclaim releases the claim itself when it settles. Age is only ever REPORTED here, never decided
on, the fence's no-clock rule. The same-driver half of that race is closed in the loop itself: an in-driver barrier keyed by the thread root
makes a follow-up claimed while a reclaim is in flight wait out the removal before its startup
sync. Docker's documented bound is one driver per daemon, so the barrier is all docker needs;
the claim is what makes the exclusion hold across drivers under kubernetes.

**A declared block-helper step is one more aux Job over the same PVC** (issue #207,
docs/jobs.md's "Block-helper steps"): the identical entrypoint/argv/script-content shape
`publishStepJobSpec` already uses for a publish step, with its own attempt-scoped Secret only
when the helper writes to GitHub, and `HELPER_TIMEOUT_MS` as its `activeDeadlineSeconds` — a
`DeadlineExceeded` condition reads back as the transport's own named `timeout` failure, the
same check the runner Job's own poll makes. Docker runs the identical script by content in the
task worktree over the existing runner image. Neither transport is wired to a real caller yet;
see docs/jobs.md for the full contract.

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
