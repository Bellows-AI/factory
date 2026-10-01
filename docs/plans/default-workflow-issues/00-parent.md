# [Workflow] Built-in default workflow — parallel delivery umbrella

## Outcome

An unnamed task runs a code-owned `default` workflow whose entry is exactly the member's arbitrary prompt or user-defined skill invocation. The mandatory spine remains prompt → declared gates → publish/open-or-reuse PR.

Two optional post-PR blocks are enabled by default:

- reconcile PR review feedback, at most three agent repair rounds;
- repair conflicts with the PR base branch, one agent repair round.

Members save their preferred defaults and may include/exclude either step for one task in the composer. The launch-time selection is frozen in the task's workflow snapshot. An explicitly selected custom workflow wins and may reference the same built-in blocks itself.

“Merge autofix” updates the PR branch; it never merges/closes the PR or enables GitHub auto-merge.

## Delivery graph

### Foundation and independent slices

- [x] #204 — reusable built-in block grammar, registry, compiler, catalog
- [x] #203 — saved default-workflow settings persistence/API
- [x] #202 — structured PR identity, signed webhook ingestion, durable wait data primitives
- [x] #201 — deterministic GitHub review collect/reply helpers
- [x] #208 — settings/composer UI and per-task overrides
- [x] #206 — waiting/needs-review task UI

### Completed helper transport

- [x] #207 — generic allowlisted script-helper transport with Docker/Kubernetes parity

### Shared runtime gap repair — run these in parallel

- [ ] #230 — pre-helper conclude control and allowlisted composite helper programs; sequence after in-progress #122
- [ ] #231 — durable block wait/wake transition and claim dispatch; depends on #122's additive claim plumbing

### Reusable blocks — run these in parallel

- [ ] #122 — `builtin/merge-conflict-autofix`; in progress on its approved relay-turn design, with no #230/#231 dependency
- [ ] #133 — `builtin/github-review-reconcile`; also depends on #230 and #231

### Enablement and closeout

- [ ] #209 — compile/launch the code-owned default workflow; depends on #122, #133, #203, #204, #208
- [ ] #210 — cross-stack/executor/UI/docs/E2E closeout; depends on the completed graph

## Recommended Factory waves

**Completed:** #201, #202, #203, #204, #206, #207, and #208.

**Active — let the current Factory run finish:** #122. Its approved implementation may add optional `helperPlans` and generic PR-identity injection in schema/claim code. An up-to-date result may use one cheap relay turn; substantive agent judgment remains conflict-only.

**Wave 1 — next, in parallel after #122 merges:** #230 and #231. They have disjoint driver/server ownership; #231 consumes #122's additive claim plumbing, while #230 must not trigger a rewrite of #122.

**Wave 2:** #133 after #230 and #231 merge.

**Wave 3:** #209 turns the pieces on for unnamed tasks.

**Wave 4:** #210 runs the full integration/visual/executor matrix and fixes only demonstrated integration defects.

## Parallel ownership rules

- Migration filenames are reserved: #203 owns `035_default_workflow_settings.sql`, #202 owns `036_job_pr_lifecycle.sql`, and #209 owns `037_default_workflow_snapshot.sql`.
- #204 adds the block catalog endpoint inside the existing workflow route plugin; #203 owns the concurrent new route registration in `app.ts`.
- #122 owns its narrow optional `helperPlans` and generic PR-identity schema/claim additions. #231 builds on those fields and must not replace them.
- #201 owns review helper files; #207 owns script-helper transport; #230 owns conclude/composite control for #133 and future blocks, not a retrofit of #122.
- #231 owns generic server wait/wake dispatch. #122 and #133 own separate descriptor/orchestration modules and do not refactor shared runtime.
- #206 owns task status/inbox/detail presentation. #208 owns settings/composer. Reuse existing primitives and leave broad style/document inventory cleanup to #210.
- #131/#132 remain separate generic workflow-editor work. Do not run #131 concurrently with #204/#208 without planning a rebase around their workflow route/settings changes.

## Product invariants

- Missing saved settings means both optional steps are on.
- Per-task overrides may turn a saved-off step on or a saved-on step off.
- Both optional steps off reproduces today's unnamed behavior: run, gates, publish.
- Custom workflows do not inherit default settings; they opt into built-in blocks explicitly.
- Waiting for human review consumes no executor.
- Review webhook deliveries are idempotent; full state is fetched before every repair round.
- The fourth required review repair rests for a human. Merge repair gets one agent round.
- Docker and Kubernetes behavior lands together.
- Running threads use their frozen expanded snapshot; settings/block updates affect future tasks only.
- Do not restore arbitrary scoped `workflow.is_default`; the default is reserved and code-owned.

## Completion

Close this umbrella only after #210 verifies the full suite, executor parity, disposable-DB coverage, UI screenshots, webhook/security behavior, and final documentation.
