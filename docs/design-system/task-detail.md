# Design system — region: task-detail

Owned by the task-detail lane. Styles: `web/src/styles/regions/task-detail.css` — the lane rules plus its
trailing 44px touch-target segment (issue 189). Shared primitives, tokens and the system
contracts: [../design-system.md](../design-system.md).

## Primitives

| Primitive | Classes | Use for |
| --- | --- | --- |
| Grid | `task-layout`, `task-main` | The task page's grid: the outcome rail (`task-outcome`) and the main column (`task-main`: conversation → run history → run activity → verification → services → published work → follow-up). Rail first in the DOM; a 320px right column from 1024px, a two-column summary above the main column below it — DOM order is visual order |
| Exchange | `chat-exchange`, `msg-user`, `msg-meta`, `chat-exit` | One turn: prompt as plain prose (line breaks kept, not mono), metadata, exit code. A failed run's structured failure kind (issue 339) renders in the metadata as a `pill-bad` word badge — "timed out", "cache lost" — beside the status pill; a run without a kind renders none |
| Run article | `run-label`, `run-summary`, `run-output`, `run-well` | One run's sections in reading order: labels (Request / Follow-up / Agent response / activity), the stored summary as flowing prose, and the raw-output disclosure (collapsed behind a summary, expanded when it is all there is) — never a fabricated response. Gates and publication are the task's panels, not a run's |
| Run history | `task-history`, `task-history-item` | The recorded stamps only, oldest first — created, started, finished, stop requested, `waitingSince`, `doneAt` + `doneBy` — each with its relative `time`. No inferred rows ("Implemented changes", "Published PR") |
| Run activity | `task-activity` | The head run's progress over time (issue 339) as a `panel`: the existing `BarChart` with a Tokens bar series and an Edits line, bucket width scaled to the run; the last bucket `bar-partial`-hatched while the run is live. A run the pipeline holds nothing about renders one `muted` sentence — never a fabricated zero line |
| Verification | `task-verification`, `task-verification-counts`, `gate-output-wrap`, `gate-output` | The newest run's gates as a panel (`#task-verification`, a focus target for the rail's View checks): "N failed" `pill-bad` / "N passed" `pill-ok` / "N running" `pill-done`, each only when N > 0; each gate a `<details>`, failed ones `open`; the output a 12px mono well on `--surface-sunken`, lines kept whole and scrolled in its own well, with a copy button. No durations, no per-test tree |
| Published work | `task-published`, `task-branch`, `run-publish`, `task-copy` | The branch as a mono chip with its copy button, and the PR link only through `isHttpUrl`. `task-copy` is the copy button (a `chat-resume`, so the 44px rule already covers it) |
| Runtime | `chat-runtime`, `chat-activity`, `task-summary`, `task-clock` | The "is it stuck or working" strips |
| Gates | `chat-gate-list` | The verification-gate list; each gate's status (and the counts) is a `pill` in the tone the `GATE_PILL` map in `task-outcome.ts` names — passed `pill-ok`, failed `pill-bad`, running `pill-done`; a zero count is not drawn at all |
| Output | `chat-output` | The scrolled raw-run well (`--surface`); `gate-output` is the gate variant |
| Verdicts | `chat-resume`, `chat-toggle`, `chat-done`, `chat-stop`, `chat-remove` | The task's action buttons, status-tinted; the tinted ones (`chat-done`, `chat-stop`, `chat-remove`) hover on their own lamp's wash, never on the strong surface their status text may not sit on |
| Outcome | `task-outcome`, `task-outcome-summary`, `task-outcome-body`, `task-outcome-label` | The task page's summary disclosure: result (the header's own state pill, not a second live region), a failure's next action (Ask for another pass when `followUpEligibility` allows it, else the same not-author sentence as the follow-up slot; nothing while the session loads), execution, verification counts, published work — one `<details>`, expanded by default, a two-column summary above the main column (600–1023px; one column on a phone, where two key/value columns cannot hold a label) and a one-column 320px rail (≥1024px) without a second component |
| Task head | `task-actions`, `task-action-help`, `task-closed`, `task-meta-line`, `task-opened-by`, `task-pill-wait`, `task-pill-done`, `task-avatar` | The page header's parts: the state pill (`taskStatusLabel` in the `taskTone` tone, per the status table — `task-pill-wait` is the wait's `--line-strong` edge, `task-pill-done` the done check in `--lamp-run`), `#id · Opened … by (avatar) login · repo`, and the action row — one primary action from the plan §3.2 matrix, the More task actions overflow, and the one sentence that says what the primary does (`task-action-help`), or the closure as "Closed by X · time" (`task-closed`), never a disabled control. The row wraps, so narrow screens drop its second line rather than clip it |
| Follow up | `task-follow-up` | The composer, offered only when `followUpEligibility` answers `eligible`; another member's task says who can continue instead, and a loading session renders nothing |
| Remove dialog | `task-remove`, `task-remove-title`, `task-remove-actions` | The remove confirmation over the task page (issue 178): in the shared `dialog` panel at 440px, the body copy carries every consequence, Cancel and the destructive Remove task end-aligned |


## Inventory

| File | Primitives |
| --- | --- |
| `TaskDetailPage.tsx` | page-header, status |
| `TaskHeader.tsx` | page-header, pill, pill-ok, pill-bad, pill-done, pill-accent, task-pill-wait, task-pill-done, sidenav-dot, icon, task-meta-line, task-opened-by, avatar, avatar-fallback, task head, task-action-help, task-closed, popover, popover-option, primary, chat-resume, chat-stop, chat-remove, muted |
| `TaskDetail.tsx` | task-layout, task-main, task-conversation, task-history, task-history-item, task-activity, task-follow-up, panel-head, panel, kv, composer, field, status, muted |
| `TaskRun.tsx` | chat-exchange, run-label, run-summary, run-output, run-well, run-publish, msg-user, msg-meta, chat-runtime, chat-activity, chat-exit, chat-done, chat-stop, task-verification, task-verification-counts, chat-gate-list, gate-output-wrap, gate-output, task-published, task-branch, task-copy, chat-resume, icon, pill-ok, pill-bad, pill-done, chat-output, panel, panel-head, pill, muted, code |
| `TaskActivity.tsx` | task-activity, panel, panel-head, muted |
| `TaskOutcome.tsx` | task-outcome, task-outcome-summary, task-outcome-body, task-outcome-label, panel, pill, pill-ok, pill-bad, pill-done, msg-meta, chat-done, chat-stop, chat-exit, task-avatar, by-user-user, kv, muted, code |
| `TaskRemoveDialog.tsx` | dialog, task-remove, status, chat-resume, chat-remove |

