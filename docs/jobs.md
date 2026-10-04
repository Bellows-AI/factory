# Job board

A job is a text command a worker runs as an agent prompt; the board hands jobs out under a lease
and records verdicts, and the driver is the only process that spawns anything.

Graph-walking tasks are [docs/workflows.md](workflows.md); the kubernetes executor is
[docs/kubernetes.md](kubernetes.md); credentials are [docs/auth.md](auth.md).

## Where things live

| Concern | Code | Test |
| --- | --- | --- |
| Route surface (worker and person verbs alike) | `server/src/routes/jobs.ts`, `job-handlers-worker.ts`, `job-handlers-actions.ts` | `server/test/routes.jobs.test.ts` |
| Body validation and refusal codes | `server/src/routes/job-field-validation*.ts`, `job-refusals.ts`, `job-limits.ts` | `server/test/routes.jobs.test.ts` |
| Schema | `server/migrations/006_jobs.sql` and the later `0*_job_*.sql` | `server/test-db/job-store.test.ts` |
| Claim, lease, fencing token, settle | `server/src/db/job-store-claim.ts`, `job-store.ts` | `server/test-db/job-store.test.ts`, `job-store.thread-claim.test.ts`, `job-store.settle.test.ts` |
| Follow-ups, done, retry, command edit | `server/src/db/job-store-actions.ts` | `server/test-db/job-store.follow-ups.test.ts`, `job-store.retries.test.ts`, `job-store.command-edit.test.ts` |
| Stop, remove, reopen, worktree reclaim | `server/src/db/job-store-actions.ts` | `server/test-db/job-store.stop-remove.test.ts`, `job-store.stop-remove.zombie-recovery.test.ts` |
| A merged PR closing its threads | `server/src/db/job-store-merge.ts` | `server/test-db/job-store.merge-close.test.ts` |
| Task summary read model (`GET /api/tasks`) | `server/src/db/task-summary.ts`, `server/src/routes/tasks.ts` | `server/test/task-summary.test.ts`, `server/test/routes.tasks.test.ts`, `server/test-db/job-store.tasks.*.test.ts` |
| Attribution, wall clock, agent turns, publication | `server/src/db/job-store-reads.ts`, `job-store-rows.ts` | `server/test-db/job-store.attribution.test.ts`, `job-store.wall-clock.test.ts`, `job-store.publication.test.ts` |
| `.bellows.yaml` parser (gates and services) | `server/src/workspace/bellows.ts` | `server/test/bellows.test.ts` |
| Gates, board side | `server/src/db/job-store-worker.ts`, `server/migrations/018_job_gates.sql` | `server/test-db/job-store.gates.test.ts`, `job-store.gates.rereads.test.ts` |
| Master prompt, rendered | `server/src/db/master-prompt.ts` | `server/test/master-prompt.test.ts` |
| Master prompt, delivered (argv, OpenCode `factory` agent) | `driver/src/master-prompt.ts`, `runner-plan.ts`, `claim.ts` | `driver/test/master-prompt.test.ts` |
| Claim loop, verdicts, reclaim | `driver/src/loop*.ts`, `board.ts`, `claim.ts` | `driver/test/loop.test.ts`, `board.test.ts` |
| Docker runner, env, argv | `driver/src/docker-runner.ts`, `docker.ts`, `runner.ts`, `config.ts` | `driver/test/docker.test.ts`, `config.test.ts` |
| Kubernetes runner | `driver/src/k8s-*.ts` | `driver/test/k8s.test.ts`, `k8s-admission.test.ts`, `k8s-transport.test.ts` |
| Gates, execution | `driver/src/gates.ts`, `loop-gates.ts`, `k8s-gates.ts` | `driver/test/gates.test.ts` |
| Gates skipped over an unclean run; the agent's `FACTORY_BLOCKED:` report | `driver/src/loop-verdict.ts`, `loop-run.ts` | `driver/test/loop.test.ts` |
| Stop/Remove cancelling every gate in flight, declared and ad-hoc (`GateServer.cancel`) | `driver/src/loop-gates.ts`, `gates.ts`, `k8s-gates.ts` | `driver/test/loop.test.ts`, `gates.test.ts`, `k8s.test.ts` |
| Tree fingerprint: sync before, probe after a failed gate, `treeChanged` on complete | `driver/src/scripts/git-worktree.cjs`, `git-probe.cjs`, `publish.ts`, `loop-run.ts` | `driver/test/worktree.test.ts`, `loop.test.ts`, `docker.test.ts`, `k8s.test.ts` |
| Block-helper steps | `driver/src/helpers.ts`, `loop-helpers.ts`, `k8s-helper-runner.ts` | `driver/test/helpers.test.ts` |
| Auxiliary services, the dead-service probe | `driver/src/services.ts`, `k8s-services.ts`, `docker-runner.ts` | `driver/test/services.test.ts`, `docker.test.ts`, `k8s.test.ts` |
| Worktree sync, publish, PR identity | `driver/src/publish.ts`, `scripts/git-worktree*.cjs`, `pr-summary.cjs` | `driver/test/worktree.test.ts`, `worktree-restore.test.ts`, `pr-summary.test.ts` |
| GitHub review collect and reply | `driver/src/review.ts`, `review-helpers.ts`, `scripts/review-*.cjs` | `driver/test/review.test.ts`, `review-collect-script.test.ts`, `review-reply-script.test.ts` |
| Session id, close-time turn count and summary | `driver/src/close-read.ts`, `docker-close-read.ts`, `scripts/claude-turns.cjs` | `driver/test/scripts-claude-turns.test.ts`, `scripts-opencode-readout.test.ts` |
| Run artifacts (full log, transcript) | `driver/src/artifacts.ts`, `server/migrations/046_job_artifacts.sql` | `driver/test/artifacts.test.ts` |
| Container scripts | `driver/src/container-scripts.ts`, `driver/src/scripts/` | `driver/test/scripts.test.ts`, `driver/test/scripts-*.test.ts` |
| Orphan reaper | `driver/src/reaper.ts`, `docker-reaper.ts`, `k8s-reaper.ts` | `driver/test/reaper.test.ts`, `docker-reaper.test.ts`, `k8s-reaper.test.ts` |
| Failure kind, timeout note, branch attribution | `driver/src/loop-verdict.ts`, `exec-codes.ts`, `timeout-note.ts`, `server/migrations/044_job_failure_kind.sql` | `driver/test/loop.test.ts`, `timeout-note.test.ts`, `branch-reporter.test.ts` |
| CLI (`factory job …`) | `cli/src/index.ts`, `run.ts`, `board.ts`, `config.ts`, `render.ts` | `cli/test/commands.test.ts`, `board-client.test.ts`, `config.test.ts` |
| Board + driver end to end | `scripts/test-jobs.sh` | `server/test/test-jobs.harness.test.ts`, `driver/test/compose.test.ts` |

## Invariants

- **A declared `.bellows.yaml` service runs hardened, which breaks stock images that expect root.**
  A stock postgres chowns its data directory as root at first boot and crash-loops with no
  capabilities; `unhardened: true` on that service restores the image's default capability set and
  nothing else — `CAP_NET_RAW` included, on the network the attempt's containers share. No gate
  image has the opt-out. `driver/src/services.ts`, `driver/test/services.test.ts`,
  [security.md](security.md).
- **A declared service found dead before the declared gates skips them and fails the verdict
  `services`, never `gate`** — a gate against a dead service fails on an environment the agent
  cannot fix, and `gate-failed` would spend a gate-fix round on it. The verdict quotes the
  service's exit and last log lines. A job with no declared gates is never probed.
  `driver/src/loop-run.ts`, `loop-verdict.ts`, `driver/test/loop.test.ts`.
- **A run reports agent turns, never a bare "turns"** — the close-time agent-turn read
  (`driver/src/close-read.ts`) counts the executor's own transcript, and a job turn is a different
  quantity, defined in [docs/metrics.md](metrics.md). Null is the contract for unmeasured: a
  missing read is never rendered as zero. `driver/test/scripts-claude-turns.test.ts`,
  `core/test/docs.terminology.test.ts`.
- **`blocked` is a failure kind 044's comment predates**; `FAILURE_KINDS` in
  `server/src/routes/job-field-validation.ts` is the set — `server/test/routes.jobs.test.ts`.
- **A `409` from heartbeat means the container must be killed.** The board can refuse a worker, it
  cannot stop one, so double execution is prevented by the driver acting on the refusal —
  `driver/src/loop*.ts`, guarded by `driver/test/loop.test.ts`.
- **A `cancelRequested: true` beat means kill the run and `suspend` the row.** Same beat, same
  kill, then a terminal `stopped` — `driver/test/loop.test.ts`,
  `server/test-db/job-store.stop-remove.test.ts`.
- **A null `masterPrompt` on the wire is refused before any setup step runs**
  (`masterPromptRefusalReason`, read in `driver/src/loop-run.ts` beside the executor-selection
  refusal) — `driver/test/master-prompt.test.ts`. The render is pure and fails closed; it never
  reads `job.command`, node prompt text, prior output or env values
  (`server/test/master-prompt.test.ts`).
- **`driver/` and `cli/` depend on nothing — `core` included.** They are HTTP clients; a shared
  type is copied, not imported. Enforced by `lint/no-cross-package-imports.grit`.
- **Container scripts are files under `driver/src/scripts/`, passed by content.** The driver talks
  to a possibly remote daemon and has no host path into the volumes it names; the build copies the
  directory into `dist` (`driver/package.json`), and a missing copy fails only in a container.
  Shell scripts are POSIX (`dash` is `sh` in the images) and a script loaded as a VALUE — the
  credential helper — is trimmed, byte-for-byte: `driver/test/scripts.test.ts`,
  `scripts-credential-helper.test.ts`.
- **Every resource an attempt creates is scoped by its lease token** — container name, network,
  service names, labels — so no sweep may touch a sibling attempt. The pre-create fence is the one
  job-scoped sweep: `driver/test/docker.test.ts`, `driver/src/labels.ts`.
- **Anything added for docker lands its kubernetes counterpart in the same change**
  ([docs/kubernetes.md](kubernetes.md)); `driver/test/k8s.test.ts` and `k8s-docs.test.ts` are where
  the parity is pinned.
- **Lease rules are only tested against a real database** (`npm run test:db`); a stub
  reimplementation would agree with itself. Expiry is simulated by ageing `lease_expires_at` in
  SQL, never by sleeping.
- **`created_by`, `stopped_by`, `done_by` are joined to `app_user` at read time**, never
  denormalised, and null is a fact rather than a gap —
  `server/test-db/job-store.attribution.test.ts`.
- **The executor label is resolved at claim time, in the task's stamped scope**; a renamed or
  deleted profile yields `executorType: null`, which the driver reports as a failed task instead
  of picking a default — `server/test-db/job-store.executor-scope.test.ts`.

## Operational facts

- `npm run test:db` and `scripts/test-jobs.sh` **reset every table** and refuse any database whose
  name does not end `_test` (`server/test-db/harness.ts`). `test-jobs.sh` also truncates `job`
  before its board phase, creates four stub images, a volume and a `*_test` database, and drops
  all of them on exit. Both boards it starts boot `server/dist/offline.js`.
- The docker socket is mounted by the driver, never by the dashboard — see
  [docs/security.md](security.md).
- The CLI needs `FACTORY_URL` (no default: a CLI that guesses a board queues real tasks against
  whichever one answers) and optionally `FACTORY_TOKEN`; the `Authorization` header is omitted, not
  sent empty, when unset. Run it through ONE npm layer — `npm run dev -w cli -- job list` — or the
  inner npm eats `--json`/`--timeout`/`--yes` as its own configuration.
- CLI exit codes: `0` ok, `1` board or network failure, `2` usage or configuration, `3` a `wait`
  that ended with no terminal row (`cli/test/commands.test.ts`). `remove` requires `--yes`; `stop`
  answering `202` means the stop was only stamped, and the worker settles it on its next beat.

## Deliberately absent

- No idempotency key on create: a retried `POST /api/jobs` runs the command twice.
- No priority and no scheduling; a queued job's place in the queue is not movable.
- No per-job authorization. Any member may queue, follow up on their own tasks, and close any
  task; the one per-user bound is the repo label on create ([docs/repos.md](repos.md)). Under
  `AUTH_MODE=none` the worker routes are open too ([docs/security.md](security.md)).
- No service volumes, health checks, `depends_on` ordering or restart policies in `.bellows.yaml`;
  the one liveness read is the dead-service probe before the gates.
- No artifact TTL sweeper: retention is the job row's lifetime, by `on delete cascade`.
