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
                                        userId, workspacePath, resumeSessionId} | 204
  every request carries `authorization: Bearer $JOB_BOARD_TOKEN`, when the board requires one
  resumeSessionId ? restore that session : mint one, POST /api/jobs/:id/session
  spawn the runner with the command, as that session
  (claude-code mints and reports a session uuid; opencode does neither — see below)
  POST /api/jobs/:id/heartbeat {leaseToken}     every leaseSeconds/3, while it runs
POST /api/jobs/:id/complete {leaseToken, status, exitCode, output}
  ... or, if the runner went quiet:
POST /api/jobs/:id/suspend  {leaseToken}        -> standby, session kept
POST /api/jobs/:id/resume   {}                  -> queued, claimed again with resumeSessionId
```

**A `409` from heartbeat means the container must be killed.** Its lease expired, the job was
handed to someone else, and nothing it reports will be accepted. The board cannot stop a worker —
it can only refuse it — so double execution is prevented by the driver acting on that 409, not by
the database. This is the single most important line in this file.

## The driver (`driver/`)

A fourth workspace, with no dependency on `core` and none at run time at all. It is a client of the
HTTP board, never of the database — which is what lets it run anywhere the board is reachable.

```bash
docker build -t claude-executor docker/claude-executor     # the claude-code runner image, once
docker build -t opencode-executor docker/opencode-executor # the opencode runner image, once
npm run driver                                             # against a board on 127.0.0.1:8080

docker compose --profile driver up -d driver             # or in the stack
```

Everything below describes the docker runner. `EXECUTOR=kubernetes` swaps the platform under it —
runners become batch Jobs, created and polled and deleted against the API server — while this
contract, the loop and the lease rules stand untouched. The parallel decisions and what the
cluster phase adds are in [kubernetes.md](kubernetes.md).

| Variable | Default | Notes |
| --- | --- | --- |
| `JOB_BOARD_URL` | `http://127.0.0.1:8080` | Must be http(s); the scheme is checked, because `new URL('dashboard:8080')` parses. |
| `JOB_BOARD_TOKEN` | unset | The worker token, from `npm run worker-token -- --name <worker>`. Required against a board running `AUTH_MODE=github`; unset against an open one, where the header is **omitted rather than sent empty** — an empty Bearer is a credential that failed, not one that was never offered. It is also how the board knows which organization this driver works for. |
| `RUNNER_CLI` | `claude-code` | Which CLI the runner image speaks: `claude-code` or `opencode`. Fatal on anything else. `opencode` is headless only — `RUNNER_REMOTE_CONTROL` and `RUNNER_SKIP_PERMISSIONS` are refused under it at startup. |
| `EXECUTOR_IMAGE` | `claude-executor`, or `opencode-executor` under `RUNNER_CLI=opencode` | An explicit value always wins. |
| `WORKSPACE_VOLUME` | `factory-ai_workspaces` | A volume **name**, not a host path — see below. |
| `RUNNER_NETWORK` | unset | Join the compose network or the runner's telemetry reaches nothing. |
| `DRIVER_CONCURRENCY` | `2` | |
| `DRIVER_POLL_MS` | `5000` | |
| `DRIVER_LEASE_SECONDS` | `300` | Heartbeat is a third of this. |
| `DRIVER_JOB_TIMEOUT_MS` | `1800000` | The container is `docker kill`ed and the job reported failed, with a note. **Not armed under Remote Control.** |
| `RUNNER_IDLE_MS` | `3600000` | Remote Control only: silence for this long parks the job on standby. |
| `RUNNER_SKIP_PERMISSIONS` | off | Appends `--dangerously-skip-permissions`. Read the paragraph below. |
| `RUNNER_ENV` | `CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY` | Names forwarded to the runner. Ignored under Remote Control. |
| `RUNNER_REMOTE_CONTROL` | off | Runs the job as a drivable session instead of a headless prompt. Read the section below. |
| `RUNNER_AUTH_VOLUME` | `claude-executor-auth` | The claude.ai login. Mounted only under Remote Control. |
| `EXECUTOR` | `docker` | `kubernetes` swaps the `docker run` for a batch Job in the namespace the driver runs in — see [kubernetes.md](kubernetes.md). Explicit enum: anything else is fatal, because a typo must not read as "docker is fine" while jobs are claimed and nothing runs. |
| `K8S_NAMESPACE` | `default` | Where runner Jobs are created. Meaningless under docker. The chart sets it via the downward API. |
| `RUNNER_CREDENTIALS_SECRET` | unset | The Secret holding runner credentials under `EXECUTOR=kubernetes`, one key per `RUNNER_ENV` name — the k8s form of `-e NAME`: names travel, values stay in the Secret. Unset forwards nothing. |
| `RUNNER_IMAGE_PULL_POLICY` | `IfNotPresent` | The runner image's pull policy under `EXECUTOR=kubernetes`. Kubernetes defaults an untagged or `:latest` image to `Always` and would ignore the node's own images; the docker runner has no equivalent problem, so the docker behavior has to be stated. |

**The workspace is passed as a volume name, not a path.** The driver's runners are *siblings*, not
children: it talks to the host's daemon over a socket, so a path inside the driver container means
nothing to that daemon, and there is no host path to give either — the dashboard writes its
checkouts into a named volume precisely to avoid one.

**`WORKDIR` comes from the board, not from the driver's configuration.** The claim carries
`workspacePath` — a root-relative `<orgId>/<userId>` — and the runner starts at
`<workspaceMount>/<that>`. `ORG_ID` used to live in this table and build `<mount>/<orgId>`, one tree
that every member's agent shared. Checkouts are per member now, so only the board knows where a
given job's tree is: it is the thing that created the directory. Each side owns what it knows — the
board owns the layout, the driver owns the mount point — which is also why the field is a
ready-made relative path rather than a raw user id the driver would have to interpret.

- **A null `workspacePath` fails the job, with a reason, rather than falling back.** There is no
  safe fallback left: both `<mount>` and `<mount>/<orgId>` are the *parent* of every member's tree,
  and handing either to a container that may be running `--dangerously-skip-permissions` is a
  cross-tenant read. Failing it also drives the job to a terminal state somebody can see, instead of
  leaving it to be reclaimed on every lease expiry forever.
- **The driver re-asserts `^<org>/<uuid>$` before interpolating it.** A board is not something this
  process trusts with a fragment of a shell command — the rule `remoteSessionArgs` already applies
  to a session id — and here a `..` would point at everybody's checkouts. The pattern is **copied**
  from the server rather than imported: this package depends on nothing, deliberately.

**Credentials are passed as `-e NAME`, never `-e NAME=value`.** The value then comes from the
driver's own environment instead of a `docker run` argv that every `ps` on the host can read. This
is the same distinction the workspace reconcile makes for the git token.

**`RUNNER_SKIP_PERMISSIONS` is a real decision, not a nuisance flag.** Off, a headless agent stalls
at permission prompts nobody can answer and the job burns its timeout. On, it edits and runs
whatever it likes inside the container — which is also mounted onto that member's checkouts. It stays
off by default so that turning it on is something somebody typed.

**A run that never started is not a failed job.** If `docker` is missing or the daemon refuses, the
driver logs and says nothing to the board: reporting `failed` would blame the command for the
driver's problem and burn an attempt. The lease expires and the job is offered again, which is
visible in `attempts`.

**The heartbeat is raced against the run finishing, not simply slept.** The beat period is a third
of the lease — 100s by default — and awaiting it before reporting left every finished job sitting
in `running` for a minute and a half. Found by running the driver for real; a unit test with an
instant fake clock cannot see it, so `loop.test.ts` models a period that never elapses.

**`RUNNER_CLI=opencode` swaps the CLI behind the image, and with it the session contract.** The
headless form becomes `run <command>`, and no session is minted, passed or reported: opencode
mints its own ids and cannot adopt one — `run --session <id>` continues a session opencode
created, it never creates one with a given id — so minting a uuid anyway would put a session on
the board that the runner never used. These jobs show no session link. Their runs still emit OTLP,
but the server's metric map carries no opencode rows yet, so spend records as an unmapped agent —
null, never zero — until those rows are added (see [limits.md](limits.md)). The combination is
refused at startup with `RUNNER_REMOTE_CONTROL` (that is claude-code's bridge) and with
`RUNNER_SKIP_PERMISSIONS` (that appends a claude-code flag; opencode's permissions come from the
`opencode.json` baked into its image — see [its README](../docker/opencode-executor/README.md)).
A parked job claimed by an opencode driver is failed with a reason rather than restored: standby
is a Remote Control feature, so a claim carrying `resumeSessionId` under opencode means the
operator flipped `RUNNER_CLI` while something was parked, and re-running that command would
re-enter a transcript somebody may have been driving by hand.

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
would re-run the work somebody has been driving by hand.

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

**A claim resumes a session only when the job was parked.** The claim keeps `session_id` when the
row's previous status was `queued` and clears it otherwise, so a lease that expired mid-run starts
fresh. That attempt's session is not this one, and replaying its transcript would resume work whose
output was thrown away.

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

## Deliberately absent

- **No idempotency key on create.** A `POST /api/jobs` that times out and is retried creates a
  second job, and the command runs twice. Add a client-supplied id with `on conflict do nothing`
  when a driver actually retries creates.
- **No cancel, no priority, no scheduling.** A dead job is reaped; a queued one is taken in order.
- **No cap on how long a job may sit on standby, and nothing reaps one.** A parked job waits for a
  `resume` forever. It costs a row rather than a worker slot, which is the whole point of parking it.
- **One auth volume, shared by every concurrent Remote Control runner.** They all write
  `.claude.json` in the same directory. Fine for one drivable job at a time and unexamined beyond
  that; a volume per job would make the login a template to copy rather than a mount.
- **No per-job authorization.** There is authentication now — see [auth.md](auth.md) — and the two
  credentials are disjoint: a session cookie queues, resumes and reads, a `Bearer fwt_…` worker token
  claims, heartbeats, suspends and completes. A session on `/claim` would let any member take work
  away from the driver running it; a worker token on `POST /api/jobs` would produce a job with no
  author. But **membership is not a sandbox**: every member can queue a command that runs against the
  their own checkouts, and `job.created_by` records who did rather than limiting what they may do.
  Under `AUTH_MODE=none` all of it is open, including the worker routes — see [security.md](security.md),
  which is where the consequence is written down.

## Testing

The lease rules are tested against a real database only (`server/test-db/job-store.test.ts`,
`npm run test:db`) — a second implementation of them in a stub would only ever agree with itself.
`server/test/routes.jobs.test.ts` covers the HTTP contract with a stub that fakes verdicts, and
pins that the board is **not** registered when `buildApp` gets no job store.

Lease expiry is simulated by ageing `lease_expires_at` with SQL, never by sleeping.

`driver/test/` injects both the board and docker, so it spawns nothing and needs no daemon.
`dockerArgs()` is exported and pinned separately: everything security-relevant about a runner is
decided in that one array.

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
- **It exports `GITHUB_MODE=none` on every boot.** The default `app` makes `loadConfig` refuse a
  `*_test` database outright, and a fetching board would start cloning repositories.

The reclaim and fencing checks age `lease_expires_at` with `psql` rather than waiting a lease out,
so the script stays a few seconds rather than a few minutes.
