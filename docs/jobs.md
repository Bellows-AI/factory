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
| Follow-ups, done, retry, command edit; a sessionless follow-up's recap | `server/src/db/job-store-actions.ts`, `follow-up-recap.ts` | `server/test-db/job-store.follow-ups.test.ts`, `job-store.retries.test.ts`, `job-store.command-edit.test.ts`, `server/test/follow-up-recap.test.ts` |
| Stop, remove, reopen, worktree reclaim | `server/src/db/job-store-actions.ts` | `server/test-db/job-store.stop-remove.test.ts`, `job-store.stop-remove.zombie-recovery.test.ts` |
| A merged PR closing its threads | `server/src/db/job-store-merge.ts` | `server/test-db/job-store.merge-close.test.ts` |
| Task summary read model (`GET /api/tasks`) | `server/src/db/task-summary.ts`, `server/src/routes/tasks.ts` | `server/test/task-summary.test.ts`, `server/test/routes.tasks.test.ts`, `server/test-db/job-store.tasks.*.test.ts` |
| Attribution, wall clock, agent turns, publication | `server/src/db/job-store-reads.ts`, `job-store-rows.ts` | `server/test-db/job-store.attribution.test.ts`, `job-store.wall-clock.test.ts`, `job-store.publication.test.ts` |
| `.bellows.yaml` parser (gates and services) | `server/src/workspace/bellows.ts` | `server/test/bellows.test.ts` |
| Gates, board side; the claim's `gatesSource` | `server/src/db/job-store-worker.ts`, `job-store-claim.ts`, `server/migrations/018_job_gates.sql` | `server/test-db/job-store.gates.test.ts`, `job-store.gates.rereads.test.ts`, `server/test/claim-gates-source.test.ts` |
| Master prompt and turn context, rendered | `server/src/db/master-prompt.ts`, `job-store-claim.ts` | `server/test/master-prompt.test.ts`, `server/test-db/job-store.helper-plans.test.ts` |
| Master prompt, delivered (argv, OpenCode `factory` agent); turn context (claude: UserPromptSubmit hook env, opencode: prompt prefix) | `driver/src/master-prompt.ts`, `runner-plan.ts`, `claim.ts`, `board.ts`, `docker/claude-executor/turn-context-hook.cjs` | `driver/test/master-prompt.test.ts`, `docker.test.ts`, `k8s.test.ts`, `turn-context-hook.test.ts` |
| Claim loop, verdicts, reclaim | `driver/src/loop*.ts`, `board.ts`, `claim.ts` | `driver/test/loop.test.ts`, `board.test.ts` |
| Setup conclusion (`SetupHalt`) and the stand-down fence: the one checkout-claim release, the one settle, the one park, and the one `AbortSignal` a step is raced against | `driver/src/loop-fence.ts`, `loop-types.ts`, `loop-attempt.ts`, `loop-run.ts`, `loop-helpers.ts`, `loop-gates.ts`, `loop-verdict.ts` | `driver/test/loop-fence.test.ts` |
| Docker runner, env, argv | `driver/src/docker-runner.ts`, `docker.ts`, `runner.ts`, `config.ts` | `driver/test/docker.test.ts`, `config.test.ts` |
| Kubernetes runner | `driver/src/k8s-*.ts` | `driver/test/k8s.test.ts`, `k8s-admission.test.ts`, `k8s-transport.test.ts` |
| Gates, execution | `driver/src/gates.ts`, `loop-gates.ts`, `k8s-gates.ts` | `driver/test/gates.test.ts`, `gates-limits.test.ts` |
| `environment.setup`: runs once per gate environment before its first gate; a failure answers `setupFailed` and the output starts `[setup failed` | `driver/src/gates.ts`, `k8s-gates.ts`, `loop-gates.ts`, `server/src/workspace/bellows.ts` | `driver/test/gates.test.ts`, `gates-ownership.test.ts`, `server/test/bellows.test.ts` |
| Gate environment owned by the lease: release/cancel no-op for another attempt, per-lease k8s Secret, teardown awaited by acquire, one run per key | `driver/src/gates.ts`, `k8s-gates.ts`, `loop-gates.ts` | `driver/test/gates-ownership.test.ts` |
| Gates skipped over an unclean run; the agent's `FACTORY_BLOCKED:` report | `driver/src/loop-ledger.ts`, `loop-verdict.ts`, `loop-run.ts` | `driver/test/loop-ledger.test.ts`, `loop.test.ts` |
| A dead declared service's exit, reason, log tail and hint: probed on every gates path, carried in `runtime.services`, and in the gate endpoint's `deadServices` answer field | `driver/src/loop-attempt.ts`, `loop-run.ts`, `loop-ledger.ts`, `runner.ts`, `gates.ts`, `server/src/routes/job-limits.ts`, `web/src/panels/TaskDetail.tsx` | `driver/test/loop.test.ts`, `loop-ledger.test.ts`, `gates.test.ts`, `server/test/routes.jobs.test.ts`, `web/test/task-outcome.render.test.tsx` |
| Run control: the per-attempt `GET /control` endpoint (every launched attempt, gated or not), `BELLOWS_CONTROL_*` env, the runner's stop poller and step-boundary hook/plugin | `driver/src/gates.ts`, `loop-gates.ts`, `docker/claude-executor/stop-poller.cjs`, `stop-hook.cjs`, `docker/opencode-executor/stop-plugin/index.js` | `driver/test/gates.test.ts`, `driver/test/run-control.test.ts`, `driver/test/executor-images.test.ts` |
| Stop/Remove cancelling every gate in flight, declared and ad-hoc (`GateServer.cancel`) | `driver/src/loop-gates.ts`, `gates.ts`, `k8s-gates.ts` | `driver/test/loop.test.ts`, `gates.test.ts`, `k8s.test.ts` |
| Tree fingerprint: sync before, probe after the run and before the gates, `treeChanged` on complete | `driver/src/scripts/git-worktree.cjs`, `git-probe.cjs`, `publish.ts`, `loop-run.ts` | `driver/test/worktree.test.ts`, `loop.test.ts`, `docker.test.ts`, `k8s.test.ts` |
| Block-helper steps | `driver/src/helpers.ts`, `loop-helpers.ts`, `k8s-helper-runner.ts` | `driver/test/helpers.test.ts` |
| Auxiliary services, the dead-service probe, the pre-gate restart (`restartServices`); a runner the platform took away (`infraLoss`) | `driver/src/services.ts`, `service-restart.ts`, `scripts/bellows-read.sh`, `k8s-services.ts`, `k8s-poll.ts`, `docker-runner.ts`, `docker-runner-support.ts` | `driver/test/services.test.ts`, `scripts-bellows-read.test.ts`, `docker.test.ts`, `k8s.test.ts` |
| Worktree sync (including a remote with no commits: an empty worktree on an unborn task branch), base-clone fast-forward, publish, PR identity | `driver/src/publish.ts`, `publish-stale.ts`, `scripts/git-worktree*.cjs`, `pr-summary.cjs` | `driver/test/worktree.test.ts`, `worktree-restore.test.ts`, `worktree-clone-ff.test.ts`, `worktree-empty-remote.test.ts`, `pr-summary.test.ts`, `publish-stale.test.ts` |
| Objective mode (`job.mode`, an omitted `workflow`): created, claimed (no `publish`, `- Mode: objective` in the master prompt), settled with no transition | `core/src/job-mode.ts`, `server/migrations/051_job_mode.sql`, `server/src/db/job-store-actions.ts`, `job-store-claim.ts`, `master-prompt.ts` | `server/test-db/job-store.objective.test.ts`, `server/test/master-prompt.test.ts` |
| Skill selection (`skills` on create, the root's names read at every claim): `requires-tools` / `requires-connections` in a SKILL.md `metadata:` block, checked at claim — an env connection (`github`) against the claim env's names (never values), a managed one (`jira`, [connections.md](connections.md)) against the root's selected connection — into `skillRefusal`, which the driver fails `config` before any runner; the selection rides the master prompt. A custom `RUNNER_IMAGE` missing a declared tool is a stated limit — tools are pinned against the shipped Dockerfiles only | `core/src/skills.ts`, `server/src/skills.ts`, `server/migrations/055_job_skills.sql`, `server/src/db/job-store-claim.ts`, `master-prompt.ts`, `driver/src/loop-run.ts`, `cli/src/run.ts` | `core/test/skills.test.ts`, `server/test-db/job-store.skills.test.ts`, `server/test/routes.jobs.test.ts`, `driver/test/loop.test.ts`, `docker.test.ts`, `k8s.test.ts` |
| An objective task end to end (issue #550): gate failure → revise → rerun → draft publish twice → verdict on the final gates; a reclaimed lease and a gate-failed retry on one thread; the optional `backend-fix` playbook | `docker/skills/backend-fix/SKILL.md`, `driver/src/loop-verdict.ts`, `driver/src/publish-control.ts` | `driver/test/loop.test.ts` (`objective-mode task`), `server/test-db/job-store.objective.test.ts`, `driver/test/executor-images.test.ts` (`optional playbook`) |
| GitHub review collect and reply | `driver/src/review.ts`, `review-helpers.ts`, `scripts/review-*.cjs` | `driver/test/review.test.ts`, `review-collect-script.test.ts`, `review-reply-script.test.ts` |
| Session id, close-time turn count and summary | `driver/src/close-read.ts`, `docker-close-read.ts`, `scripts/claude-turns.cjs` | `driver/test/scripts-claude-turns.test.ts`, `scripts-opencode-readout.test.ts` |
| Run artifacts (full log, transcript) | `driver/src/artifacts.ts`, `server/migrations/046_job_artifacts.sql` | `driver/test/artifacts.test.ts` |
| Agent questions: store (ask, expire, answer, thread shape, `needsAnswer`), routes | `server/src/db/job-store-questions.ts`, `server/src/routes/job-handlers-questions.ts`, `job-field-validation-questions.ts`, `server/migrations/050_job_question.sql` | `server/test-db/job-store.questions.test.ts`, `server/test/routes.jobs.test.ts`, `server/test/auth.enforcement.test.ts` |
| The control server's question routes (`POST /question`, `GET /question/:id`, control token only, 5 per attempt, validated as the board's route is) | `driver/src/gates.ts`, `question-control.ts`, `question-validation.ts` | `driver/test/gates.test.ts` |
| The question relay: forward to the board with the board-call backoff, answers applied from each heartbeat's `answeredQuestions`, a 1 h expiry timer the board arbitrates, a Stop cancelling every pending question; the entry dies with `closeRunControl` | `driver/src/loop-questions.ts`, `loop-attempt.ts`, `loop-gates.ts`, `board-retry.ts`, `board.ts` | `driver/test/loop.test.ts` (`questions`), `board.test.ts` |
| The agent's draft publication: `POST /publish` on the control server (control token only, one at a time per token, 403 on a claim with `publish: false`); the relay's stand-down fences before and after the credential ask; `--draft` only on a NEW pull request, an existing one reused; the verdict carries the agent's PR when the end-of-run publish has nothing left | `driver/src/publish-control.ts`, `control-channel.ts`, `loop-publish.ts`, `publish.ts`, `loop-run.ts`, `docker/skills/github/SKILL.md` | `driver/test/publish-control.test.ts`, `loop.test.ts` (`draft publication`), `docker.test.ts`, `k8s.test.ts` |
| Revision-bound evidence: `policy:` in `.bellows.yaml` (read from the base clone only), the claim's `policy` and `review`, the verdict's `evidence` (`treeBefore`, `treeAfter`, `gates`), the publish decision (`evidenceDecision`, refusal `policy` kind), the stale-revision check in `publishCheckout`, and the board's completion check inside the verdict transaction | `server/src/workspace/bellows.ts`, `server/src/db/evidence-policy.ts`, `job-store-evidence.ts`, `job-store-claim.ts`, `job-store-worker.ts`, `server/migrations/053_job_evidence.sql`, `driver/src/evidence-policy.ts`, `loop-run.ts`, `loop-publish.ts`, `publish.ts` | `server/test/evidence-policy.test.ts`, `bellows.policy.test.ts`, `server/test-db/job-store.evidence.test.ts`, `driver/test/evidence-policy.test.ts`, `loop.test.ts` (`revision-bound evidence`), `publish-control.test.ts`, `docker.test.ts`, `k8s.test.ts` |
| Independent reviewer invocation: `reviewers:` profiles in `.bellows.yaml` (base clone only, stamped on the caller's row at each claim); `POST /review` and `GET /review/:key` on the control server (control token only, one request at a time per token, the driver measures the revision and freezes a snapshot ref BEFORE asking the board); the board runs it as a job of its own thread (`review_of`, unique per caller and key) claimed with only the profile's `connections`, no token, no gates and no publish, from the snapshot in its own worktree; the thread's review evidence counts the review row bound to the revision asked about; Stop, the caller's verdict, a dead retirement and Remove all reach it | `server/src/workspace/bellows-reviewers.ts`, `bellows.ts`, `server/src/db/job-store-reviews.ts`, `job-store-claim.ts` (`claimReview`), `job-store-evidence.ts`, `evidence-policy.ts`, `review-prompt.ts`, `job-store-rows.ts` (`stopRows`), `server/src/routes/job-handlers-reviews.ts`, `server/migrations/056_job_review.sql`, `driver/src/review-control.ts`, `loop-review.ts`, `review-snapshot.ts`, `scripts/git-review-snapshot.cjs`, `scripts/git-worktree.cjs` (`REVIEW_REF`), `claim.ts` (`runTimeoutMs`, `claimRestoresTree`), `docker/skills/review/SKILL.md` | `server/test/bellows.reviewers.test.ts`, `server/test/evidence-policy.test.ts`, `review-prompt.test.ts`, `routes.jobs.test.ts` (`issue #549`), `server/test-db/job-store.reviews.test.ts`, `driver/test/review-control.test.ts`, `review-snapshot.test.ts`, `review-executors.test.ts`, `board-review.test.ts`, `loop-review.test.ts`, `scripts-git-review-snapshot.test.ts`, `worktree-review.test.ts` |
| The deadline extension: each accepted question adds `QUESTION_TIMEOUT_MS` to the run deadline, never refunded (docker re-arms its kill timer, kubernetes patches the Job — [kubernetes.md](kubernetes.md)); the timeout note reports the extended deadline | `driver/src/run-deadline.ts`, `docker-runner.ts`, `k8s-runner.ts`, `loop-verdict.ts` | `driver/test/run-deadline.test.ts`, `k8s.test.ts`, `loop.test.ts`, `timeout-note.test.ts` |
| Container scripts | `driver/src/container-scripts.ts`, `driver/src/scripts/` | `driver/test/scripts.test.ts`, `driver/test/scripts-*.test.ts` |
| Orphan reaper | `driver/src/reaper.ts`, `docker-reaper.ts`, `k8s-reaper.ts` | `driver/test/reaper.test.ts`, `docker-reaper.test.ts`, `k8s-reaper.test.ts` |
| Failure kind, timeout note, branch attribution | `driver/src/loop-ledger.ts`, `loop-verdict.ts`, `exec-codes.ts`, `timeout-note.ts`, `server/migrations/044_job_failure_kind.sql` | `driver/test/loop-ledger.test.ts`, `loop.test.ts`, `timeout-note.test.ts`, `branch-reporter.test.ts` |
| CLI (`factory job …`) | `cli/src/index.ts`, `run.ts`, `board.ts`, `config.ts`, `render.ts` | `cli/test/commands.test.ts`, `board-client.test.ts`, `config.test.ts` |
| The runner end of questions: the bridge answers `AskUserQuestion` through the control endpoint inside the same Claude run | `docker/claude-executor/claude-bridge.cjs` | `driver/test/claude-bridge.test.ts`, `scripts/test-jobs.sh` (`ask_lane`) |
| A prose question ending a turn becomes an `AskUserQuestion`: the baked `Stop` prompt hook, its model resolved at start; a run still ending on `?` gets the task page's notice (`endedOnQuestion`) | `docker/claude-executor/claude-home/settings.json`, `docker/claude-executor/entrypoint.sh`, `web/src/task-outcome.ts` | `driver/test/run-control.test.ts`, `driver/test/executor-images.test.ts`, `web/test/task-derivations.test.ts`, `scripts/test-jobs.sh` (`ask_lane prose`) |
| Board + driver end to end | `scripts/test-jobs.sh` | `server/test/test-jobs.harness.test.ts`, `driver/test/compose.test.ts` |

## Invariants

- **A declared `.bellows.yaml` service runs hardened, which breaks stock images that expect root.**
  A stock postgres chowns its data directory as root at first boot and crash-loops with no
  capabilities; `unhardened: true` on that service restores the image's default capability set and
  nothing else — `CAP_NET_RAW` included, on the network the attempt's containers share. No gate
  image has the opt-out. `user: "999:999"` is the hardened fix instead: the image starts as its own
  uid, skips the chown and user switch, and keeps every capability dropped (`runAsUser` on
  kubernetes, `--user` on docker). `driver/src/services.ts`, `driver/src/k8s-auxspec.ts`,
  `driver/test/services.test.ts`, [security.md](security.md).
- **A declared service found dead before the declared gates is restarted, and only a failed
  restart skips them and fails the verdict `services`, never `gate`** — a gate against a dead
  service fails on an environment the agent cannot fix. Work the services alone failed publishes
  as a draft. The verdict quotes the exit, or why a vanished one went, and the last log lines. A
  failed gate re-probes; a k8s pod Pending on an image-pull or config error counts as dead. A
  runner the platform took away reports no verdict and is left to the lease.
  `driver/src/loop-run.ts`, `loop-verdict.ts`, `driver/test/loop.test.ts`.
- **A run reports agent turns, never a bare "turns"** — the close-time agent-turn read
  (`driver/src/close-read.ts`) counts the executor's own transcript, and a job turn is a different
  quantity, defined in [docs/metrics.md](metrics.md). Null is the contract for unmeasured: a
  missing read is never rendered as zero. `driver/test/scripts-claude-turns.test.ts`,
  `core/test/docs.terminology.test.ts`.
- **`blocked` and `config` are failure kinds 044's comment predates**; `FAILURE_KINDS` in
  `server/src/routes/job-field-validation.ts` is the set — `server/test/routes.jobs.test.ts`.
  `config` (a refused `.bellows.yaml` or an unmet skill requirement, `driver/src/loop-run.ts`) is no ledger fault and rests the
  thread at once — `driver/test/loop.test.ts`, `server/test/workflow-engine.next-transition.test.ts`.
- **A `409` from heartbeat means the container must be killed.** The board can refuse a worker, it
  cannot stop one, so double execution is prevented by the driver acting on the refusal —
  `driver/src/loop*.ts`, guarded by `driver/test/loop.test.ts`.
- **A `cancelRequested: true` beat during the setup phase or after the agent's run means kill and
  `suspend` the row.** Same beat, same kill, then a terminal `stopped` — `driver/test/loop.test.ts`,
  `server/test-db/job-store.stop-remove.test.ts`.
- **During the agent's run it means drain, not kill.** The first such beat raises the stop on the
  attempt's control endpoint once (`JobState.draining`, not `down()`), the runner's poller turns it
  into a marker the baked Claude Code hook / OpenCode plugin reads at the next model-step boundary,
  and the attempt settles `stopped` when the agent exits — session report, artifacts, `suspend`;
  never gates, post-helpers, publish or `complete`. `RUN_CONTROL_POLL_MS` (5 s) paces the beat and
  the poller; `STOP_GRACE_MS` (5 min) is the hard-kill deadline. Lease loss and Remove still kill at
  once. No config knob for either. A driver whose endpoint cannot bind keeps the immediate kill.
  `driver/src/loop-attempt.ts`, `driver/test/loop.test.ts`, `driver/test/run-control.test.ts`.
- **A null `masterPrompt` on the wire is refused before any setup step runs**
  (`masterPromptRefusalReason`, read in `driver/src/loop-run.ts` beside the executor-selection
  refusal) — `driver/test/master-prompt.test.ts`. The render is pure and fails closed; it never
  reads `job.command`, node prompt text, prior output or env values, and it is byte-identical on
  every claim of a thread; the node and capabilities ride `turnContext`
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

- Ad-hoc gate runs (the agent's `BELLOWS_GATE_*` endpoint) are not evidence: they carry no assessed revision, so a draft
  publication under `policy: gates: required` is refused (`driver/src/loop-publish.ts`) and the
  end-of-run publish, which runs the declared gates, is the path.
- The evidence fingerprint includes `HEAD` and every non-ignored change, so a gate that writes an
  untracked file makes its own evidence stale — deliberate, and only under a configured policy.

- A reviewer profile grants connections (env names) and a budget (minutes, capped by
  `DRIVER_JOB_TIMEOUT_MS`), not a tool allowlist: the agent CLI's own permission config is the
  runner image's, and a per-profile one is not enforced. A workflow task reviews through its graph's
  `review: true` node, so a named reviewer on it is refused (`REVIEW_UNSUPPORTED`). A review stopped
  or retired mid-run keeps its worktree until its caller's thread is removed; one that settles
  reclaims its own tree on its verdict. The snapshot refs (`refs/factory/review/*`) are never
  deleted, and on docker the reviewer shares the author's workspace volume read-write: "reads a
  frozen copy and changes nothing" is an instruction and a worktree of its own, not a mount-level
  guarantee.

- No idempotency key on create: a retried `POST /api/jobs` runs the command twice.
- No priority and no scheduling; a queued job's place in the queue is not movable.
- No per-job authorization. Any member may queue, follow up on their own tasks, and close any
  task; the one per-user bound is the repo label on create ([docs/repos.md](repos.md)). Under
  `AUTH_MODE=none` the worker routes are open too ([docs/security.md](security.md)).
- No service volumes, health checks, `depends_on` ordering or restart policies in `.bellows.yaml`;
  a restarted service is ready once it runs (`SERVICE_RESTART_TIMEOUT_MS`, `driver/src/runner.ts`).
- No abort for an in-flight publish: a push cannot be recalled, so a lease lost after
  `publishBranch` pushed stands down without reporting and the next holder re-runs it
  (`driver/test/loop.test.ts`, "a lease lost after the push"). Nor for the kubernetes checkout
  sync, which writes the worktree: a stand-down abandons it and `releaseAbandonedSync` hands the
  claim back when it lands.
- No artifact TTL sweeper: retention is the job row's lifetime, by `on delete cascade`.
