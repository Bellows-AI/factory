## Purpose

Executor session transcripts are retained in a dedicated location instead of dying with the
runner container, so later efficiency analysis (factory-stats) has ground truth to work from.
Tracked as GitHub issue #55.

## ADDED Requirements

### Requirement: Headless claude-code transcripts survive the run
A headless claude-code run SHALL write its session transcript to persistent storage (the
workspaces volume) such that the transcript survives the run container's teardown — including
an abnormal end (kill, timeout, driver crash after the run), not only a clean completion.
The mechanism SHALL NOT have a post-run copy window in which a transcript can be lost.

#### Scenario: Normal completion
- **WHEN** a headless claude-code job completes and its runner container is removed
- **THEN** the run's session transcript exists on the workspaces volume

#### Scenario: Killed run
- **WHEN** a headless claude-code run is killed mid-session (cancel, lease loss, timeout) and the container is removed
- **THEN** the transcript of everything the session wrote up to the kill exists on the workspaces volume

### Requirement: Transcripts live in a dedicated, keyed location
Transcripts SHALL be written to a path dedicated to transcripts — never into a checkout, a
member's visible tree, or a shared pile. The path SHALL be scoped per member and per task
thread root (`<workspacePath>/.factory/transcripts/<rootJobId>/`), so every attempt and
follow-up of one thread lands in one directory and different threads never share one. The
directory naming SHALL be ignored by the workspace reconcile as a non-checkout.

#### Scenario: Two threads of one member
- **WHEN** two task threads run for the same member on the same repository
- **THEN** each thread's transcripts land in its own `<rootJobId>` directory, and neither run can write into the other's

#### Scenario: Workspace reconcile ignores the store
- **WHEN** the workspace reconcile lists the member tree containing `.factory/transcripts/`
- **THEN** no transcript directory is cloned, updated, or mistaken for a checkout

### Requirement: Baked runner configuration survives the redirect
When the transcript location displaces the CLI's default config directory, the CLI SHALL run
with the baked configuration intact — the git-guard hook and every baked setting MUST be in
force exactly as in an unredirected run.

#### Scenario: Guard still enforced
- **WHEN** a redirected headless run attempts a deny-listed git command (e.g. `git switch` off the task branch)
- **THEN** the baked git-guard hook refuses it, as it would in an unredirected run

### Requirement: Remote Control keeps its existing store
Under Remote Control the config directory SHALL remain the auth volume. The transcript-store
mechanism MUST NOT redirect it: standby/park depends on the transcript surviving its
container on that volume for a later `--resume`.

#### Scenario: RC run is untouched
- **WHEN** a Remote Control job is claimed and spawned
- **THEN** the runner's config directory is the auth volume and no transcript-store path is passed

### Requirement: The transcript location is not member-steerable
The environment name carrying the transcript location SHALL be reserved on both the driver
and the board, so member configuration can neither set nor shadow it — the value the runner
receives is always the driver-composed one.

#### Scenario: Member tries to claim the name
- **WHEN** a member PUTs an environment variable under the reserved transcript-store name
- **THEN** the board refuses the write

### Requirement: The mechanism is claude-code-headless only
Only headless claude-code runs receive the transcript-store location. Opencode runs persist
through their own per-member session database and SHALL NOT be redirected or duplicated.

#### Scenario: Opencode run is untouched
- **WHEN** an opencode job is claimed and spawned
- **THEN** the runner receives only the existing `XDG_DATA_HOME` persistence, and no transcript-store path

### Requirement: Both executors persist transcripts identically
The docker and kubernetes transports SHALL pass the same transcript-store location for the
same claim, so transcript persistence does not depend on which executor ran the job.

#### Scenario: Same claim, either executor
- **WHEN** the same claim is run once under `EXECUTOR=docker` and once under `EXECUTOR=kubernetes`
- **THEN** both runners receive the same transcript-store path, and transcripts persist on the workspaces volume in both cases
