# Redesign plan review

Reviewed: 2026-09-26. Target: [PLAN.md](PLAN.md), against the current application source and the reference analysis recorded during planning.

Assessment: the plan provides a sound existing-data first release, but two task-journey requirements need clarification before implementation. One additional foundation deliverable would make the visual handoff more reliable. This review does not change the plan or application code.

## 1. P1 — Preserve the task draft through configuration recovery

**Plan location:** [Composer readiness and launch](PLAN.md#72-new-task), particularly lines 157–163.

The plan directs users to Settings when an executor or other prerequisite is missing, but only specifies draft retention after a failed submission. It does not define what happens when users follow the recommended configuration link and return.

The current request is local component state in [TaskComposer.tsx](../../../web/src/panels/TaskComposer.tsx#L92), alongside repository/executor choices, workflow parameters, and optional-step overrides. The composer and settings are different routed branches in [App.tsx](../../../web/src/App.tsx#L50). Leaving the composer unmounts it; the inspected composer/page/layout have no draft persistence or navigation guard that restores these values.

**Failure scenario:** write a detailed request → discover no executor is configured → follow Configure executor → create a profile → return to New task → request and prior choices are gone. This is existing behavior the proposed recovery flow would perpetuate, rather than a regression already introduced by this document.

**Required plan change:** make the configuration detour a complete round trip. Choose one concrete design:

- Configure the missing resource in a dialog while the composer stays mounted; or
- Keep an organization/user-scoped draft above route lifetime, provide a return destination, and restore the draft after configuration.

For the second approach, specify retention lifetime, explicit discard, clearing after successful launch, and invalidation/revalidation of executor/repository/workflow selections. Never restore a draft into another user's or organization's context. Storage choice should be deliberate; persistent browser storage is not required to solve an in-session detour.

**Acceptance test:** enter a request, workflow parameters and overrides; follow the configuration action; save; return; verify that the draft survives, newly available configuration is refreshed, and the submitted payload matches the restored choices. Also exercise cancellation and an organization switch.

**Delivery impact:** R3 must include this behavior, with a dependency on the relevant settings recovery flow in R5 or a small shared dialog delivered earlier. The current R3 estimate should be rechecked once the approach is chosen.

## 2. P2 — Make the review-wait action matrix explicit

**Plan location:** [Task state table](PLAN.md#task-state-is-multidimensional), line 64, and [review detail behavior](PLAN.md#73-task-detail-review-and-failure), line 173.

The review-wait row mentions opening published work and completion/follow-up “when allowed,” but omits the stop-automation path. The blanket instruction to preserve restrictions helps, yet it leaves the most important exception absent from the concrete action specification. Reference image 03 shows Mark done prominently, which makes an incorrect implementation especially plausible.

The current UI explicitly retains **Stop run** for a nonterminal queued review wait, with the explanation that stopping cancels remaining automation without closing or merging the PR. See [TaskHeader.tsx](../../../web/src/panels/TaskHeader.tsx#L82) and the corresponding [review-wait test](../../../web/test/task-header.render.test.tsx#L58). Eligibility is determined separately: stop for nonterminal status; Mark done for terminal and not closed; follow-up for terminal, not closed, and an available session. See [TaskHeader.tsx](../../../web/src/panels/TaskHeader.tsx#L173) and [TaskDetail.tsx](../../../web/src/panels/TaskDetail.tsx#L72).

**Failure scenario:** an implementation follows the plan's review-wait row or the mockup and substitutes a completion action for a queued wait, removing the user's established way to cancel remaining automation or offering an ineligible operation.

**Required plan change:** specify actions using the underlying run status, open-wait metadata, closure, and session availability together. For the supported queued-wait case, explicitly preserve Stop run and its consequence text. Treat terminal-with-wait separately rather than assuming every wait has the same underlying status. Keep server refusal handling authoritative.

**Acceptance test:** cover queued + open wait, terminal + open wait where supported by the server, live follow-up precedence, closed task, and missing session. Verify the displayed action, its request target, resulting state, and consequence copy. Resolve any mismatch between current server-produced wait shapes and existing fixtures in R0; do not silently perpetuate a stale fixture.

**Delivery impact:** clarify R0 fixtures and R4 acceptance before the task-header layout is rebuilt.

## 3. Handoff recommendation — Add a foundation review artifact before page work

**Plan location:** [Visual foundation specification](PLAN.md#5-visual-foundation-specification) and R1 in the [delivery table](PLAN.md#9-delivery-sequence-and-reviewable-work-packages).

R1 promises tokens, shared controls and a reviewed shell, but does not explicitly deliver a specimen showing component states together. The plan intentionally leaves some dimensions as ranges, and the references mix several visual systems. Separate page implementations could each look reasonable while choosing inconsistent density, status treatment or control geometry.

Add a local component specimen or equivalent documented screenshot sheet to R1. It should settle exact token/type/spacing choices and show primary/secondary/destructive controls, selector states, fields with errors, disabled/busy actions, statuses, dialog, table row and disclosure in both themes. Include focus, long-label and compact-width examples. Reuse the actual application primitives; do not introduce a separate component framework or publicly exposed development route solely for this artifact.

R2–R7 should reuse those reviewed choices. This is a delivery-quality recommendation, not a verified application defect, and does not require another user approval round.

## What holds up

- The distinction between screenshot inspiration and API-supported behavior is useful and correctly avoids fake checks, diff data, cost comparisons and bulk actions.
- Keeping cursor pagination, current route structure and the two real workflow preferences makes the first release implementable.
- The plan correctly separates task closure, run result, verification and durable wait state at the conceptual level; finding 2 concerns its incomplete action specification.
- Scope, secrets, stale-data behavior, no-repository launch, Kubernetes parity for future runner changes, and disposable test databases are addressed.
- Existing browser failures are labeled as historical observations, not claimed as a passing baseline.

## Review limits

This was a document and source review. No tests or live browser sessions were run, and no new pixel-level inspection was performed in this review pass. Findings describe implementation risks in the plan and behavior visible in the inspected code/tests. The 18–27 day estimate remains a rough planning range; it is not validated delivery capacity.

Recommended disposition: revise the two task-journey requirements, add the foundation specimen to R1, then proceed with R0. No architectural rewrite is indicated by this review.
