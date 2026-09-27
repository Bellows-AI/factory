# Bellows redesign — final review report

Date: 2026-09-26. Reviewed source: `e19fce1`.

Reviewed artifacts: [redesign plan](PLAN.md), [first review](REVIEW.md), supplied concept images, current frontend state/action code, and backend task lifecycle code/tests. This report supersedes the first review where conclusions differ. The plan and application code remain unchanged.

## Verdict

**Ready to begin baseline and foundation work; revise three task-journey requirements before implementing R3/R4.**

The visual direction, existing-data scope, route coverage and delivery sequence are reasonable. The remaining issues concern completing user actions correctly, rather than choosing another layout or framework. There are **two P1 findings, one P2 finding, and one nonblocking handoff recommendation**. Priorities describe implementation impact: P1 should be resolved before the affected journey ships; P2 is an important usability requirement.

| ID | Priority | Finding | Required in |
| --- | --- | --- | --- |
| F1 | P1 | Configuration recovery loses the new-task draft | R3, with a settings return path |
| F2 | P1 | Review-wait completion conflicts with the existing status derivation | R0 fixtures and R4 lifecycle presentation |
| F3 | P2 | Follow-up recovery lacks an actor/ownership condition | R4, including authenticated coverage |
| H1 | Recommendation | Foundation work needs a shared component-state specimen | R1 |

## F1 — Preserve the draft through configuration recovery

**Plan location:** section 7.2, especially lines 157–163. **Confidence:** high from component and route lifetime; not reproduced in a browser during this review.

The plan tells users to follow configuration links when they cannot launch, but only promises draft retention after a failed API request. The missing case is leaving the composer to resolve the blocker.

The request, execution choices, workflow parameters and preference overrides live in component state in [TaskComposer.tsx](../../../web/src/panels/TaskComposer.tsx#L92). Settings and the composer occupy separate route branches in [App.tsx](../../../web/src/App.tsx#L50). The inspected composer, page and task layout do not preserve that draft across unmounting.

**User impact:** write a detailed request → select Configure executor → save a profile → return → lose the request and selections. This is an existing weakness that the proposed recovery journey would retain, not a regression already introduced by the plan.

**Required revision:** define a complete configuration-and-return flow. Recommended default: retain the draft in an organization/user-scoped in-memory owner above the affected routes, carry a return destination, and restore it after configuration. A dialog that keeps the composer mounted is also viable, but should be chosen explicitly rather than left for each blocker link to implement differently.

The draft contract must cover:

- Request, repository, executor, workflow identity, parameter values and explicit preference overrides.
- Revalidating restored references after configuration changes; retaining text while explaining invalid selections.
- Clearing after successful launch or explicit discard.
- Preventing restoration into another organization/account; defining what happens on sign-out and reload.
- Returning after either save or cancellation, without silently launching the task.

**Acceptance:** fill the composer, configure an executor, return, and launch the same request exactly once. Repeat with cancellation, changed/deleted configuration and organization switching. Choose whether reload persistence is supported; do not add persistent storage by accident.

**Scheduling:** deliver a small settings return path with R3 or move that part of R5 earlier. This does not require moving the entire settings redesign ahead of the task journey.

## F2 — Specify closure and wait semantics across frontend and backend

**Plan location:** section 4 state table, particularly lines 64–71, and section 7.3 at line 173. **Confidence:** high for the observed helper behavior; the complete database/browser transition was not executed.

The plan promises that a marked-done task displays Done while recommending reuse of existing state derivations. Those requirements currently conflict when review-wait metadata remains open.

The second pass found a material qualification to the earlier review:

1. A durable block wait need not be a queued job. The backend completes the publishing run and parks a separate `workflow_round` without inserting another runnable job. See [the durable-wait fixture](../../../server/test-db/job-store.block-wait.test.ts#L73) and [its parking assertion](../../../server/test-db/job-store.block-wait.test.ts#L100).
2. The thread read joins wait metadata onto actual job rows without replacing their status: [job-store-reads.ts](../../../server/src/db/job-store-reads.ts#L18).
3. Mark done accepts terminal jobs and stamps closure, but does not clear wait metadata in that function: [job-store-actions.ts](../../../server/src/db/job-store-actions.ts#L152).
4. The wake sweep excludes threads containing a done row, so this review does **not** claim that a completed thread continues waking automatically: [runtime.ts](../../../server/src/db/workflow-blocks/runtime.ts#L179).
5. The frontend label checks open wait before `doneAt`: [task-tree.ts](../../../web/src/task-tree.ts#L56). The wait predicate used elsewhere also ignores closure: [task-outcome.ts](../../../web/src/task-outcome.ts#L180).

A direct execution of the current status helper returned:

| Input | Actual label |
| --- | --- |
| Succeeded + open review wait + no closure | Waiting for review |
| Succeeded + open review wait + `doneAt` set | Waiting for review |
| Succeeded + terminal wait reason + `doneAt` set | Done |

**User impact:** after a valid Mark done action, the interface can continue describing the task as waiting for review. Reusing the helpers unchanged would violate the plan's stated closure behavior and can disagree with closure attribution and the Past bucket.

**Required revision:** define an explicit action and status matrix using run state, closure, wait metadata, session availability and actor eligibility. For display, recommended precedence is live execution/stopping first, then confirmed closure, then open wait, then ordinary queued/terminal results. Apply the decision consistently to the header, inbox, sidebar, outcome and wait explanations. Any change to documented precedence must update its focused tests and design/job documentation.

Keep the action rules distinct:

- Queued/running runs can expose the existing Stop run operation; preserve its consequences and server refusal handling.
- A terminal publishing run with a parked wait can expose Mark done under the current terminal-state rules.
- Do not add Stop run to every waiting task: the current stop API rejects terminal jobs. A separate cancel-wait operation would be additional product/API work.
- Closing a task must not be presented as merging, approving or closing its GitHub PR.

A frontend precedence correction can address the contradictory label. If implementation instead changes how Mark done finalizes wait records, treat that as a lifecycle change with transactional/database coverage, not a cosmetic refactor.

**Acceptance:** use a real backend-shaped terminal parked wait, mark it done, and verify consistent Done presentation, no available follow-up and no subsequent wake. Also cover queued/woken continuation, stop, manual follow-up, PR closure and a live run with wait metadata. Do not rely solely on the older queued-wait render fixture.

**Correction to first review:** its warning about preserving the queued-wait Stop action remains applicable to that specific state. It was too narrow as the principal review-wait requirement. This finding replaces it; universal Stop behavior is not the recommendation.

## F3 — Make “Ask for another pass” respect the task author

**Plan location:** section 4 failed-state actions and section 7.3 failure recovery, particularly lines 66–68 and 175–179. **Confidence:** high from backend eligibility and current UI predicate.

The proposed failure-recovery path describes follow-up eligibility largely through task state and session availability. It does not specify the difference between viewing one's own task and another member's task on the organization board.

The backend permits a follow-up only when the authenticated caller matches the parent task's creator. This is a null-safe author comparison, not a general organization-membership permission: [job-store-actions.ts](../../../server/src/db/job-store-actions.ts#L85). The handler supplies identity from the authenticated request: [job-handlers-actions.ts](../../../server/src/routes/job-handlers-actions.ts#L44). The existing database suite explicitly covers refusal for another account: [job-store.follow-ups.test.ts](../../../server/test-db/job-store.follow-ups.test.ts#L256).

The current composer predicate checks terminal status, closure and session but not author identity: [TaskDetail.tsx](../../../web/src/panels/TaskDetail.tsx#L72).

**User impact:** a member viewing another person's failed task is encouraged to request another pass, writes an adjustment, and receives a predictable refusal. A prominent recovery button would amplify this existing mismatch. This is a usability issue; the server already enforces the restriction.

**Required revision:** make follow-up eligibility actor-aware and display a concise explanation when the viewer cannot continue that session. Compare stable account identity, not display names. Preserve the backend's exact null/open-mode rules. Do not apply an author-only restriction to stop, done or remove without checking their separate contracts.

**Acceptance:** own task, another member's task, open-mode/null author, signed-in viewer of a null-author task, missing session and closed task. Keep server-side enforcement and refusal handling even when the frontend predicts eligibility correctly.

**Scheduling:** include authenticated multi-user coverage in R4 instead of waiting for the later account/entry redesign.

## H1 — Add a component-state specimen to R1

The recommendation from the first review stands. R1 should produce a local specimen or screenshot sheet using actual application primitives, with exact token/spacing/type choices and both themes. Cover buttons, fields, selectors, badges, banners, dialogs, disclosures and rows across default, focus, selected, invalid, disabled, busy and long-content states.

This gives R2–R7 a concrete shared reference and makes visual drift easier to detect. Preserve the current downward-only selector anchoring and other documented interaction contracts unless explicitly revising them. No new component framework, public development route or extra approval round is required.

## Decisions that remain sound

- Images 01–06 establish the Bellows screen direction; 07–09 provide surface/theme inspiration rather than new product features.
- The existing-data first release is correctly distinguished from richer inbox data, native diff, bulk actions and unimplemented analytics.
- Retaining routes, cursor pagination, the existing component stack and real workflow preferences controls implementation scope.
- Scope labels, unknown-versus-zero distinctions, stale-data retention, secrets handling and operator-owned workspace-root configuration are appropriate constraints.
- Responsive and accessibility coverage spans the application, including public pages and configuration flows.
- Kubernetes parity is correctly required only if follow-on work changes runner behavior or collected data.

The plan is an adaptation of the concepts, not a promise to reproduce every visible control. Its 18–27 focused-day estimate applies only to that first-release scope. The newly specified draft recovery and lifecycle/permission coverage should be included when re-estimating after R0; this review supplies no replacement duration estimate.

## Verification performed in this pass

| Check | Result and boundary |
| --- | --- |
| Source baseline | `e19fce1`; plan source baseline still matches |
| Existing focused tests | `vitest run web/test/task-tree.test.ts web/test/task-header.render.test.tsx web/test/task-composer-logic.test.ts` — **3 files, 82 tests passed** |
| Direct helper probe | Executed `taskStatusLabel` against terminal-wait, closed-with-open-wait and closed-with-terminal-wait inputs; results recorded under F2 |
| Backend inspection | Read thread projection, follow-up ownership, Mark done, stop and wake guards; inspected relevant database tests |
| Visual references | Reopened concepts 02, 03 and 06 to check configuration recovery, review actions and operator configuration assumptions |
| Artifact validation | Checked local report links and source references for valid target files |

The focused test output is preserved in [final-review-vitest.log](final-review-vitest.log). Passing those suites does not establish that the missing scenarios are covered or that browser layout is correct.

Not run: full regression suite, database suites, browser tests, live configuration detour, or a live parked-wait completion. The earlier screenshot run's 78-pass/13-fail result remains historical evidence and is not replaced by these focused checks. No current application code or tests were changed.

## Required plan updates and handoff

1. **R0:** use terminal parked-wait fixtures from the current backend model, reconcile older queued-wait assumptions, and record actual browser baseline failures.
2. **R1:** include H1's component-state artifact as an exit deliverable.
3. **R3:** add F1's scoped draft lifetime, configuration return path and recovery acceptance cases; schedule the small settings dependency explicitly.
4. **R4:** add F2's closure/wait precedence and full action matrix, plus F3's author-aware follow-up and authenticated cases.
5. **R8:** verify the complete configuration → launch → wait/failure → follow-up/close journeys, including refused actions and both themes.

After these revisions, the plan is suitable for implementation in its stated scope. This report is the consolidated review record; unresolved findings are requirements for the affected delivery packages, not claims that fixes have already landed.
