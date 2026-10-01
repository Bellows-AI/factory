Part **3 of 4** of Slice C — *Make task execution deliberate and auditable* (P1).

Full spec: `docs/ui-designer/ISSUE-SLICE-C-TASK-EXECUTION.md` — sections **Target task-detail
structure**, **9–14**, **Implementation instructions by file → Web task model and pure derivations /
Task-detail components**, and **Test plan → Conversation / Outcome**.

**Depends on:** #175 and #176.

## Summary

Rebuild task detail as a trustworthy work record. Every run should read as request → agent
response/activity → checks and published work → quiet metadata, while a compact thread-level
outcome summary answers what happened and where.

Use the stored agent `summary` and frozen `workflowName`. Do not infer either from logs, workflow
nodes, or live workflow rows.

This issue owns content hierarchy and responsive task-detail layout. State-based actions and the
remove dialog land in Slice C 4/4.

## Page structure

Keep Slice A's `TaskHeader` title/status/wall-clock/activity shell, then render:

1. action/thread error region;
2. `task-layout` containing:
   - `TaskOutcome` first in DOM;
   - Conversation second in DOM.

At ≥1024px place Conversation in the dominant left column and Outcome in a bounded right column.
At 360/768px keep Outcome above Conversation as an expanded-by-default native disclosure.

Do not duplicate the outcome component for breakpoints.

## 1. Replace TaskSide with TaskOutcome

Create `TaskOutcome.tsx` and delete `TaskSide.tsx` after callers/tests move.

### Result

- current textual status;
- closure attribution when present;
- root author as Started by;
- task wall clock, including the newest live segment;
- newest terminal exit code when known.

### Execution

- repository when non-null;
- worktree when non-null;
- named executor or **Default executor**;
- frozen workflow name when non-null;
- workflow node when non-null;
- newest closed turn's context;
- sum of positive measured per-turn cost.

### Verification

- newest-run gate counts only when gates exist;
- passed/failed/running text plus status treatment;
- **View checks in run <n>** focuses the run's verification section;
- do not duplicate gate output in Outcome.

### Published work

- derive the newest anchored driver publication line;
- show code-styled branch;
- link a safe URL as the bare PR number **#<n>** — the row's label already says *Pull request*;
- branch without URL shows branch only;
- remove the fabricated **PR state —** row;
- link the bare **#<n>** only when a valid repository makes the URL constructible.

### Services

- newest attempt only;
- only when present;
- describe as last-reported attempt state;
- collapse when more than three.

Omit absent optional rows. Preserve the wall-clock em-dash convention. Never fabricate zero
context/cost or current service state.

## 2. Pure outcome/publication derivations

Add `web/src/task-outcome.ts` and move derivations out of the panel:

- thread context;
- positive-cost sum;
- issue reference;
- `publicationForRun(job)`;
- `threadPublish(jobs)`;
- gate counts;
- closure label.

Return data, not React nodes.

Publication parser invariants:

- anchored `[driver] published <branch> — <url>` line only;
- newest-first at thread level;
- per-run parser reads one row only;
- mid-line lookalikes rejected;
- only HTTP(S) links;
- stored output remains untouched.

## 3. Conversation and TaskRun

Add `TaskRun.tsx` and render one article per job, oldest-first.

Every article uses:

1. **Request** on root or **Follow-up** on later rows;
2. **Agent response** or live **Agent activity**;
3. **Checks and published work** when either exists;
4. quiet metadata footer.

Prompts render as plain normal prose with line breaks preserved. They are not Markdown and not
monospace merely because they are agent input.

### Agent response truth table

| State/data | Rendering |
| --- | --- |
| Running + activity | Agent activity sentence |
| Running + output | Visible bounded live output which follows the tail |
| Queued/running without output | **Waiting for the executor…** |
| Terminal + summary | Flowing summary text |
| Terminal + summary + output | Summary, then collapsed **View raw output** |
| Terminal without summary + output | **No agent summary was captured.** plus expanded raw output |
| Terminal without summary/output | **This run finished without a captured agent response. Check its exit status and checks below.** |

Summary and output remain untrusted text. Output uses a labelled, keyboard-scrollable `pre`.
Only the newest non-terminal output auto-scrolls.

### Checks and published work

- Keep gates attached to their producing run.
- Summarize passed/failed/running with text.
- Gate rows retain name/status/exit code.
- Gate output remains a nested disclosure and text `pre`.
- Render per-run publication beside checks.
- Give this region a stable focus target for Outcome.

### Quiet metadata footer

When applicable:

- run status;
- created/exact time;
- executor;
- workflow name and node;
- run duration;
- exit code;
- per-turn context and positive cost;
- stop/stop-request attribution;
- done attribution;
- standby/parked marker.

Metadata follows the work; it does not lead the article.

## 4. Follow-up composer

Keep it after the newest run, inside Conversation:

- label **Ask for a follow-up**;
- helper **The agent continues the same task, checkout, executor, and session.**
- placeholder **Describe the adjustment…**;
- action **Send follow-up** / **Sending…**;
- visible `Ctrl/⌘ + Enter`;
- one guarded shortcut/click path;
- failed send preserves draft;
- success clears only after acceptance, refreshes the same thread, and keeps the route.

Availability does not change: newest run terminal, open, and carrying an agent session.

For terminal open sessionless runs, keep the explanation and link **Start a new task** to
`/tasks/new`. Closed tasks render no composer.

## Implementation map

- `web/src/task-outcome.ts` — pure derivations.
- `web/src/panels/TaskOutcome.tsx` — thread summary; replaces/deletes TaskSide.
- `web/src/panels/TaskRun.tsx` — one run article.
- `web/src/panels/TaskDetail.tsx` — layout, newest derivation, live output ref, follow-up.
- `web/src/api/useJobs.ts` — consume `workflowName` from 1/4.
- `web/src/styles.css` — documented task outcome/conversation primitives.
- `docs/design-system.md` — replace inventory rows and document primitives.
- `web/test/tasks.render.test.tsx` — truth/omission/order matrices.
- `e2e/task-detail.spec.ts` — real task states and responsive screenshots.

Keep polling, abort, last-good state, and mutation ownership outside these components.

## Accessibility and responsive requirements

- One page `h1` remains in TaskHeader.
- Conversation has a visible heading.
- Run heading/labels produce a logical outline.
- Details summaries have visible focus and meaningful names.
- Raw/gate output wells are keyboard scrollable.
- Status/check meaning includes text, not color alone.
- Links use descriptive text and safe `rel`.
- Do not make the transcript/output tail an `aria-live` region.
- 360/768px: Outcome disclosure above Conversation.
- ≥1024px: bounded Outcome column, dominant Conversation column.
- No page-level overflow at the four target widths.

## Tests

### Pure/render

- context uses newest closed turn, never sum;
- positive cost sums once and absent/zero omits;
- publication per-run/thread precedence, unsafe URL, and mid-line rejection;
- workflow name is distinct from node;
- every Outcome omission rule;
- summary-before-output ordering;
- full terminal response truth table;
- prompt/summary/output remain text;
- root/follow-up order and labels;
- checks/publication attached to the right run;
- metadata follows work in markup order;
- follow-up availability and sessionless/closed states;
- no `undefined`, `null`, `NaN`, fake zeros, or PR state.

### Browser

- successful task with summary, output, checks, publication;
- successful task with no captured response;
- multi-run conversation;
- running activity/output;
- sessionless terminal task;
- closed task;
- 360/768/1024/1440 screenshots and overflow assertions.

Use seeded data for durable states and request interception only for transient states. Do not add a
production test route.

## Acceptance criteria

- [ ] Every run reads request → response/activity → checks/published work → metadata.
- [ ] Stored summary is the primary terminal response.
- [ ] Missing response has the specified explanatory copy.
- [ ] Raw output remains available, bounded, text-only, and keyboard scrollable.
- [ ] Checks and publication remain attached to the producing run.
- [ ] Outcome contains only meaningful, source-backed facts.
- [ ] Frozen workflow name and workflow node are displayed as different concepts.
- [ ] No PR state is fabricated.
- [ ] Follow-ups remain in the same conversation with Send follow-up.
- [ ] Outcome becomes one disclosure above Conversation on narrow screens.
- [ ] Polling and lifecycle behavior are unchanged.
- [ ] Old TaskSide code/classes/inventory are removed.

## Verification

```bash
npx vitest run web/test/tasks.render.test.tsx web/test/styles.test.ts
npm run typecheck
npm run lint
npm run build
npm run verify:ui
```

Inspect every task-detail screenshot.

## Out of scope

- Task action-state changes.
- Remove menu/dialog.
- Structured publication/PR-state API.
- Markdown rendering.
- Polling or lifecycle changes.
