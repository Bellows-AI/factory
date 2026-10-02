# Job board

Read before: touching `server/src/routes/jobs.ts`, `server/src/db/job-store*.ts`,
`server/migrations/006_jobs.sql` or anything under `driver/` or `cli/`.

A job is a text command waiting for a worker — read as an agent prompt. The runner's `ENTRYPOINT`
is a CLI wrapper: the driver passes the command as `-p <command>` to claude-code, or as the
positional prompt of `opencode run`. The task's selected executor profile type chooses which.

**The server hands jobs out and records results. It never spawns anything.** The claim resolves the
task's executor label in the STAMPED SCOPE's executor list (issue 391) — the author's own rows by
default, or the organization's when the task stamped `executorScope: 'org'`, which is how an
admin-configured profile runs any member's task — and carries its type; the driver runs the
matching `claude-executor` or `opencode-executor` container against that author's workspace checkout
and reports back. Sharing a profile changes the configuration, never the author: the task's
`created_by`, workspace and environment scope are the queuing member's own, whatever scope the
executor came from. The docker socket lives with the driver, never with the dashboard: the dashboard's
port is unauthenticated, and a socket on that process would make it root on the host.

When a task walks a WORKFLOW — the graph of agent nodes the board itself walks between verdicts —
that is a separate doc: [docs/workflows.md](docs/workflows.md) covers the definition grammar, the
edge vocabulary, the claim's `publish` flag and the halt semantics. This file describes the
one-row pipeline every task still shares, workflow or not.

## The CLI (`cli/`, issue #21)

`npm run dev -w cli -- <args>` (or `node cli/dist/index.js` after a build) — a plain HTTP client
shaped exactly like `driver/`: it depends on nothing, `core` included, and speaks to the board's
person routes only. The whole task lifecycle, one command per verb:

```
factory job create <command...> [--repo owner/name] [--executor name]
      [--executor-scope user|org]                                        POST /api/jobs
factory job list [--status <status>] [--limit <n>] [--repo owner/name] [--json]   GET /api/jobs
factory job investigate <id> [--json]                                   GET /api/jobs/:id + /thread
factory job wait <id> [--timeout <seconds>] [--json]                    GET /api/jobs/:id?waitFor=terminal
factory job follow-up <id> <command...>                                 POST /api/jobs/:id/follow-up
factory job stop <id>                                                   POST /api/jobs/:id/stop
factory job done <id>                                                   POST /api/jobs/:id/done
factory job remove <id> --yes                                           POST /api/jobs/:id/remove
```

- **Config is two environment variables and nothing else.** `FACTORY_URL` names the board and is
  required — unlike the driver there is no default, because a CLI that guesses a board queues real
  tasks against whichever one answers. `FACTORY_TOKEN` carries a personal access token (`fat_…`,
  minted from the settings page — docs/auth.md "Access tokens", issue #70); the `Authorization`
  header is **omitted, never sent empty**, when it is unset, which is the common case against an
  `AUTH_MODE=none` board. An `oat_` org token also authenticates, but only the reads — every
  write answers the board's own 403.
- **The board is the validator.** The CLI performs no command-length or repo-shape checks of its
  own — every refusal arrives as the board's `{error, code}` envelope and is printed to stderr
  with the code. The one client-side check is `--limit`, so an obvious typo never round-trips.
- **`--` ends option parsing**, so a create command with flags of its own survives:
  `factory job create --repo owner/name -- npm test --watch`.
- **One npm layer, not two.** A root convenience script wrapping `npm run dev -w cli` is not
  worth having: the inner npm claims `--timeout`, `--json`, `--yes` and friends as its own
  configuration before the CLI ever sees them, so `npm run cli -- job list --limit 1` reached
  `src/index.ts` as `job list 1` — a flag silently dropped, never an error. The script is gone;
  spell it `npm run dev -w cli -- <args>`, or run the built `cli/dist/index.js` directly. The
  `factory` name in the table above is the package's `bin`, not something on PATH.
- **Exit codes: 0 ok, 1 board or network failure, 2 usage or configuration, 3 a wait that ended
  with no terminal row.** 3 is its own code because "still running" is not a failure, and a
  script that cannot tell the two apart reports healthy tasks as broken. `investigate`
  prints the job's header block (status, command, authorship, timing, session, gates, output
  tail) followed by every thread member with its command, verdict, session id and tail;
  `--json` prints the payloads as JSON — the `jobs` array for list, `{job, thread}` for
  investigate.
- **`wait` re-issues the settle long-poll; it never sleeps.** `--timeout` is the TOTAL budget,
  which the CLI spends as successive holds of at most the board's 60s cap, the last one asking
  only for what is left. Two ways it ends without a verdict, both exit 3: the budget runs out, or
  a hold comes back far short of what it asked for on a non-terminal row — which is the board
  settling on an open workflow wait (`settleStateOf`), a state no amount of re-issuing moves.
  Re-issuing on THAT is a request storm, which is the whole reason the early return is detected
  rather than ignored.
- **`remove` demands `--yes`.** It deletes the thread and cannot be undone, and this CLI has no
  prompt to ask through, so the command line is where the intent is said out loud. `stop` needs
  no such flag — it ends a turn, keeping the thread and its session — but note its two answers:
  200 settles the row, while 202 means the stop was only STAMPED and the worker settles it at its
  next heartbeat, so a 202 must not be reported as stopped.

## The driver contract

```
POST /api/jobs/claim {worker}   -> 200 {id, command, masterPrompt, leaseToken, leaseExpiresAt,
                                        executorType, userId, workspacePath, resumeSessionId, followUp,
                                        env} | 204
  every request carries `authorization: Bearer $JOB_BOARD_TOKEN`, when the board requires one
  resumeSessionId ? restore that session : mint one, POST /api/jobs/:id/session
  followUp ? deliver the command into the restored session — every resumed claim is a
  follow-up now; there is no park resume
  spawn the runner with the command, as that session
  (claude-code mints and reports a session uuid; opencode reports the id it used, scraped at close — see below)
  POST /api/jobs/:id/heartbeat {leaseToken}     every leaseSeconds/3 while the runner runs,
                                                every ~2s while the attempt is still setting up —
                                                a stop issued into the setup must not wait out a
                                                beat period or a checkout sync (see Stop)
     200 {leaseExpiresAt, cancelRequested}: false on an ordinary beat, true when the
     user asked to park this run (see Stop) — the kill order of a different kind
  POST /api/jobs/:id/output {leaseToken, output}  the newest output tail, ~every 2s, while it runs
  POST /api/jobs/:id/gates-reread {leaseToken}  once, after the startup sync (see Publishing)
POST /api/jobs/:id/artifact {leaseToken, kind, attempt, content, truncated}
  the full-run log and the agent transcript, once each, at close — before the verdict, or
  before the suspend on a stop (issue #325; best-effort, 409 not a kill order)
POST /api/jobs/leases {ids}                     the orphan reaper's batched lookup (see Auxiliary
                                                services) — each known id's status and CURRENT
                                                lease, absent for the ids the board does not know
POST /api/jobs/:id/complete {leaseToken, status, exitCode, output,
                             failureKind?, publication?}  (see Publishing and the verdict
                              paragraph below; failureKind is the structured terminal
                              reason — issue #339)
  -> 200 {id, status, threadDone}   the verdict, plus whether EVERY job of the thread is
                                    terminal AND the user has closed it — the worktree-reclaim
                                    signal (see below)
  ... or, if the user asked to stop:
POST /api/jobs/:id/suspend  {leaseToken}        -> the board lands the park 'stopped' — the
                                                   turn ended, session kept for the follow-up
```

**Person-gated routes meet the same loop through the same states.** `POST /api/jobs/:id/stop`
ends a task's turn — queued rows settle `stopped` directly, a running row whose
lease is still live answers
`202 {status: 'running', cancelRequestedAt}` and the worker reads that flag on the heartbeat above —
fast while the attempt is still setting up, at the lease's third once the runner runs — kills its
runner and suspends, which lands `stopped` under the stamp. A running row whose lease has already
expired settles `stopped` in place (#152) — nobody holds the lease, and a stamp would wait for a
heartbeat nobody will send. A stop issued while the row is between
claim and spawn — the window the task view renders as "Waiting for the executor…" — is answered by
that setup-phase poll: the driver stands down without spawning anything, and the row settles
`stopped` at once (issue #126). `POST /api/jobs/:id/remove`
deletes the whole thread and hands the driver the worktree to remove through a separate queue (see
the sections below). `PATCH /api/jobs/:id` edits a QUEUED row's command in place (issue #329) —
same id, same thread, where a stop plus a re-create would have burned both: queued rows only, the
author only, and the write is decided atomically against the claim (the conditional UPDATE takes
the row's lock, so a row claimed as the edit arrives answers `409 NOT_QUEUED`, and an edit that
commits first is what the claim's `RETURNING command` delivers — the driver reads the command at
claim time and needs nothing new). Workflow rows refuse: their command is the interpolated entry
prompt, and the raw chat line was never stored.

**A `409` from heartbeat means the container must be killed.** Its lease expired, the job was
handed to someone else, and nothing it reports will be accepted. The board cannot stop a worker —
it can only refuse it — so double execution is prevented by the driver acting on that 409, not by
the database. This is the single most important line in this file.

The other kill order rode the same beat, and deserved a line of its own: **a `cancelRequested: true`
beat means the container must be killed AND the run settled.** A user asked for the task, the board
can do nothing but pass the message, and the run dies the same way a 409 does — only afterwards the
driver `suspend`s the row, and the board lands the park as a terminal
`stopped`. There is no separate endpoint and no third state:
`cancel_requested_at` is a timestamp on the moving row that the beat reads.

## The master prompt (issue #244)

**Read this before touching** `server/src/db/master-prompt.ts`, `driver/src/master-prompt.ts`, the
`masterPrompt` field on the claim, or the argv plan it feeds
(`driver/src/runner-plan.ts`'s `runnerPlan`, composed from
`driver/src/master-prompt.ts`'s `claudeSystemPromptArgs`/`opencodeAgentArgs`). Every agent claim carries a
board-owned, board-rendered text — never authorable by a workflow or task prompt — that tells the
agent it is one turn inside a Factory-run process and names exactly what Factory itself does around
it: declared gates, publish/reuse-PR, any declared pre/post helper steps, and (scanned off the
thread's frozen workflow snapshot, when it has one) review reconciliation, merge-conflict repair,
and durable GitHub waits. `server/src/db/master-prompt.ts`'s `resolveMasterPrompt` is pure — it
reads only trusted claim metadata (the row's `workflow_node`/`workflow_name`, the root's frozen
snapshot, this claim's resolved `helperPlans`) and never `job.command`, a node's own prompt text,
prior output, env values, or credentials. It fails CLOSED: a node claim whose snapshot is missing
or does not contain the claimed node renders null, and a null `masterPrompt` on the wire is refused
by the driver before any setup step runs (`loop-run.ts`'s `masterPromptRefusalReason`, checked
beside the executor-selection refusal) — the same "never run with half a contract" posture the
workspace-path and executor-type refusals already take. `job.command` is untouched: it remains the
audit record, the workflow interpolation input, the issue reference source, and the commit/PR-title
fallback, exactly as before this field existed.

**Delivery is provider-native, never a prefix on the command.** Claude Code gets it through
`--append-system-prompt` (additive to the CLI's own built-in system prompt, never a replacement)
plus `--system-prompt-snapshot off`, so a resumed conversation rebuilds the CURRENT claim's
workflow/node context instead of retaining whichever node's text rode the thread's first turn —
docker and kubernetes build the identical flag pair, right before `-p`/the delivered command.
OpenCode gets it through a reserved PRIMARY agent named `factory`
(`driver/src/master-prompt.ts`'s `opencodeConfigContent`), merged into whatever
`OPENCODE_CONFIG_CONTENT` the claim already carries from the member's own executor config: every
other key — model, permissions, plugins, any other declared agent — survives untouched, and a
member-declared `agent.factory` is replaced wholesale rather than merged field-by-field, so a
member cannot rename, disable, or rewrite the reserved agent's prompt. Both fresh and resumed
OpenCode runs launch `run --agent factory ...`. The merge happens once, in
`driver/src/claim.ts`'s `runnerClaimEnv` — the one place the real runner's env is built, never an
aux container's (sync, gates, publish, block-helpers), none of which run the agent CLI and none of
which needs the reserved agent at all.

Four things can shape one run's behavior, and conflating them is the mistake this feature exists to
prevent: the Factory master prompt (this section — code-owned, immutable, refreshed every claim),
the current node's own prompt (the task's command, or a workflow node's authored template,
docs/workflows.md), a checkout's own `AGENTS.md` (read by the agent at its own discretion, never
injected by the driver), and the provider's own default system prompt (untouched by Claude Code,
replaced for the `factory` agent's own scope by OpenCode — see the executor image READMEs for the
provider-specific detail).

## The driver (`driver/`)

A fourth workspace, with no dependency on `core` and none at run time at all. It is a client of the
HTTP board, never of the database — which is what lets it run anywhere the board is reachable.

```bash
make runners                                               # both runner images, once
npm run driver                                             # against a board on 127.0.0.1:8080

docker compose up -d driver                              # or in the stack, with everything else
```

In the stack the driver runs the working tree, like the dashboard: the compose service builds
`docker/driver.Dockerfile`'s `dev` stage and bind-mounts the checkout over it, so an edit is live
on the next restart and no restart can serve a publisher older than the tree (#174). The baked
`runtime` stage is untouched and is still what deploys — the chart and `scripts/test-k8s.sh`
build it with no `--target`.

Everything below describes the docker runner. `EXECUTOR=kubernetes` swaps the platform under it —
runners become batch Jobs, created and polled and deleted against the API server — while this
contract, the loop and the lease rules stand untouched. The parallel decisions and what the
cluster phase adds are in [kubernetes.md](kubernetes.md).

| Variable | Default | Notes |
| --- | --- | --- |
| `JOB_BOARD_URL` | `http://127.0.0.1:8080` | Must be http(s); the scheme is checked, because `new URL('dashboard:8080')` parses. |
| `JOB_BOARD_TOKEN` | unset | The shared board secret — the same value the dashboard validates against, both sides from one `.env` entry (chart: one Secret key). **Required against a board running `AUTH_MODE=github`** (the board itself refuses to boot without it); unset against an open one, where the header is **omitted rather than sent empty** — an empty Bearer is a credential that failed, not one that was never offered. |
| `CLAUDE_EXECUTOR_IMAGE` | `claude-executor` | Deployment image for tasks whose selected executor profile type is `claude-code`. This changes the image location, never task routing. |
| `OPENCODE_EXECUTOR_IMAGE` | `opencode-executor` | Deployment image for tasks whose selected executor profile type is `opencode`. This changes the image location, never task routing. |
| `WORKSPACE_VOLUME` | `factory-ai_workspaces` | A volume **name**, not a host path — see below. |
| `RUNNER_NETWORK` | unset | Join the compose network or the runner's telemetry reaches nothing. |
| `RUNNER_OTEL_ENDPOINT` | `http://collector:4318` | Where a runner's telemetry is pointed, passed to both runners as `OTEL_EXPORTER_OTLP_ENDPOINT`. The default names the compose collector, so the endpoint is always provided — a runner's telemetry reaches the collector whether or not the compose network is there to make the baked image default resolve. The chart overrides it with the in-chart collector. |
| `RUNNER_STATS_URL` | `JOB_BOARD_URL` | Where the runner's branch reporter posts its `session → (repo, branch)` samples — the board's own `/api/sessions/branch`. Defaults to the board URL, which a runner can already reach on compose and in the chart; override for a split topology (host driver, containerized runners) where only a host-gateway address names the API. |
| `RUNNER_JOB_ID` | set by the loop | The job this attempt runs for. Half of the runner's branch-ingest credential, with `RUNNER_LEASE_TOKEN` below: the reporter sends the pair as `x-factory-job-id` + `x-factory-job-lease-token`, and the board resolves the report's organization from the live attempt — never from the report's `repo` field, which is caller-controlled payload. Forwarded always (there is no branch reporting without it), but it is still a credential channel: it rides the env file (docker) or the per-attempt Secret (kubernetes), never an argv. |
| `RUNNER_LEASE_TOKEN` | set by the loop | That attempt's lease token, from the claim. The half that makes the pair attempt-scoped: a reclaim rotates the token, so a superseded attempt's reports stop authenticating, while `complete()` retains it so the reporter's final `--once` sample — landing after the verdict — still resolves. Same carriage rules as `RUNNER_JOB_ID`. |
| `DRIVER_CONCURRENCY` | `2` | |
| `DRIVER_POLL_MS` | `5000` | |
| `DRIVER_LEASE_SECONDS` | `300` | Heartbeat is a third of this. |
| `DRIVER_JOB_TIMEOUT_MS` | `7200000` | The container is `docker kill`ed and the job reported failed, with a note — and the note says whether the run was still working: `[driver] killed after 7200000ms — still active: last output 2s ago, gates test+lint passed at 22:45:02, last activity "…"` versus `— idle: no output for 34m`. Active means the newest CHANGED output tail is younger than `STILL_ACTIVE_AFTER_MS` (120s); the gate clause quotes the ad-hoc gate server's latest verdict per declared gate (docker and kubernetes share the loop and the server, so both executors get it); the activity clause quotes the agent's last output line. Each clause is omitted when the driver holds nothing for it. |
| `RUNNER_CACHE_WATCH` | off | Kills a job whose provider stopped serving prompt cache: three consecutive completed turns with no cached input over ≥20k tokens, each turn over a minute. Opencode only — see the section below. |
| `RUNNER_CACHE_WATCH_POLL_MS` | `30000` | How often the watch probes the session database. One throwaway container per poll. |
| `RUNNER_SKIP_PERMISSIONS` | off | Appends `--dangerously-skip-permissions`. Read the paragraph below. |
| `RUNNER_ENV` | `CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY` | Names forwarded to the runner. A name the claim also carries is shadowed by it — under an app-mode board that is now always `GITHUB_TOKEN` — see [env.md](env.md). |
| `EXECUTOR` | `docker` | `kubernetes` swaps the `docker run` for a batch Job in the namespace the driver runs in — see [kubernetes.md](kubernetes.md). Explicit enum: anything else is fatal, because a typo must not read as "docker is fine" while jobs are claimed and nothing runs. |
| `K8S_NAMESPACE` | `default` | Where runner Jobs are created. Meaningless under docker. The chart sets it via the downward API. |
| `RUNNER_CREDENTIALS_SECRET` | unset | The Secret holding runner credentials under `EXECUTOR=kubernetes`, one key per `RUNNER_ENV` name — the k8s form of `-e NAME`: names travel, values stay in the Secret. Unset forwards nothing. |
| `RUNNER_IMAGE_PULL_POLICY` | `IfNotPresent` | The runner image's pull policy under `EXECUTOR=kubernetes`. Kubernetes defaults an untagged or `:latest` image to `Always` and would ignore the node's own images; the docker runner has no equivalent problem, so the docker behavior has to be stated. |
| `RUNNER_CPU_REQUEST` / `RUNNER_MEMORY_REQUEST` | unset | Resource requests on every pod the driver specs (kubernetes quantities), and on docker the memory request as `--memory-reservation` — docker has no cpu-request analogue, a stated limit. Requests make a runner fleet Burstable instead of BestEffort and are what the autoscaler sizes for. Unset renders nothing, the BestEffort behavior before #360. See [kubernetes.md](kubernetes.md). |
| `RUNNER_CPU_LIMIT` / `RUNNER_MEMORY_LIMIT` | unset | Resource limits, off by default: a memory limit on an agent run turns a big build into an OOM kill mid-work. Rendered as `resources.limits` on kubernetes and `--cpus`/`--memory` on docker, translated from the same quantities. |
| `GATE_COOLDOWN_MS` | `600000` | How long a gate environment container outlives the task that started it, so the task's next turn does not pay startup again. `0` tears it down the moment the run's exits are walked. Docker only: the kubernetes gate manager runs each gate as a Job that leaves nothing behind, so there is nothing to cool down. |
| `GATE_LISTEN_HOST` | `127.0.0.1` | Where the ad-hoc gate endpoint binds. Loopback by default — it runs shell commands, and the bind address is the access control. |
| `GATE_ADVERTISE_URL` | unset | The URL runners are told to reach the gate endpoint by. Unset builds `http://host.docker.internal:<port>` from the bound port, which dockerArgs makes resolvable for gated jobs (`--add-host … host-gateway`). Set it when that default cannot reach the driver — the compose stack points it at `http://driver`, the chart at the driver pod's own IP (`http://$(POD_IP)`, so a gate call never lands on another replica). A URL with no port of its own has the bound (ephemeral) port appended — the listener is `listen(0)`, so no fixed URL could name it; one with a port stays verbatim. |
| `GATE_TIMEOUT_MS` | `600000` | The wall-clock cap on one gate run. A gate that outlives it is a failed gate, exit 124 — the runner's own timeout covers the agent, this covers a gate that hangs. The chart sets it from `driver.gateTimeoutMs` (thirty minutes in the local profile); compose passes it through from `.env`. |
| `RUNNER_SERVICES` | on | Honors `.bellows.yaml` in the author's checkouts: before a run, the driver starts each declared service on a per-job network (docker) or as a pod under a per-attempt headless DNS Service (kubernetes), so `postgres://db:5432` resolves for exactly that job. `0` opts out. Read the section below for the security posture. |
| `DRIVER_REAP_INTERVAL_MS` | `300000` | How often the orphan reaper sweeps — the watcher that reaps service objects whose owning job can no longer use them (terminal, `dead`, board-unknown, or superseded lease). Every delete is decided by the board's answer and scoped to a dead attempt's labels, so it is on by default; `0` disables it. |
| `DRIVER_REAP_GRACE_MS` | `600000` | How old an object must be before the reaper may act on it — the defer that keeps a fleet created moments before its attempt's verdict from being raced by the attempt's own teardown. Age only ever DEFERS an action the board state already decided; it never decides one. |

**The workspace is passed as a volume name, not a path.** The driver's runners are *siblings*, not
children: it talks to the host's daemon over a socket, so a path inside the driver container means
nothing to that daemon, and there is no host path to give either — the dashboard writes its
checkouts into a named volume precisely to avoid one.

**`WORKDIR` comes from the board, not from the driver's configuration.** The claim carries
`workspacePath` — a root-relative `<orgId>/<userId>` (the org id is the installation id since
#99) — and the runner starts at the task
worktree: `<workspaceMount>/<workspacePath>/.worktrees/<rootJobId>`, one `git worktree` of the
job's repository per task THREAD, branched off the remote default (issue #35). The root id is
the claim's `rootJobId` — the job itself, or the chain's first job for a follow-up — so every
attempt of a task and every follow-up resuming its session lands in the same tree, and two
tasks of DIFFERENT threads on one repository are two trees, never two writers on one. (One
thread never holds two claims either: the claim refuses a row whose root already has a
`running` row, so a follow-up waits for the row it follows to reach a terminal status before
it is handed out, and one `.worktrees/<rootJobId>` has at most one live claim from the board.
The exclusion is decided under a transaction-scoped advisory lock on the thread root, because
under READ COMMITTED a concurrent claim could otherwise miss an uncommitted `running` update
and pass it — claims of one thread fully serialize, different threads never block each other.
What remains is the reclaimed row's own predecessor — a lease expires, the row is handed out
again, and the superseded attempt may still be dying — and there the heartbeat's 409 kill is
the arbiter between writers, with the driver's re-claim fence sweeping the predecessor's
fleet and fencing the startup sync.) The clone stays
pristine: `git worktree add` writes only `.git/worktrees/` inside it and the new directory
beside it. A command-only job names no repo, so no worktree exists and it starts at
`<workspaceMount>/<workspacePath>` — the argv it always had. `ORG_ID` used to live in this
table and build `<mount>/<orgId>`, one tree that every member's agent shared. Checkouts are per
member now, so only the board knows where a given job's tree is: it is the thing that created
the directory. Each side owns what it knows — the board owns the layout, the driver owns the
mount point — which is also why the field is a ready-made relative path rather than a raw user
id the driver would have to interpret.

- **A null `workspacePath` fails the job, with a reason, rather than falling back.** There is no
  safe fallback left: both `<mount>` and `<mount>/<orgId>` are the *parent* of every member's tree,
  and handing either to a container that may be running `--dangerously-skip-permissions` is a
  cross-tenant read. Failing it also drives the job to a terminal state somebody can see, instead of
  leaving it to be reclaimed on every lease expiry forever.
- **The driver re-asserts `^<org>/<uuid>$` before interpolating it.** A board is not something this
  process trusts with a fragment of a shell command, and here a `..` would point at everybody's checkouts. The pattern is **copied**
  from the server rather than imported: this package depends on nothing, deliberately.
- **The reads carry it too.** `get`/`thread`/`list` derive the same `workspacePath` with the same
  rule (null when the job has no author or there is no workspace root), which is what the task
  view's status sidebar shows — the layout is the board's knowledge, so the dashboard reads it
  rather than rebuilding it.

**Credentials are passed as `-e NAME`, never `-e NAME=value`.** The value then comes from the
driver's own environment instead of a `docker run` argv that every `ps` on the host can read. This
is the same distinction the workspace reconcile makes for the git token.

**The claim's `env` is the runner's stacked environment, and the driver forwards it by env file.**
The board resolves org < workspace < repo at claim time, for the job's author and repo label — see
[env.md](env.md) for the storage, the write-only rules and what never persists. Under an app-mode
board the stack stands on a minted base layer: the App's installation token under `GITHUB_TOKEN`,
unless a `GITHUB_TOKEN` configured in any scope displaces it (see
[env.md](env.md), "Core secrets" and GitHub authentication). The claim's values
NEVER pass through this process's environment: `-e NAME` would read them from there, and the names
are member-controlled, so a member's `PATH` or `DOCKER_HOST` could steer the docker CLI the driver
executes on the host. Instead the driver writes a 0600 `--env-file` in the OS temp directory, spawns
against it, and removes it when the run ends — verdict, throw, or kill. The driver's own
`RUNNER_ENV` names keep the `-e NAME` form (operator-controlled values only), minus any name the
claim also carries: docker gives `-e` precedence over `--env-file`, and **the claim must win a
collision** — its stacked resolution is authoritative, and the names an org configures as core
secrets are exactly the ones `RUNNER_ENV` forwards by default. A board that predates the field
omits it; the driver reads that as "no environment".

**`RUNNER_SKIP_PERMISSIONS` is a real decision, not a nuisance flag.** Off, a headless agent stalls
at permission prompts nobody can answer and the job burns its timeout. On, it edits and runs
whatever it likes inside the container — which is also mounted onto that member's checkouts. It stays
off by default so that turning it on is something somebody typed.

**The publish asks for its own credential.** The claim's `GITHUB_TOKEN` is minted at claim time with
GitHub's full hour on it, and a run can outlive that — observed 2026-09-13 (job 43379d3a): a 1h33m
run finished with green gates, pushed with its claim-time token 34 minutes past expiry, and the
publish failed on `Invalid username or token` with the work done. So before the push the loop calls
`POST /api/jobs/:id/publish-token`, which re-answers the claim's environment assembly NOW: an
operator-configured `GITHUB_TOKEN` still wins over the mint (a deliberate credential is never
silently replaced, the claim-time rule unchanged), the mint — when there is one — is fresh, and a
null is an answer rather than an error (nothing fresher than the claim env; the driver publishes
with what it holds). The route is lease-guarded like every worker route, and the ask is best-effort
like `gates-reread`: a failed request degrades to the claim env, never to a failed publish. Both
transports lay the answer over the claim env through `withPublishToken` — the docker env file and
the kubernetes Secret are both built from it, so neither can drift.

**A run that never started is not a failed job.** If `docker` is missing or the daemon refuses, the
driver logs and says nothing to the board: reporting `failed` would blame the command for the
driver's problem and burn an attempt. The lease expires and the job is offered again, which is
visible in `attempts`. What a refused start looks like is platform knowledge, and it is stamped by
the runner as `RunOutcome.started: false`. The docker runner does not guess from stderr — the
daemon's errors and the command's own output share one stream, and a command that prints
`docker: ` before exiting 125 is a verdict, not a refusal — so it asks the daemon instead: a 125
close is classified by `docker inspect`, where a container that exists ran and `State.ExitCode` is
the verdict, and no container means nothing was ever accepted. The shared loop interprets no exit
codes, so a kubernetes pod that genuinely exits 125 is reported as the failure it is.

**Every resource an attempt creates is scoped by its lease token.** The runner container's name,
each service container's name, the services network's name and the `factory.lease` label beside
`factory.job` are all derived from the lease token, which is regenerated on every claim and never
repeats. A stale attempt is therefore structurally incapable of addressing a replacement's
resources: its kill resolves its runner through its own label pair and kills by id (never by
name), and its teardowns filter by its own lease — whatever they name can only be their own
attempt's fleet. Correctness does not depend on any in-process ownership gate, so there is none.

**The fence is the one job-scoped sweep, because it runs before anything is created.** The docker
runner removes every container and network labeled `factory.job=<id>` before standing its own
fleet up. Everything a fence finds is a previous attempt's leftover — a driver that died before it
could kill its runner, which is what a compose restart does — and this claim exists only because
those attempts' leases are gone, so removing them delivers the same verdict their heartbeats
would have, had the driver survived to receive it. The alternative to leaving a live leftover
runner running is two writers on one checkout, which is the thing actually worth preventing. On
kubernetes the fence is stronger than a sweep: the runner first takes a per-job **checkout
claim** (a ConfigMap POST the apiserver's name uniqueness arbitrates — `409` means held), and the
sweep of leftover Jobs runs only under it, re-verified before every deleting round; a superseded
attempt stands down from the claim itself and burns its attempt, never the winner's objects. The
docker runner keeps the plain sweep because the docker API has no conditional delete or
name-uniqueness primitive to build that claim from — one driver per daemon, and the heartbeat's
409-kill below, is what bounds writers there (the full protocol in
[kubernetes.md](kubernetes.md)).

**The heartbeat is raced against the run finishing, not simply slept.** The beat period is a third
of the lease — 100s by default — and awaiting it before reporting left every finished job sitting
in `running` for a minute and a half. Found by running the driver for real; a unit test with an
instant fake clock cannot see it, so `loop.test.ts` models a period that never elapses. The FIRST
beat of an attempt fires the moment the attempt exists, not after a period, and the period is ~2s
until the runner has spawned and a third of the lease afterwards (issue #126): the setup phase —
the checkout sync, the gate environment, the services network — is exactly where a stop used to sit
unobserved for minutes. The fast setup poll also renews the lease through a sync that outlives it, which the old heartbeat
— started only when the run began — never did: a long fetch no longer expires the attempt
mid-sync.

**The board banks the task's wall clock at its own settle points.** `job.wall_clock_ms` (024)
accumulates the milliseconds each row actually spent executing, and the task view's head clock is
the thread's sum of them (`taskWallClockMs`, served by the thread read; `get` and the per-run
lists carry the ROW's own banked total as `wallClockMs`). The terminal list is grouped as one row
per task (#124), and its wall clock is the thread sum — the figure the recently-completed view
renders, matching the task view's head clock; the exclusion of threads with a still-moving member
is what keeps that sum exact, because nothing in it is still banking.
Every statement that ends or supersedes a running attempt — the claim, the dead retirement, the
verdict, the suspend park, and the stop settles (#152: the claim's landing for a stamped row whose
worker died, and `/stop`'s in-place landing on a row whose lease already expired) — adds
`started_at → now()` to the row's total in the same breath, which
is the only moment it can: `started_at` resetting on every claim is exactly what would otherwise
erase the superseded segment, and a run that crashed after forty minutes and was retried keeps its
forty minutes. The park banks too — the segment it ends was real work; the time after it banks
nothing. What never banks is a settle of a row that never executed:
the first claim of a queued row leaves the clock null (null means "never ran"; zero would claim a
measurement that was never made), and `stop`'s direct landing on a queued row banks
nothing. One known overcount is accepted as inherent: a superseded or retired attempt banks up to
its lease expiry, because when a worker dies the board cannot know when the run actually stopped —
the span is the same one the view's per-run "running time" already shows.

**Live output is a rolling tail, and the driver owns the window.** Without it the dashboard showed
"Waiting for the executor…" for the whole run — the status moved, the work did not. The mechanics:

- The docker runner hands the loop its newest output tail on every chunk it reads (the tail it
  would report on complete anyway); the kubernetes twin reads the pod log's tail on each status
  poll. Neither throttles — that is the loop's business.
- The Claude image runs the CLI in `stream-json` mode and formats its session start, tool names
  and assistant text into that tail. Tool arguments never leave the container through this path:
  they can carry credentials, while the tool name is enough to show that the task is progressing.
  Kubernetes uses the same image, so it receives the same stream.
- The loop flushes at most once every 2s, and only when the tail changed — the pace the detail
  page itself polls at, so a faster flush would be requests the reader cannot see.
- The board **replaces** `output` with the tail it is sent, never appends. Appending would grow
  the row unbounded over a long session, and this side cannot know where the previous tail ended
  anyway. The final `complete` report overwrites whatever the last tail was: the stream is a
  preview, the verdict is the verdict.
- A `409` from the output route is **not a kill order**. The heartbeat is the one place that
  decides a superseded run must die; a telemetry refusal must not duplicate that decision, so the
  pump just stops talking. A failed request costs freshness, not the run, and complains about
  consecutive failures once rather than every flush.
- **The vitals ride the same flush.** Each progress report may carry a `runtime` object — the
  runner container's sampled CPU and memory (`docker stats --no-stream`, one round-trip in flight
  at a time) plus the agent's current activity line, read off the tail being flushed (last
  non-empty line, escapes stripped — the tool call most of the time, and deliberately a heuristic:
  the stream is the CLI's to format). A flush fires when either the tail or the sample changed, so
  a quiet agent burning CPU still answers "is it stuck". A missed sample stores nothing and the
  last good one stays; the claim clears the column (`started_at`'s precedent — the sample
  describes the attempt that took it), and the kubernetes runner samples the metrics API instead
  (`metrics.k8s.io`, read off the runner's own pod), answering the same null whenever the cluster
  runs no metrics-server. The attempt's `.bellows.yaml` services ride the same object as
  `runtime.services` (`[{ name, image, state }]`): the fleet's states, read in the same sampling
  round as CPU/mem — docker's `ps` over the attempt's job+lease+service label pair, kubernetes's
  lease-scoped pod list, the states lowercase platform-native words either way. A failed read
  costs its half, never the sample: null numbers beside real service states (the fleet must not
  depend on the metrics API — kind runs none), and no key at all when the attempt declared none,
  so a service-less job's report is byte-identical to what it always was. The board merges the
  object key-wise — a report without services keeps the stored fleet, null numbers keep the last
  good numbers — and clears it whole on the claim, with the numbers.

**`RUNNER_CACHE_WATCH` kills a run whose provider stopped caching, before the timeout reports
only a corpse.** Off by default — arming a kill switch over provider quality is something somebody
types. Armed, a throwaway container probes the session database (the close-time readout's source,
read while the run is LIVE — sqlite's WAL serves a reader beside a writer) every
`RUNNER_CACHE_WATCH_POLL_MS`, and three consecutive completed turns with **no cached input over
≥20k tokens of real context, each turn itself slower than a minute**, kill the job. The verdict is
failed with the observed numbers in the output, so its reader does not have to re-derive why
30 minutes bought nothing. Every axis of the trigger is deliberate: cache-read-zero is the cause,
the input floor is what makes it matter, and the duration floor is what makes it a problem — a
provider that never cached but answers quickly is left alone, and no single fluke turn kills
anything. The kill burns the attempt, and that is honest: it is a failed attempt, and the
provider state it names usually outlives a re-queue. First observed 2026-09-09 on a free-tier
model: cache served for fourteen turns, then stopped — turns went from ~25s to 2.5-4.5 minutes
re-reading 63-84k tokens, and the run died on the timeout having explored and edited nothing.
The watch is opencode-only (the message rows record per-turn cache tokens; a claude-code
transcript answers nothing to the query): a mixed-task driver probes only its OpenCode runs and
leaves Claude Code runs alone. It is docker-only: each tick is one throwaway container on a warm
daemon, while the kubernetes form would be a Job per tick — pod admission every poll period,
refused at startup under `EXECUTOR=kubernetes`.

**The branch reporter is how an executor run becomes attributable at all.** The CLIs' OTLP
metrics carry a session id and nothing else — no branch, no repo — so without the reporter's
reports the session would resolve to no repo and land in `sessionsWithoutHook`, however much it
cost. Both executor images bake
`branch-reporter.cjs`, launched by the entrypoint beside the CLI (never as its child), which
samples `session → (repo, branch)` from the task worktree and POSTs the plugin's exact wire
shape to `FACTORY_STATS_URL` (`RUNNER_STATS_URL`, defaulted to the board) every twenty seconds,
once more at close, and immediately whenever the session id changes. Its posture is the local
plugin's: one short-timeout request, no retries, no spool, nothing on stdout or stderr — the
stream this container prints is the run's — and every failure exits 0, because telemetry
degrades alone. The session id is handed in (`BELLOWS_SESSION_ID`, always under claude-code —
the driver mints it; on opencode, only a follow-up, which must keep naming the SAME
conversation) or, for a fresh opencode run, discovered live from the session database with the
close-time readout's exact query. The names are reserved from member configuration on both
sides, exactly like the gate credentials: a member value in `FACTORY_STATS_URL`,
`RUNNER_JOB_ID`, `RUNNER_LEASE_TOKEN` or `BELLOWS_SESSION_ID` would be a cross-tenant write into
the telemetry store — the middle two by forging the attempt credential the board resolves the
report's organization from (see [env.md](env.md)). Discovery reads the member's NEWEST root
session RECORDED IN THE RUN'S
OWN WORKING DIRECTORY — the same directory-scoped query the shipped readout runs, without which
two concurrent fresh runs of one member would cross-report each other's session id; a follow-up
avoids the residual window entirely by carrying the id.

**The runner images refuse checkout manipulation at the hook.** The task worktree standing on its
`factory/<root>` branch is this system's invariant, and nothing stopped the agent from moving it —
`git switch`, `git checkout <branch>`, branch delete/rename, a worktree of its own all ran
unimpeded, and the restore-mode sync's refusal (below) arrived only after the damage, stranding
the thread (job `43379d3a`, 2026-09-13: nine committed, gate-green commits locked in a worktree
standing on `fix/62-…`). Both runner images now deny the deny-list at the tool boundary, each in
its CLI's native mechanism — claude-executor through a `PreToolUse` Bash hook
(`git-guard.cjs`, which parses the command: compounds, `$(…)`, env prefixes, `sh -c`, `git -C`),
opencode-executor through the baked `permission.bash` table (exact-match allows ranked after the
deny globs, because opencode resolves rules last-match-wins). Read-only git, `git add` and `git
commit` stay allowed on both: a commit endangers no checkout, and publishing is the driver's
publish flow. `git rebase` stays denied outright — a rebase rewrites the published task-branch
commits — but `git merge` of an **origin remote-tracking ref** is allowed (the claude guard parses
it: every operand must be `origin/<ref>`, redirections like `2>&1` are not operands; the opencode
table allows the exact `git merge origin/main` forms, `--continue` included, and the entrypoint
appends the same exact forms for the checkout's `origin/HEAD` when that default is not `main`; a
redirected or piped merge stays denied there):
merging the remote default in is the one exit from a conflicts dead-end (job
`3e85c499`, 2026-09-20 — the agent reconciled the files but could not produce the merge commit),
and a merge can neither move HEAD off the task branch nor rewrite the published commits, so the
invariant survives it. This is a guardrail, not a security boundary — the agent is root in its
container,
    and the sync refusal stays the last line of defense. The same images serve both backends, so one
change covers docker and kubernetes; the case table lives in `git-guard.cjs` itself and is pinned
twice — offline by vitest (`driver/test/executor-images.test.ts`) and against the baked copy by
the image suites' checks.

**Selecting an `opencode` executor swaps the CLI and with it the session contract for that task.** The
headless form becomes `run <command>`, and no session is minted or passed: opencode mints its own
ids (`ses_…`) and cannot adopt one minted in advance — minting a uuid anyway would put a session
on the board that the runner never used. Instead the runner **scrapes the id the run actually
used** after the container exits: opencode keeps its sessions in a sqlite database, the driver
persists that database per member by pointing `XDG_DATA_HOME` at a `.opencode` directory in the
member's own tree on the workspaces volume (which is also what makes a session resumable at all —
a fresh container starts with an empty one), and one throwaway node container reads the newest root
session **recorded in the run's own working directory** out of it — the `directory` column is the
runner's WORKDIR, passed to the readout as `OPENCODE_DIR`, because the shared per-member database
means two concurrent tasks would otherwise scrape whichever task closed last (observed 2026-09-11:
two `/fix` tasks recorded one session id, and both their follow-ups resumed the same conversation;
a readout whose scope matches nothing answers nothing, loudly, rather than falling back to the
newest row). The same read answers **how the run's last message ended** — opencode
exits 0 even when the model's context limit cuts a task short mid-investigation, and only the
session database knows — so a finish reason that is not `stop` is reported as a FAILED run, the
reason in the output, despite the exit code. The read also lifts the **context the run reached**
(the last assistant message's token total), the run's summed cost, and the **last provider error**
the session recorded — so a premature stop names its cause (`Rate limit exceeded`, observed the
same day: a 429 cut a run off mid-tool-call) instead of leaving the author a finish reason to
decode. The error rides the verdict only beside a premature stop: a run that finished cleanly is
not footnoted with an error it already retried through. The context and cost merge into the
runtime vitals — the finished task shows `ctx 90,433 tok`, which is where a context death is
legible. The id is reported while the lease is still live, before the verdict, because a follow-up
resumes exactly that row. Their runs still emit OTLP, but the server's
metric map carries no opencode rows yet, so spend records as an unmapped agent — null, never zero
— until those rows are added (see [limits.md](limits.md)). `RUNNER_SKIP_PERMISSIONS` applies only
to claude-code tasks; opencode's permissions come from the `opencode.json` baked into its image —
see [its README](../docker/opencode-executor/README.md).

**Any executor can resume its own sessions.** A follow-up claim carries the session id the parent
run used, whatever CLI minted it: claude-code restores with `--resume <uuid> -p <command>`,
opencode with `run --session <ses_…> <command>`. A driver may run Claude Code and OpenCode tasks concurrently; the claim, not the process, owns the
choice.

### The executor transcript store (issue #55)

**Claude-code transcripts now survive the container.** The runner images used to be the
one path that lost them: the CLI writes `projects/<path>/<session-id>.jsonl` under
`CLAUDE_CONFIG_DIR`, which lived on the container filesystem, and the container is removed at
every run's end. The driver now composes a per-thread directory from the claim's own fields —
`<mount>/<workspacePath>/.factory/transcripts/<rootJobId>/`, the same `<org>/<uuid>` workspace
path `WORKDIR` uses and the same root id the task worktree is keyed by — and passes it to the
runner as `FACTORY_TRANSCRIPT_DIR`. The entrypoint makes it `CLAUDE_CONFIG_DIR` before anything
else runs, so transcripts land on the workspaces volume the moment the CLI writes them — no
post-run copy, no loss window, on both executors (docker and kubernetes run the same images and
the driver passes the same env on both). The leading-dot `.factory/` namespace is never mistaken
for a checkout by the workspace reconcile.

**The baked configuration rides along.** The `/opt/claude-home` seed is keyed on
`settings.json` being absent, so the first attempt of a thread seeds the baked git guard and
settings into the thread directory and every later attempt of the same thread finds them.

**Resume is the side effect the design leans on.** `--resume` resolves the session inside
`CLAUDE_CONFIG_DIR`, and the root id is stable across every attempt and follow-up of a thread —
so a follow-up is pointed at the same directory its parent wrote and can actually find the
session it names. Before this store, a follow-up resumed against an ephemeral config
directory, where the session did not exist.

**What persists, per path.** Claude-code: the thread directory on the workspaces volume
(this store). Opencode: its own per-member sqlite database under `XDG_DATA_HOME` (above) —
already persistent, deliberately not duplicated.

**Out of scope, deliberately:** reading or analyzing transcripts (the factory-stats dashboard's
eventual use — it needs the bytes to exist first), board ingestion, retention policy (unbounded
for now; the `.factory/` namespace makes a future sweep easy to aim), and re-homing opencode's
database. `FACTORY_TRANSCRIPT_DIR` is
reserved from member configuration on both the driver and the board (see
[env.md](env.md)) — the value the runner receives is always the driver-composed one.

## Auxiliary services (`.bellows.yaml`)

**A checkout can ask for the containers its tests need.** A `services:` list in a `.bellows.yaml`
at the root of any checkout in the author's workspace — Drone's services syntax, trimmed to what a
test run actually needs:

```yaml
services:
  - name: db
    image: postgres:16
    # The postgres entrypoint chowns PGDATA as root before dropping down, which needs
    # capabilities the default hardening takes away. See "The hardening, and the opt-out" below.
    unhardened: true
    environment:
      POSTGRES_PASSWORD: secret

  - name: cache
    image: redis
```

With services on (`RUNNER_SERVICES`, **on by default** — `RUNNER_SERVICES=0` opts out), the driver
reads every checkout's file before the run —
through a throwaway container over the workspaces volume (a readout Job over the PVC under
kubernetes), because it has no host path into a named
volume — starts one detached container per service, and puts
the runner on the same user-defined network. **The service's `name` is its DNS name inside the
job** — for the runner AND for the job's gates: `postgres://db:5432` resolves from the agent's
turn, from its ad-hoc gate calls, and from the declared gates after it, and to nothing once the
attempt is over.
Service exit codes are ignored, and there is no health wait: the agent can watch a service refuse a
connection and retry, which is what agents are for.

- **The merge across checkouts is a union, and a duplicate name fails the job.** The claim does not
  say which repository a job is about — `job.repo` is tasks-UI metadata — so every checkout's file
  applies, capped at ten services across the workspace. The readout globs the CLONES
  (`<ws>/*/.bellows.yaml` — a shell glob skips dot-directories, which is also why the task
  worktrees beside them are never read twice): a task that edits its `.bellows.yaml` in its
  worktree therefore runs the services its branch inherited from main, and an edited services
  half applies from the thread's next worktree-based read — gates, by contrast, are read
  worktree-first. Two repos defining `db` would race for one
  alias, and no first-wins or last-wins rule reads as anything but "the wrong database came up", so
  the job fails naming both.
- **A runner that joins both networks needs Docker 25.0.** Multi-network container create landed
  in API 1.44; on older daemons `--network` is single-valued and the last one silently wins, which
  with `RUNNER_NETWORK` set would drop the runner's telemetry without an error. A deployment that
  runs services plus a telemetry network runs a current docker.
- **The docker executor's volume mounts need Docker 26.1.** Every container the driver starts —
  runner, gates, sync, readouts, publish steps — mounts the workspaces volume with
  `--mount type=volume,…,volume-subpath=<orgId>/<userId>,target=<mount>/<orgId>/<userId>`, the
  option's spelling of the kubernetes executor's `subPath`, so both executors grant a container
  the same subtree at the same consumer paths. `volume-subpath` landed in Engine 26.1; on an older
  daemon every claim fails on a mount error rather than running against a broader mount.
  `docker version` before pointing a dev driver at a host daemon.
- **The hardening, and the opt-out (issue #382).** A declared service runs an image this project
  did not build, named by a repository author, so it is hardened like every other container the
  driver starts: every capability dropped (`capabilities.drop: [ALL]` / `--cap-drop ALL`), no
  privilege escalation, the runtime's default seccomp profile, and no ServiceAccount token. **That
  default breaks a large share of stock images**, because the common entrypoint chowns its data
  directory as root before dropping down to an unprivileged user — `postgres`, `mysql` and `redis`
  with a persistent directory all do — and `drop: [ALL]` takes away the `CHOWN`, `DAC_OVERRIDE`
  and `FOWNER` that needs. The symptom is a container that exits immediately with a permission
  error, not a security message.

  The escape hatch is one key, `unhardened: true`, and it gives back **the image's default
  capability set and nothing else**: the container still may not escalate privileges, still runs
  under the default seccomp profile, still has no cluster credential and still cannot mount a host
  path. It is a declaration in the repository rather than a cluster setting, so the relaxation is
  visible in review — and it is per service, so one database opting out does not relax the rest of
  the fleet. Its cost is legible: among what comes back is `CAP_NET_RAW`, on a network shared with
  the runner and every other declared service. Grant it to the service that needs it, not to all
  of them. `unhardened` takes the literal `true` and nothing else — `yes`, `on` and `1` are
  refused, so the one key that loosens a control cannot be set by accident.

- **The parse is strict to the point of rudeness, deliberately.** Unknown keys are refused, which
  is what makes a pasted Drone pipeline fail loudly instead of doing nothing — and `ports:` is an
  unknown key. There is no host port publishing and no volume mounting: the daemon executing these
  argv is root on the host, and a published port is the one step from "a database for my tests" to
  "a listener on somebody's machine". One exception, not leniency: a top-level `environment:` block
  is the gates half of the file (read by the board's own parser, below), and one file may carry
  both halves — the services parser skips it wholesale and judges only its own grammar. Size is
  bounded where author content crosses into this
  process or onto an argv: a `.bellows.yaml` is read only to its first 64 KiB (the readout refuses
  the rest in place), an environment value is at most 8192 characters. A parse refusal fails the
  job terminally with the reason in the output, rather than burning attempts on a file that cannot
  change.
- **The fleet is fenced like the runner, and scoped like it too.** Service containers and the
  network are labeled `factory.job` and `factory.lease`, and named after the job id AND the lease
  token (`factory-job-<id>-<token>-svc-<name>`, `factory-job-<id>-<token>-services`). The
  re-claim fence — the one job-scoped sweep, run before anything is created — removes every
  leftover container and network of the job by the `factory.job` label, previous attempts'
  services included; the teardown after the gates, on kill, on timeout filters by `factory.lease`,
  so it can only ever remove the attempt's own fleet. Teardown is the feature's own machinery,
  but the fence runs regardless of the flag, so a fleet from before a `RUNNER_SERVICES` flip off
  meets the next claim's fence all the same; reclaim a fleet that has no next claim by hand with
  `docker rm`/`docker network rm` — by the `factory.job` label, since the names now carry the
  attempt token, and pruning the workspaces volume removes neither.
- **The orphan reaper is what replaces "reclaim by hand" (issue #301).** The fence only runs when
  a later attempt of the same job reaches its `prepare()` — a job that ends `dead` (attempts
  exhausted), a later attempt that dies before `prepare()` (a pre-run helper refusing, a checkout
  sync throwing), or an attempt whose own driver crashed after starting its fleet, all leave
  objects nothing would ever look at again. So the driver runs a periodic watcher, independent of
  any claim: enumerate every object carrying the service label (`factory.service` — service
  containers under docker, service pods and their headless Services under kubernetes), group by
  `factory.job` + `factory.lease`, and ask the board once per batch what it thinks of those ids
  (`POST /api/jobs/leases`). Reap when the job is terminal (`succeeded`/`failed`/`dead`/`stopped`)
  or unknown to the board, or when the object's lease is not the job's current one (including a
  job holding no lease at all). NEVER reap the live attempt's objects — its teardown and the
  fence own those, and attempt-scoped names mean the reaper cannot reach them even by mistake.
  The fence's no-clock rule is preserved in a weaker form: age (the object's creation time) only
  ever DEFERS an action the board state already decided, inside `DRIVER_REAP_GRACE_MS` — it never
  decides one. A board that cannot answer the lookup reaps nothing: absence must be proven for
  every id, which is why one org board failing 503s the whole batched route. Deletes are
  idempotent and board-gated, so there is no leader election — every replica sweeps.
  `DRIVER_REAP_INTERVAL_MS=0` disables the watcher; the default is five minutes.
- **A refused read or a refused service start is infrastructure, not a verdict.** Thrown, so the
  job goes back to its lease instead of being reported failed — the distinction "a run that never
  started is not a failed job" draws, one layer out.
- **The security posture is stated, not solved.** This lets a repo author run arbitrary images
  through the driver's socket — one capability the runner container deliberately does not have. It
  is the same trust the checkout already carried: the agent runs arbitrary code in that tree, and
  the tree now also names containers. What it does not do is widen the blast radius across
  members: services are per-job, on a per-job network, reachable only from that job's runner and
  its gate environment.
- **The fleet outlives `run()`; the loop tears it down after the gates.** The declared gates run
  after the agent finishes, and they are what tests against the services — so `run()` leaves the
  fleet up and the loop calls `Runner.releaseServices` once the gates are done, in the same
  `finally` that releases the gate session, on every exit path (a thrown run included). Torn down
  inside `run()`, every service-backed gate failed on a name that no longer resolved
  (`ENOTFOUND test-mongo`, observed 2026-09-25 under kubernetes). `kill()` still takes the fleet
  down at once. On docker the gate environment is a separate warm container, so before each gate
  it joins the attempt's services network (`docker network connect`, once per attempt — the
  network is named after the lease); a job with no services has no network and the refused
  connect is ignored. Docker refuses to remove a network with an endpoint attached, so the
  teardown detaches whatever is still on it first. Under kubernetes a gate pod carries the
  attempt's service search domain in `dnsConfig`, the same one the runner pod does.
- **Both executors run them.** Docker starts sibling containers on a per-job network; kubernetes
  starts service pods under a per-attempt headless Service ([kubernetes.md](kubernetes.md),
  "Gates and services on this platform"). `RUNNER_SERVICES` decides whether they run at all, on
  either platform — nothing about the flag is executor-specific.
- **The fleet is visible in the task view.** Each vitals flush carries the attempt's service
  states under `runtime.services`, and the task view renders the newest attempt's last observed
  states in a Services section beside the thread's context and cost. The states freeze when the
  attempt ends — the fleet is torn down, and what remains is the attempt's record of it, the same
  record-not-liveness rule the verdict and exit code follow. See "The vitals ride the same flush"
  above for the read, the merge and the claim-time clear.

## Block-helper steps (issue #207)

**Read this before touching** `driver/src/helpers.ts`, `driver/src/k8s-helper-runner.ts`,
`driver/src/loop-helpers.ts`, or the `Runner.runHelper` seam (declared in `driver/src/runner.ts`,
implemented for docker by `dockerRunHelper` in `driver/src/docker-runner.ts`).

A workflow `block` node (docs/workflows.md) may declare an allowlisted, board-owned helper to run
before and/or after its agent turn — a runtime plan naming a helper id, its phase (`pre`/`post`),
validated/bounded JSON input, and whether it writes to GitHub, never arbitrary shell or an image.
`BoardJob.helperPlans` carries the declared plans on a claim; `runWorkflowHelper`'s seam is
`Runner.runHelper(job, plan, token?)`, one shared `HelperResult` either side answers.

**This issue shipped transport only; issue #122 is the first real producer.** `WorkflowNode.helperPlans`
(#122) is what a block's `expand()` populates — `builtin/merge-conflict-autofix`'s `repair` node
declares one, `merge-conflict-probe` — and `job-store-claim.ts`'s `resolveClaimHelperPlans` resolves
it onto the claim generically (docs/workflows.md, "Built-in blocks"); `BoardJob.helperPlans` is
still read defensively (absent on every claim outside a block's own expansion), exactly like
`job.env` on a board that predates it. The `noop` fixture — echoing its bounded input back — stays
shipped alongside the real one, proving the transport end to end independent of any block's own
content. Issue #133's `github-review-reconcile` block is the second real producer: its own
`review-collect-probe`/`review-reply-probe` descriptors (`driver/src/review-helpers.ts`) wrap
issue #201's unmodified `review-collect.cjs`/`review-reply.cjs` — never edited — inside a small
ADAPTER, composed at driver LOAD time (never in the container) from prelude/postlude files that
map the transport's bounded `HELPER_INPUT` onto the env those scripts read and reshape their bare
verdicts into this transport's `{schema, version, ok, output}` envelope; see
docs/workflows.md, "The github-review-reconcile block". This issue's own scope was only the
generic seam, both transports, and the loop's fencing — #122 and #133 each added their own helper
descriptors (`driver/src/helpers.ts`, `driver/src/review-helpers.ts`) and #122 the claim-side
resolver, none of which touched this seam.

- **The loop owns WHEN a helper runs.** A PRE helper runs as the last step of `runSetup`
  (`driver/src/loop-helpers.ts`'s `preHelperStep`), fenced by the exact same lease/stop race
  (`raceStep`, `down(state)`) every other setup step uses: a Stop or lost lease observed mid-helper
  stands the attempt down without ever launching the agent, releasing the kubernetes checkout fence
  the same way a failed gates-reread does. A required pre-helper that answers `{ ok: false }`
  reports a NAMED failure (`reason`, `message`) and the agent never spawns — `state.launched` never
  turns true. A POST helper runs in `runPostHelperPhase`, in the same window `runDeclaredGates`
  runs in — after the agent and its gates have resolved, heartbeat still live, `settle()` not yet
  called — and runs UNCONDITIONALLY once reached (deciding otherwise on the run's own outcome would
  be block-specific policy this generic transport must not encode, per the issue's ownership
  boundary); a failed post-helper fails the verdict and skips publish, the same way a failed gate
  does. A job with no declared plans, or a runner with no `runHelper`, pays no extra branch at all.
- **A github-writing helper gets a fresh installation token, minted immediately before it runs** —
  the loop asks `board.publishToken(job)` (the same re-mint the publish flow itself uses;
  docs/jobs.md's "The publish asks for its own credential" above) and lays it over the claim env
  through the existing `withPublishToken`. A read-only helper (`plan.githubWriting: false`) runs
  with the claim env untouched, asking the board for nothing. Either way the token never enters
  argv, a pod spec, or stored output — it rides the same env-file (docker) / per-attempt Secret
  (kubernetes) every credential here already does.
- **Unknown/unavailable helper ids fail before any container or Job starts.** `lookupHelper` closes
  over real files under `driver/src/scripts/` (never a path, never inline TS — the same
  content-passed convention every script here follows); a plan naming an unregistered id answers
  `{ ok: false, reason: 'unknown_helper' }` before either transport touches the daemon or the API
  server.
- **Output is parsed as versioned bounded JSON, and nothing else.** `parseHelperOutput` checks the
  byte cap BEFORE attempting `JSON.parse` — an oversized answer is never handed to the parser at
  all — then the `schema`/`version` fields, then an `ok: false` line's own named `reason` (one of
  `unknown_helper` / `malformed_output` / `oversized_output` / `wrong_version` / `auth_failed` /
  `timeout` / `runner_error`), falling back to `runner_error` for anything a script names that this
  module never declared. Malformed, oversized or wrong-version output is a helper FAILURE, never
  agent context — the same discipline the review scripts' own bounded verdicts already carry.
- **Docker runs the helper in the task worktree, over the existing runner image, under its own
  attempt-scoped, per-call NAME** — never `--rm`: `execDocker`'s `timeout` kills the `docker run`
  CLIENT process, not the container the daemon may still be running, so `--rm` (which fires only
  when the daemon sees the container itself exit) could leak one on the timeout path — the same
  reason `dockerRun`'s own runner container skips it. The `finally` removes the named container
  explicitly and unconditionally instead, tolerating one already gone, exactly as `dockerRunVerdict`
  does for the runner container. Otherwise: entrypoint swapped for `node`, the script passed by
  content, the bounded input as one literal `-e HELPER_INPUT=` value (never a credential, the same
  class as the sync's `REPO`/`WORKTREE` literals), attempt labels, and an env file only when the
  helper writes to GitHub. Kubernetes runs the identical entrypoint/argv/script content as an aux
  Job on the task PVC — the same shape `publishStepJobSpec` already uses for one publish step — with
  its OWN per-call nonce in the Job/Secret name (never a bare `(job, plan)` hash, which would
  collide the moment two plans of one phase ever name the same helper — `gateJobName`'s run counter
  closes the identical hole for gates), an attempt-scoped Secret only when needed,
  `HELPER_TIMEOUT_MS` (shared between both transports) as its `activeDeadlineSeconds`, and a
  `DeadlineExceeded` condition read back as the named `timeout` failure (`k8s-poll.ts`'s
  `helperVerdict`, the same check `pollRunnerJobUntilTerminal` makes for the runner Job). Both
  transports clean up their Job/Secret and env file on every exit path.

### Conclude control and composite helper programs (issue #230)

**Neither transport changed for this issue.** `dockerRunHelper` and `k8s-helper-runner.ts`'s
`runHelper` only ever resolve `lookupHelper(plan.helperId)` against a single plan — they know
nothing of phases or composites — so both of the gaps below are closed entirely inside
`driver/src/helpers.ts` (pure sequencing/registry) and `driver/src/loop-helpers.ts` (the loop's own
fencing around each child call). Docker/kubernetes parity for both is therefore a property of the
orchestration being platform-agnostic, not something either transport had to grow.

- **A successful PRE helper may answer an explicit control outcome** (`HelperResult.control`):
  `continue`, the default — absent from the wire verdict reads the same way, so every script that
  never adopts the field keeps its exact pre-#230 result shape — or `conclude`. `conclude` is valid
  only for a pre-helper; `preHelperStep` completes the job `succeeded` right there, through the
  SAME `rt.report` call site an ordinary setup failure uses, with `formatConcludeOutput(result.output)`
  as the verdict's `output` — a string passes through verbatim (so a helper's own marker
  convention still lands on the exact final line the workflow engine's marker edges read; "The
  edge vocabulary" in docs/workflows.md), anything else is JSON-stringified. The agent never
  launches, no gates run, no post-helper runs, and publish is never asked for — `preHelperStep`
  returns `STOOD_DOWN` exactly as a pre-helper failure does, just with a succeeded verdict instead
  of a failed one. A POST helper naming `conclude` is invalid usage and fails the verdict with a
  named `invalid_control` reason, exactly like any other post-helper failure — conclude is a
  pre-only outcome, decided before the agent, never after it.
- **`CompositeDescriptor` is an allowlisted, host-side helper PROGRAM**: a registered id (disjoint
  from every script id, validated at module load — a collision, an empty or oversized step list, an
  unregistered or nested step id, or a non-function planner/finalizer throws synchronously, so a
  malformed registration never reaches a claim) naming an ordered list of registered SCRIPT steps
  (never another composite — no nesting) plus two pure functions: `planStepInput` computes one
  step's bounded input from the previous step's bounded output and the composite's own declared
  input, and `finalize` folds every step's output, once all have succeeded, into the composite's
  own bounded result and its own continue/conclude control. `runHelperPlan` (`helpers.ts`) is the
  shared sequencing algorithm: a plain script plan is a single call through the caller-supplied
  `invokeChild`, unchanged; a composite plan sequences its steps through the exact SAME
  `invokeChild` — so every child still rides whatever fencing, per-call token-minting and bounded
  I/O the caller already applies to a lone plan, one call per step, in declared order. A composite
  plan cannot itself declare `githubWriting: true` (`invalid_composite_plan`, fails closed before
  any child runs) — each step declares its own, minted only when that step actually runs, the same
  "fresh write-token" rule every other github-writing helper follows. A child's own failure
  propagates as the composite's own failure, unchanged and un-wrapped (its own named `reason`
  survives, e.g. `timeout`) — no step past the failing one ever runs. `invokeChild` answering
  `null` (a stop, a lost lease, mid-composite) abandons the remaining steps and `finalize`
  immediately, observed BETWEEN children, not just around the composite as a whole. The one
  shipped composite, `sequence-fixture` (two `noop` steps), exists for the same reason `noop` does:
  proving sequencing, intermediate planning, output propagation and conclude/continue end to end
  with no real block's own scope involved.

## The session id

**The driver mints it; it never reads it back out of the container.** `claude --session-id
<uuid>` takes the id as an input, which removes the whole problem: there is no output to parse, no
race between the container printing and the driver reading, and a runner that dies in its first
second still leaves a job with a session on it. It joins a job to its telemetry. Under opencode
the driver mints none — opencode mints its own, and the driver scrapes it after the run (see
above).

It is reported **before** the container is spawned, on its own route rather than folded into the
completion, so it is on the row while the job is still running. The report is deliberately
non-fatal — a board that is briefly unreachable costs the link, not the run — and a `409` on it is
not acted on, because the heartbeat is the one place that decides a superseded run must die.

**A refused start takes its minted session back.** The id is on the row before the runner knows
whether it will start the agent, and a refused start (`RunOutcome.refused` — a `.bellows.yaml` the
parser rejects, a service name another job holds) never does: no transcript exists under that id.
Left on the row, a follow-up would inherit it and `--resume` straight into `No conversation found
with session ID`. So the loop reports `sessionId: null` for a refused run whose session it minted;
the row settles sessionless and the follow-up is refused `NO_SESSION` up front. A refused
follow-up keeps its session — that one is the parent's, and its transcript is real.

The id is cleared on every claim, for the same reason `started_at` resets — except on a
follow-up's claim, where the session genuinely is the same one. The attempt that died ran a
different session, and showing its link next to this attempt's output points a reader at work that
was thrown away.

## The close-time agent-turn read, and the run summary

**Every run banks one number at close: its agent turns** — one assistant response cycle in the
run's ROOT conversation, subagent conversations excluded (the definition of record is the
terminology block in docs/metrics.md, where "job turn" and "agent turn" are kept apart; no
figure or label says a bare "turns"). No OTLP metric carries turns — the arriving metric set is
closed — so the count comes from the session's own records, taken by the driver at run close and
reported on the completion report as `agentTurns`; the board stores it on the job row
(`job.agent_turns`, the only migration this feature needed). The SAME reads lift the run's
**summary** (`job.summary`, 028) — the agent's last words, what the run actually did, shown on the
task page's run and the inbox row; the command records what was asked, never what was done.

- **opencode**: `opencode-readout.cjs` already walked the root session's messages — the count is
  a counter in that loop, emitted as `turns` on the readout's JSON line. The session selection
  (`parent_id is null`) is what excludes subagents; there is no second read. The summary is the
  last assistant message's text `part` rows, collapsed to one line by the script; a database
  whose schema predates the `part` table costs the summary alone, never the rest of the line.
- **claude-code**: the transcript lands on the workspaces volume under `FACTORY_TRANSCRIPT_DIR`
  (the runner's `CLAUDE_CONFIG_DIR`), so the driver reads it AFTER the run exits as a throwaway
  container over the volume — nothing dies with the runner, and there is no teardown to race.
  `claude-turns.cjs` (a real file under `driver/src/scripts/`, passed by content) finds the run's
  session transcript by glob and counts `type: "assistant"` entries that are not sidechains.
  The summary is the last such entry's text blocks, collapsed the same way.
- **kubernetes**: the twin of the docker read — the same script as one aux Job over the PVC
  before the runner pod goes. Both platforms produce the count and the summary through their own
  close-time read (executor parity, docs/kubernetes.md).
- **A follow-up reports its own delta, not the resumed whole.** The conversation a follow-up
  resumes already carries the earlier runs' cycles, so the driver bounds each close-time read to
  the run's own start (passed as an env value): opencode counts root messages created at or
  after it, claude-code the transcript entries written at or after it — and the summary is
  bounded the same way, so a follow-up's last words are ITS last words. The task total is the sum
  of per-run turns — a first run of 9 and a follow-up of 4 bank 13, never 9 + 16.
- **The summary is prose, bounded, and null is the contract for none**: a run cut off
  mid-tool-call has no final text, and null means exactly that — never an empty string, never a
  fabricated line. The driver truncates to one line (400 characters) and the completing route
  re-bounds it; the board's list read carries it for the recently-completed view (#109). Since
  the terminal list became one row per task (#124), the summary a thread shows there is the HEAD
  run's — the conversation's last words, the same present-tense rule the sidenav follows — and a
  null head summary falls back to the root command in the panel, never to an older turn's words.
- **Null is the contract for unmeasured**: a read that failed, a run killed before it, a
  transcript that is gone — all store null, never zero. A genuine zero-response run stores 0.
  The task statistics exclude a task with any unmeasured in-range run from the agent-turn
  distribution rather than sum it partially; its tokens and runs still count in theirs.

## Run artifacts: the full log and the transcript (issue #325)

**The rolling tail is a preview; the artifacts are the record.** `output` is a 64 KiB tail,
replaced on every report and overwritten by the verdict — investigating a failed task from a
client saw only the end of the run. So every attempt that ran to a close banks two more
artifacts (046), uploaded by the driver at close while its lease is still live, and served by
two person reads:

- **`job_artifact` (`log`)** — the attempt's full runner output (stdout and stderr, one stream),
  tail-kept at **512 KiB of UTF-8** (`ARTIFACT_LIMIT`, copied on both sides — the driver depends
  on nothing). Docker accumulates it in the same `collect` that feeds the report tail; kubernetes
  cuts it from the pod log the verdict read reads. The head is what a cut drops — a run that
  fails says why at the end — and `truncated` is true when it happened. A refused start uploads
  nothing: no log exists, and an empty artifact would claim one.
- **`job_artifact` (`transcript`)** — the agent session transcript of THIS run, the same per-run
  delta bound (`RUN_STARTED_AT` / `RUN_STARTED_MS`) the close-time turn counts keep. Claude's is
  the session JSONL the CLI already wrote onto the workspaces volume (issue #55's store); opencode
  has no file to point at, so the export is a reshaped view — one JSON line per message,
  `{role, time, text}`, from the same sqlite database the readout walks. Both exports self-cap to
  the same 512 KiB, line-aligned, and say what they dropped in a marker line the driver sniffs,
  strips, and folds into the `truncated` flag. The read that produces it is one more close-time
  read, best-effort by the same contract as the turn count: a failed export costs the artifact,
  never the verdict.

**One upload route, guarded like every worker write.** `POST /api/jobs/:id/artifact
{leaseToken, kind, attempt, content, truncated}` — the guard and the upsert are one statement (a
CTE that answers only under a live lease), so a superseded worker's report inserts nothing; keyed
`(org, job, kind, attempt)`, so a retried upload overwrites its own row and two attempts never
overwrite each other; upsert, never append. The upload lands before the verdict on the ordinary
finish path and before the park on a stop — both while the lease is live — and is best-effort
like every telemetry send: a failure is a log line, never a throw into the finish path, and a
`409` from it is not a kill order (the `/output` rule). Content is sliced to the cap at the
route, which forces `truncated` when it cut — the reader can trust the flag.

**Retention is the job row's lifetime; there is no TTL sweeper.** `on delete cascade` from
`job`, the same rule `output` and `gates` follow: Remove deletes the thread's artifacts with it,
and nothing prunes a finished task's record behind its reader's back. The issue's TTL question
is answered the way this board answers every retention question: the artifact is part of the
audit row, and the row is the retention policy.

**Reads are person reads, paged by characters.** `GET /api/jobs/:id/log` and
`GET /api/jobs/:id/transcript`, resolved through the same route guard as the job read they
extend — the org is the credential's, and an artifact is answerable only inside the org whose
job produced it. `?attempt=` names an attempt (absent reads the newest stored, what an
investigating reader wants by default); `?offset=`/`?limit=` page, JSON envelope, no HTTP
`Range`; an offset past the end answers an empty page. `404` when nothing was uploaded — no
artifact is fabricated, and "nothing retained" stays sayable.

**Secrets stay out by construction, and the pins say so.** The artifacts are built from the
runner's own stdio and the volume transcript; the claim env never enters either — the env file
is written around the spawn and removed at the close, and no artifact read touches it. The
driver suite pins this where the bytes are made: the full log must be STRICTLY EQUAL to the
runner's own stream (any driver-side injection, an env value included, would break the
equality), and the argv pins assert the export scripts' text carries no board-derived value.
(An agent can still `printenv` inside its own container — docs/security.md's boundary — which
is why masking was never the design; the constraint is that THIS driver's code never writes a
credential into the store.)

**Kubernetes parity, with one stated limit.** Both transcript exports run as aux Jobs over the
PVC (`factory-ctrans-` / `factory-otrans-`, twins of the turns/readout Jobs), and the full log
is cut from the same pod-log read the verdict uses — one close-time read shape per executor, on
both platforms. The limit: a kubernetes runner Job whose pod is gone before the verdict read
(deleted mid-run on a kill, reaped by its TTL) uploads no log — docker's streamed accumulator
survives its container, a pod log does not survive its pod. The absent-artifact 404 is the
documented answer, tested as the nothing-retained path.

## The structured failure kind

**Every failed run names WHY it failed in one queryable column** (`job.failure_kind`, 044, issue
#339): the driver reports `failureKind` with the verdict, the route validates it against the six
known spellings (`400 BAD_FAILURE_KIND` otherwise), and every job read — detail, thread, both list
shapes — serves it, so "how many timeouts this week" and "timeouts where the gates passed" are
queries, not archaeology through output tails.

- **`timeout`** — the `DRIVER_JOB_TIMEOUT_MS` kill (see the env table above for the active/idle
  note that rides the same verdict's output).
- **`cache_lost`** — the prompt-cache watch kill (`RUNNER_CACHE_WATCH`).
- **`gate`** — a declared gate ran and failed. Reserved for a gate RUN: the setup refusals (a
  gates file that cannot be read, a driver started with no gate environment, a gate environment
  that will not start) are `runner_error`, not `gate`.
- **`helper`** — a declared pre- or post-block-helper step failed.
- **`publish`** — the deterministic publish ran and its work did not land.
- **`runner_error`** — every other failed ending: a non-zero exit, a premature finish, a refused
  setup (claim refusals, a failed checkout sync, an unrunnable executor selection or master
  prompt). The precedence when several conditions land on one verdict: timeout, cache, gate,
  helper, publish, then runner error.

**Null is "not a failure"** — a succeeded run, and every row that predates the column (there is no
backfill; a historical tail usually does not name a kind and guessing one would manufacture
history). The verdict's overwrite is the only write, so an absent kind overwrites to null like
`agent_turns` does.

## The park (`suspend`)

`suspend` is how a worker lands a user's Stop: the heartbeat delivers the stop stamp, the worker
kills its runner, and the park settles the row `stopped` — terminal, the session kept for the
follow-up that continues the turn.

**`suspend` hands back the attempt the claim took.** Parking is not a failed try, and without the
give-back a job stopped three times is `dead`. A run that keeps killing its worker still burns
attempts normally, because that path never reaches `suspend`.

**`suspend` also expires the lease**, exactly as insert does it. A stopped row is not claimable, so
this changes nothing while it sits.

## Follow-ups and done: a task is over when the user says so

A run finishing is not a task finishing. `POST /api/jobs/:id/follow-up {command}` queues
an adjustment on a **finished** task — `succeeded`, `failed`, `dead`, or the user's own
`stopped` — as a continuation of what it just did, and `POST /api/jobs/:id/done` records the user
closing the task by hand. Between "the executor stopped talking" and "I am satisfied" sit as many
rounds of "again, but tighter" as the human wants.
Done is also what frees the task worktree: until the user closes the thread, its tree stays on
the volume whatever the runs' verdicts were (issue #47, revised — see the reclaim section
below).

**A follow-up is a NEW job row, never an edit of the parent.** `job` is an audit record of what ran
(the `created_by` precedent), and overwriting the parent's command or output would erase the very
run the user is following up on. The audit-record rule scopes the one edit that DOES exist
(issue #329): `PATCH /api/jobs/:id` rewrites a QUEUED row's command — a row that has run nothing
has nothing audited to overwrite — and refuses everything else (`409 NOT_QUEUED` once claimed,
`409 WORKFLOW_COMMAND_FROZEN` for the prompt-built commands, `403 FORBIDDEN` for any account but
the author's, null-safe both ways). The new row carries `parent_job_id` — it is one row per RUN, but
still one TASK to the member: `GET /api/jobs/:id/thread` resolves any member's id to the whole
chain, the task page renders it as one conversation, a follow-up extends the view in place instead
of navigating away, and the sidenav lists thread roots only — copies of the parent's `repo`,
and `session_id` from insert. The
repo copy keeps the thread under its repository's name in the task list; the session copy is what makes the claim resume the parent
conversation without any new claim-side rule. The thread's frozen `workflow_name` (033) is
inherited the same way, so every turn of a workflow task carries the name the member chose at
create. Every row also carries `root_job_id` (022): the
thread's root, stamped from the parent at follow-up insert and from itself at first insert, next to
the copied labels. It is the same fact `parent_job_id` implies without a walk, written once so the
composite is SERVED rather than re-derived — the thread read, the claim's worktree root and
thread-exclusion, the verdict's terminality and remove's whole-thread delete all key off it, and
the `/api/jobs` list carries it so the UI can resolve any turn to its task even when the poll's
capped window no longer holds the root row itself.

**The terminal list groups by it too (#124).** `GET /api/jobs?status=terminal` answers one row per
TASK, not per run: the settled verdicts fold by `root_job_id`, identity fields from the root,
present-tense fields (status, summary, runtime, session, started) from the chain head — the newest
member, the `chainHead` rule the sidenav renders — the wall clock and the completion stamp the
thread's sum and max, and the done from whichever member carries it. A thread with a member still
queued or running is not completed and is excluded whole; ordering is by the thread's
newest completion, and the limit bounds tasks. The recently-completed dashboard panel is the
consumer; the per-run lists the tasks pages poll are unchanged.

**A follow-up is the author's, because of where the resumed session would run.** The child inherits
the parent's `session_id`, and a session resumes only coherently in the checkout tree it ran in —
the AUTHOR's. The workspace invariant already settles that a member's command only ever runs in
their own tree, and running the follower's command in the author's tree is not an option either, so
the insert-select also requires the parent's `created_by` to be the caller, and a mismatch answers
`403 FORBIDDEN`. It is the last refusal checked: a sessionless parent answers the truer `NO_SESSION`
whoever asks, and a caller with no account can only follow up a task with no author — the state
every task queued before accounts existed is in.

**Every refusal is decided atomically with the insert.** One conditional insert-select requires the
parent to be finished, not done, to carry a session, and to be the caller's own task — and it takes
the parent row's lock, so it cannot race a completion, a second follow-up, or another request's
`done` from a stale snapshot. The read that names which precondition failed runs only when nothing
inserted, and a parent that moves on between the two can make a refusal name the newer state; the
retry succeeds. `409 NO_SESSION` is the interesting one: a parent whose run never reported a
session has nothing to continue, and starting a fresh run would look like a continuation while
carrying nothing over — every task run before the session mechanic existed, and any run whose
driver died before it could report. Since 016 the session id is whatever the executor minted — a
claude uuid or an opencode `ses_…` — so every executor with a reported session can be followed up. Marking a task done is likewise terminal-only, and idempotent by `coalesce` on `done_at`, so a
retried click answers the first verdict's instant rather than rewriting it.

**All three insert paths take the author's checkout row's lock (issue #92).** Root creation,
follow-up insertion and retry insertion (issue #326) check the AUTHOR's `user_repo` row for the
task's repo NAME — by name, because
the directory is keyed by name even when an old task's `owner/name` label differs — inside the
same transaction as the job insert, `for update` BEFORE inserting. `purging` answers
`409 PURGE_IN_PROGRESS`: a checkout that is being manually deleted must not have a task queued
into it. The lock is the point, not a preflight query: an insert that commits before the purge's
stamp is visible to the stamp's unfinished-task count (so the purge refuses with
`TASKS_IN_FLIGHT`), and an insert that arrives after the stamp re-reads `purging` under READ
COMMITTED once the lock is granted (so the insert refuses). An unlocked check would read a stale
snapshot and lose the race in both directions. Absence of the row is no refusal — a job may be
queued after the row is gone under the existing task contract (the rows come and go with a PUT);
that does not guarantee its later claim will find a checkout. Command-only tasks and authorless
rows are never guarded, and the workflow successor insert is not either: a purge requires the
thread terminal and done, after which no successor is inserted.

**The command is delivered on every claim, resume included.** There is no delivered-once rule: the
runner plan both executors render from (`driver/src/runner-plan.ts`) appends `-p <command>` to every
claude-code run, so a resumed claim carries its command exactly as a fresh one does
(`--resume <id> -p <command>`). A follow-up is not a special case of delivery — its command is the
NEW adjustment and the restored transcript is the conversation it continues, which is the same
argv either way.

This replaced a delivered-once rule the two executors disagreed about: docker delivered
unconditionally, kubernetes suppressed the command on a resume that was not a follow-up, and each
file's comments claimed to be the other's twin. Docker's behavior is the one that survived, so the
rule is now stated in one place and rendered by one planner.

`command_delivered_at` is left over from the old rule and no longer gates anything. `suspend()`
still stamps it (`job-store-actions.ts`) and the claim still derives `followUp` from it —
`(parent_job_id is not null and command_delivered_at is null)`, `job-store-claim.ts` — but no
runner reads that flag to decide delivery any more; `followUp` survives only in
`claimContinuesSession` (`driver/src/claim.ts`). The column and its derivation are candidates for
removal, which is a schema change and wants its own migration.

**A crashed follow-up attempt keeps the session through the re-claim, where an ordinary job's is
cleared.** The claim's keep predicate (below) extends to rows carrying
`parent_job_id`: the session holds the whole conversation, not just the dead attempt's work, and
clearing it would throw the thread away with the attempt. The command re-delivers on that re-claim,
which is the ordinary retry semantics for a run.

**Retry (issue #326) is the exit from follow-up's `NO_SESSION` dead end.** A finished run whose
session was never reported — the driver died before reporting, or a refused start reported its
minted session and then took it back — has nothing to continue, and before retry the only way
forward was a brand-new task that lost the thread and its worktree. `POST /api/jobs/:id/retry`
(takes no body, no lease token — a person's action on a finished task) queues a fresh attempt of
the THREAD HEAD's command — the newest member, the chainHead rule — in the same thread. The new
row copies the head's `command`, `repo`, `executor` and frozen `workflow_name` (every member
inherits those labels, so the head and the named task agree today), and carries the thread's
`root_job_id`; what it deliberately does NOT carry is
the follow-up's other two columns — no `parent_job_id`, no `session_id`. That absence is the whole
mechanism: the claim computes `followUp` from `parent_job_id` and keeps `session_id` only for a
follow-up, so a retry is delivered as an ordinary first fresh run (`resumeSessionId: null`,
`followUp: false`) with no claim-side rule added, and it lands in the thread's own worktree
because the worktree is keyed by the root. Retry never refuses for HAVING a session and never
resumes one — follow-up is the resume action, retry the fresh one. On a WORKFLOW thread the retry
row is off-graph like a user follow-up: it copies the head's `workflow_name` but carries no
`workflow_node`, so its claim's publish flag reads as absent (the driver publishes after a
succeeded gated run, exactly as it does for a follow-up) and its completion drives the transition
decision from the halted node. Refusals are decided atomically
with the insert, under the named row's `for update` lock and the same checkout purge guard the
other insert paths take: `404` unknown, `409 NOT_FINISHED`, `409 TASK_DONE`, `403 FORBIDDEN`
(author-scoped like follow-up — the thread's worktree lives in the author's checkout tree),
`409 PURGE_IN_PROGRESS`. Executor parity is by construction: the claim shape is unchanged, so
docker and kubernetes run a retried task exactly as they run a first one.

## The task summary read model: `GET /api/tasks` (#157)

`GET /api/jobs` is a RUN list — one row per job row, threads reconstructed by whichever browser
polled it — and that cannot answer the questions a task INBOX asks: how many tasks does the whole
organization have running right now, what is the root of a follow-up whose root fell outside the
newest-50 window, what changed since the last poll without refetching every run's tail. The task
summary read model is the server's answer, and the run/job endpoints keep their audit-thread and
driver contracts untouched. The store method is `listTasks(filters)`; `GET /api/tasks` is its only
route — a person route like the other board reads (session cookie or access token, never the
worker secret), its org resolved from the credential, never the query.

**One row per TASK, not per run — with the exact bucket semantics the sidenav already renders.**
The summary's identity fields (id, command, author, createdAt) are the ROOT's; the present tense
(status, doneAt, cancelRequestedAt, activity, summary) is the chain HEAD's — the newest member by
created-then-id, the same resolution `chainHead()` applies in the browser. The bucket comes from
the HEAD's status and the HEAD's done stamp exactly as `taskSections()` derives it: queued or
running → **running**; terminal without the user's done → **review**; terminal with it →
**past**. Reading the HEAD's done (not the thread's max, which the grouped terminal list uses for
its own purposes) is what makes resurrection work: a done task with a fresh queued follow-up has
a non-terminal head, so the task is running again and the done stamp is gone. The pure half of
these rules lives in `db/task-summary.ts` (`taskBucket`, `activityAtOf`, the cursor codec), shared
by the PostgreSQL query and the in-memory `memoryTaskList` so the two implementations cannot
drift; the web layer keeps title derivation and the running-only presentation rule for activity —
the API carries the head's stored line verbatim and introduces no second truncation rule.

**`attention` is the inbox view: running and review at once — everything that is not past.** The
page states are `attention` (the default), `running`, `review` and `past`; the navigation counts
stay the three buckets.

**Navigation is org-wide and filter-independent; the page obeys every filter.** The response is
exactly `{ navigation, page }`: `navigation.counts` and the running/review previews (three and
five rows, newest first) are computed from the full unfiltered task set of the organization, so a
narrowed page never moves the sidebar's numbers; `page.items` answer `state`, `q` (case-insensitive
substring of the ROOT command — search is a command search, not a global one), `repo` (exact, the
same `BAD_REPO` rules as create), `author` (case-insensitive login match on the root author) and
`sort`. One SQL statement derives the task set once for all of it — counts, previews and page read
the same rows, so they cannot disagree. A summary carries no output tail, no gate reports, no
runtime object and no session ids; the activity line is the one bounded field a list renders.

**Pagination is keyset on `(activity_at, root_id)` — never OFFSET.** `activity_at` is the head
run's newest of created/started/finished/done, truncated to milliseconds (the precision an ISO
stamp carries, so a cursor's value round-trips exactly and the exclusive comparison cannot
re-admit the boundary row). Fetch is `limit + 1`: the extra row is the only honest `nextCursor`
signal, and the cursor is minted from the last row RETURNED. The cursor is base64url JSON with a
version field that binds the sort and every normalized filter — a cursor minted under one query
is refused (`400 BAD_CURSOR`) under another rather than silently answering page 2 of a different
question. New runs landing between polls push rows forward without duplicating or skipping any.

**The task read's `terminal` predicate is also the settle long-poll's (issue #323).**
`GET /api/jobs/:id?waitFor=terminal&timeout=<s>` holds the request until a thread stops moving,
and "stops moving" is the same rule the task read buckets by (the paragraph above): the chain
head — the newest member, created-then-id — in `succeeded|failed|dead|stopped`, or an open PR
wait (036) standing on the thread. The store half is `waitForSettle(id, timeoutMs)` in
`job-store-reads.ts`: one indexed re-read every 250ms (the same single statement
`settleStateOf` evaluates each round, no connection held between polls) until it reads settled
or the deadline lands, `{ settled: false }` at the timeout — the client re-issues — and null
without holding for an id the org does not hold. A client waiting on this read and the sidenav
rendering the same thread can therefore never disagree about whether it is still moving; the
route's parameter contract (the 60s cap, the two `BAD_*` refusals) is documented in
[docs/api.md](docs/api.md).

## Stop, remove, reopen: winding a task down, deleting it, or taking the close back

Three person-gated actions (session cookie, like `follow-up`/`done` — the board secret must never move a
thread the driver does not hold). All reuse what exists: stopping lands on the suspend machinery,
removing lands on the worktree-reclaim machinery, and reopening is done's own inverse.

**Stop ends the turn.** `POST /api/jobs/:id/stop` is a person's verdict that this run should stop
talking: the row settles `stopped` — terminal, its session kept — so the follow-up composer is
what the member sees next, and the conversation continues from exactly where it was cut. There is
no resume. A queued row (never started) settles `stopped`
directly (the answer is `{ status: 'stopped' }`); a `running` row whose lease is still live answers
`{ status: 'running', cancelRequestedAt }` and the request is delivered by the worker's heartbeat —
the `cancelRequested` flag — exactly the way a lost lease is delivered, and by the same kill. A
`running` row whose lease has already expired settles `stopped` directly too (#152): nobody holds
the lease, so a stamp would wait for a heartbeat nobody will send — a previous holder that is
still beating loses the row on its next beat (the heartbeat's `lost`, the kill order) exactly as a
reclaim delivers it. While
the attempt is still setting up the heartbeat polls at ~2s, so a stop issued into the
"Waiting for the executor…" window stands the attempt down before the runner spawns and lands
`stopped` within seconds, not minutes (issue #126); the `suspend` that honours it lands `stopped`
under the stamp. The loading of the `running`
answer makes a stop idempotent: asking twice before the worker settles answers the same instant. A
row that already ended answers `409 NOT_STOPPABLE` — there is no turn left to stop, and the task's
own verdicts are the ones that outlived the run. The verdict has an actor now (025): `stopped_by`
is stamped from the session at the request — the person who asked, even though a running row
settles later — with the same first-writer coalesce as the flag, and the UI names it on the turn.

**The stop lands when the parking (or the finishing) lands, never when the request does.**
`cancel_requested_at` is cleared by `suspend` and by `complete` — parking a run IS the stop
landing, and a run that finishes under its own power before the driver reads the flag needed no
parking. The claim does not clear it either — it settles it: a driver that died mid-stop drops its
lease, and the next claim finds the stamped row expired and lands it `stopped` instead of handing
it to a new attempt (#152), the attempt handed back and the session kept for the follow-up — the
stop nobody could deliver is still a stop, not a re-run. A stop stamped into a live lease whose
worker then finishes under its own power is the `complete` case: the work the member cancelled
never parks, but it did finish, and the row's own verdict stands.

**A stopped opencode run reports the session it ran as, before the park.** Under opencode the
session id is only learned at close — the runner scrapes it out of the session database, the
driver never mints one — so the loop's stopped path reports the scraped id to `/session` BEFORE
calling `/suspend` (#152): the report is accepted only while the row still runs under the lease,
and a park-first order would settle the stopped task sessionless — `NO_SESSION` on follow-up, the
composer never appearing. Both runners await the close-time scrape before the run's outcome
resolves, so the id is final when the park lands, on docker and kubernetes alike. One narrow race
is accepted: a lease that expires between the kill and the report lets another claimer's settle
sweep land the row first, so the report and the park both answer `lost` (both swallowed, as every
superseded attempt's answer is) and the run settles stopped but sessionless — the same blast
radius as a failed readout, and unreachable while the worker was still beating.

**Remove deletes the whole thread and queues its worktree for removal.** `POST /api/jobs/:id/remove`
deletes the task's root and every follow-up — the audit rows, not just the newest run — and, in the
same transaction, inserts a `task_reclaim` row for the driver to delete the tree (see the section
above). The transaction takes the same advisory lock the claim takes, so a claim cannot slip a
`running` row between the check and the delete; Remove is refused with `409 TASK_RUNNING` while any
thread member is running, because a live run's worktree is exactly what must not come down under it
— stop first, then remove. Nothing on the row survives: the thread's nav entry, its tabs, its
Reclaim-eligible tree. The remover's actor rides the `task_reclaim` row as `removed_by` — the
thread rows are deleted in the very same transaction, so the reclaim row is the removal's only
surviving artifact, and that is the honest bound of what "who removed this" can mean once nothing
of the task remains. `done_by` (a done is also a person's verdict) is stamped beside `done_at`.

**The reclaim is its own queue, not a verdict signal.** A removed thread has no attempt to
complete, so the board hands the
tree itself out: `POST /api/reclaims/claim {worker}` returns the oldest queued row
(`{ id, rootJobId, repo, workspacePath, leaseExpiresAt }`) or 204, and `POST /api/reclaims/:id/ack`
proves it gone. The row id is the lease token, ack matches on `claimed_by`, and the driver drains
the queue in a loop parallel to its job claims — claim, remove the worktree, ack, repeat — so a
worker that dies mid-reclaim simply loses the lease and the next poll picks the tree up again. A
removed task cannot be undeleted; the worktree removal is the last thing to land, and it lands
because the rows are already gone. A done on an already-terminal thread feeds the same queue (see
the reclaim section below), so remove and done are the queue's two writers and the verdict-time
reclaim is the third path, covering a done declared while a follow-up still moved.

**Reopen is done's inverse (issue #327).** `POST /api/jobs/:id/reopen` takes back a close made by
mistake: it clears `done_at`/`done_by` on every member of the thread and withdraws a queued
`task_reclaim` row — the `TASK_DONE` refusal a follow-up would otherwise hit is gone, and the
conversation continues. It is the done stamp's only writer besides `done` itself, and the one
transaction — under the same advisory lock remove takes — is what makes it race-safe against the
reclaim claim: only rows no worker holds a LIVE claim on are withdrawn (with a re-check after the
delete, so a row claimed mid-transaction is refused, not yanked), and the withdraw's DELETE
row-locks the row out of `claimReclaim`'s candidate scan, so a row being withdrawn is never handed
out. A worker holding a live claim is mid-removal, and reopen refuses outright —
`409 RECLAIM_IN_PROGRESS`, retry once the claim settles: an ack stamps the marker
(`WORKTREE_RECLAIMED`), an expired lease — the crashed worker's relinquish, the same rule #152
applies to a lost job lease — reverts the row to withdrawable and the reopen lands. The refuse-side
is the `worktree_reclaimed_at`
marker on the root (045): "done + all-terminal + no reclaim row" is ambiguous between tree present
and tree gone — ack DELETES the row, and the verdict-time reclaim never queues one — so both points
where a removal becomes issued stamp the marker (the ack's transaction, and a `threadDone`-true
verdict's), and reopen answers `409 WORKTREE_RECLAIMED` once it is set. A thread nobody closed has
nothing to reopen (`409 TASK_NOT_DONE` — reopen is deliberately NOT idempotent), a moving thread
with an early done reopens fine (clearing the stamp is exactly the recovery; the member's verdict
then answers `threadDone: false`), and `200 { id, reopened: true }` vouches that no removal was
ever issued. The marker records the removal as ISSUED, never completed — a driver that crashes
between the `threadDone: true` answer and the actual `rm` leaves the tree on disk under a stamped
marker, and reopen conservatively refuses a thread whose tree survives; recover by removing, or by
re-done and a later reclaim, the same paths that take a tree down anyway.

**A merged PR closes its threads (issue #390).** A verified `pull_request` delivery with
`action: closed` and `pull_request.merged === true` (strictly the boolean — a missing or non-boolean
flag is an ordinary close) hands the delivery to the job store instead of the wait cancel, and one
transaction closes every thread whose recorded publication (`job_pr`) resolves to the delivery's
(org, repo, PR number): done-stamped like a manual Done, with NO local actor — `done_by` is never
written by the merge, so a pure merge close reads authorless and an earlier manual Done keeps its
instant and actor (first-writer `coalesce`, the done route's own rule). Queued members settle
`stopped` (no actor, no wall clock — a row that never ran banks nothing); already-running attempts
settle normally, and the verdict that lands in a merge-closed thread inserts no workflow successor
and no durable-wait park — the marker, not the done stamp, is what the transition reads. Open waits
cancel with terminal reason `pr merged` (a plain close keeps `pr closed`). The worktree reclaims
through the existing machinery only, and only once every member is terminal — the shared
`queueReclaimIfThreadDone` rule at closure, the `threadDone` verdict when the last member was still
running. The whole closure is keyed by the delivery in two tables (048): `pr_merge` is the immutable
ledger — a redelivery, same GUID or not, answers `duplicate` and repeats nothing, which is also what
keeps a redelivered merge from undoing a manual Reopen (the row survives reopen; reopen deletes the
per-thread marker) — and doubles as the durable merge state for a delivery that arrives before its
publication association commits: the publishing verdict's transaction reads the ledger and applies
the closure inline, so a thread whose PR merged mid-run rests instead of parking. Association is
`job_pr` and nothing else — never branch names, PR text or runner output — and a delivery for
another installation, repo or PR number reaches nothing. A member running when the merge lands
takes its done from whatever settles it — the verdict, a stop, a suspend, the dead retirement, the
claim-time cancellation fence — through one shared conditional settle, so a merge-marked thread is
never left marked-but-never-done, and the tree reclaims the moment its last member goes terminal.
One stated bound of the ledger's durability: a thread the user reopens walks again — until it
publishes to that same (merged) PR again, whose verdict re-reads the ledger and re-applies the
closure; a re-publish normally mints a new PR number, so this is the rare shape, not the expected
one.

**A reclaim that cannot settle names why, once, until what refuses changes (issue #344).** The
row is re-offered every lease expiry, so a refusal that will repeat identically — under
kubernetes, an orphaned checkout claim whose holder job the board no longer knows: the driver
that held it died, its thread was later removed, and nothing else can see a bare ConfigMap —
used to log the same line every five minutes, forever (109 in 24h in the wild). The failure
line now logs on the first refusal and on STATE CHANGES only: the digest is the refusal reason
plus the held claim's name, a settled row clears its entry, and the claim's age is reported in
the orphan line but never makes a "change". The orphan itself is proven against the board, in
the reaper's own vocabulary: `POST /api/jobs/leases` answers the root row absent or terminal —
no attempt of that thread exists or can ever come — and only then does the driver reap the
claim (uid-preconditioned; `docs/kubernetes.md` has the full protocol) and retry the removal
once, in the same drain. A live row or a refused lookup reaps nothing and logs throttled; age
is never the decider, the fence's no-clock rule.

## Gates: verification checks declared by `.bellows.yaml`

A repository may ship a `.bellows.yaml` at its checkout root declaring an environment image and
named gate commands:

```yaml
environment:
    image: node:24
    gates:
         - name: test
           command: "npm test"
```

The board reads it **at claim time, off its own workspace mount** — the driver cannot open a path
on the volume it only names, and the claim is the one place the author, repo label and workspace
path are all in hand. The read is worktree-first (`<ws>/.worktrees/<root id>`), falling back to
the clone: at claim time the worktree does not exist yet, so the clone's file answers, and the
post-sync re-read finds the worktree's — the tree the run actually edits. Missing file means no
gates; a file that exists but is outside the accepted
strict-YAML subset travels as `gateError` on the claim, and the driver **fails the job with that
reason before anything runs** — running the work while pretending its gates do not exist is the
one outcome worse than the failure. The parser accepts no YAML package: one `environment:` block,
`image:` plus a `- name:`/`- command:` list, bare or quoted scalars, comments and blank lines. A
top-level `services:` block is the one tolerated foreign key — the services half of the file,
read by the driver's own parser, which skips the `environment:` block in return; a file may carry
both halves. Anything else — tabs, unknown keys, a seventeenth gate, a flag-shaped image — is a
named error with the line number.

**A failed gate can queue a bounded repair round — board-side, driver-untouched (issue #49).**
The gate report the driver lands (`POST /api/jobs/:id/gates`, then the failed verdict) is what the
default workflow's `gate-failed` edge evaluates: the board queues a `gate-fix` round whose claim
is byte-shape identical to any gated publishing claim, so the existing claim/lease/gate/publish
machinery runs it unchanged on both transports (docs/workflows.md, "The code-owned default
workflow"). The round limit is the selected executor's configured option, frozen onto the thread
at create; nothing in `driver/` grew a gate, a retry, or a config key for this.

**One environment container per task worktree, a `docker exec` per gate.** The container
(`factory-env-…`, labelled `factory.gates=<key>`) runs the declared image as a `sleep infinity`
sleeper over the workspaces volume, working directory at the task worktree —
`<org>/<uuid>/.worktrees/<root id>`, the same tree the coding agent edits, so gates see exactly
what the agent wrote. It runs as the RUNNER's uid:gid (`1000:1000`, the executor images' `USER
node`, `HOME=/tmp` for the non-root uid; the kubernetes gate Job states the same numbers as a
`securityContext`), not as the declared image's own default: the gate is a WRITER on the shared
task worktree, and a gate that wrote as root would leave files the uid-1000 sync and reclaim can
never remove — the tree stuck for every later turn of the thread (observed 2026-09-13: a
gate-built `core/dist` left a worktree whose reclaim died with EACCES and whose next turn's
restore failed the same way). The key is the worktree path now, and with it the environment is
per TASK:
a follow-up within the cooldown reuses the warm container (same key), but two concurrent tasks
on one member+repo no longer share one, which is the disk-for-isolation trade the worktree
model already made. It comes up **before** the agent runs,
because the agent calls gates mid-run: the claim's env rides into it by 0600 env file, and the
runner gets `BELLOWS_GATE_URL` / `BELLOWS_GATE_TOKEN` (minted per attempt, delivered after the
claim's env lines in the same file — docker's last-wins rule is the precedence rule; both names
are reserved from member configuration at the board and in the driver's own copy of the list).
The endpoint runs **declared gate names only** — never an arbitrary command — and answers the
exit code plus an output tail. A reused container keeps the env resolved at its start: a turn
within the cooldown inherits the earlier turn's resolution, which the token's lifetime (one
attempt) comfortably outlives.

**The cooldown, and where it ends.** On every exit path the loop releases the environment rather
than killing it: it stays up for `GATE_COOLDOWN_MS` (ten minutes by default), so a follow-up turn
reuses the warm container instead of paying startup again. Any activity — a new turn's acquire,
an ad-hoc gate run — cancels the pending teardown and re-arms it. A driver that exits takes its
environments with it; the cooldown is for turns that arrive while the driver lives. A teardown
already run is not an error: the next acquire re-fences and recreates, the same fence every
spawn here does.

**The gates run between the agent finishing and the verdict**, with the heartbeat still beating —
a test suite can take minutes, and it must not outrun the lease it runs under. Each gate
re-acquires the environment before it runs, exactly as the ad-hoc endpoint does: a run can
outlive `GATE_COOLDOWN_MS` past the agent's last ad-hoc gate call, and acquire is the idempotent
revive (it cancels a pending teardown and recreates a torn-down environment), so a cooldown
firing mid-run costs a re-acquire, never a failed gate. Each state change
is reported to `POST /api/jobs/:id/gates`, which **replaces** the stored list: the job row's
`gates` jsonb holds the current/last state only, which is what makes the task view's "no history"
honest (the report is bounded so the whole list always fits the board's body limit, whatever the
gates printed). The first failing gate fails the job: `complete` carries `failed`, the gate's
exit code, and the agent output plus the gate's name and output tail — the output relayed back to
the author is the fix-next-time channel. What this cannot do is stop the agent pushing from
inside its own container: enforcement is at the verdict level, and a task is never reported
`succeeded` while a declared gate fails.

Two exit codes mean more than the gate's own verdict, and the conflation is accepted rather than
solved: a gate command that genuinely exits **125** is read as docker's "the container is not
there" — the ad-hoc endpoint answers it with a retryable 409, and the verdict path reports a
failed gate either way (125 ≠ 0), so the worst case is a wrong *reason*, never a wrong verdict.
A gate outliving `GATE_TIMEOUT_MS` fails with exit **124** (the convention `timeout` uses); the
kill stops the docker CLI, and a stubborn in-container process outlives the gate only until the
container's own teardown.

**Gates run under both executors, by different machinery.** Docker keeps a warm environment
container per task worktree and `docker exec`s each gate into it. Kubernetes runs each
gate as a **Job** — the declared image over the workspaces PVC, `workingDir` at the checkout, the
env as a per-run Secret the pod reads by reference (`envFrom`, never literals), the kubelet's
`activeDeadlineSeconds` as the wall-clock cap read back as exit 124. A gate run is attempt-scoped
(`factory.job`/`factory.lease` labels), so the re-claim fence sweeps a dead attempt's gate Jobs
like anything else. What docker's cooldown buys and kubernetes does not is warm start: docker pays
container startup once per cooldown window, kubernetes pays pod admission per gate run — seconds
against suites that run minutes, a cost optimization deliberately not ported. The one rule that
still fails a job at claim: a driver started with **no gate configuration at all** refuses a
gated job with a named reason; an ungated job's run is untouched — no container, no registration,
no reports, byte-identical argv. One honest ambiguity remains: a missing `.bellows.yaml` is
indistinguishable from a checkout that has not been cloned yet, so the first task on a
just-connected repository whose gates file was written by the agent itself can run and succeed
before the file exists. Every later turn of that task is gated; the first is the race, and it is
the same race every CI-on-first-commit system lives with. The k8s form is in
[kubernetes.md](kubernetes.md).

## Publishing: a task ends on a remote branch

**The task worktree is synced before anything reads it — under the re-claim fence.** The
workspace reconcile clones a repository once and otherwise leaves the checkout untouched, and
the startup sync is what makes each run start from the code it is meant to continue. The
principle (issue #58): git operations that touch the remote belong to a task's BEGINNING and
END — the first sync, and the publish — never its middle. So before the runner spawns, one
container runs the worktree script in one of two modes, decided by the claim: a claim that
CONTINUES a session — a follow-up, the only resumed claim there is — RESTORES (the paragraph after
this one); every other claim SYNCES.

**A starting claim SYNCES.** One container fetches the remote and then: the task's worktree is
created branched off `origin/<default>` (first attempt of the thread) or rebased onto the new
default with `--autostash`, keeping its own commits AND any uncommitted edits the previous run
left — which is what keeps a kubernetes thread (where nothing commits for you) alive across
turns, and what makes a lease-expired re-claim of an ordinary job honest: the claim cleared
the dead attempt's session, so that run starts — and syncs — fresh.
The fetch's credential: the claim env rides the env file as before, and
when it carries a NON-EMPTY `GITHUB_TOKEN` (empty counts as absent — a helper answering an
empty password would break the public-repo fetch it exists to preserve) the fetch runs under
the push's own token-backed credential helper (the helper CODE travels as an env value;
the token itself only ever the env) — git
reads no token from the environment, so a private-repo fetch without a helper cannot
authenticate; a public repo with no token keeps its plain unauthenticated fetch. The helper
is CONTEXT-FREE — it answers the token to whatever host or transport asks — so a credentialed
fetch is fenced twice on the transport: origin must be an `https://` URL (the remote is the
member tree's state and a prior session can re-point it; anything else refuses the sync with
a named reason rather than send the token toward a cleartext or local transport), and the
fetch carries `http.followRedirects=initial`, which permits same-host redirects only. `CRED_HELPER`,
the env name carrying the helper code, is reserved from member configuration (see
[env.md](env.md)) — the driver's own helper is the only possible one. The sync is the first
WRITER on the tree, so
each platform's re-claim
fence runs inside the sync, before the script: docker sweeps the `factory.job` label's
leftovers (the runner's own sweep after it is the documented twice-per-attempt idempotency),
kubernetes TAKES the checkout claim first and holds it through the run — `prepare`'s acquire
recognizes its own holder and proceeds. A kubernetes claim held against a live newer attempt
throws the attempt's stand-down, and the loop treats that like a runner that cannot start: no
verdict, the lease expires, the job is offered again — and so does a fence that cannot prove
the coast clear, docker's sweep included: a failed `docker ps` is never read as "nothing
left", because starting the sync over a live previous runner is the one outcome the fence
exists to prevent (a removal failing with docker's already-gone answer is the fence
succeeding, not failing). A sync that fails after taking the
claim RELEASES it (uid-preconditioned, holder-checked) — but only AFTER the sync Job is
deleted with Foreground propagation and the delete has ANSWERED: Foreground returns once the
pod is gone, so the checkout is never handed to a replacement while this sync's pod can still
write the tree. On success the deletion stays fire-and-forget Background, because the claim —
and with it the checkout — is still held through the run: no handover, no window. The sync
Job is deleted on
every exit path either way — a Job left to its kubelet deadline could overlap a replacement's
sync on
the shared tree. A STOP that lands mid-sync (issue #126) does not wait out the git either: the
attempt's slow setup steps are raced against its heartbeat, and a stop that wins abandons the
sync to its own cleanup and stands the attempt down before anything spawns — the row settles
`stopped` while the fetch may still be running, and there is no container to wait out. The
abandoned sync's own arms own the checkout: a failure takes the Job down and releases the claim
inside the runner (above); a success has nothing left live, so the loop's chained release hands
the checkout back once the answer is in — ownership-checked, never touching a claim that moved
on. Two terminal pre-run refusals never reach `runner.run`, whose cleanup is the
ordinary release path — a gates file that cannot be read, and gates this driver cannot run —
so the loop hands the fence back explicitly (kubernetes's ownership-checked claim release;
docker holds nothing) before failing the job: a refusal that never runs must not hold the
checkout forever. The same handback covers every other no-run exit the loop gained — a stop, a
lost lease or a Remove observed after an ok sync: the claim would otherwise sit on the checkout
with no attempt ever to release it. Two conflicts
still dead-end the attempt, with the work preserved and named: a rebase whose COMMITS conflict
aborts itself (the worktree must never sit mid-rebase), and a rebase whose reapplied STASH
conflicts leaves the markers and the retained autostash in the tree and refuses — a tree with
unmerged entries is not one to run on. The dead-end has an exit, though: a follow-up can merge
`origin/<default>` in itself (the git guard's one merge allowance, above) and resolve the
conflicts, after which the next starting sync's rebase is a no-op. The same
protection covers the worktree PATH: a directory that holds a git tree this sync did
not create is refused, never deleted — whatever uncommitted work sits there belongs to an agent
session. The clone's own working tree is never touched — under the worktree model that is
finally literally true, where the old sync hard-reset the clone's default branch and destroyed
whatever stray edits sat there.

**The sync serializes on the checkout's own lock, and lock contention is not a verdict (#307).**
Every task worktree of one member's repository hangs off ONE clone, whose `refs/` every STARTING
claim's fetch moves — and git's ref transaction moves a remote-tracking ref only from the value
it read, so two overlapping fetches race and the loser dies with `cannot lock ref … is at X but
expected Y`. Until #307 that was a terminal `failed` before the agent ever started, one burned
attempt of three on a race the board would have won on retry. The script now takes an exclusive
`factory-sync.lock` (an `O_EXCL` create) in the clone's git dir — a file on the shared workspaces
volume, so the docker sync containers AND the kubernetes sync Jobs of one checkout contend on one
file, across containers and pods alike. A second sync waits up to `SYNC_LOCK_WAIT_MS`
(120 s — inside the kubernetes sync Job's 600 s deadline, and covered by the still-beating setup
heartbeat) and steals a lock older than `SYNC_LOCK_STALE_MS` (600 s — on kubernetes that is the
sync Job's own deadline, so no holder can still be alive past it and an older file is an orphan a
killed holder left behind; docker bounds nothing, so a wedged live holder can be stolen from
there, and the release is ownership-checked — the file must still be the holder's own — so a
theft never cascades into deleting a successor's lock); both bounds are
env seams the driver never sets, reserved from member configuration beside `RESTORE` and
`CRED_HELPER`. The fetch itself attempts three times on a ref-lock stderr (`cannot lock ref`,
`unable to update local ref`, `index.lock`, `shallow.lock`) — after the winner's fetch the refs
are already current, so a retry is cheap and correct. A wait-out or an exhausted retry answers
with the `transient worktree sync:` marker (`TRANSIENT_SYNC_REASON` in `publish.ts`), and the
loop reads that as infrastructure: no verdict, the claim goes back to the board, an attempt is
spent at the next claim, and `maxAttempts` governs — exactly like a sync that threw. Every other
sync refusal still completes `failed` as before. The price is stated: a lock leaked younger than
the stale bound (a pod OOM-killed mid-fetch, say) costs every re-claim its 120 s wait and one
attempt — clearing such a file by hand stops the burn. And the lock serializes syncs against
syncs only: a publish's push from another thread's worktree updates the same shared refs and can
still lose a ref-lock race to a concurrent fetch — the same failure family, left for a follow-up.

**A claim that continues a session RESTORES, and never touches the remote.** A follow-up
is a task MID-FLIGHT: rebasing its tree onto a freshly fetched main would
move the conversation's base underneath it, the "sync with main on task follow up commands"
that must not happen (issue #58). So its claim's git work is a restore: the script runs with
`RESTORE=1` and no credential — the env file (docker) and the claim-env Secret (kubernetes) are
not written at all — and the existing tree is left byte-for-byte as the run before it left it:
no fetch, no rebase, no autostash, whatever state that is, ugly included; mid-flight is not the
board's business to tidy. A tree the reclaim removed is recreated from the surviving
`factory/<root>` branch — at its OWN tip, never a fresh start off `origin/<default>`: a
follow-up whose thread branch is gone has nothing to continue, and the attempt fails naming the
branch instead of silently restarting the task from main. The fence stands unchanged (docker's
sweep, kubernetes's checkout claim) — it fences containers, not git — and the gates re-read
that follows the sync stays, because a restored tree can still differ from the clone fallback
the claim was read from.

**The task worktree is reclaimed when the user closes the thread — done or delete cleans up the
tree (issue #47, revised).** The sync created the tree, and every commit on it belongs to one
thread; but "the thread is over" is the USER's verdict, not the executor's — a task is over when
the user says so, and until then the tree is exactly what its next turn continues from. A failed
run, a burned attempt budget, a cache kill — none of them frees the tree; the rebase autostash of
a later starting claim would, but mid-flight is not the board's business to tidy. The signal is
done-and-terminal: `complete` answers `{ id, status, threadDone }`, where `threadDone` is the
store's answer — computed in the same transaction as the verdict — to whether EVERY job of the
thread is terminal (`succeeded`/`failed`/`dead`) AND one member carries the user's `done_at` (the
tasks UI marks the thread's head, so the column can sit on any member — one done is the THREAD's
done). When it is true the completing attempt removes the
tree via the worktree script run as the sync's twin — a throwaway `docker run` naming the clone
and the tree, or a reclaim Job over the PVC whose name carries the lease token. The reclaim may
race the member's manual purge of the checkout (issue #92, `docs/workspace.md`): the parent clone
can be gone by the time the reclaim runs, and the script settles that from the tree's own `.git`
— a worktree whose gitdir names the dead clone's admin dir is removed, anything else keeps the
refusal, and there is no prune when there is no clone to prune into. One verdict, no retry loop:
a failure is logged once and the `task_reclaim` lease does what it already does. The driver does
not ask the board for the thread any more: an earlier shape read `GET /api/jobs/:id/thread`
after the verdict, which put the whole thread's commands, output and session ids on a route the
board secret could reach — audit data of jobs the driver never held — and computing the answer
at the verdict moment also closes a race the read had: a follow-up inserted between the verdict
and the read made the thread non-terminal at the last possible moment, where the verdict-moment
answer is final. A follow-up still queued or running keeps `threadDone` false and
the tree in place — and so does a thread that finished with nobody closing it, which is now the
common case rather than the reclaim.

The done itself is the ordinary path, because the user usually closes a thread that has already
stopped moving: `POST /api/jobs/:id/done` stamps `done_at` and, in the same transaction, queues
a `task_reclaim` row when every member is already terminal — the queue below takes the tree
down, exactly as a remove does. The verdict-time reclaim above is what covers the other order:
a done declared while a follow-up still moved queues nothing (the thread is not terminal yet),
and the follow-up's completing attempt finds done and terminality together and reclaims at the
verdict. Either way there is exactly one reclaim per closed thread: the queue insert is
guarded against a row the thread already has.

The reclaim deletes only
what the sync would have — a registered worktree of the clone, or the bare leftover directory
the sync itself would have removed — and REFUSES, like the sync, a path that holds a git tree
that is not this clone's worktree, logging the reason rather than touching it. It is
best-effort by contract: the verdict is already on the board when it runs, so a board that
refuses the complete call, a runner that refuses the tree, or a daemon that says no costs the
reclaim, never the verdict — the tree stays and the branch survives for a later follow-up. Who
reclaims: the driver's last completing attempt, or the queue's drain loop. Deleting a task by
hand is the other end of the same
queue: `remove` inserts a `task_reclaim` row in the delete transaction, and the driver's separate
reclaim loop (claim → worktree removal → ack) pulls it down — see the Remove section above.

**The claim's gates answer is re-read after the sync.** The board reads `.bellows.yaml` at CLAIM
time, which is before the sync — so the claim's answer can predate the tree the run will see,
and a repository whose gates file just arrived would run ungated for its whole first task. After
the sync, the driver calls `POST /api/jobs/:id/gates-reread` and the refusals (a broken file, a
gates-this-driver-cannot-run check) act on what the tree holds NOW. Lease-guarded like every
worker route; a refused or failed re-read keeps the claim's decision, because freshness is worth
a request, not an error path.

**A succeeded run whose work exists only in a local checkout is not a success.** After the agent
finishes and the gates pass — and only then — the driver deterministically publishes: task branch
(when the checkout sits on the default one), commit, push, and a PR, each step a separate
throwaway container over the workspaces volume (docker) or a separate batch Job over the
workspaces PVC (kubernetes) — the same `publishCheckout` workflow over both, so the two
executors cannot drift on what a publish decides. The executor's baked `AGENTS.md` tells the agent
this is the shape of a finished task (branch, commit as you go, gates green, never ask); the
driver-side publish is what makes it enforcement rather than hope — instructions are what the
model follows, and this is what happens regardless. Nothing is ever pushed past a failing gate,
because the publish runs after `runDeclaredGates` returns null and never otherwise; a run that
failed, timed out, was cache-killed, or stopped talking early publishes nothing — its tree may be
mid-thought, and pushing it would publish work no verdict was ever given on.

**The PR speaks for the work, not for the command that started it (issues #82, #389).** The executor
may not open pull requests — the claude guard denies `gh pr create` (a second `Bash(gh *)` hook
arm), the opencode permission fence refuses the same, and the baked skills say the board
publishes. The title/description are not the author's prompt text either: a summarizer script
(`driver/src/scripts/pr-summary.cjs`) runs as one more publish step in the same throwaway
container/Job shape, reads the branch's commits and its final diff against the default branch,
and answers one JSON line the driver turns into the PR title and body. The title is selected,
not copied (#389): each commit is scored by how much of its churn survives in the final diff —
reverted or superseded work scores nothing — the heaviest survivor names the PR, earliest wins a
tie, and test-only commits cannot win while any source-touching commit survives (the fix, not
the regression test that opened the branch). A commit subject is reused whenever it does
summarize the change; single-commit branches keep their only subject. The chosen mechanism is
deterministic and local-git only — no model call, deliberately: the step runs credential-free
and offline in a throwaway container on both executors, and a generator needing a credential,
egress or quota would put a decoration at risk of failing a publish. The documented limit: the
rule selects among the branch's own subjects, it cannot coin one — a branch of `wip`/`fix`
subjects keeps a subject-based title, with the command-derived plan title as the driver-side
floor. The publish's own backstop commit — the uncommitted leftovers, committed under the
command's first line just before the summarizer reads — is excluded from the selection (its
subject rides the step as `BACKSTOP_TITLE`): the prompt must never win the title, though the
commit stays in the body's list. The exclusion keys on the current command, so a backstop
commit a previous attempt left behind under a different command is scored like any other
commit — a follow-up after a partially-failed publish can still inherit that attempt's subject.
The commit list (capped) and shortstat are the body, with the issue closure and a
published-by line appended by the driver; the issue reference is appended to the title when the
selected subject does not already end with it. Every git read carries a max buffer and a
timeout — bounded input, bounded time. The step needs no credential (local git reads only) and
its failure is decoration: the command-derived title and plain body of the early publishes
remain the fallback. The boundary is exactly creating and checking out: `gh pr edit`, `gh pr
merge`, `gh pr close` stay allowed — the issue's scope was opening, and a follow-up that answers
review feedback may still need to comment on the PR it did not create.

**A publish failure fails the verdict.** The work did not land; a green badge over a tree that
exists on one machine only is the exact lie this exists to prevent. The reason (which git step,
what it said) rides the output the author reads. No credential passes through an argv: the claim
env rides the same 0600 env file the runner got (docker) or the same per-attempt Secret the
runner's pod reads through `envFrom` (kubernetes), and the push credential helper reads
`GITHUB_TOKEN` from the container's environment.

**Idempotence and limits.** An existing task branch is reused, never reset (`switch -c` only when
the branch is absent — earlier attempts' commits survive); an existing PR is reused, never
duplicated. "Unpushed" counts commits the remote default branch does not have — never `@{u}..HEAD`,
which is fatal for a never-pushed branch and once read a two-commit task branch as "nothing to
publish". The push is `--force-with-lease`: the startup sync legitimately rewrites a task branch's
base, and the lease refuses to clobber a remote that moved under us. No uncommitted changes and
nothing unpushed is the ordinary no-op; a checkout that was never cloned is the other one.
`EXECUTOR=kubernetes` publishes the same way, one aux Job per step — the step Jobs carry the
attempt's `factory.job`/`factory.lease` labels, so the re-claim fence sweeps a dead driver's
half-finished publish before a replacement touches the tree. The startup sync runs on both
executors too: the worktree script is a Job like every other aux Job (read-write PVC, the claim
env by a per-attempt Secret), because the worktree does not exist until something creates it and
a refusal there would fail every claimed job. Under
`AUTH_MODE=none` a board with no `GITHUB_TOKEN` in any env scope will fail the publish at push
with the daemon's authentication error — the work stays local, loudly.

**The verdict names who it published — the PR identity rides the completion report (036).** A
publish is only real once it is recorded. `publishCheckout` answers the PR URL it created and the
branch pair; the loop ships them to `complete` as the optional `publication` object — `repo`,
`prNumber`, `prUrl`, `headBranch`, `baseBranch` — and the board, validating the shape (the repo an
`owner/name`, the URL the github.com `.../pull/<n>` spelling, the branches bounded refs) and
cross-checking `repo` against the leased job's OWN `repo` label inside the verdict's transaction,
records the identity (`job_pr`). A no-op or a failed publish invents nothing: the field is absent
and no row is written — only a run that actually published a PR names one. The identity is the
durable anchor a block layer keys its waits on, and it is already what the PR waits read:
a waiting thread's `workflow_wait` row is addressed to that same `(repo, prNumber)`, GitHub's
webhook deliveries fold into it and cancel it on PR close, and the task read model surfaces it as
`waitReason` / `waitingSince` / `waitTerminalReason` (an open wait first, else the most recent
terminal one). Both `listTasks()` and `thread()` join it (206): an OPEN wait buckets the thread as
`review` regardless of the row's own status — a human-blocked thread is never "running", whatever
status the wait-entry mechanism (issue #231, `workflow-blocks/runtime.ts` — docs/workflows.md,
"Durable block waits") parks it under, which today is no `job` row at all — and `thread()` carries
the same triple on every member of the conversation, since the wait belongs to the root, not the run.
Since #324 the detail reads (`get()`, `thread()`) serve the wait triple too — `get()` joined neither
the wait nor the publication before — and expose the recorded publication itself as `publication`
(`{ repo, prNumber, prUrl, headBranch, baseBranch }`), null for a thread that never published: a
client can walk from a task to its PR without searching GitHub. The per-run lists answer null for
both, the same rule they already followed for the wait fields. The same identity is what a merged
PR is answered by: the merge delivery resolves `job_pr` and closes the threads it names (issue
#390 — the section above), which is why a thread that never recorded a publication is never closed
by one.

**Display precedence.** The web reads a task's state through ONE function, `taskTone`
(`web/src/task-tree.ts`); `taskStatusLabel` and `taskDotClass` are lookups on it, and first match
wins: no run → `—`; `running` → `Stopping` / `Running`; `doneAt` set → `Done`; an open wait →
`Waiting for review`; `queued` → `Queued`; then the verdict with `· Needs review` (plus the
terminal wait reason, once there is one). A live run outranks a stray wait, and **closure outranks
an open wait**: Mark done ends the human's turn even before the board settles the wait row, so a
done task never keeps reading as blocked on review. `isWaitingForReview` (`web/src/task-outcome.ts`)
applies the same rule — it requires `doneAt === null` — so the outcome panel drops its wait
explanation on a done task. The dot for a success the user has not closed is `sidenav-dot-review`
(accent blue: the member's turn); a done task's is `sidenav-dot-done` (green).

## Decisions

**`workflow_name` is frozen audit data, not a live reference (033).** The route stamps the
RESOLVED record's name on the root row at create — the `created_by` trust pattern: it travels from
the record the store resolved, never off the body, and no job endpoint accepts one — and every
graph successor and user follow-up inherits it. `job.workflow_id` names the definition but is
opaque on reads, and the workflow row is deletable by design, so a deleted definition would
otherwise take its human name out of task history. The column has no foreign key and no read-time
join, exactly like `workflow_id`: a rename or delete of the source workflow changes later tasks,
never existing task history. Null is honest on workflow-less tasks and on pre-033 rows whose
definition was already gone when the migration backfilled.

**Attribution is a read-time join, never a denormalised label (issue #67).** `author`,
`stoppedBy` and `doneBy` on the job payloads are `app_user` rows joined at read time off the
`created_by` / `stopped_by` / `done_by` uuids — logins, display names and avatars go stale, joins
do not, and a login captured at action time is a lie the moment GitHub's rename lands. Null is a
fact, not a gap to paper over: a pre-accounts row has no author and renders "unknown". For agent
sessions the same rule one level out: the telemetry tables (`metric_point`, `session_branch`)
carry **no identity — the collector strips it on purpose** (`docs/organizations.md`) — and the
per-user rollup joins `session_branch` to `job` on `(org_id, session_id)` and `job` to `app_user`
at read time instead. Follow-ups share the parent's session AND, by the follow-up author guard,
its author, so that join is deterministic. Sessions with no matching task — local dev runs,
backfilled transcripts — stay unattributed and are counted (`unattributedSessions`), never
guessed. No identity travels through the runner, so the driver, the executor images and the chart
are untouched by attribution.

**Lifecycle actors are columns, not a job_event table.** The display path ("who stopped/closed
this") is served by the same app_user joins the authorship already pays for; a table would add a
second write per action and a second store surface for nothing that renders it. Stop stamps
`stopped_by` at REQUEST time with the first-writer coalesce the flag beside it follows; done
stamps `done_by` beside `done_at`; remove rides `removed_by` on the reclaim row, because the
thread rows are deleted in the same transaction and a column on job would be written and
immediately deleted. All three are `on delete set null` like `created_by`: removing a member must
not delete the record of what they did. If a durable removal audit is ever wanted, that is a
`job_event` table — a decision for the day something renders one.

**Leases, not a status flag.** A worker that dies mid-job cannot tell anyone, so a claim expires.
`lease_expires_at` is `not null` from insert, set to `now()` — already expired. That makes
claimable one predicate, `status in ('queued','running') and lease_expires_at <= now()`, which a
partial index implies. The obvious alternative,
`status = 'queued' or (status = 'running' and lease_expires_at < now())`, is implied by no index at
all and can only ever be a scan plus a filter.

**A fencing token, not `claimed_by`.** A restarted container comes back with the same worker id, so
the name cannot distinguish the live run from the stale one it replaced. `lease_token` is
regenerated on every claim and must be presented on heartbeat and complete. A report carrying an
old one is refused, not merged: the two runs did different work, and merging them writes one run's
exit code next to another's output.

**A claim resumes a session only when the job is a follow-up.** The claim keeps `session_id` when
the row carries `parent_job_id`, and clears it otherwise, so a lease that expired mid-run starts
fresh for an ordinary job. That attempt's
session is not this one, and replaying its transcript would resume work whose output was thrown away
— which is why the follow-up is the carved-out exception rather than the rule: its session holds the
parent conversation, and clearing it would throw the thread away with the attempt. The stamped rows
the settle sweep lands `stopped` (#152) never reach this clearing: the stop kept the session, and
the follow-up that continues it needs exactly that conversation.

**`max_attempts` and `dead` exist from the first migration.** A command that kills its worker is
otherwise reclaimed the moment its lease expires, forever, and one poison job permanently occupies
a worker slot. Adding a value to `job_status_ck` later means rewriting the constraint on a
populated table, so `'dead'` is in it now.

**`started_at` resets on every claim.** It has to describe the attempt that ran; keeping it from
the first attempt makes every duration measure from a run that died.

**The claim's row lock sits inside the subquery, below the `LIMIT`.** `for update skip locked` there
means a row another claimer holds is skipped rather than counted against the limit and then
discarded — the difference between a busy queue handing out work and one returning `204` while jobs
wait. The outer `update … where id = (…)` is safe only because that subquery holds the lock; do not
flatten it.

**`order by created_at, id`.** `now()` is transaction-constant, so a batch insert shares a
timestamp and FIFO without the id tiebreaker is arbitrary.

**`repo` and `executor` remain audit labels, but executor is also resolved at claim time.** The task
list names the repository workspace and executor profile a task was queued with. There are no foreign
keys: `job` records the choice, while `user_repo` and `user_executor` are mutable member state. The
claim resolves the executor label against the AUTHOR's current profiles and carries the matched type;
that type chooses the CLI and its image. A renamed or deleted profile leaves the label in history but
produces `executorType: null`, which the driver reports as a failed task instead of choosing a
deployment default. The composer requires a configured profile and initially selects the first one.

**The git guard lives in the images, not the sync.** The restore-mode sync enforces the checkout
invariant only when a claim STARTS — by then a wrong checkout already exists and the thread is
stranded: the follow-up that would fix it is exactly the run the refusal blocks (job `43379d3a`,
2026-09-13). So the enforcement moved upstream of the damage: the runner images deny checkout
manipulation at the tool boundary, in each CLI's native mechanism, and keep the sync as the last
line rather than the only one. A guardrail and not a security boundary is a stated posture, not a
disclaimer — the agent is root in its container and can flag its way around any hook — but the
threat being handled is a competent agent's ordinary command, not a hostile one, and an ordinary
command is exactly what a hook intercepts.

## Deliberately absent

- **No idempotency key on create.** A `POST /api/jobs` that times out and is retried creates a
  second job, and the command runs twice. Add a client-supplied id with `on conflict do nothing`
  when a driver actually retries creates.
- **No priority, no scheduling.** A dead job is reaped; a queued one is taken in order. Stop and
  remove exist (a person can wind a task down or delete it — see the section above), but a queued
  job's *place* in the queue is not something anybody moves.
- **No per-JOB authorization.** There is authentication now — see [auth.md](auth.md) — and the two
  credentials are disjoint: a session cookie queues, follows up, marks done, stops, removes and
  reads, a `Bearer $JOB_BOARD_TOKEN` (the shared board secret) claims, heartbeats, streams output,
  suspends, completes,
  and drains the reclaim queue. A session on `/claim`
  would let any member take work away from the driver running it; the board secret on `POST /api/jobs`
  would produce a job with no author. But **membership is not a sandbox**: every member can queue a
  command that runs against their own checkouts, follow up on their own tasks, and close any task —
  and `job.created_by` records who did rather than limiting what they may do. Follow-ups are the one
  exception, and not an authorization regime: the child resumes the parent's session, and a session
  only resumes in the tree it ran in — the author's (see the follow-ups section above). Done, stop
  and remove have no such coupling, so they stay open to every member.
  The one per-user bound is the REPO LABEL on create: where per-user repo scoping is active
  ([repos.md](repos.md)), `POST /api/jobs` refuses a label outside the caller's GitHub-reachable set
  (`403 REPO_NOT_ACCESSIBLE`) — the picker hiding a repo while the API accepted it would make the
  scoping depend on the SPA's politeness. Reads stay open to every member: the board is the org's
  audit trail, and a label never changes what a worker runs.
  Under `AUTH_MODE=none` all of it is open, including the worker routes — see [security.md](security.md),
  which is where the consequence is written down.
- **No service volumes, health checks, depends-on ordering or restart policies.** A service that
   needs a warmed database is the agent's problem — it can sleep and retry, which is the one
   superpower a headless run has. Add keys to the parser when a real job needs them, not before.
- **A service name is attempt-scoped on both executors.** Docker gives each attempt its own
  network; kubernetes gives each attempt its own headless Service and resolves the declared name
  as a pod hostname under it, through a search domain on the runner and gate pods. Two concurrent
  jobs can both run a service called `db`. The kubernetes caveat: the search domain comes after
  the namespace's own, so a non-factory Service literally named `db` in the namespace wins.

## Testing

The lease rules are tested against a real database only (`server/test-db/job-store.test.ts`,
`npm run test:db`) — a second implementation of them in a stub would only ever agree with itself.
`server/test/routes.jobs.test.ts` covers the HTTP contract with a stub that fakes verdicts, and
pins that the board is **not** registered when `buildApp` gets no job store.

Lease expiry is simulated by ageing `lease_expires_at` with SQL, never by sleeping.

`driver/test/` injects both the board and docker, so it spawns nothing and needs no daemon.
`dockerArgs()` is exported and pinned separately: everything security-relevant about a runner is
decided in that one array. The `.bellows.yaml` parser and the service argv builders are pinned the
same way in `driver/test/services.test.ts`, and the service lifecycle is driven through the same
injected daemon seam in `driver/test/docker.test.ts` — readout, network, fleet, teardown, fence,
the off-switch proving the daemon hears nothing services-specific when `RUNNER_SERVICES=0`, and the
attempt-scoping pins: no stale attempt's argv may name a sibling attempt's
resources, and the fence is the one sweep allowed to be job-scoped.

`npm run test:jobs` (`scripts/test-jobs.sh`) is the end-to-end: a real board, a real database, a
real driver and real containers, with no Claude and no credential. The runners are four stub
images — two whose entrypoints echo and exit, plus a service stub and a runner-exec stub. The job's
`output` comes back as the arguments the container was
given, which is what proves the prompt, the mount and the completion path all line up. It is also
what proves the session round-trip: the `sessionId` the board hands back is found inside those
arguments, so the link points at the session the job actually ran as. Stop is covered in the
board phase rather than the driver phase — ask a running job to stop, park it, prove the stopped
job is not offered to an idle poll, and continue it as a follow-up whose claim carries the session
back — because none of that needs a container. Its leftover sweeps are scoped to the jobs this run created, so a live
deployment sharing the daemon does not trip them. It creates a
`*_test` database, four images and a volume, and drops all of them on exit.

One phase runs the driver the way the stack does, not the way the host does: after the host-driven
phases, the script starts the **compose `driver` service** (`docker compose run`, aimed at the same
board over `host.docker.internal`, under a compose project name of its own so its volumes tear
down with it) and settles a job through it. Services are off for that job, as for every other
host-driven phase — the services phase itself runs with them on, and it deliberately leaves a
malformed `.bellows.yaml` in the
stand-in author's tree, and a services readout failing is a job verdict, not this phase's
business. The compose service runs the
working tree from a bind mount — `docker/driver.Dockerfile`'s `dev` stage — so the phase greps the
running container for the checkout's `publish.ts` source and only then queues a job: under the old
baked-`runtime` compose file the image holds no source at all, and the phase fails exactly the way
issue #174 went unnoticed. `driver/test/compose.test.ts` pins the file shape offline — bind mount,
`target: dev`, and that `runtime` stays the last stage the chart ships.

Two things it does that are not decoration:

- **It truncates `job` before the board phase.** The queue is FIFO, so a job left by an earlier run
  hands the claim a different job than the one under test — which reads as a broken lease rather
  than a dirty fixture. That misdiagnosis cost real time the first time this script ran.
- **Both boards boot the offline entry** (`server/dist/offline.js`): the same server built with
  the code-only no-fetch arm, which is what lets them run with no App credential against a
  `*_test` database — the App is the only env-reachable configuration, and it would refuse the
  database name outright, and a fetching board would start cloning repositories.

The reclaim and fencing checks age `lease_expires_at` with `psql` rather than waiting a lease out,
so the script stays a few seconds rather than a few minutes.
