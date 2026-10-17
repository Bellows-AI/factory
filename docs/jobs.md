# Job board

A job is a text command a worker runs as an agent prompt; the board leases jobs out and records
verdicts, and the driver is the only process that spawns anything. Graphs are
[workflows.md](workflows.md), the kubernetes executor [kubernetes.md](kubernetes.md), credentials
[auth.md](auth.md).

## Board

| Concern | Code | Test |
| --- | --- | --- |
| Routes, validation, refusal codes | `server/src/routes/jobs.ts`, `job-handlers-worker.ts`, `job-handlers-actions.ts`, `job-field-validation*.ts`, `job-refusals.ts`, `job-limits.ts` | `server/test/routes.jobs.test.ts` |
| Schema | `server/migrations/006_jobs.sql` and later `0*_job_*.sql` | `server/test-db/job-store.test.ts` |
| `failure_cause` under a `gate`/`publish`/`helper` kind: validated (`BAD_FAILURE_KIND`), written with the verdict, nulled by a completion refusal, decided on by batch recovery, served as `failureCause` on job reads | `server/migrations/065_batch_recovery_evidence.sql`, `server/src/routes/job-field-validation.ts`, `server/src/db/job-store-worker.ts`, `job-store-evidence.ts`, `job-store-reads.ts` | `server/test/routes.jobs.test.ts`, `server/test-db/job-store.test.ts` |
| Claim, lease, fencing, `claim_seq`, contention requeue, settle long-poll; an infrastructure interruption (`POST /interrupt`) refunds the attempt inside `INTERRUPTION_BUDGET`, served as `interruptions` on detail reads (`071_job_interruptions.sql`); an expired lease is recorded by the claim that takes the row over as the superseded claim's interruption (`LEASE_EXPIRED_REASON`), spending no attempt and keeping the session it resumes, until the budget is spent — past it an expiry spends an attempt, then retires `dead` with the session kept; complete, suspend, requeue and a released interrupt record a settle receipt per lease token, so the identical request replays its answer and any other under a concluded lease is `409` (`072_job_settle_receipts.sql`); a claim reserves its candidate (`claim_deferred_until`, `073_job_claim_deferral.sql`) for `CLAIM_PREPARE_SECONDS`, reads its plan outside every lock, then acquires it under the row and root locks against the `claim_seq` it reserved, the lease measured from that acquisition; a candidate whose preparation throws keeps the reservation as its backoff, attempt unspent, and sorts behind every candidate that never failed; the dead retirement commits on its own | `server/src/db/job-store-claim.ts`, `job-store-actions.ts`, `job-store-receipts.ts`, `job-store.ts`, `job-store-reads.ts` | `server/test-db/job-store.test.ts`, `job-store.thread-claim.test.ts`, `job-store.settle.test.ts`, `job-store.requeue.test.ts`, `job-store.interrupt.test.ts`, `job-store.receipts.test.ts`, `job-store.claim-prep.test.ts` |
| Follow-up (`409 NOT_FINISHED` while any thread member is unfinished, as a retry; a keyed replay answers first), done, retry (the fresh run: a new row with no session), command edit, sessionless recap | `server/src/db/job-store-actions.ts`, `follow-up-recap.ts` | `server/test-db/job-store.follow-ups.test.ts`, `job-store.retries.test.ts`, `job-store.command-edit.test.ts`, `server/test/follow-up-recap.test.ts` |
| Stop, remove, reopen, worktree reclaim; a done thread's verdict queues its reclaim claimed by the completing worker (`reclaimId`), and `worktree_reclaimed_at` is stamped only by an ack | `server/src/db/job-store-actions.ts`, `job-store-rows.ts`, `job-store-claim.ts` | `server/test-db/job-store.stop-remove.test.ts`, `job-store.receipts.test.ts`, `job-store.follow-ups.test.ts` |
| Merged PR closing its threads | `server/src/db/job-store-merge.ts` | `server/test-db/job-store.merge-close.test.ts` |
| Task summary (`GET /api/tasks`) | `server/src/db/task-summary.ts`, `server/src/routes/tasks.ts` | `server/test/task-summary.test.ts`, `server/test/routes.tasks.test.ts` |
| Attribution, wall clock (less agent-question waits, banked by `wallTickFragment` and live), `setupMs` (`069_job_setup_ms.sql`, detail reads only), publication | `server/src/db/job-store-reads.ts`, `job-store-rows.ts`, `web/src/format.ts` | `server/test-db/job-store.attribution.test.ts`, `job-store.wall-clock.test.ts`, `job-store.test.ts`, `job-store.publication.test.ts`, `web/test/task-derivations.test.ts`, `e2e/task-question.spec.ts` |
| Mutation idempotency (`Idempotency-Key`) | `server/src/routes/job-idempotency.ts`, `server/src/db/job-store-idempotency.ts`, `server/migrations/058_job_idempotency.sql` | `server/test-db/job-store.idempotency.test.ts`, `server/test/routes.jobs.test.ts`, `server/test-db/cli.scripting.test.ts` |
| `.bellows.yaml` grammar: gates and their `timeout:` and `on_demand:`, `environment.cache`, `policy:`, `reviewers:` (`bellows.ts`), services with their `ports:` (`bellows-services.ts`) | `server/src/workspace/bellows.ts`, `bellows-services.ts`, `bellows-reviewers.ts`, `bellows-cache.ts` | `server/test/bellows.test.ts`, `bellows.plan.test.ts`, `bellows.policy.test.ts`, `bellows.reviewers.test.ts` |
| Execution plan at claim: gates, services, policy and reviewers read through the GitHub API at the base branch tip, validated whole (port collisions, image, service count), delivered as `gates`, `services`, `planRevision` or `planRefusal`; an outage rejects the claim and defers that task — retried, never failed, its failure in the board log only | `server/src/github/file-read.ts`, `server/src/workspace/bellows-plan.ts`, `server/src/db/job-store-claim.ts`, `driver/src/loop-run.ts` | `server/test/bellows.plan.test.ts`, `server/test/claim-plan.test.ts`, `server/test-db/job-store.gates.test.ts` |
| Gates, board side: the report and its replace-never-append state | `server/src/db/job-store-worker.ts`, `server/migrations/018_job_gates.sql` | `server/test-db/job-store.gates.test.ts` |
| Master prompt and turn context, rendered | `server/src/db/master-prompt.ts` | `server/test/master-prompt.test.ts` |
| Objective mode (no `workflow`) | `core/src/job-mode.ts`, `server/migrations/051_job_mode.sql` | `server/test-db/job-store.objective.test.ts` |
| Skill selection and `skillRefusal` | `core/src/skills.ts`, `server/src/skills.ts`, `server/migrations/055_job_skills.sql` | `core/test/skills.test.ts`, `server/test-db/job-store.skills.test.ts` |
| Evidence policy and the completion check | `server/src/db/evidence-policy.ts`, `job-store-evidence.ts`, `server/migrations/053_job_evidence.sql` | `server/test/evidence-policy.test.ts`, `server/test-db/job-store.evidence.test.ts` |
| Independent reviewer jobs (`review_of`) | `server/src/db/job-store-reviews.ts`, `review-prompt.ts`, `server/src/routes/job-handlers-reviews.ts`, `server/migrations/056_job_review.sql` | `server/test-db/job-store.reviews.test.ts`, `server/test/review-prompt.test.ts` |
| Agent questions | `server/src/db/job-store-questions.ts`, `server/src/routes/job-handlers-questions.ts`, `server/migrations/050_job_question.sql` | `server/test-db/job-store.questions.test.ts` |

## Driver and runners

| Concern | Code | Test |
| --- | --- | --- |
| Claim loop, verdicts, reclaim; a decided verdict is retried for the lease on a 5xx or a dropped connection, sent once on any other 4xx, and never rewritten, and its serialized body is fit to the route's `BODY_LIMIT` by dropping the oldest output; an attempt that throws is logged, never a rejected loop | `driver/src/loop*.ts`, `board.ts`, `claim.ts`, `board-retry.ts`, `verdict-budget.ts` | `driver/test/loop.test.ts`, `board.test.ts`, `board-retry.test.ts`, `loop-containment.test.ts` |
| Stand-down fence (`SetupHalt`, one release/settle/park/`AbortSignal`, acted on once per attempt; a park the board never takes is retried, then left to the lease); a runner that never started or could not run is left to the lease with its reason logged, and the last attempt (`lastAttempt` on the claim: its attempts and the interruption budget both spent) reports it as the failed verdict (`leaveToLease`); a runner the platform took away is an interruption (`interruptAttempt`), and a drain past `DRIVER_HANDOVER_MS` hands its runs over (`Loop.handover`) | `driver/src/loop-fence.ts`, `loop-run.ts`, `loop.ts`, `index.ts` | `driver/test/loop-fence.test.ts`, `loop.test.ts`, `scripts/test-jobs.sh`, `scripts/test-k8s.sh` |
| Master prompt delivered; turn-context hook | `driver/src/master-prompt.ts`, `runner-plan.ts`, `docker/claude-executor/turn-context-hook.cjs` | `driver/test/master-prompt.test.ts`, `runner-plan.test.ts`, `turn-context-hook.test.ts` |
| Docker runner | `driver/src/docker-runner.ts`, `docker.ts`, `runner.ts`, `config.ts` | `driver/test/docker.test.ts`, `config.test.ts` |
| Kubernetes runner | `driver/src/k8s-*.ts` | `driver/test/k8s.test.ts`, `k8s-admission.test.ts`, `k8s-transport.test.ts` |
| Gates, `environment.setup`, gate environments (docker only: labelled `factory.job`/`factory.lease` at creation, reaped on the lease lookup unless the live manager still holds the container, so a warm environment passed to a newer attempt survives; kubernetes leaves no gate containers); a gate's `timeout:` overrides `GATE_TIMEOUT_MS`, capped by `DRIVER_JOB_TIMEOUT_MS` (`gateDeadlineMs`), and ad-hoc `/run` answers 422 above 10 minutes; an `on_demand` gate runs ad hoc only, never in the end-of-run pass or its evidence; setup runs once per attempt before the agent (`runSetup`, timeout `setupTimeoutMs`, its time off the runner deadline and reported as `setupMs`), once per attempt across a cooldown reap; a failure goes to the turn context, is retried by the end-of-run pass even with no gate declared, and is noted on a verdict no pass reported | `driver/src/gates.ts`, `gate-exec.ts`, `loop-gates.ts`, `k8s-gates.ts`, `claim.ts`, `docker-reaper.ts` | `driver/test/gates.test.ts`, `gates-limits.test.ts`, `gates-ownership.test.ts`, `setup-budget.test.ts`, `run-deadline.test.ts`, `docker-reaper.test.ts`, `k8s.test.ts`, `loop.test.ts` |
| Task supervisor: a trusted container of the run's pod (docker: container group) owns prepare, setup, execute, verify, publish, finalize, report; the agent is a separate child container released by `go`, and its exit leaves the supervisor alive to drain the exporter, report and serve the attempt's steps until `finish`. Stop, questions, budget and kill route to it through four mailboxes only it shares (the agent mounts `in` read-only and `out`, never the credential); failure and cancellation enter finalize without implying verify or publish, and a `publish` step is refused after either | `driver/src/scripts/supervisor.cjs`, `supervisor-contract.ts`, `supervisor-plan.ts`, `docker-group.ts`, `docker-mailbox.ts`, `k8s-podspec.ts`, `loop-attempt.ts` (`killAgent`) | `driver/test/supervisor.test.ts`, `docker-group.test.ts`, `k8s.test.ts` |
| Supervised steps: the sync, probe, review snapshot, publish steps, helpers and reclaim run in the attempt's supervisor, never as a Job or container of their own; the group is created by the sync and ended by `Runner.finish` (`settle`), on both executors; the step id is its operation identity | `driver/src/supervised-steps.ts`, `step-control.ts`, `control-channel.ts`, `k8s-group.ts`, `docker-runner.ts`, `loop-run.ts` | `driver/test/supervised-steps.test.ts`, `step-control.test.ts`, `k8s-group.test.ts`, `docker.test.ts` |
| Run control (`GET /control`, the agent's mailbox helper `ctl-agent.cjs`, step-boundary hook/plugin); the helper signals only the entrypoint pid it recorded at start | `driver/src/control-channel.ts`, `gates.ts`, `docker/claude-executor/ctl-agent.cjs`, `stop-hook.cjs`, `docker/opencode-executor/stop-plugin/index.js` | `driver/test/run-control.test.ts` |
| Ledger, failure kind and cause, `FACTORY_BLOCKED:`, timeout note | `driver/src/loop-ledger.ts`, `loop-verdict.ts`, `publish.ts` (`publishCauseOf`), `exec-codes.ts`, `timeout-note.ts` | `driver/test/loop-ledger.test.ts`, `publish-cause.test.ts`, `timeout-note.test.ts`, `branch-reporter.test.ts` |
| Services, dead-service probe and restart, `infraLoss`; started by the setup phase and waited until running (else a `services` failure) before the gate environment and `environment.setup`, never by `run()`, whose re-claim fence/sweep spares the attempt's own lease; released on any later setup conclusion | `driver/src/services.ts`, `loop-services.ts`, `service-restart.ts`, `k8s-services.ts`, `k8s-auxspec.ts`, `docker-runner.ts`; the fleet is exactly the claim's `services` | `driver/test/services.test.ts`, `loop.test.ts`, `docker.test.ts`, `k8s.test.ts` |
| Worktree sync, `SyncQueue`, publish, PR identity, tree fingerprint; the claim's `baseBranch` (`BASE_BRANCH` on sync and run, `gh pr create --base`, a reused PR retargeted) | `driver/src/publish.ts`, `publish-stale.ts`, `sync-queue.ts`, `driver/src/scripts/git-worktree*.cjs`, `git-probe.cjs`, `pr-summary.cjs` | `driver/test/worktree*.test.ts`, `publish-checkout.test.ts`, `publish-stale.test.ts`, `sync-queue.test.ts`, `pr-summary.test.ts` |
| Publication operation identity (`<branch>@<sha>`, `pushing` → `pushed` → `opened` in the worktree's `.factory/publication.json`) and reconciliation: the remote is read after any failed push or PR creation before it is repeated, and a clean pushed tree whose own push landed opens the missing PR | `driver/src/publish-reconcile.ts`, `publish.ts`, `driver/src/scripts/publish-ledger.cjs` | `driver/test/publish-reconcile.test.ts` |
| Agent draft publication (`POST /publish`) | `driver/src/publish-control.ts`, `control-channel.ts`, `loop-publish.ts` | `driver/test/publish-control.test.ts` |
| Agent-opened PR, git guard | `docker/claude-executor/git-guard.cjs`, `docker/opencode-executor/opencode-home/opencode.json`, `driver/src/publish.ts` | `driver/test/executor-images.test.ts` |
| Evidence policy, driver side: evidence binds the tree fingerprint probed before the gates (ignored files and `.factory/` never move it), and a publish bound to it ships only that content — a repository hook that moves it (the switch's post-checkout, the commit's; staging runs hook-free) is refused `stale`, nothing pushed; an unbound publish binds nothing | `driver/src/evidence-policy.ts`, `publish.ts`, `publish-stale.ts`, `scripts/git-probe.cjs` | `driver/test/evidence-policy.test.ts`, `publish-checkout.test.ts`, `publish-hooks.test.ts`, `publish-stale.test.ts`, `tree-fingerprint.test.ts` |
| Reviewer invocation (`POST /review`, snapshot ref) | `driver/src/review-control.ts`, `loop-review.ts`, `review-snapshot.ts`, `driver/src/scripts/git-review-snapshot.cjs` | `driver/test/review-control.test.ts`, `loop-review.test.ts`, `review-snapshot.test.ts`, `review-executors.test.ts` |
| Question routes and relay; runtime budget paused until all answers arrive or Stop cancels them | `driver/src/question-control.ts`, `question-validation.ts`, `loop-questions.ts`, `run-deadline.ts` | `driver/test/gates.test.ts`, `run-deadline.test.ts`, `loop.test.ts` |
| `AskUserQuestion` bridge; prose-question `Stop` hook | `docker/claude-executor/claude-bridge.cjs`, `docker/claude-executor/claude-home/settings.json`, `web/src/task-outcome.ts` | `driver/test/claude-bridge.test.ts`, `web/test/task-derivations.test.ts` |
| Block-helper steps (a supervised step; only a github-writing helper gets the claim env, the board's GitHub token laid over it) | `driver/src/helpers.ts`, `loop-helpers.ts`, `supervised-steps.ts` | `driver/test/helpers.test.ts`, `supervised-steps.test.ts` |
| GitHub review collect and reply | `driver/src/review.ts`, `review-helpers.ts`, `driver/src/scripts/review-*.cjs` | `driver/test/review.test.ts`, `review-collect-script.test.ts`, `review-reply-script.test.ts` |
| Session id, close-time agent turns; a `--resume` of a session that left no transcript starts that id with `--session-id` | `driver/src/close-read.ts`, `docker-close-read.ts`, `driver/src/scripts/claude-turns.cjs`, `docker/claude-executor/claude-bridge.cjs` | `driver/test/close-read.test.ts`, `scripts-claude-turns.test.ts`, `scripts-opencode-readout.test.ts`, `claude-bridge.test.ts` |
| opencode session export: raw rows (`transcript-raw`) and a normalized stream with provenance, tool calls and usage (`transcript`), read in one transaction by the readout; opencode data is per task (`opencodeDataDir`), no transcript container or Job; the live session is recorded on the attempt from the branch reporter's report under the attempt pair (the driver's lease-guarded session write), never a session that predates the run (`BRANCH_REPORTER_PRIOR_SESSION`), and a `--session` the database lacks starts a new one; reported only from a git worktree through a `RUNNER_STATS_URL` that is the board, so an attempt lost before its first report recovers in a new session | `driver/src/scripts/opencode-readout.cjs`, `driver/src/close-read.ts`, `driver/src/claim.ts`, `driver/src/artifact-upload.ts`, `server/src/routes/ingest.ts`, `docker/opencode-executor/branch-reporter.cjs`, `entrypoint.sh` | `driver/test/scripts-opencode-export.test.ts`, `driver/test/runner-plan.test.ts`, `server/test/routes.ingest.test.ts`, `driver/test/branch-reporter.test.ts`, `executor-images.test.ts` |
| Run artifacts: object store plus immutable chunk and manifest index (migration 070; [persistence.md](persistence.md)) | `server/src/artifacts/artifact-store.ts`, `server/migrations/070_artifact_index.sql` | `server/test-db/artifact-store.test.ts` |
| Artifact upload: chunk put and manifest finalize, authorized by claim sequence (a stale attempt files under its own claim and moves no job state); the driver retries with bounded backoff and a failed upload never changes a verdict. Claude's transcript streams while the run lives: an exporter container in the run's pod (docker: container group) under the supervisor, relayed through the control channel's `/export` routes, which drains after an agent kill on the supervisor's order, spools on the task volume (1 GiB per attempt, else `artifact_spool_full`) and reports its backlog in the run vitals | `driver/src/artifact-upload.ts`, `artifact-calls.ts`, `loop-run.ts`, `loop-export.ts`, `export-control.ts`, `transcript-export.ts`, `scripts/claude-export.cjs`, `docker-group.ts`, `k8s-podspec.ts`, `server/src/routes/job-handlers-artifacts.ts`, `server/src/db/job-store-reads.ts` | `driver/test/artifact-upload.test.ts`, `driver/test/loop.test.ts`, `loop-export.test.ts`, `export-control.test.ts`, `scripts-claude-export.test.ts`, `server/test/routes.artifacts.test.ts`, `server/test-db/job-store.artifact-scope.test.ts` |
| Container scripts | `driver/src/container-scripts.ts`, `driver/src/scripts/` | `driver/test/scripts.test.ts`, `scripts-*.test.ts` |
| Orphan reaper; lease-owned Kubernetes Jobs and service resources, never a finished runner of a live job; the next claim adopts that runner's verdict, log and session before its sync (`Runner.adopt`) | `driver/src/reaper.ts`, `docker-reaper.ts`, `k8s-reaper.ts`, `loop-adopt.ts`, `k8s-adopt.ts`, `docker-close-read.ts` | `driver/test/reaper.test.ts`, `docker-reaper.test.ts`, `k8s-reaper.test.ts`, `loop.test.ts`, `k8s.test.ts`, `docker.test.ts`, `scripts/test-jobs.sh`, `scripts/test-k8s.sh` |
| Optional `backend-fix` playbook | `docker/skills/backend-fix/SKILL.md` | `driver/test/executor-images.test.ts` |
| Objective PR landing loop (wait for CI and review, fix, reply), hinted by the master prompt | `docker/skills/pr-land/SKILL.md`, `pr-status.sh`, `server/src/db/master-prompt.ts` | `driver/test/executor-images.test.ts`, `pr-land-status-script.test.ts`, `server/test/master-prompt.test.ts` |
| Board + driver end to end | `scripts/test-jobs.sh` | `server/test/test-jobs.harness.test.ts`, `driver/test/compose.test.ts` |

## CLI (`bellows …`)

| Concern | Code | Test |
| --- | --- | --- |
| Entry, dispatch, board client, config | `cli/src/index.ts`, `run.ts`, `board.ts`, `config.ts`, `http.ts` | `cli/test/commands.test.ts`, `board-client.test.ts`, `config.test.ts`; end to end: `server/test-db/cli.scripting.test.ts` |
| Transport: deadlines, retries of reads and keyed writes only, interrupt | `cli/src/transport.ts` | `cli/test/board-client.test.ts` |
| Outcomes, exit codes, `--json` envelope | `cli/src/outcome.ts`, `render.ts` | `cli/test/commands.test.ts` |
| Prompt input (words, `--file`, `--stdin`) | `cli/src/input.ts` | `cli/test/input.test.ts` |
| `task list` and cursors | `cli/src/tasks.ts` | `cli/test/tasks.test.ts` |
| Discovery (`repo`, `executor`, `skill`, `connection list`) | `cli/src/discovery.ts` | `cli/test/discovery.test.ts` |
| Diagnostics (`auth status`, `job preflight`, help, `--version`) | `cli/src/diagnose.ts`, `diagnostics.ts`, `selection.ts`, `usage.ts`, `version.ts` | `cli/test/diagnostics.test.ts` |
| `job activity`, `job streams`, `job read` (`--all` follows the cursors) | `cli/src/artifacts.ts` | `cli/test/artifacts.test.ts` |
| `job retry`, `edit`, `reopen` | `cli/src/board.ts` | `cli/test/retry-edit.test.ts` |
| `job questions`, `job answer` | `cli/src/run.ts` | `cli/test/questions.test.ts` |
| `--idempotency-key` | `cli/src/board.ts` | `cli/test/idempotency.test.ts` |
| `batch` (import, update, validate, start, inspect, list, wait, retry, accept, cancel); a wait only reads, its verdict is `batchVerdict` | `cli/src/batch.ts`, `batch-commands.ts`, `batch-render.ts` | `cli/test/batch.test.ts` |

## Invariants

- **A declared `.bellows.yaml` service runs hardened, which breaks stock images that expect root.**
  A stock postgres chowns its data directory as root at first boot and crash-loops; `unhardened: true`
  restores the image's default capability set and nothing else — `CAP_NET_RAW` included. `user:`
  is the hardened fix. `driver/src/services.ts`, `driver/test/services.test.ts`, [security.md](security.md).
- **A run reports agent turns, never a bare "turns"** — the close-time agent-turn read counts the
  executor's own transcript; a job turn is defined in [docs/metrics.md](metrics.md).
  Null is the contract for unmeasured. `core/test/docs.terminology.test.ts`.
- **A `409` from heartbeat means the container must be killed**; the board cannot stop a worker.
  `cancelRequested` during the agent's run drains to the next step boundary instead. `driver/test/loop.test.ts`.
- **Every resource an attempt creates is scoped by its lease token**, so no sweep touches a sibling
  attempt — `driver/src/labels.ts`, `driver/test/docker.test.ts`.
- **The publish decision is made in `driver/src/loop-verdict.ts` and `loop-publish.ts` only**; neither
  transport has its own — `driver/test/docker.test.ts`, `k8s.test.ts`.
- **A null `masterPrompt` on the wire is refused before setup**, and the render never reads command,
  output or env values — `driver/test/master-prompt.test.ts`, `server/test/master-prompt.test.ts`.
- **`created_by`, `stopped_by`, `done_by` join `app_user` at read time** —
  `server/test-db/job-store.attribution.test.ts`.
- **The executor label resolves at claim in the task's stamped scope**; a missing profile fails the
  task rather than defaulting — `server/test-db/job-store.executor-scope.test.ts`.
- **Lease rules are tested only against a real database**, expiry by ageing `lease_expires_at`.

## Operational facts

- `npm run test:db` and `scripts/test-jobs.sh` reset every table and refuse a database not ending
  `_test` (`server/test-db/harness.ts`); `test-jobs.sh` also creates and drops stub images and a volume.
- The CLI needs `FACTORY_URL` or `url` in `~/.bellows/settings.json` / `--config <path>` (no
  default; `cli/src/config.ts`). Run it through one npm layer: `npm run dev -w cli -- job list`.
  Exit `0` means the verdict `succeeded`, never that a PR is ready (`cli/src/outcome.ts`).

## Stated limits

- Ad-hoc gate runs are not evidence; under `policy: gates: required` a draft publication is refused.
- A reviewer profile grants connections and a budget, not a tool allowlist; snapshot refs
  (`refs/factory/review/*`) are never deleted, and on docker the reviewer's volume is read-write.
- No priority or scheduling; no per-job authorization ([repos.md](repos.md)).
- No service volumes, health checks, `depends_on` or restart policies in `.bellows.yaml`.
- No abort for an in-flight publish; a lease lost after the push is re-run by the next holder, which reads the
  publication ledger and the remote before it pushes or opens anything (`driver/src/publish-reconcile.ts`).
- A task group's supervisor holds its pod requests from the sync to `finish`, gates included, and a thread with no
  attempt reclaims in a supervisor-only group: the sync, probe, publish and helpers are no Jobs, the reclaim of a
  removed thread is the one Job a thread without an attempt gets.
- Only the tail-kept log and the opencode transcript upload (`ARTIFACT_LIMIT`, never `complete` when cut by it or the kubernetes transport; Claude's streams whole), and no sweeper
  deletes a removed task's objects: `ARTIFACTS_RETENTION_DAYS` is configuration only. `driver/src/runner.ts`, `k8s-transport.ts`.
- A custom `RUNNER_IMAGE` missing a skill's declared tool is not detected.
