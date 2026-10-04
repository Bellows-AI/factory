# Workflows

A workflow is a graph of nodes the board walks between verdicts: the driver claims one row, runs it
and reports one verdict; the board, never the driver, decides the next row. Checkout, gates and
publish stay driver machinery the graph references by OUTCOME — they are never nodes.

The grammar, the closed key sets and the refusal codes are defined by `workflow-schema.ts`; the
built-in block list is `workflow-blocks/index.ts`'s registry. Read those, not a table here.

## Where things live

| Concern | Code | Test |
| --- | --- | --- |
| Definition grammar, the closed key sets, bounded interpolation | `server/src/db/workflow-schema.ts`, `workflow-schema-validate.ts`, `workflow-schema-validate-helper-plans.ts` | `server/test/workflow-schema.test.ts`, `workflow-engine.validation.test.ts` |
| Launch parameters and the safe regex subset | `server/src/db/workflow-pattern.ts`, `workflow-schema.ts` (`checkWorkflowParams`) | `server/test/workflow-engine.params.test.ts` |
| The transition engine (pure: thread rows + snapshot + completed run → insert-or-rest) | `server/src/db/workflow-engine.ts` | `server/test/workflow-engine.next-transition.test.ts`, `workflow-engine.walkthrough.test.ts` |
| The block registry, config resolution, the expansion compiler | `server/src/db/workflow-blocks/index.ts`, `types.ts` | `server/test/workflow-block-compiler.test.ts` |
| The built-in blocks, one file each | `server/src/db/workflow-blocks/github-review-reconcile.ts`, `merge-conflict-autofix.ts` | `server/test/workflow-block-github-review-reconcile.test.ts`, `workflow-block-merge-conflict-autofix.test.ts` |
| Durable block waits: the runtime allowlist, the park, the wake sweep, the user poke | `server/src/db/workflow-blocks/runtime.ts`, `server/migrations/038_workflow_round.sql`, `045_workflow_wait_user_control.sql` | `server/test/workflow-block-runtime.test.ts`, `server/test-db/job-store.block-wait.test.ts` |
| Finishing a wait when a thread leaves the block's scope; the no-publication block-entry guard | `server/src/db/workflow-blocks/runtime-settle.ts` | `server/test/workflow-block-runtime-settle.test.ts` |
| The PR-lifecycle primitives a wait is built on | `server/src/db/pr-lifecycle-store.ts`, `server/migrations/036_job_pr_lifecycle.sql` | `server/test-db/job-store.block-wait.test.ts` |
| CRUD, scope visibility, block compilation at create, base-workflow seeding | `server/src/db/workflow-store.ts` | `server/test-db/workflow-store.test.ts`, `workflow-store.seeding.test.ts` |
| Board-owned prompt templates and the seeded `fix-issue` workflow | `server/src/db/workflow-templates.ts` | `server/test/workflow-engine.walkthrough.test.ts` |
| The code-owned default workflow, its selected blocks and its gate-fix round | `server/src/db/default-workflow.ts`, `server/src/routes/job-workflow-resolution.ts` | `server/test/default-workflow.test.ts`, `routes.jobs.default-workflow.test.ts`, `server/test-db/job-store.workflow.default.test.ts` |
| A member's saved default-step switches | `server/src/db/default-workflow-settings-store.ts`, `server/src/routes/workflow-settings.ts`, `server/migrations/035_default_workflow_settings.sql` | `server/test/routes.workflow-settings.test.ts`, `server/test-db/default-workflow-settings-store.test.ts` |
| CRUD routes and the block catalog | `server/src/routes/workflows.ts` | `server/test/routes.workflows.test.ts` |
| Launch resolution and the `wait/cancel`, `wait/poke` verbs | `server/src/routes/jobs.ts`, `job-workflow-resolution.ts` | `server/test/routes.jobs.test.ts`, `routes.jobs.default-workflow.test.ts` |
| The transition, inside the verdict's transaction | `server/src/db/job-store-worker.ts` (`runWorkflowTransition`) | `server/test-db/job-store.workflow.test.ts` |
| Rests no edge overrides: `blocked` (the run's failure kind), `no_progress` (`gate-failed` over `treeChanged: false`) | `server/src/db/workflow-engine.ts`, `job-store-worker.ts` (`transitionContextOf`) | `server/test/workflow-engine.next-transition.test.ts`, `default-workflow.test.ts` |
| The claim's `publish` flag, the gates opt-out, helper-plan resolution, the cancellation fence | `server/src/db/job-store-claim.ts` | `server/test-db/job-store.workflow.test.ts`, `job-store.block-wait.test.ts` |
| Session policy and the follow-up's primary-session copy | `server/src/db/job-store-actions.ts` | `server/test-db/job-store.workflow.sessions.test.ts` |
| Columns and the frozen snapshot | `server/migrations/027_workflows.sql`, `030_workflow_params.sql`, `033_job_workflow_name.sql`, `039_default_workflow_snapshot.sql`, `043_job_default_gate_fix_rounds.sql` | `server/test-db/job-store.workflow.frozen-name.test.ts`, `job-store.workflow.params.test.ts` |
| Stop/done/remove against a workflow thread | `server/src/db/job-store-actions.ts` | `server/test-db/job-store.workflow.control.test.ts` |
| The driver's one publish gate | `driver/src/loop.ts` | `driver/test/loop.test.ts`, `docker.test.ts`, `k8s.test.ts` |
| The blocks' driver-side helper scripts | `driver/src/review-helpers.ts`, `driver/src/scripts/merge-conflict-probe.cjs`, `review-collect.cjs`, `review-reply.cjs` | `driver/test/review-helpers.test.ts`, `merge-conflict-probe-script.test.ts`, `scripts.test.ts` |
| Composer dropdown and the parameter inputs | `web/src/panels/TaskComposer.tsx`, `web/src/components/WorkflowParameterFields.tsx`, `web/src/api/useWorkflows.ts` | `web/test/use-workflows.test.ts` |
| Management panel and the default-step settings page | `web/src/panels/WorkflowsPanel.tsx`, `DefaultWorkflowPanel.tsx`, `web/src/pages/SettingsWorkflowsPage.tsx` | `web/test/workflows-panel.render.test.tsx`, `default-workflow.render.test.tsx`, `default-workflow-draft.test.ts` |
| A stub workflow walked on a real board and driver | `scripts/test-jobs.sh` (`# workflows`) | — |

The helper transport a block's declared helpers run through, and the master prompt a claim carries,
are [jobs.md](jobs.md) ("Block-helper steps", "The master prompt").

## Invariants

- **What is stored is the EXPANDED graph, never the authored block reference.** `workflow-store.ts`'s
  `create()`/`update()` run `compileDefinition` after the schema check and re-validate the result;
  `workflow-engine.ts` and `routes/jobs.ts` read `.prompt` off every node with no `kind` guard, so a
  stored `block` node would corrupt the first transition into it. Guarded by
  `server/test-db/workflow-store.test.ts` and `server/test/workflow-block-compiler.test.ts`.
  Consequence: a `GET` response shows the expansion, and pasting it back is checked against the
  narrower AUTHORED size cap — re-author the block reference rather than editing an expansion.
- **`runtime` is never authorable.** It is attached to a compiled node AFTER `validateDefinition`
  runs, so any authored or pasted definition carrying it refuses `UNKNOWN_KEY` —
  `server/test/workflow-schema.test.ts`. Deleting the key to get a round trip past that refusal
  turns a durable wait into an ordinary claimable node.
- **The resolved definition, its name, the selected default blocks and the gate-fix round limit
  freeze on the thread's root row at create.** Editing or deleting a workflow changes later tasks,
  never a running thread; `job.workflow_id` carries no foreign key, because `job` is an audit
  record. `server/test-db/job-store.workflow.frozen-name.test.ts`, `job-store.workflow.default.test.ts`.
- **Marker absence is a first-class outcome.** A completed node no rule matches rests the thread
  loudly, output intact — never failed, never silently continued; a bound-exhausted edge rests too
  rather than falling through. `server/test/workflow-engine.next-transition.test.ts`.
- **Loop bounds count ROWS for the target node, dead rows included.** There is no loop-counter
  store — the rows are the audit record. To declare "review x3", give EVERY edge into `review` the
  same `max`. Same test.
- **The publish decision rides the claim and is enforced in exactly one place**, `driver/src/loop.ts`;
  neither transport grew a gate of its own, pinned by `driver/test/docker.test.ts` and `k8s.test.ts`.
  Absent on a workflow-less claim, which the driver reads as "publish".
- **A parked durable wait holds no `job` row and no executor lease.** The per-root advisory lock is
  the only thing preventing two claimers double-waking one round, and the claim-time cancellation
  fence is what makes a cancel or a PR close win the race against a wake — both asserted directly on
  `job` row counts in `server/test-db/job-store.block-wait.test.ts`.
- **`param` is a reserved node name**: prompts reference launch values as `{{param.NAME}}`.

## Stated limits

- Every declared parameter is REQUIRED at launch; there is no optional parameter.
- The parameter pattern grammar is a bounded subset — no anchors, lookarounds or backreferences, and
  a capped ambiguity budget. Refused on any doubt (`workflow-pattern.ts`).
- A definition with no `publish: true` node reachable from the entry is refused at create.
- `{{command}}` is the one unbounded substitution; every other one is truncated to its share.
- Webhook deliveries are the board's only GitHub input — a missed delivery is released by
  `POST /api/jobs/:id/wait/poke`, never by the board fetching GitHub itself.
- Neither built-in block merges, closes or auto-merges a pull request.
