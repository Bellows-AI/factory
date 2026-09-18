# executor-volume-isolation Delta

## Purpose

Containers the driver starts see only their own job's workspace subtree of the workspaces
volume, on both executors, so one organization's agent cannot reach another organization's —
or another member's — source, transcripts or session state. The dashboard's whole-volume
access is the stated, deliberate exception that makes provisioning and org-level analysis
possible.

## ADDED Requirements

### Requirement: A runner container sees only its own workspace subtree
A runner container's view of the workspaces volume SHALL begin at its own job's workspace
path (`<orgId>/<userId>`) and SHALL NOT expose any other organization's or any other member's
tree — not read-only, not by traversal, not by any path the mount grants. The boundary SHALL
be enforced by the container's mount itself, so an agent running arbitrary code inside the
container cannot cross it regardless of what the code attempts.

#### Scenario: Runner of one member cannot see another member's tree
- **WHEN** a runner runs for org A's member 1 and the workspaces volume also holds org A's
  member 2 and org B's members
- **THEN** the container's filesystem shows only member 1's workspace, and no path inside the
  container resolves to member 2's or org B's files

#### Scenario: Agent code cannot traverse past the boundary
- **WHEN** code inside the runner attempts to reach a sibling or foreign workspace by
  relative traversal, absolute path, or symlink planted in its own tree
- **THEN** every such attempt fails, because the mount root is the member's subtree itself

### Requirement: Auxiliary containers are scoped identically
Every auxiliary container the driver starts for a job — gates, worktree sync, workspace
readouts, publish steps — SHALL mount the same per-job workspace subtree as that job's
runner, and nothing broader.

#### Scenario: Gate run sees one checkout
- **WHEN** a gate runs for one job's checkout
- **THEN** the gate container reads and writes that checkout and its `.factory` state, and no
  other member's or org's checkout is reachable from it

### Requirement: A missing mount target fails loud
When the workspace directory a job's container mount targets does not exist at container
start, the container SHALL fail to start visibly. The system SHALL NOT fall back to mounting
a broader scope — the whole volume included — to make a missing directory invisible.

#### Scenario: Job starts before its workspace directory exists
- **WHEN** a job's mount target directory is absent when its container is created
- **THEN** the container never reaches a running state with a wider mount: the kubernetes pod
  is stuck in creation with a volume error, and the docker run fails with a mount error

### Requirement: Provisioning precedes the mount
The workspace directory a job's mount targets SHALL exist before any container for that job
is started: the board reports a `workspacePath` on a claim only for a member whose workspace
has been provisioned, and provisioning creates the directory tree the mount names.

#### Scenario: Claim for a provisioned member
- **WHEN** a driver claims a job whose member signed in at least once (workspace provisioned
  at sign-in and on workspace polls)
- **THEN** the mount target directory already exists on the volume when the job's containers
  start, and the loud-failure path above is unreachable in normal operation

### Requirement: The dashboard's whole-volume access is the stated exception
The dashboard process SHALL retain read-write access to the whole workspaces volume, because
it is the provisioning plane and the org-level analysis plane (workspace disk statistics,
transcript aggregation). The per-job scoping SHALL apply to containers the driver starts and
to nothing else; org-level analysis SHALL keep working unchanged, reading through the
dashboard's own mount.

#### Scenario: Org-level disk statistics still enumerate every org
- **WHEN** workspace disk statistics or transcript aggregation run in the dashboard
- **THEN** they traverse all orgs' trees as before, unaffected by the runners' scoped mounts

#### Scenario: A runner cannot use the dashboard's visibility
- **WHEN** a runner or auxiliary container runs for any job
- **THEN** its mount is its own subtree only — the exception is the dashboard process, not a
  capability any driver-started container holds

### Requirement: Both executors scope identically
The docker executor and the kubernetes executor SHALL grant a container the same workspace
subtree for the same claim, so executor choice changes nothing about what an agent can reach.

#### Scenario: Same claim, either executor
- **WHEN** the same job claim runs once under the docker executor and once under the
  kubernetes executor
- **THEN** the container's visible volume root is the member's workspace subtree in both
  cases
