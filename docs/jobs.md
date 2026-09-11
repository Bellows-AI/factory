# Job board

Read before: touching `server/src/routes/jobs.ts`, `server/src/db/job-store.ts`,
`server/migrations/006_jobs.sql` or anything under `driver/`.

A job is a text command waiting for a worker — read as an agent prompt. The runner's `ENTRYPOINT`
is a CLI wrapper: the driver passes the command as `-p <command>` to claude-code, or as the
positional prompt of `opencode run` under `RUNNER_CLI=opencode`.

**The server hands jobs out and records results. It never spawns anything.** The driver claims a
job, runs it in a `claude-executor` container against the AUTHOR's workspace checkout, and reports
back. The docker socket lives with the driver, never with the dashboard: the dashboard's port is
unauthenticated, and a socket on that process would make it root on the host.

## The driver contract

```
POST /api/jobs/claim {worker}   -> 200 {id, command, leaseToken, leaseExpiresAt,
                                        userId, workspacePath, resumeSessionId, followUp,
                                        env} | 204
  every request carries `authorization: Bearer $JOB_BOARD_TOKEN`, when the board requires one
  resumeSessionId ? restore that session : mint one, POST /api/jobs/:id/session
  followUp ? deliver the command into the restored session : a park resume delivers nothing
  spawn the runner with the command, as that session
  (claude-code mints and reports a session uuid; opencode reports the id it used, scraped at close — see below)
  POST /api/jobs/:id/heartbeat {leaseToken}     every leaseSeconds/3, while it runs
     200 {leaseExpiresAt, cancelRequested}: false on an ordinary beat, true when the
     user asked to park this run (see Stop) — the kill order of a different kind
  POST /api/jobs/:id/output {leaseToken, output}  the newest output tail, ~every 2s, while it runs
  POST /api/jobs/:id/gates-reread {leaseToken}  once, after the startup sync (see Publishing)
POST /api/jobs/:id/complete {leaseToken, status, exitCode, output}
  -> 200 {id, status, threadTerminal}   the verdict, plus whether EVERY job of the thread is
                                         terminal — the worktree-reclaim signal (see below)
  ... or, if the runner went quiet:
POST /api/jobs/:id/suspend  {leaseToken}        -> standby, session kept
POST /api/jobs/:id/resume   {}                  -> queued, claimed again with resumeSessionId
```

**Person-gated routes meet the same loop through the same states.** `POST /api/jobs/:id/stop`
parks a task — queued or already-parked rows land on `standby` directly, a moving run answers
`202 {status: 'running', cancelRequestedAt}` and the worker reads that flag on the beat above,
kills its runner and suspends. `POST /api/jobs/:id/remove` deletes the whole thread and hands the
driver the worktree to remove through a separate queue (see the sections below).

**A `409` from heartbeat means the container must be killed.** Its lease expired, the job was
handed to someone else, and nothing it reports will be accepted. The board cannot stop a worker —
it can only refuse it — so double execution is prevented by the driver acting on that 409, not by
the database. This is the single most important line in this file.

The other kill order rode the same beat, and deserved a line of its own: **a `cancelRequested: true`
beat means the container must be killed AND the run parked.** A user asked for the task, the board
can do nothing but pass the message, and the run dies the same way a 409 does — only afterwards the
driver `suspend`s the row instead of settling it. There is no separate endpoint and no third state:
`cancel_requested_at` is a timestamp on the moving row that the beat reads.

## The driver (`driver/`)

A fourth workspace, with no dependency on `core` and none at run time at all. It is a client of the
HTTP board, never of the database — which is what lets it run anywhere the board is reachable.

```bash
docker build -t claude-executor docker/claude-executor     # the claude-code runner image, once
docker build -t opencode-executor docker/opencode-executor # the opencode runner image, once
npm run driver                                             # against a board on 127.0.0.1:8080

docker compose up -d driver                              # or in the stack, with everything else
```

Everything below describes the docker runner. `EXECUTOR=kubernetes` swaps the platform under it —
runners become batch Jobs, created and polled and deleted against the API server — while this
contract, the loop and the lease rules stand untouched. The parallel decisions and what the
cluster phase adds are in [kubernetes.md](kubernetes.md).

| Variable | Default | Notes |
| --- | --- | --- |
| `JOB_BOARD_URL` | `http://127.0.0.1:8080` | Must be http(s); the scheme is checked, because `new URL('dashboard:8080')` parses. |
| `JOB_BOARD_TOKEN` | unset | The worker token, from `npm run worker-token -- --name <worker>`. Required against a board running `AUTH_MODE=github`; unset against an open one, where the header is **omitted rather than sent empty** — an empty Bearer is a credential that failed, not one that was never offered. It is also how the board knows which organization this driver works for. |
| `EXECUTOR_IMAGE` | `claude-executor` | The runner image. `opencode-executor` under `RUNNER_CLI=opencode`, unless set explicitly. |
| `RUNNER_CLI` | `claude-code` | Which CLI the runner image speaks: claude-code's `--session-id`/`-p <prompt>` form, or opencode's headless `run [--session <id>] <prompt>`. Explicit enum. Under `opencode` no session is minted — the runner scrapes the id the run used and reports it at close — and Remote Control and skip-permissions are refused at startup. Both executors carry both CLIs; the cache watch is the one opencode feature that stays docker-only (see `RUNNER_CACHE_WATCH`). |
| `WORKSPACE_VOLUME` | `factory-ai_workspaces` | A volume **name**, not a host path — see below. |
| `RUNNER_NETWORK` | unset | Join the compose network or the runner's telemetry reaches nothing. |
| `RUNNER_OTEL_ENDPOINT` | `http://collector:4318` | Where a runner's telemetry is pointed, passed to both runners as `OTEL_EXPORTER_OTLP_ENDPOINT`. The default names the compose collector, so the endpoint is always provided — a runner's telemetry reaches the collector whether or not the compose network is there to make the baked image default resolve. The chart overrides it with the in-chart collector. |
| `RUNNER_STATS_URL` | `JOB_BOARD_URL` | Where the runner's branch reporter posts its `session → (repo, branch)` samples — the board's own `/api/sessions/branch`. Defaults to the board URL, which a runner can already reach on compose and in the chart; override for a split topology (host driver, containerized runners) where only a host-gateway address names the API. |
| `RUNNER_INGEST_TOKEN` | unset | The board's optional ingest token, forwarded so the reporter's reports authenticate on a board that requires one. A credential: it travels the env file (docker) or the per-attempt Secret (kubernetes), never an argv — and never under Remote Control, which receives no forwarded credentials at all. |
| `DRIVER_CONCURRENCY` | `2` | |
| `DRIVER_POLL_MS` | `5000` | |
| `DRIVER_LEASE_SECONDS` | `300` | Heartbeat is a third of this. |
| `DRIVER_JOB_TIMEOUT_MS` | `1800000` | The container is `docker kill`ed and the job reported failed, with a note. **Not armed under Remote Control.** |
| `RUNNER_IDLE_MS` | `3600000` | Remote Control only: silence for this long parks the job on standby. |
| `RUNNER_CACHE_WATCH` | off | Kills a job whose provider stopped serving prompt cache: three consecutive completed turns with no cached input over ≥20k tokens, each turn over a minute. Opencode only — see the section below. |
| `RUNNER_CACHE_WATCH_POLL_MS` | `30000` | How often the watch probes the session database. One throwaway container per poll. |
| `RUNNER_SKIP_PERMISSIONS` | off | Appends `--dangerously-skip-permissions`. Read the paragraph below. |
| `RUNNER_ENV` | `CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY` | Names forwarded to the runner. Ignored under Remote Control. A name the claim also carries is shadowed by it — under an app-mode board that is now always `GITHUB_TOKEN` — see [env.md](env.md). |
| `RUNNER_REMOTE_CONTROL` | off | Runs the job as a drivable session instead of a headless prompt. Read the section below. |
| `RUNNER_AUTH_VOLUME` | `claude-executor-auth` | The claude.ai login. Mounted only under Remote Control. |
| `EXECUTOR` | `docker` | `kubernetes` swaps the `docker run` for a batch Job in the namespace the driver runs in — see [kubernetes.md](kubernetes.md). Explicit enum: anything else is fatal, because a typo must not read as "docker is fine" while jobs are claimed and nothing runs. |
| `K8S_NAMESPACE` | `default` | Where runner Jobs are created. Meaningless under docker. The chart sets it via the downward API. |
| `RUNNER_CREDENTIALS_SECRET` | unset | The Secret holding runner credentials under `EXECUTOR=kubernetes`, one key per `RUNNER_ENV` name — the k8s form of `-e NAME`: names travel, values stay in the Secret. Unset forwards nothing. |
| `RUNNER_IMAGE_PULL_POLICY` | `IfNotPresent` | The runner image's pull policy under `EXECUTOR=kubernetes`. Kubernetes defaults an untagged or `:latest` image to `Always` and would ignore the node's own images; the docker runner has no equivalent problem, so the docker behavior has to be stated. |
| `GATE_COOLDOWN_MS` | `600000` | How long a gate environment container outlives the task that started it, so the task's next turn does not pay startup again. `0` tears it down the moment the run's exits are walked. Docker only: the kubernetes gate manager runs each gate as a Job that leaves nothing behind, so there is nothing to cool down. |
| `GATE_LISTEN_HOST` | `127.0.0.1` | Where the ad-hoc gate endpoint binds. Loopback by default — it runs shell commands, and the bind address is the access control. |
| `GATE_ADVERTISE_URL` | unset | The URL runners are told to reach the gate endpoint by. Unset builds `http://host.docker.internal:<port>` from the bound port, which dockerArgs makes resolvable for gated jobs (`--add-host … host-gateway`). Set it when that default cannot reach the driver — the compose stack points it at `http://driver`. A URL with no port of its own has the bound (ephemeral) port appended — the listener is `listen(0)`, so no fixed URL could name it; one with a port stays verbatim. |
| `GATE_TIMEOUT_MS` | `600000` | The wall-clock cap on one gate run. A gate that outlives it is a failed gate, exit 124 — the runner's own timeout covers the agent, this covers a gate that hangs. |
| `RUNNER_SERVICES` | off | Honors `.bellows.yaml` in the author's checkouts: before a run, the driver starts each declared service on a per-job network (docker) or as a pod with a headless DNS Service (kubernetes), so `postgres://db:5432` resolves for exactly that job. Read the section below before turning it on. |

**The workspace is passed as a volume name, not a path.** The driver's runners are *siblings*, not
children: it talks to the host's daemon over a socket, so a path inside the driver container means
nothing to that daemon, and there is no host path to give either — the dashboard writes its
checkouts into a named volume precisely to avoid one.

**`WORKDIR` comes from the board, not from the driver's configuration.** The claim carries
`workspacePath` — a root-relative `<orgId>/<userId>` — and the runner starts at the task
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
  process trusts with a fragment of a shell command — the rule `remoteSessionArgs` already applies
  to a session id — and here a `..` would point at everybody's checkouts. The pattern is **copied**
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
omits it; the driver reads that as "no environment". Remote Control runners get none, for the same
reason they get no `RUNNER_ENV` — a forwarded credential there does not fail, it degrades the
session in silence.

**`RUNNER_SKIP_PERMISSIONS` is a real decision, not a nuisance flag.** Off, a headless agent stalls
at permission prompts nobody can answer and the job burns its timeout. On, it edits and runs
whatever it likes inside the container — which is also mounted onto that member's checkouts. It stays
off by default so that turning it on is something somebody typed.

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
instant fake clock cannot see it, so `loop.test.ts` models a period that never elapses.

**Live output is a rolling tail, and the driver owns the window.** Without it the dashboard showed
"Waiting for the executor…" for the whole run — the status moved, the work did not. The mechanics:

- The docker runner hands the loop its newest output tail on every chunk it reads (the tail it
  would report on complete anyway); the kubernetes twin reads the pod log's tail on each status
  poll. Neither throttles — that is the loop's business.
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
  describes the attempt that took it), and the kubernetes runner reports none at all, the same
  honest refusal its gates make.

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
transcript answers nothing to the query), refused at startup under claude-code, and docker-only:
each tick is one throwaway container on a warm daemon, while the kubernetes form would be a Job
per tick — pod admission every poll period, refused at startup under `EXECUTOR=kubernetes`.

**The branch reporter is how an executor run becomes attributable at all.** The CLIs' OTLP
metrics carry a session id and nothing else — no branch, no repo, no PR — so the attribution
join (see [telemetry.md](telemetry.md)) would have no span to intersect, and every executor run
would land in the unmatched bucket no matter how much it cost. Both executor images bake
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
`INGEST_TOKEN` or `BELLOWS_SESSION_ID` would be a cross-tenant write into the telemetry store
(see [env.md](env.md)). One honest edge, shared with the shipped readout and cache probe that
read the same database: discovery reads the member's NEWEST root session, so two concurrent
fresh runs of one member can briefly cross-report each other's session id — the window is the
time between one run's start and opencode creating its row, and a follow-up avoids it entirely
by carrying the id.

**`RUNNER_CLI=opencode` swaps the CLI behind the image, and with it the session contract.** The
headless form becomes `run <command>`, and no session is minted or passed: opencode mints its own
ids (`ses_…`) and cannot adopt one minted in advance — minting a uuid anyway would put a session
on the board that the runner never used. Instead the runner **scrapes the id the run actually
used** after the container exits: opencode keeps its sessions in a sqlite database, the driver
persists that database per member by pointing `XDG_DATA_HOME` at a `.opencode` directory in the
member's own tree on the workspaces volume (which is also what makes a session resumable at all —
a fresh container starts with an empty one), and one throwaway node container reads the newest
root session out of it. The same read answers **how the run's last message ended** — opencode
exits 0 even when the model's context limit cuts a task short mid-investigation, and only the
session database knows — so a finish reason that is not `stop` is reported as a FAILED run, the
reason in the output, despite the exit code. The read also lifts the **context the run reached**
(the last assistant message's token total) and the run's summed cost, which ride the verdict and
merge into the runtime vitals — the finished task shows `ctx 90,433 tok`, which is where a
context death is legible. The id is reported while the lease is still live, before the verdict,
because a follow-up resumes exactly that row. These jobs show no session link (the link is built
from `remote_session_id`, which stays claude-only). Their runs still emit OTLP, but the server's
metric map carries no opencode rows yet, so spend records as an unmapped agent — null, never zero
— until those rows are added (see [limits.md](limits.md)). The combination is refused at startup
with `RUNNER_REMOTE_CONTROL` (that is claude-code's bridge) and with `RUNNER_SKIP_PERMISSIONS`
(that appends a claude-code flag; opencode's permissions come from the `opencode.json` baked into
its image — see [its README](../docker/opencode-executor/README.md)).

**Any executor can resume its own sessions.** A follow-up claim carries the session id the parent
run used, whatever CLI minted it: claude-code restores with `--resume <uuid> -p <command>`,
opencode with `run --session <ses_…> <command>`. The one refusal that survives is a resume claim
under opencode with **nothing to deliver** — standby is a Remote Control feature, so that means
the operator flipped `RUNNER_CLI` while something was parked, and restoring a claude session into
opencode's database is impossible (`Session not found`, loudly, if it were tried). A follow-up
whose parent ran under a DIFFERENT CLI than the driver now serving the queue fails at run time
the same loud way — the operator keeps one CLI per queue.

## Auxiliary services (`.bellows.yaml`)

**A checkout can ask for the containers its tests need.** A `services:` list in a `.bellows.yaml`
at the root of any checkout in the author's workspace — Drone's services syntax, trimmed to what a
test run actually needs:

```yaml
services:
  - name: db
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: secret
```

With `RUNNER_SERVICES=1` (off by default), the driver reads every checkout's file before the run —
through a throwaway container over the workspaces volume (a readout Job over the PVC under
kubernetes), because it has no host path into a named
volume — starts one detached container per service, and puts
the runner on the same user-defined network. **The service's `name` is its DNS name inside the
job**: `postgres://db:5432` resolves for exactly as long as the job runs, and to nothing afterwards.
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
- **The parse is strict to the point of rudeness, deliberately.** Unknown keys are refused, which
  is what makes a pasted Drone pipeline fail loudly instead of doing nothing — and `ports:` is an
  unknown key. There is no host port publishing and no volume mounting: the daemon executing these
  argv is root on the host, and a published port is the one step from "a database for my tests" to
  "a listener on somebody's machine". Size is bounded where author content crosses into this
  process or onto an argv: a `.bellows.yaml` is read only to its first 64 KiB (the readout refuses
  the rest in place), an environment value is at most 8192 characters. A parse refusal fails the
  job terminally with the reason in the output, rather than burning attempts on a file that cannot
  change.
- **The fleet is fenced like the runner, and scoped like it too.** Service containers and the
  network are labeled `factory.job` and `factory.lease`, and named after the job id AND the lease
  token (`factory-job-<id>-<token>-svc-<name>`, `factory-job-<id>-<token>-services`). The
  re-claim fence — the one job-scoped sweep, run before anything is created — removes every
  leftover container and network of the job by the `factory.job` label, previous attempts'
  services included; the teardown after the run, on kill, on timeout filters by `factory.lease`,
  so it can only ever remove the attempt's own fleet. Teardown is the feature's own machinery,
  but the fence runs regardless of the flag, so a fleet from before a `RUNNER_SERVICES` flip off
  meets the next claim's fence all the same; reclaim a fleet that has no next claim by hand with
  `docker rm`/`docker network rm` — by the `factory.job` label, since the names now carry the
  attempt token, and pruning the workspaces volume removes neither.
- **A refused read or a refused service start is infrastructure, not a verdict.** Thrown, so the
  job goes back to its lease instead of being reported failed — the distinction "a run that never
  started is not a failed job" draws, one layer out.
- **The security posture is stated, not solved.** This lets a repo author run arbitrary images
  through the driver's socket — one capability the runner container deliberately does not have. It
  is the same trust the checkout already carried: the agent runs arbitrary code in that tree, and
  the tree now also names containers. What it does not do is widen the blast radius across
  members: services are per-job, on a per-job network, reachable only from that job's runner.
- **`EXECUTOR=kubernetes` refuses the flag at startup**, the way Remote Control is refused:
  services are docker networks and sibling containers the kubernetes runner does not create, and
  silent absence would read as a broken feature rather than the configuration decision it was.

## The session ids, and driving a job from the Claude UI

**There are two of them, and they are not interchangeable.**

| | `session_id` | `remote_session_id` |
| --- | --- | --- |
| Looks like | a uuid | `cse_015tb2nHhHNrBuL7ZDhn9Wx5` |
| Comes from | the driver, which mints it | Anthropic's backend, when the bridge connects |
| Known | before the container starts | seconds into the run, or never |
| Good for | joining a job to its telemetry | `https://claude.ai/code/<id>` |
| Headless jobs | always, under claude-code; under opencode, none — it mints its own and the driver never sees one | never — a `-p` run registers no bridge |

The link is built from the **remote** one. Using the local uuid gives a dead URL, which is an easy
mistake to make and a hard one to notice: both are called "the session id", both are present, and
only one of them resolves.

**The driver mints that id; it never reads it back out of the container.** `claude --session-id
<uuid>` takes the id as an input, which removes the whole problem: there is no output to parse, no
race between the container printing and the driver reading, and a runner that dies in its first
second still leaves a job with a session on it. Scraping was the alternative and it is worse in
every direction — an interactive session reports its state into a TUI rather than onto stdout, so
under Remote Control there is nothing parseable there at all.

It is reported **before** the container is spawned, on its own route rather than folded into the
completion: under Remote Control the link is worth something only while the job is still running.
The report is deliberately non-fatal — a board that is briefly unreachable costs the link, not the
run — and a `409` on it is not acted on, because the heartbeat is the one place that decides a
superseded run must die.

**The remote id has to be gone and found, because it cannot be minted.** The driver polls the
running container for it — `docker exec`, reading the `bridge-session` record out of the session
transcript:

```json
{"type":"bridge-session","sessionId":"f7b4b985-…","bridgeSessionId":"cse_015tb2nHhHNrBuL7ZDhn9Wx5"}
```

The transcript is the only place it is legible: the CLI puts its Remote Control state in a TUI, not
on stdout. Reading it inside the container rather than off the host avoids having to find the auth
volume, and the file is found by a glob over `projects/*/` rather than by rebuilding the CLI's
directory-slug rule, which would break silently the day that rule changes. `remoteSessionArgs`
refuses a session id that is not a uuid before interpolating it into that shell command — the id
arrives from the board on a resume, and a board is not something this process should trust with a
fragment of shell.

The poll gives up after two minutes. A session with no bridge by then is a Remote Control that did
not connect, and the run is no less valid for it. That is also why the second report carries the
remote id and the store `coalesce`s it: the first report of an attempt has none yet and must not
wipe one a later report stored.

Both ids are cleared on every claim, for the same reason `started_at` resets — except on the claim
that resumes a parked job, where the session genuinely is the same one. The attempt that died ran a
different session, and showing its link next to this attempt's output points a reader at work that
was thrown away.

**`RUNNER_REMOTE_CONTROL=1` changes what a job is.** It swaps the headless `-p <command>` for
`--remote-control <container-name> <command>` — an interactive session, with the command as its
opening prompt, that appears at claude.ai/code and can be driven from there or from the mobile app.
An interactive session does not end when the agent stops talking, so:

- the container lives until somebody ends the session or `RUNNER_IDLE_MS` of silence parks it (see
  below), and a drivable job holds its worker slot for that whole time;
- `exitCode` and `output` arrive only at that point, and `output` is a captured TUI — escape codes
  and redraws, not a transcript. The OTLP pipeline is where the session's actual content lives.

Three things it needs that a headless run does not, all decided in `dockerArgs`:

- **A tty with stdin held open** (`-i -t`, and a pipe rather than `'ignore'` for the child's stdin).
  Without a tty the CLI will not start an interactive session; with a tty whose stdin closes
  immediately it exits the moment it starts. The driver never writes to that stdin.
- **The login volume, and no forwarded credentials at all.** Remote Control requires a full-scope
  claude.ai login — `docker/claude-executor/run.sh login` writes one into `claude-executor-auth`.
  `RUNNER_ENV` is skipped entirely in this mode, because a forwarded token does not fail: a
  `setup-token` can only make model requests, so `--remote-control` starts a perfectly ordinary
  local session and the only symptom is that it never appears at claude.ai/code.
- **`TRUST_WORKDIR=1`.** The trust dialog is a real prompt and a driver-started session has nobody
  to answer it. See [the executor README](../docker/claude-executor/README.md) for what accepting it
  implies when the checkout ships a `.claude/settings.local.json`.

Off by default, so that turning a worker slot into a long-lived interactive session is something
somebody typed.

## Standby: parking a drivable job and picking it up again

A session waiting for a human should not hold a container for the hours it may take one to arrive.
So a Remote Control runner that goes quiet is **parked**, not failed:

```
running --(RUNNER_IDLE_MS of silence)--> standby --(POST resume)--> queued --(claim)--> running
```

**The transcript is what makes this work, and it survives because of a decision made for a different
reason.** Remote Control mounts the login volume over `CLAUDE_CONFIG_DIR`, and that is also where
the CLI writes `projects/<path>/<session-id>.jsonl`. So the session outlives its container, and a
new one resumes it with `--resume <sessionId>` — which keeps the original id, since forking it is a
separate flag. The link the UI shows does not move when a job is parked.

The command is delivered **once**. On a resume it is already in the transcript, and sending it again
would re-run the work somebody has been driving by hand. The follow-up is the one exception, decided
by the board and not the driver: its command is new, so the claim says `followUp` and it goes into
the restored transcript — see the section above.

**Silence is the idle signal because it is the one the driver already has.** It reads every chunk
the container writes, so a timer reset on each one costs nothing and keeps this process a client of
the HTTP board and of docker, and of nothing else. Asking the board, or the telemetry store, would
make it a client of something it has no business knowing about.

**`DRIVER_JOB_TIMEOUT_MS` is not armed under Remote Control.** With both bounds running the shorter
one always wins, so at the defaults every drivable job would be killed at thirty minutes and
reported `failed` — and standby would never happen once, which reads as a feature that does not
exist rather than as a misconfiguration. An interactive session has no meaningful total duration:
being driven for three hours is the point. Silence is the bound there.

**`suspend` hands back the attempt the claim took.** Parking is not a failed try, and without the
give-back a job parked three times is `dead`. A run that keeps killing its worker still burns
attempts normally, because that path never reaches `suspend`.

**`suspend` also expires the lease**, exactly as insert does. Standby is not claimable, so this
changes nothing while the job is parked — and then it is the difference between the next poll
picking the job up and it sitting in `queued` until the parked worker's lease finally runs out.

**`resume` takes no lease token.** Nobody holds a parked job, and that is precisely what makes it
resumable by a request from outside rather than only by the worker that parked it. It answers
`409 NOT_STANDBY` for a job that exists but is not parked, which has to read differently from a
`404`: resuming a finished job is a caller mistake, not a missing row.

## Follow-ups and done: a task is over when the user says so

A run finishing is not a task finishing. `POST /api/jobs/:id/follow-up {command}` queues
an adjustment on a **finished** task as a continuation of what it just did, and `POST
/api/jobs/:id/done` records the user closing the task by hand. Between "the executor stopped
talking" and "I am satisfied" sit as many rounds of "again, but tighter" as the human wants.

**A follow-up is a NEW job row, never an edit of the parent.** `job` is an audit record of what ran
(the `created_by` precedent), and overwriting the parent's command or output would erase the very
run the user is following up on. The new row carries `parent_job_id` — it is one row per RUN, but
still one TASK to the member: `GET /api/jobs/:id/thread` resolves any member's id to the whole
chain, the task page renders it as one conversation, a follow-up extends the view in place instead
of navigating away, and the sidenav lists thread roots only — copies of the parent's `repo`,
`session_id` and `remote_session_id` from insert. The
repo copy keeps the thread under its repository's name in the task list; the session copies are what make the claim resume the parent
conversation without any new claim-side rule.

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

**Delivering the command into a restored session is the follow-up's exception to delivered-once, and
`command_delivered_at` is what keeps it an exception.** A follow-up's command is the NEW adjustment
and the restored transcript is the conversation it continues, so it goes out even though the claim
resumes (`followUp: true` → `--resume <id> -p <command>`). But a follow-up that was PARKED has its
command in the transcript already, and its resume is an ordinary resume delivering nothing. `suspend`
stamps `command_delivered_at` — parking is the moment "the command sits in a transcript somebody may
have been driving" becomes true — and the claim returns `followUp` from the pre-update value, so a
fresh or crashed follow-up delivers and a parked one does not.

**A crashed follow-up attempt keeps the session through the re-claim, where an ordinary job's is
cleared.** The claim's keep predicate ("kept when parked", below) extends to rows carrying
`parent_job_id`: the session holds the whole conversation, not just the dead attempt's work, and
clearing it would throw the thread away with the attempt. The command re-delivers on that re-claim,
which is the ordinary retry semantics for a headless run — and unreachable for Remote Control in
practice, since a drivable job parks on silence before its lease can expire.

## Stop and remove: winding a task down, and deleting it

Two person-gated actions (session cookie, like `resume`/`done` — a worker token must never move a
thread the driver does not hold). Both reuse what exists: stopping lands on the standby machinery,
removing lands on the worktree-reclaim machinery.

**Stop parks the task, never destroys it.** `POST /api/jobs/:id/stop` is a person's verdict that
no more work is wanted *right now* — the row keeps its session and its place in the thread, and a
`resume` brings it straight back. A queued or already-parked row is parked directly (the answer is
`{ status: 'standby' }`); a `running` row answers `{ status: 'running', cancelRequestedAt }` and
the request is delivered by the worker's next heartbeat — the `cancelRequested` flag — exactly the
way a lost lease is delivered, and by the same kill. The loading of the `running` answer makes a
stop idempotent: asking twice before the worker parks answers the same instant. A finished or dead
row answers `409 NOT_STOPPABLE` — there is nothing running to stop, and the task's own verdicts are
the ones that outlived the run.

**The stop lands when the parking (or the finishing) lands, never when the request does.**
`cancel_requested_at` is cleared by `suspend` and by `complete` — parking a run IS finishing the
stop, and a run that finishes under its own power before the driver reads the flag needs no
parking. The claim does **not** clear it: a driver that dies mid-stop drops its lease, the next
claimor picks the row up, and the flag tells it the previous worker never parked the task — so it
kills the attempt it spawned and parks, preserving the user's stop through a crash. That is the
same dead-driver story as a lost lease, with the verdict "park it instead of running it".

**Remove deletes the whole thread and queues its worktree for removal.** `POST /api/jobs/:id/remove`
deletes the task's root and every follow-up — the audit rows, not just the newest run — and, in the
same transaction, inserts a `task_reclaim` row for the driver to delete the tree (see the section
above). The transaction takes the same advisory lock the claim takes, so a claim cannot slip a
`running` row between the check and the delete; Remove is refused with `409 TASK_RUNNING` while any
thread member is running, because a live run's worktree is exactly what must not come down under it
— stop first, then remove. Nothing on the row survives: the thread's nav entry, its tabs, its
Reclaim-eligible tree.

**The reclaim is its own queue, not a verdict signal.** `threadTerminal` is the driver's completing
attempt claiming its own tree; a removed thread has no attempt to complete, so the board hands the
tree itself out: `POST /api/reclaims/claim {worker}` returns the oldest queued row
(`{ id, rootJobId, repo, workspacePath, leaseExpiresAt }`) or 204, and `POST /api/reclaims/:id/ack`
proves it gone. The row id is the lease token, ack matches on `claimed_by`, and the driver drains
the queue in a loop parallel to its job claims — claim, remove the worktree, ack, repeat — so a
worker that dies mid-reclaim simply loses the lease and the next poll picks the tree up again. A
removed task cannot be undeleted; the worktree removal is the last thing to land, and it lands
because the rows are already gone.

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
`image:` plus a `- name:`/`- command:` list, bare or quoted scalars, comments and blank lines.
Anything else — tabs, unknown keys, a seventeenth gate, a flag-shaped image — is a named error
with the line number.

**One environment container per task worktree, a `docker exec` per gate.** The container
(`factory-env-…`, labelled `factory.gates=<key>`) runs the declared image as a `sleep infinity`
sleeper over the workspaces volume, working directory at the task worktree —
`<org>/<uuid>/.worktrees/<root id>`, the same tree the coding agent edits, so gates see exactly
what the agent wrote. The key is the worktree path now, and with it the environment is per TASK:
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
a test suite can take minutes, and it must not outrun the lease it runs under. Each state change
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
container per member+repo checkout and `docker exec`s each gate into it. Kubernetes runs each
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
the startup sync is what makes each run start from the code — and the declared gates — that
main actually has. At the start of each attempt, before the runner spawns, one container
fetches the remote and then: the task's worktree is created
branched off `origin/<default>` (first attempt of the thread) or rebased onto the new default
with `--autostash`, keeping its own commits AND any uncommitted edits the previous run left —
which is what makes a follow-up, which lands in this same tree by design, work whether or not
the last run finished tidy, and what keeps a kubernetes thread (where nothing commits for you)
alive across turns. The fetch's credential: the claim env rides the env file as before, and
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
the shared tree. Two terminal pre-run refusals never reach `runner.run`, whose cleanup is the
ordinary release path — a gates file that cannot be read, and gates this driver cannot run —
so the loop hands the fence back explicitly (kubernetes's ownership-checked claim release;
docker holds nothing) before failing the job: a refusal that never runs must not hold the
checkout forever. Two conflicts
still dead-end the attempt, with the work preserved and named: a rebase whose COMMITS conflict
aborts itself (the worktree must never sit mid-rebase), and a rebase whose reapplied STASH
conflicts leaves the markers and the retained autostash in the tree and refuses — a tree with
unmerged entries is not one to run on. The same
protection covers the worktree PATH: a directory that holds a git tree this sync did
not create is refused, never deleted — whatever uncommitted work sits there belongs to an agent
session. The clone's own working tree is never touched — under the worktree model that is
finally literally true, where the old sync hard-reset the clone's default branch and destroyed
whatever stray edits sat there.

**The task worktree is reclaimed when the thread ends — finishing or deleting a task cleans up
its tree (issue #47).** The sync created the tree, and every commit on it belongs to one thread;
once the whole thread is terminal the tree holds nothing worth keeping. The signal is the
verdict itself: `complete` answers `{ id, status, threadTerminal }`, where `threadTerminal` is
the store's answer — computed in the same transaction as the verdict — to whether EVERY job of
the thread is terminal (`succeeded`/`failed`/`dead`), and when it is true the driver removes the
tree via the worktree script run as the sync's twin — a throwaway `docker run` naming the clone
and the tree, or a reclaim Job over the PVC whose name carries the lease token. The driver does
not ask the board for the thread any more: an earlier shape read `GET /api/jobs/:id/thread`
after the verdict, which put the whole thread's commands, output and session ids on a route the
worker token could reach — audit data of jobs the driver never held — and computing the answer
at the verdict moment also closes a race the read had: a follow-up inserted between the verdict
and the read made the thread non-terminal at the last possible moment, where the verdict-moment
answer is final. A follow-up still queued, parked, or running keeps `threadTerminal` false and
the tree in place; a follow-up created after the reclaim simply recreates the tree on the
surviving `factory/<root>` branch the next time it syncs. The reclaim deletes only
what the sync would have — a registered worktree of the clone, or the bare leftover directory
the sync itself would have removed — and REFUSES, like the sync, a path that holds a git tree
that is not this clone's worktree, logging the reason rather than touching it. It is
best-effort by contract: the verdict is already on the board when it runs, so a board that
refuses the complete call, a runner that refuses the tree, or a daemon that says no costs the
reclaim, never the verdict — the tree stays and the branch survives for a later follow-up. Who
reclaims: the driver's last completing attempt. Deleting a task by hand is the other end of the same
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

## Decisions

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

**`standby` is a status, not an expired lease.** Parking by simply releasing the lease would leave
the job claimable, so the next idle poll — five seconds later — would resume it, which is the
opposite of parking it. As a status it falls outside `job_claimable`'s partial predicate
(`status in ('queued','running')`) and is invisible to the claim without one extra word of SQL.
Adding it did cost the constraint rewrite that 006's header warns about; that was cheaper than a
second predicate on the hot path.

**A claim resumes a session only when the job was parked or is a follow-up.** The claim keeps
`session_id` when the row's previous status was `queued` or the row carries `parent_job_id`, and
clears it otherwise, so a lease that expired mid-run starts fresh for an ordinary job. That attempt's
session is not this one, and replaying its transcript would resume work whose output was thrown away
— which is why the follow-up is the carved-out exception rather than the rule: its session holds the
parent conversation, and clearing it would throw the thread away with the attempt.

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

**`repo` and `executor` are grouping metadata for the tasks UI, not execution inputs.** The task
list names the repository workspace a task belongs to and the executor it was queued with, so a
job carries both labels — nullable, because every job queued before the tasks UI has neither, and 014
adds them as plain text for the same reason `remote_session_id` is. No foreign keys: `job` is an
audit record (the `created_by` precedent — "records who did rather than limiting what they may do"),
while `user_repo` and `user_executor` rows are member state that comes and goes with a PUT, and a
deselected repository must not take its history with it. Shape-validated only, under the same
path-segment rules a checkout's name obeys, because nothing consumes either label: the claim payload
is unchanged, and a wrong-but-well-formed label in a hand-written API call is as harmless as a
typo'd command. Wiring an executor into the driver remains future work — that change will decide
what an executor name means to a worker, and whether existence is then checked at create or at
claim. "Nothing runs an executor yet" stays true.

## Deliberately absent

- **No idempotency key on create.** A `POST /api/jobs` that times out and is retried creates a
  second job, and the command runs twice. Add a client-supplied id with `on conflict do nothing`
  when a driver actually retries creates.
- **No priority, no scheduling.** A dead job is reaped; a queued one is taken in order. Stop and
  remove exist (a person can wind a task down or delete it — see the section above), but a queued
  job's *place* in the queue is not something anybody moves.
- **No cap on how long a job may sit on standby, and nothing reaps one.** A parked job waits for a
  `resume` forever. It costs a row rather than a worker slot, which is the whole point of parking it.
- **One auth volume, shared by every concurrent Remote Control runner.** They all write
  `.claude.json` in the same directory. Fine for one drivable job at a time and unexamined beyond
  that; a volume per job would make the login a template to copy rather than a mount.
- **No per-job authorization.** There is authentication now — see [auth.md](auth.md) — and the two
  credentials are disjoint: a session cookie queues, follows up, marks done, resumes, stops, removes
  and reads, a `Bearer fwt_…` worker token claims, heartbeats, streams output, suspends, completes,
  and drains the reclaim queue. A session on `/claim`
  would let any member take work away from the driver running it; a worker token on `POST /api/jobs`
  would produce a job with no author. But **membership is not a sandbox**: every member can queue a
  command that runs against their own checkouts, follow up on their own tasks, and close any task —
  and `job.created_by` records who did rather than limiting what they may do. Follow-ups are the one
  exception, and not an authorization regime: the child resumes the parent's session, and a session
  only resumes in the tree it ran in — the author's (see the follow-ups section above). Done, stop
  and remove have no such coupling, so they stay open to every member.
  Under `AUTH_MODE=none` all of it is open, including the worker routes — see [security.md](security.md),
  which is where the consequence is written down.
- **No service volumes, health checks, depends-on ordering or restart policies.** A service that
   needs a warmed database is the agent's problem — it can sleep and retry, which is the one
   superpower a headless run has. Add keys to the parser when a real job needs them, not before.
- **Under kubernetes a service name is namespace-global.** Docker gives each attempt its own
  network, so two concurrent jobs can both run a service called `db`. A k8s Service named `db`
  is one object per namespace, so a second concurrent job that declares `db` is refused
  terminally, naming the conflict — the same rule as a duplicate across checkouts, because no
  ordering rule reads as anything but "the wrong database came up". Sequential jobs are fine:
  the name goes free when the attempt's teardown deletes it.

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
the off-switch proving the daemon hears nothing services-specific when `RUNNER_SERVICES` is
unset, and the attempt-scoping pins: no stale attempt's argv may name a sibling attempt's
resources, and the fence is the one sweep allowed to be job-scoped.

`npm run test:jobs` (`scripts/test-jobs.sh`) is the end-to-end: a real board, a real database, a
real driver and real containers, with no Claude and no credential. The runners are two stub images
whose entrypoints echo and exit — the job's `output` comes back as the arguments the container was
given, which is what proves the prompt, the mount and the completion path all line up. It is also
what proves the session round-trip: the `sessionId` the board hands back is found inside those
arguments, so the link points at the session the job actually ran as. Standby is covered in the
board phase rather than the driver phase — park, prove a parked job is not offered to an idle poll,
resume, and check the claim carries the session back — because none of that needs a container. It
creates a
`*_test` database, two images and a volume, and drops all of them on exit.

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
