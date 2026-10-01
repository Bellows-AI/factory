# [Workflow] Render durable “Waiting for review” task state and outcomes

Parent: #36

Depends on #202's read-model contract. It can be implemented in parallel against fixtures, but merge after #202.

## Goal

Represent a durable PR-review wait honestly in the inbox and task detail. A task waiting for a human is not running, queued, or done, and must not be inferred from log prose.

This issue owns presentation only. It does not add webhook behavior, review automation, or settings/composer controls.

## Contract consumed

Use the bounded structured fields from #202, including `waitReason`, `waitingSince`, and a terminal/exhausted reason. Add no client-side parsing of `[driver]` output, workflow node names, or GitHub URLs.

## Work

- Extend task outcome/status derivation so an active PR-review wait yields `Waiting for review`.
- Place waiting tasks in the actionable/review grouping rather than running or past/done.
- Task detail explains what Factory is waiting for, when the wait began, and that no executor is occupied.
- Preserve the existing Stop action when the server permits it; copy explains that stopping cancels remaining automation but does not close the PR.
- Render max-round exhaustion or review/merge automation refusal as `Needs review` with the server's bounded reason and the existing follow-up path.
- Closed/merged/cancelled waits transition according to server terminal state without stale waiting copy.
- Add accessible non-color status, live-region behavior only for real transitions, and narrow-layout coverage.
- Update seeded fixtures and `docs/design-system.md` inventory.

## Ownership boundary

Own: task status/outcome pure derivations, task inbox/detail rendering and styles, web fixtures/render tests, design-system docs.

Do not touch: settings pages, composer, server routes/stores, workflow schema, driver, or webhook code.

## Acceptance

- The same structured wait state renders consistently in nav preview, inbox, and task detail.
- Waiting never displays as running/queued/done and never implies an executor is busy.
- Stop/cancel, PR closed/merged, and max-round exhausted states have distinct truthful copy.
- No output-string/node-name heuristic is introduced.
- Existing task states and actions stay green.

## Verification

- Focused task outcome/state unit tests.
- Inbox/task-detail/nav render tests for active, cancelled, completed, and exhausted waits.
- Representative UI screenshots when the browser environment is available.
- `npm run typecheck`
- `npm run lint`

