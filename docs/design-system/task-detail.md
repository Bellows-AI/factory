# Design system — region: task-detail

The task page. `web/src/styles/regions/task-detail.css`; shared system:
[../design-system.md](../design-system.md).

| Concern | Code | Test |
| --- | --- | --- |
| Page frame, grid, panel order, remove dialog | `web/src/pages/TaskDetailPage.tsx`, `web/src/panels/TaskDetail.tsx`, `web/src/components/TaskRemoveDialog.tsx` | `web/test/task-detail.render.test.tsx`, `e2e/task-detail.spec.ts` |
| Head: state pill, metadata, action row | `web/src/panels/TaskHeader.tsx` | `web/test/task-header.render.test.tsx` |
| Outcome rail, and one run's exchange, output, gates, published work | `web/src/panels/TaskOutcome.tsx`, `web/src/panels/TaskRun.tsx` | `web/test/task-outcome.render.test.tsx`, `web/test/task-run.render.test.tsx` |
| Run activity chart, gate tones, follow-up eligibility | `web/src/panels/TaskActivity.tsx`, `web/src/task-outcome.ts` | `web/test/task-activity.render.test.tsx`, `web/test/task-derivations.test.ts` |

## Invariants

- Nothing here is inferred: run history shows recorded stamps only, a run with no stored response
  renders none, a run the pipeline holds nothing about gets one sentence, not a zero line.
- DOM order is visual order — the outcome rail comes first at every width.

Classes defined here: `task-layout`, `task-main`, `task-summary`, `task-clock`, `task-actions`,
`task-action-help`, `task-closed`, `task-meta-line`, `task-opened-by`, `task-pill-wait`,
`task-pill-done`, `task-outcome-body`, `task-outcome-label`, `task-history-item`, `task-branch`,
`task-copy`, `task-verification-counts`, `task-remove-title`, `task-remove-actions`, `msg-user`,
`msg-meta`, `chat-exchange`, `chat-exit`, `chat-runtime`, `chat-activity`, `chat-gate-list`,
`chat-output`, `chat-resume`, `chat-done`, `chat-stop`, `chat-remove`, `run-label`, `run-summary`,
`run-output`, `run-well`, `run-publish`, `gate-output-wrap`.
