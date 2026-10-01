# [UI] Slice C — Make task execution deliberate and auditable

## Issue metadata

- **Type:** Feature / task execution UX
- **Priority:** P1
- **Size:** Large; land as the ordered PR sequence at the end of this issue
- **Areas:** Workflow contract, job audit data, task composer, task detail, task actions,
  responsive layout, accessibility, tests, visual regression, documentation
- **Depends on:** Slice A — Navigation and hierarchy; rebase onto Slice B's final design-system
  primitives before styling
- **Blocks:** Slice E's final visual, focus-state, contrast, and theme audit

## Summary

Turn task creation and task review into one legible execution flow.

Before starting a task, a member must be able to say what the agent will do, which repository and
executor it will use, whether a reusable workflow will transform the prompt, and which workflow
inputs are still required. After a run, the same member must be able to distinguish the request,
the agent's result, verification and publication, the run's audit metadata, and the next available
human action without decoding a wall of pills or raw output.

This slice delivers:

- a guided composer with explicit execution context, plain-language workflow guidance, a
  preflight sentence, and **Start task**;
- a task conversation whose visual order is request → agent response → checks/published work →
  metadata;
- an outcome summary that contains only facts the board actually knows;
- one state-appropriate task action, with destructive removal moved behind an accessible menu and
  confirmation dialog.

This is a presentation and auditability change, plus the minimum data-contract work required to
present those facts honestly. Do not add agent planning, prompt rewriting previews, new runner
behavior, task editing, or synthetic success interpretations.

## Baseline and dependency assumptions

Implement this issue after Slice A. Rebase every route and component name below onto Slice A's
landed tree rather than restoring superseded navigation.

Slice C assumes Slice A has delivered:

- `/tasks` as the task inbox;
- `/tasks/new` as the new-task composer;
- `/tasks/:id` as task detail;
- `PageHeader` with one page-level `h1`;
- a compact desktop sidenav and focus-managed mobile navigation;
- global control sizing, skip-link behavior, and base `:focus-visible` treatment.

Slice C assumes Slice B has delivered the final P1-era spacing, surface, status, disclosure, and
responsive conventions in `web/src/styles.css`. Slice C may add task-specific primitives, but it
must not fork a second control, panel, table, status, or popover language.

The current implementation still contains useful behavior that this issue must evolve rather than
discard:

- `TaskComposer` owns draft selection and mirrors server-side workflow-parameter validation.
- `TaskComposerPage` owns queueing, workflow fetching, and success navigation.
- `TaskDetailPage` owns thread polling and the follow-up, stop, done, and remove mutations.
- `TaskDetail` renders every run oldest-first and auto-scrolls only the newest live output.
- `TaskSide` derives thread context, cost, issue, and publication facts.
- `TaskHeader` derives title, current status, wall clock, activity, and action availability.
- `useThread` keeps one task's last good thread and stops polling after every run is terminal.

Do not move network effects into presentational components while recomposing these surfaces.

## Required reading before implementation

Read these files before editing the corresponding code:

- `docs/design-system.md` for tokens, primitives, responsive rules, and inventory requirements;
- `docs/jobs.md` for thread identity, follow-ups, summaries, checks, stop, done, remove, worktree
  reclaim, and publication behavior;
- `docs/workflows.md` for workflow resolution, snapshots, parameters, and transition semantics;
- `docs/api.md` before changing workflow or job responses;
- `docs/persistence.md` before adding the job audit column and migration;
- `docs/security.md` before rendering external links or changing action surfaces.

## Problem statement

### The composer hides execution choices in a control strip

The prompt is an unlabeled textarea followed by three compact selectors and **Send**. Repository,
executor, workflow, and workflow parameters determine what runs, where it runs, and whether the
member's words are transformed, but they read like incidental metadata.

The current `none` labels are ambiguous:

- repository null means **No repository**;
- executor null means the deployment's **Default executor**;
- workflow null means the member's prompt runs as written.

Those are different decisions and must not share an unexplained placeholder.

### Workflow validation exposes implementation syntax

The current parameter row uses `title="must match ..."` and a shared “needs” sentence containing the
raw regular expression. That tells a member how the validator is implemented, not how to repair the
input. It also gives every invalid field the same `aria-describedby` target and marks untouched
required fields invalid immediately.

A generic client cannot reliably turn an arbitrary regex into product copy. Workflow authors need a
small, bounded place to provide human guidance, while the regex remains available as secondary
technical detail.

### The transcript makes logs louder than outcomes

Each run currently leads with the prompt, then a dense metadata row, then gates and raw output. The
close-time agent `summary` exists in the job response but is not rendered. A successful run with no
captured output therefore looks close to an empty record, while timestamps, status pills, and logs
carry more visual weight than the result.

### The status sidebar is sparse and mixes unrelated facts

`TaskSide` mixes thread outcome, live activity, workspace, services, issue parsing, and publication
under **Status** and **Connections**. It omits the repository and workflow name, repeats information
from the page header, leaves empty key/value rows, and renders **PR state —** even though no source
records PR state.

### Task actions compete instead of reflecting state

Stop, Done, and Remove are peers at the top of the page. Their labels do not describe the affected
unit, closed tasks do not foreground closure attribution, and Remove uses `window.confirm`.
Removing a task permanently deletes every run and queues its worktree for reclamation; that requires
a real dialog which names the task and explains what remains remote.

## Goals

1. Make the prompt and execution context readable in the order a member decides them.
2. Use explicit **No repository**, **Default executor**, and **No workflow — run prompt as written**
   choices.
3. Explain workflow parameters in product language and keep regex source behind
   **Format details**.
4. Show a live preflight sentence describing repository, executor, workflow, and prompt behavior.
5. Make **Start task** the one composer action and keep its keyboard shortcut visible.
6. Render the close-time agent summary as the primary response when it exists.
7. Separate every run into request, agent response/activity, verification/published work, and quiet
   metadata.
8. Replace the sparse sidebar with a compact, truthful outcome summary.
9. Present one state-appropriate action and move Remove into a destructive overflow path.
10. Preserve thread, polling, session, workflow, check, publication, and measurement semantics.
11. Prevent horizontal overflow and keep the critical action reachable at 360px, 768px, 1024px,
    and 1440px.

## Non-goals

- Do not add prompt templates outside the existing workflow system.
- Do not preview the fully interpolated workflow command; that is resolved node-by-node by the
  board and may depend on prior output or checks.
- Do not auto-select a workflow, including a formerly supported default. The member chooses one or
  the prompt runs verbatim.
- Do not change workflow resolution precedence: repo > user > org.
- Do not change parameter requiredness, the 512-character value limit, full-match behavior, or the
  safe regex subset.
- Do not make repository mandatory. A null repository is a supported no-checkout task.
- Do not make a named executor mandatory. Null still means the deployment default.
- Do not add task drafts, autosave, scheduling, priority, estimated duration, or cost forecasts.
- Do not add Markdown or HTML rendering for prompts, summaries, gate output, or runner output.
- Do not create a second transcript or split follow-ups into separate task pages.
- Do not change stop, follow-up, done, remove, reclaim, or workflow transition semantics.
- Do not claim a PR state, merge state, or deployment result the board does not record.
- Do not delete a published branch or pull request when removing a Factory task.
- Do not add a driver feature. This slice does not touch Docker/Kubernetes runner behavior.
- Do not redesign the task inbox, dashboard, settings pages, onboarding, or application shell.
- Do not retain old component names, props, payload aliases, or CSS classes after callers move.
- Do not add theme switching or decorative animation.

## Product and behavior constraints to preserve

- A task is one thread. The root command and every follow-up render in one conversation,
  oldest-first.
- Any run id resolves to the same root thread.
- The newest run controls present-tense status, action availability, follow-up availability, live
  activity, current checks, services, and polling.
- A task run ending does not close the task. A human marks the terminal thread done.
- `queued`, `running`, and `standby` can still move and are stoppable by the board.
- `succeeded`, `failed`, `dead`, and `stopped` are terminal.
- A follow-up is offered only when the newest run is terminal, open (`doneAt === null`), and has an
  agent session.
- Follow-ups inherit repository, executor, workflow snapshot/parameters, worktree, and the correct
  session. They never expose a new executor selector.
- Workflow-less tasks run the member's prompt verbatim and send no `workflowParams`.
- Switching repository clears the workflow choice and its values before the new workflow list can
  be used.
- Switching workflow never carries parameter values from a different workflow id.
- A failed mutation remains visible in place and does not clear the member's draft.
- A successful queue navigates to the created task.
- A successful follow-up stays on the same task and refreshes its thread.
- A successful stop stays on the task and polling reveals the settled `stopped` row.
- A successful done stays on the task and refreshes closure attribution.
- A successful remove navigates to `/tasks`.
- Stop can take seconds to settle through the worker heartbeat. “Stopping…” is a pending state, not
  a terminal verdict.
- Remove deletes all thread rows and queues worktree reclamation. It is refused while any thread
  member is running.
- Published remote branches and pull requests are outside Remove and remain remote.
- Raw output and gate output are untrusted text and must stay text inside `pre` elements.
- The newest live output follows its tail. Terminal output never steals the reader's scroll.
- Context is the newest closed turn's non-null context scrape, never a sum.
- Thread cost is the sum of positive per-turn costs. If nothing was billed or measured, omit the
  row rather than fabricating `$0.0000`.
- Task wall clock uses `taskWallClockMs` plus the newest live segment while running. Null and no
  live segment render as an em dash, never zero.
- Null is unmeasured. Zero is a measured value. Preserve that distinction in every formatter.
- The workflow name shown on a task must be the name frozen at creation, not a join to a mutable or
  deleted live workflow.
- Publication remains derived from the driver's anchored
  `[driver] published <branch> — <url>` output line until a separate structured contract exists.
- Only `http:` and `https:` publication URLs become links, with `noopener noreferrer`.
- Poll cadence, abort behavior, last-good state, hidden-tab slowdown, and 401 handling do not
  change.

## Target composer structure

Render the `/tasks/new` page in this order:

1. Slice A `PageHeader`: eyebrow **Tasks**, title **New task**, and one sentence explaining that the
   task starts an agent in the chosen execution context.
2. Page-level stale/workspace/action error, when present.
3. One `form`-like composer surface containing:
   1. prompt;
   2. execution context;
   3. optional reusable workflow;
   4. selected workflow parameters;
   5. preflight summary;
   6. primary action and shortcut.

The composer remains a client-side action surface. Because the CSP uses `form-action 'none'`, use
`type="button"` and the existing explicit queue callback rather than relying on native form
submission.

## 1. Prompt

- Add a persistent visible label: **What should the agent do?**
- Keep a multiline textarea and `Ctrl/⌘ + Enter` submission.
- Use helper text, not placeholder-only instruction:
  **Include the outcome you want, relevant files or issue, and checks the agent should run.**
- Use a short placeholder example:
  **Example: Fix issue #123, update the affected tests, and run the relevant checks.**
- Do not prefill the draft with the example.
- Preserve whitespace inside the submitted command; trim only to decide whether it is empty.
- Do not run character-count animation. If the server command limit is surfaced, show it as quiet
  text only near the limit.

## 2. Execution context

Group repository and executor under a visible **Execution context** heading. Each control has a
label, current value, and short consequence.

### Repository

- Label: **Repository**.
- Null option: **No repository**.
- Selected option: `owner/name`.
- Helper for null: **Run without a repository checkout.**
- Helper for a selection: describe that the task uses the member's checkout for that repository.
- Keep first-selected-repository defaulting and the existing touched/clamp behavior.
- A repository which disappears still clamps to the first available repository.
- Changing repository clears workflow and workflow parameter state before reporting the new
  workflow query context.
- When the member has no selected repositories, keep **No repository** usable and add a nearby link:
  **Select repositories in Settings to run against a codebase** → `/settings/repositories`.
  This is remediation, not a false queueing blocker.
- Do not infer that `workspace.root === null` is an error; that is a supported deployment mode.

### Executor

- Label: **Executor**.
- Null option: **Default executor**.
- Named options remain the configured executor names.
- Helper for null: **Use the deployment's default runner.**
- Keep first-configured-executor defaulting and touched/clamp behavior.
- When no named executors exist, keep **Default executor** valid. Do not manufacture an incomplete
  setup state.

Use the existing Headless UI `Listbox` pattern. A closed control must expose its label and selected
value to assistive technology; options remain keyboard navigable and type-selectable.

## 3. Reusable workflow

- Heading: **Reusable workflow**.
- Explain once: **A workflow can turn this request into a repeatable multi-step process.**
- Null option: **No workflow — run prompt as written**.
- A selected option uses the workflow's human name.
- Do not expose scope (`org`, `user`, `repo`) as if the member must choose among duplicates.
  `effectiveWorkflows` still collapses to the repo-over-user-over-org winner per name.
- Do not auto-select a workflow.
- If the board serves no workflow choices, omit the selector and state in the preflight sentence
  that the prompt runs as written.
- If a selected workflow disappears after refresh, clamp to no workflow and clear its values.

## 4. Workflow parameter guidance

Extend the workflow parameter definition with optional author-provided guidance:

```ts
interface WorkflowParam {
    name: string;
    pattern?: string;
    description?: string; // plain-language instruction, max 160 characters
    example?: string;     // valid example value, max 120 characters
}
```

The two new strings are display metadata only. They do not participate in interpolation or
validation.

Rendering rules:

- Group inputs below the selected workflow under **Workflow details**.
- Turn the identifier into a readable fallback label (`issue-number` → **Issue number**) when no
  richer field label exists.
- Render `description` as helper text.
- Render `example` as **Example: …** and optionally as the input placeholder.
- Every input remains required and capped at 512 characters.
- Do not render the raw regex in the input title, main helper, inline error, or action blocker.
- When `pattern` exists, render a per-field `details` disclosure:
  **Format details** → `Must match: <pattern>`.
- Use a unique helper/error id per parameter. Do not point several fields at one duplicated id.
- Untouched empty fields communicate **Required** but are not painted as failed.
- After blur, after an attempted keyboard submission, or while correcting a touched field, render
  the appropriate plain-language error.

Validation copy:

| Condition | Member-facing copy |
| --- | --- |
| Empty | **<Label> is required.** |
| More than 512 characters | **<Label> must be 512 characters or fewer.** |
| Pattern mismatch with description/example | Reuse the author guidance, for example **Enter an issue reference such as #123 or a full GitHub issue URL.** |
| Pattern mismatch without guidance | **<Label> does not match the required format. Open Format details for the technical rule.** |
| Client cannot compile a stored rule | **This workflow's format rule could not be checked. Ask an administrator to fix the workflow.** |

The seeded `fix-issue` parameter must declare guidance matching its actual accepted pattern:

- description: **Enter an issue reference such as #123 or a full GitHub issue URL.**
- example: **#123**

Keep `paramValueMatches` aligned with `checkWorkflowParams`. The server remains authoritative and
still returns `400 BAD_WORKFLOW_PARAMS` for missing, extra, over-length, or non-matching values.

## 5. Preflight summary

Render one live sentence after the controls and before the action. It must be readable text, not a
disabled control or a row of badges.

Required examples:

- **Will run in bellows.ai using Main executor, with the Fix issue workflow.**
- **Will run in bellows.ai using the default executor. Your prompt will run as written.**
- **Will run without a repository using the default executor. Your prompt will run as written.**

Rules:

- Use the actual selected repository and executor label.
- A selected workflow sentence says that workflow will guide the task.
- No workflow explicitly says the prompt runs as written.
- Do not imply that workflow interpolation has already occurred.
- Update the sentence immediately after a selection changes.
- Expose the sentence through ordinary text; do not make every change an assertive live
  announcement.

## 6. Start action and composer states

- Rename **Send** to **Start task**.
- While queueing, label it **Starting…** and keep it disabled.
- Display `Ctrl/⌘ + Enter` beside the button with semantic `kbd` elements.
- The shortcut and click must call the same guarded function.
- Do not assign a browser `accesskey`.
- Keep the button disabled when the prompt is empty, a request is in flight, or selected workflow
  parameters are invalid.
- Always pair a disabled action with a visible reason:

| State | Visible reason |
| --- | --- |
| Empty prompt | **Describe the task to continue.** |
| Invalid workflow fields | **Complete the required workflow details to continue.** |
| Sending | **Starting the task…** |
| Ready | No blocker sentence |

- Keyboard submission with invalid fields marks them touched and moves focus to the first invalid
  field. It must not issue a request.
- A refused queue keeps prompt, context, workflow, and parameters intact and places the server
  error near the action with `role="alert"`.
- A successful queue clears no visible state before navigation lands.
- Loading the workspace keeps the existing honest loading and Retry states; it does not render
  placeholder selectors.

## Target task-detail structure

Render `/tasks/:id` in this order:

1. `TaskHeader` with stable task title, present-tense state, wall clock/activity, and state-based
   actions.
2. Action/thread error region.
3. `task-layout`:
   - outcome summary;
   - conversation.

At wide widths, CSS places the conversation in the main column and outcome summary in the narrower
right column. Keep the outcome summary first in DOM order so narrow layouts can place it above the
conversation without duplicating content.

## 7. Page header and action hierarchy

The header keeps:

- eyebrow **Tasks**;
- the root command's trimmed first line as the one page `h1`;
- newest-run status in text;
- task wall clock, using the existing measured-null semantics;
- current activity only while the newest run is running.

Do not put run logs, check counts, repository, executor, workflow, or publication into the page
title.

Action matrix:

| Newest thread state | Visible action | Treatment |
| --- | --- | --- |
| `queued` | **Stop run** | Destructive secondary action |
| `running`, no cancel request | **Stop run** | Destructive secondary action |
| `running`, cancel requested | **Stopping…** | Non-interactive pending status |
| `standby` | **Stop run** | Destructive secondary action |
| Terminal and `doneAt === null` | **Mark done** | One primary action |
| `doneAt !== null` | **Done by <login>** or **Marked done** | Status text, no disabled button |

Notes:

- Use `!isTerminal(status)` for stoppable presentation, not only `status === 'running'`. The board
  explicitly accepts queued and standby stops.
- Keep one in-flight guard per mutation.
- Labels become **Stopping…** and **Marking done…** while the request itself is pending.
- A state which changes under another member may still produce a server refusal; show it in the
  action error region and let the next poll repaint the controls.
- Follow-up remains attached to the conversation and is not promoted into the page header.

## 8. Destructive overflow and remove confirmation

Move **Remove task** out of the primary action row.

- Add a Headless UI `Menu` trigger named **More task actions**.
- Render the trigger only when at least one menu action is available.
- Put **Remove task** in a visually destructive group.
- Hide Remove while any thread row is `running`. The server remains authoritative and may still
  return `409 TASK_RUNNING` after a race.
- The menu button is not the primary action and does not use the primary fill.
- Closing the menu returns focus to its trigger.

Selecting Remove opens a Headless UI `Dialog`. Remove `window.confirm` completely.

Dialog requirements:

- Title: **Remove “<first line of root command>”?**
- Body:
  **This permanently deletes all <n> runs and their transcript from Factory. Its worktree will be
  queued for deletion. Published branches and pull requests are not deleted. This cannot be
  undone.**
- The run count is the actual thread length.
- Buttons: **Cancel** and destructive **Remove task**.
- Initial focus goes to **Cancel**.
- Escape and backdrop close the dialog before submission.
- While removal is in flight, label the destructive button **Removing…**, disable both actions,
  and do not allow backdrop/Escape dismissal.
- A removal failure stays inside the open dialog with `role="alert"`; the page remains usable.
- A successful removal closes by navigating to `/tasks`.
- Restoring focus after Cancel targets **More task actions**.

Do not ask the member to type the title. The named consequence, safe initial focus, and explicit
irreversibility are sufficient for this action.

## 9. Outcome summary

Replace `TaskSide` with `TaskOutcome`. It is the task's present-tense, thread-level summary, not a
second run transcript.

Use a native `details` disclosure, expanded by default, with summary text **Outcome summary** and
the current textual status. At narrow widths it sits above the conversation and can be collapsed.
At wide widths it occupies the right column and retains the same single DOM instance.

Group only meaningful facts:

### Result

- Status, always.
- Closure attribution when `doneAt` exists: actor when known, otherwise **Marked done**.
- Root author as **Started by**, using avatar/name/login rules already implemented.
- Task wall clock, including the newest live segment.
- Exit code for the newest terminal run when known.

### Execution

- Repository when non-null.
- Worktree path when non-null.
- Executor: named value or **Default executor**.
- Frozen workflow name when non-null.
- Current workflow node when non-null.
- Context: newest closed turn's measured token count.
- Cost: sum of positive measured turn costs.

### Verification

- Render only when the newest run reports gates.
- Show passed, failed, and running counts with text, not color alone.
- Link or button text **View checks in run <n>** moves focus to that run's verification section;
  do not duplicate raw gate output in the outcome summary.

### Published work

- Render only when an anchored publication line exists in the thread.
- Branch is code-styled text.
- A safe URL is linked as the bare PR number **#<n>** — the row's label already says *Pull
  request*; never a CTA verbatim (**Open pull request**) and never a raw URL as link text.
- If a branch exists without a URL, show only the branch. Do not render **PR state —**.
- When an issue reference can be derived and the task has a repository, link the constructed
  safe URL as the bare number **#<n>**. Otherwise render the issue number as text.

### Services

- Preserve the newest attempt's reported services only when present.
- Label them as the attempt's last reported states, not as a claim that containers still run.
- Keep this group secondary and collapsible if it contains more than three services.

Omission rules:

- Omit absent repository, worktree, workflow, node, context, cost, checks, publication, issue, and
  services rows.
- Keep a wall-clock em dash when the labeled measurement has not begun; this is the existing
  honest measurement convention.
- Never print `undefined`, `null`, `NaN`, `0 tok` for absent context, or `$0.0000` for absent cost.

## 10. Conversation hierarchy

Render a visible **Conversation** heading followed by one article per run, oldest-first.

Every run article uses this order:

1. **Request** for the root or **Follow-up** for later rows.
2. **Agent response** or present-tense **Agent activity**.
3. **Checks and published work**, when either exists.
4. A quiet metadata footer.

The request:

- renders the full command as normal prose;
- preserves line breaks;
- does not use monospace simply because it is agent input;
- never executes Markdown or HTML.

The first run and follow-ups use the same structure. Their labels communicate position without
turning every row into a separate task.

## 11. Agent response and raw output

Use the job's close-time `summary` as the primary terminal response.

| Run state/data | Required rendering |
| --- | --- |
| Running with activity | **Agent activity** plus the current activity sentence |
| Running with output | Visible bounded live-output `pre` which follows the tail |
| Queued/running without output | **Waiting for the executor…** |
| Terminal with summary | Flowing summary text at reading width |
| Terminal with summary and output | Summary first; collapsed **View raw output** disclosure |
| Terminal without summary but with output | **No agent summary was captured.** plus expanded raw output |
| Terminal without summary or output | **This run finished without a captured agent response. Check its exit status and checks below.** |

Rules:

- Summary is plain text and normal body typography.
- Raw output stays monospace in a bounded scroll well.
- An overflowing `pre` is keyboard focusable and has an accessible label naming the run.
- Preserve live auto-scroll only for the newest non-terminal run.
- Opening or reading terminal raw output never auto-scrolls.
- Do not parse the summary out of output; use the stored `summary` field.
- Do not treat `status === 'succeeded'` as proof that output or checks exist.

## 12. Checks and publication inside a run

Keep check status and output attached to the run which produced them.

- Label the section **Checks and published work** when both are present, **Checks** or
  **Published work** when only one is present.
- The check summary names passed, failed, and running counts.
- Each gate row names the gate, textual status, and exit code when measured.
- Gate output remains in a nested native disclosure and text-only `pre`.
- Do not render a gate-output disclosure when output is null.
- Give the section a stable id so the outcome summary can focus it.

Extract a per-run publication parser from the current thread parser:

- `publicationForRun(job)` parses only that row's anchored driver line.
- `threadPublish(jobs)` scans newest-first using the same helper.
- Both reject mid-line lookalikes.
- Both carry a branch and optional URL.
- Both link only safe HTTP(S) URLs.
- A run's publication line has no label of its own, so its link reads **Pull request #<n>** —
  informative, never a CTA.

Do not strip the driver's publication line out of raw output. The structured presentation is a
convenience over the same stored evidence, not a mutation of the audit record.

## 13. Quiet run metadata

Move metadata after the response and verification in a semantic footer or description list.

Include only applicable values:

- textual run status;
- created time, with exact timestamp available;
- executor;
- frozen workflow name and workflow node;
- run duration;
- exit code;
- context tokens and positive cost for that turn;
- stopped-by / stop-requested-by attribution;
- done-by attribution;
- parked marker for standby.

Use monospace only for identifiers, code-like workflow nodes, timestamps where appropriate, and
numeric machine output. Status and normal attribution remain body text.

Do not suppress the newest run's metadata solely because the outcome summary exists. The summary is
thread-level; the footer is the audit record for that run.

## 14. Follow-up composer

Keep the follow-up composer after the final run inside the conversation surface.

- Visible label: **Ask for a follow-up**.
- Helper: **The agent continues the same task, checkout, executor, and session.**
- Placeholder: **Describe the adjustment…**
- Primary label: **Send follow-up**.
- Pending label: **Sending…**.
- Display `Ctrl/⌘ + Enter` beside the action.
- The shortcut and button use one guarded callback.
- A failed send preserves the draft and renders the error beside this composer.
- A successful send clears the draft only after the board accepts it, refreshes the same thread,
  and keeps the route unchanged.

When the newest open terminal run has no session, preserve the existing explanation and link to
**Start a new task** at `/tasks/new`.

When the task is closed, omit the composer. Closure attribution in the header/outcome explains why
there is no next action.

## Data-contract work required by the UI

## 15. Workflow parameter presentation metadata

Update the closed workflow grammar to accept only `description` and `example` in addition to
`name` and `pattern`.

Validation:

- each is optional;
- if present, it must be a trimmed, non-empty string;
- `description` is at most 160 characters;
- `example` is at most 120 characters;
- unknown keys remain `UNKNOWN_KEY`;
- guidance does not weaken pattern or parameter-value validation;
- normalized definitions store the trimmed strings;
- list and detail workflow routes return the normalized fields.

The workflow definition size cap remains 16 KiB. Do not add a separate table or columns for this
metadata; it belongs to the frozen JSON definition.

Update `docs/workflows.md` and `docs/api.md` in the same PR. Examples must show product guidance,
not imply that clients can infer copy from regex source.

## 16. Frozen task workflow name

The task detail cannot currently show a workflow name honestly:

- `workflowNode` is a graph position, not the workflow name;
- joining `job.workflow_id` to the live workflow row would change or erase old task history when a
  workflow is renamed or deleted;
- the current snapshot contains the definition, not the row's name.

Add a frozen job audit field.

### Migration

Add `server/migrations/033_job_workflow_name.sql`, or the next available number if 033 has been
claimed before implementation:

- add nullable `job.workflow_name text`;
- constrain non-null values to 1–100 characters, matching the workflow name boundary;
- backfill rows whose `workflow_id` still resolves to a workflow row;
- propagate the root's recovered name to every row in its thread where possible;
- leave null when the historical name cannot be recovered;
- do not add a foreign key or live lookup.

### Writes

- Add `name` to the resolved workflow object passed from `routes/jobs.ts` to
  `JobStore.create`.
- Stamp `workflow_name` on the root create.
- Carry it into graph successor rows.
- Carry it into user follow-up rows.
- Never accept it from the client request body.
- Deleting or renaming a workflow must not change an existing task's name.

### Reads

- Add `workflowName: string | null` to the server job row/response and web `Job` type.
- Include it in thread reads and any shared mapper used by list reads.
- Keep null on workflow-less and unrecoverable historical rows.
- Do not expose a compatibility alias.

Document the field and freeze semantics in `docs/jobs.md`, `docs/workflows.md`, and `docs/api.md`.

## Implementation instructions by file

### Workflow schema and route

#### `server/src/db/workflow-schema.ts`

- Extend `WorkflowParam` with `description` and `example`.
- Add named length constants for both fields.
- Permit only the four known parameter keys.
- Validate, trim, and normalize optional guidance.
- Keep `checkWorkflowParams` concerned only with names, values, length, and pattern.
- Preserve `DEFINITION_LIMIT` and safe-regex validation.

#### `server/src/db/workflow-templates.ts`

- Add the issue guidance and example specified above to `ISSUE_PARAM`.
- Do not change the accepted issue-reference pattern.

#### `server/src/routes/workflows.ts` and `server/src/db/workflow-store.ts`

- Return normalized parameter guidance through existing workflow summaries.
- Do not add a second composer-only endpoint.
- Keep permission, scope, and effective-resolution behavior unchanged.

#### `server/test/routes.workflows.test.ts` and workflow-schema coverage

- Cover accepted guidance, normalization, limits, blank guidance, and unknown keys.
- Assert list responses contain guidance.
- Assert patterns and guidance remain separate fields.
- Keep malformed-pattern and definition-size cases green.

### Frozen workflow name

#### `server/migrations/033_job_workflow_name.sql`

- Implement the nullable audit column, constraint, and best-effort backfill.
- Follow `docs/persistence.md` migration rules.
- Do not modify `027_workflows.sql` in place.

#### `server/src/db/job-store.ts`

- Extend the resolved workflow create input with `name`.
- Stamp and propagate `workflow_name` through create, workflow transitions, and follow-ups.
- Add the field to the job-row mapper and thread/list selects which return `Job`.
- Keep the task-summary endpoint unchanged unless its existing mapper requires the new field.
- Do not join live workflow rows on reads.

#### `server/src/routes/jobs.ts`

- Pass the resolved record's name to `JobStore.create`.
- Serialize `workflowName` on job reads.
- Do not accept `workflowName` in `POST /api/jobs`.

#### `server/test/routes.jobs.test.ts`

- Assert the route passes the resolved name into the store.
- Assert client-supplied names are ignored/refused under the existing closed body contract.
- Assert workflow-less creates carry null.
- Assert thread response serialization uses `workflowName`.

#### `server/test-db/job-store.workflow.test.ts`

- Assert root create stamps the name.
- Assert graph successors and user follow-ups inherit it.
- Rename/delete the workflow record and assert the task thread keeps its frozen name.
- Keep snapshot and launch-parameter freeze tests green.

### Web task model and pure derivations

#### `web/src/api/useWorkflows.ts`

- Add `description` and `example` to `WorkflowChoice.params`.
- Do not change polling, 401, abort, or repo-context behavior.

#### `web/src/api/useJobs.ts`

- Add `workflowName` to `Job`.
- Keep `isTerminal` and every polling rule unchanged.

#### `web/src/task-composer.ts` (new pure helper)

Move or add pure logic for:

- effective workflow collapse;
- repository/workflow draft reset and clamp;
- parameter validation result
  (`empty | too-long | mismatch | invalid-rule | valid`);
- parameter label fallback;
- preflight sentence generation;
- action-blocker generation.

Keep the helpers DOM-free and deterministic so the offline suite can cover the state matrix without
mounting Headless UI.

Delete the superseded helper exports from `TaskComposer.tsx` and update all callers/tests in the
same change.

#### `web/src/task-outcome.ts` (new pure helper)

Move thread derivations out of the deleted `TaskSide.tsx`:

- thread context;
- thread cost;
- issue reference;
- `publicationForRun`;
- `threadPublish`;
- gate counts;
- closure label.

Keep URL safety explicit. Return data, not React nodes.

### Composer components

#### `web/src/panels/TaskComposer.tsx`

- Recompose the surface in sections 1–6.
- Keep selection ownership, touched/clamp behavior, and queue callback semantics.
- Render a visible prompt label, grouped execution context, workflow section, preflight sentence,
  blocker sentence, and Start action.
- Use the pure validation result rather than assembling regex copy in JSX.
- Remove bare `none` labels, `title="must match ..."`, the shared
  `composer-param-error` id, and **Send**.
- Preserve the workspace loading/error/Retry branch.

#### `web/src/components/WorkflowParameterFields.tsx` (new)

- Render the selected workflow's grouped fields.
- Own per-field touched state only; values stay owned by `TaskComposer`.
- Use unique ids derived from the workflow id and parameter name.
- Connect label, description, example, format disclosure, and error with
  `aria-describedby`.
- Expose an imperative or callback-based “reveal/focus first invalid field” path for invalid
  keyboard submission without moving queue ownership into the component.

#### `web/src/pages/TaskComposerPage.tsx`

- Keep fetching and queueing here.
- Render at Slice A's `/tasks/new` route.
- Pass workspace root/repository availability only as needed for truthful helper/remediation copy.
- Preserve draft state on a failed queue.
- Navigate to `/tasks/:id` only after a successful `201`.

### Task-detail components

#### `web/src/panels/TaskHeader.tsx`

- Apply the state/action matrix in section 7.
- Rename **Stop** to **Stop run** and **Done** to **Mark done**.
- Render closure attribution as status text.
- Add the Headless UI overflow menu trigger and hand Remove selection back to the page.
- Keep title, wall-clock, and activity derivations.

#### `web/src/components/TaskRemoveDialog.tsx` (new)

- Implement the dialog in section 8.
- Accept title, run count, open/removing/error state, and callbacks.
- Do not fetch, mutate, or navigate.
- Use existing dialog primitives/classes before adding task-specific ones.

#### `web/src/panels/TaskOutcome.tsx` (new)

- Replace `TaskSide.tsx`.
- Render the grouped, omission-driven outcome summary in section 9.
- Use pure data derivations from `task-outcome.ts`.
- Keep one DOM instance inside an expanded-by-default native disclosure.
- Delete `TaskSide.tsx` after its callers and tests move.

#### `web/src/panels/TaskRun.tsx` (new)

- Render one run using sections 10–13.
- Keep checks, raw output, runtime vitals, publication, and metadata attached to that run.
- Receive whether it is the newest run and the output ref needed for live-tail behavior.
- Do not own polling or mutations.

#### `web/src/panels/TaskDetail.tsx`

- Become the thread layout and follow-up-composer coordinator.
- Render `TaskOutcome` first in DOM, then the conversation panel.
- Keep newest-run derivation, follow-up availability, and live-output auto-scroll.
- Delegate each article to `TaskRun`.
- Use **Send follow-up** and the section 14 copy.
- Keep loading, thread error, sessionless, open, and closed states honest.

#### `web/src/pages/TaskDetailPage.tsx`

- Continue to own `useThread` and mutation guards.
- Replace `window.confirm` with dialog state.
- Open the dialog from the header menu; call `tasks.remove` only after confirmation.
- Keep failure in the open dialog; navigate on success.
- Reset action/dialog errors and in-flight marks when the route id changes.
- Keep stop/done refresh behavior.

### Styling and design-system documentation

#### `web/src/styles.css`

Add or revise documented primitives for:

- guided composer sections, labels, help, preflight, blocker, and shortcut;
- workflow-parameter field, error, and format disclosure;
- task action menu and destructive menu item;
- remove dialog content;
- outcome disclosure and grouped key/value presentation;
- conversation, request, agent response, verification/publish, raw output, and metadata footer;
- narrow-layout ordering and wide two-column layout.

Constraints:

- use existing tokens only;
- no color literal outside token blocks;
- status and destructive meaning never rely on color alone;
- body prose remains at least the design-system body size;
- raw output is bounded within its own well and cannot cause page-level horizontal overflow;
- do not create another general panel/button/pill primitive under a task-specific name.

#### `docs/design-system.md`

- Document every new or renamed class.
- Add `WorkflowParameterFields.tsx` and `TaskRemoveDialog.tsx` to Components.
- Replace the `TaskSide.tsx` inventory row with `TaskOutcome.tsx`.
- Add `TaskRun.tsx` and update `TaskComposer.tsx`, `TaskDetail.tsx`, and `TaskHeader.tsx` rows.
- Document the task conversation and outcome primitives.
- Remove deleted class/file inventory entries in the same PR.

### Product/API documentation

#### `docs/jobs.md`

- Document frozen `workflow_name` and propagation through transitions/follow-ups.
- Describe the new presentation without changing stop/done/remove semantics.
- Keep the Remove consequence explicit: local Factory rows are deleted, worktree reclaim is queued,
  remote published work is not deleted.

#### `docs/workflows.md`

- Add parameter `description`/`example` grammar and limits.
- Update the base `fix-issue` example.
- Document that a task freezes both the workflow definition and display name.

#### `docs/api.md`

- Add workflow parameter guidance to workflow response examples.
- Add `workflowName` to job/thread responses.
- Keep request bodies unchanged except that workflow-definition writes accept the two declared
  parameter keys.

## Accessibility requirements

- Exactly one page `h1` remains in `PageHeader`.
- Prompt, every Listbox, every workflow parameter, and follow-up textarea have visible labels.
- Helper and error relationships use unique ids.
- Untouched fields are not announced as errors.
- Invalid keyboard submission focuses the first invalid field.
- `Ctrl/⌘ + Enter` never bypasses validation.
- Menu, dialog, Listbox, and disclosure controls work by keyboard without custom key traps.
- The Remove dialog traps focus, uses a labelled title/description, focuses Cancel initially, and
  restores focus on close.
- Async action failures use `role="alert"`; routine field guidance uses polite status.
- Status, gate result, stopping, closure, and destructive meaning include text in addition to
  color.
- Links are informative references, not commands: **Pull request #123** on a label-less line,
  the bare **#123** under a labeled row — never bare URLs, never **Open …** verbatims.
- External links use a new tab only with an explicit accessible label and safe `rel`.
- Raw-output and gate-output wells are keyboard scrollable.
- Native `details` summaries have clear labels and visible focus.
- Heading order remains logical inside Conversation and Outcome summary.
- Do not add `aria-live` to the entire transcript, output tail, or preflight sentence.
- Honor Slice A/Slice E reduced-motion rules; do not introduce new motion in this slice.

## Responsive acceptance matrix

| Width | Required behavior |
| --- | --- |
| 360px | Composer sections stack; Listboxes and parameter fields use the available width; summary and Start action remain visible without horizontal scrolling; Outcome summary appears above Conversation as a disclosure; action menu/dialog fit the viewport; raw output scrolls inside its well. |
| 768px | Composer may use a two-column execution-context row only when labels/help do not compress; workflow details remain readable; task detail remains one column with Outcome above Conversation. |
| 1024px | Task detail becomes a two-column layout with Conversation dominant and Outcome bounded; header actions wrap without colliding with title/meta. |
| 1440px | Reading width remains bounded; outcome does not become a large empty card; long prompts/summaries wrap and logs retain their own scroll. |

At every width:

- no page-level horizontal overflow;
- no fixed control width clips translated/long repository names;
- the primary action and its blocker are visible together;
- the destructive menu remains reachable;
- opening a dialog does not shift content outside the viewport.

## Test plan

### Server unit/route tests

Update and run:

- `server/test/routes.workflows.test.ts`;
- workflow-schema cases currently colocated with workflow engine/store tests;
- `server/test/routes.jobs.test.ts`.

Cover:

- accepted and normalized parameter guidance;
- blank, over-limit, and unknown guidance keys;
- guidance returned by workflow list/detail routes;
- queue route passing the resolved workflow name to the store;
- `workflowName` thread serialization;
- no client authority over the frozen name;
- workflow-less null behavior.

### Database tests

Update `server/test-db/job-store.workflow.test.ts`:

- root workflow name stamp;
- transition inheritance;
- follow-up inheritance;
- rename/delete immunity;
- null behavior for workflow-less tasks.

If shared fixtures or row assertions enumerate columns, update them deliberately rather than adding
an optional compatibility path.

### Web pure/render tests

Update `web/test/tasks.render.test.tsx` and split focused suites if the file becomes harder to
navigate.

#### Composer

- explicit No repository / Default executor / No workflow labels;
- visible prompt label/helper/example;
- preflight sentences for all null/selected combinations;
- Start task and Starting labels;
- visible blocker for empty prompt and invalid parameters;
- parameter validation result for empty, too long, mismatch, invalid regex, and valid;
- guidance copy visible while regex source is absent from normal text/title;
- regex source appears only inside **Format details**;
- unique `aria-describedby` ids for two invalid fields;
- repository/workflow reset semantics remain pinned;
- refused queue preserves the draft.

#### Header/actions/dialog

- state table covers queued, running, stopping, standby, each terminal status, and closed;
- queued/standby expose Stop run;
- only open terminal tasks expose Mark done;
- closed task renders attribution, not a disabled action;
- Remove is absent from the primary action row;
- dialog copy names the task, run count, local deletion, queued worktree deletion, remote-work
  survival, and irreversibility;
- removal failure remains visible.

#### Conversation

- summary precedes raw output;
- terminal summary/output truth table in section 11;
- no-output implication copy is exact;
- prompts and summaries render as text;
- newest live output retains its ref/auto-scroll path;
- root/follow-up labels and order;
- checks remain attached to their run;
- per-run publication rejects mid-line lookalikes and unsafe URLs;
- metadata follows response/verification in markup order.

#### Outcome

- status/result always render;
- repository/worktree/workflow/context/cost/checks/publication/services omit when absent;
- null executor renders Default executor;
- task wall clock keeps dash/zero semantics;
- context uses newest closed turn;
- cost sums positive turn values once;
- workflow name is not confused with workflow node;
- branch and labeled PR link render without fabricated PR state;
- issue link is created only with a valid repository and issue number.

#### Design system

- Update `web/test/styles.test.ts` inventory expectations.
- Keep no-color-literal, every-token-used, and every-class-documented gates green.

### Browser and visual verification

Update `e2e/composer.spec.ts` for Slice A's `/tasks/new` route:

- prompt → execution context → workflow → parameters → preflight → Start order;
- human issue guidance and hidden-by-default regex details;
- no-workflow prompt-as-written state;
- settings remediation when no repositories are selected;
- click and `Ctrl/⌘ + Enter` paths;
- 360px and 1440px screenshots.

Add `e2e/task-detail.spec.ts`:

- seeded successful task with summary, raw output, checks, publication, and outcome summary;
- successful task with no captured summary/output;
- multi-run conversation and follow-up composer;
- running task with live activity/output and Stop run;
- terminal-open task with Mark done;
- closed task with attribution and no composer;
- Remove menu → dialog → Cancel/Escape focus restoration;
- removal refusal stays in dialog;
- no horizontal overflow at 360px, 768px, 1024px, and 1440px.

Use the seeded disposable database for durable states and Playwright request interception for
transient/racy states. Do not add a production-only test route.

Review every generated screenshot. DOM assertions prove semantics, not hierarchy, density, clipping,
or scroll behavior.

## Acceptance criteria

### Guided composer

- [ ] Prompt has a visible label, useful helper, and non-prefilled example.
- [ ] Repository, executor, and workflow are separate labelled decisions.
- [ ] Null choices read No repository, Default executor, and No workflow — run prompt as written.
- [ ] Workflow parameters have author-provided human guidance where supplied.
- [ ] Raw patterns appear only inside Format details.
- [ ] Preflight copy says where/how the task will run and whether the prompt is transformed.
- [ ] Start task and its keyboard shortcut share one guarded path.
- [ ] Every disabled Start state has a visible reason.
- [ ] No-repository tasks remain supported; repository settings remediation does not falsely block.
- [ ] A user can state repository, executor, workflow, and prompt behavior before starting.

### Trustworthy work record

- [ ] Every run reads request → response/activity → checks/published work → metadata.
- [ ] Stored agent summary is the primary terminal response.
- [ ] Raw output remains available as text in a bounded well.
- [ ] A run with no captured response explains the implication in plain language.
- [ ] Checks and publication remain attached to the run that produced them.
- [ ] Follow-ups remain one conversation and use Send follow-up.
- [ ] No Markdown/HTML from agent-controlled fields is executed.

### Outcome summary

- [ ] Status, repository/worktree, executor/workflow, context/cost, duration, checks, and published
      work render only under the specified truth/omission rules.
- [ ] Frozen workflow name survives workflow rename/delete and is distinct from node.
- [ ] PR links are labelled and safe; no PR state is fabricated.
- [ ] Services are clearly last-reported attempt state.
- [ ] Narrow layouts place one collapsible Outcome summary above Conversation.

### Actions and destructive flow

- [ ] Queued, running, and standby tasks offer Stop run as a destructive secondary action.
- [ ] Terminal open tasks offer Mark done as the one primary action.
- [ ] Closed tasks show closure attribution instead of a disabled button.
- [ ] Remove task lives in an overflow danger area.
- [ ] No `window.confirm` remains.
- [ ] The confirmation dialog names the task and exact local/remote consequences.
- [ ] Cancel/Escape restore focus; failed removal stays in the dialog; success returns to `/tasks`.

### Responsive/accessibility/quality

- [ ] No page-level overflow at 360px, 768px, 1024px, or 1440px.
- [ ] Labels, errors, menu, dialog, disclosures, output wells, and shortcuts work by keyboard.
- [ ] Status and destructive meaning do not rely on color.
- [ ] Task polling and all lifecycle semantics remain unchanged.
- [ ] New fields/classes/files are documented and old TaskSide artifacts are removed.
- [ ] Unit, database, typecheck, lint, build, and browser verification pass.

## Verification commands

Run the cheapest checks first:

```bash
npx vitest run server/test/routes.workflows.test.ts server/test/routes.jobs.test.ts web/test/tasks.render.test.tsx web/test/tasks.wiring.test.tsx web/test/styles.test.ts
npm run typecheck
npm run lint
npm test
npm run build
```

Then run the database contract against a disposable `*_test` database:

```bash
docker compose up -d timescale
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test npm run test:db
```

Finally run the real browser suite and inspect the task screenshots:

```bash
npm run verify:ui
```

## Suggested PR sequence

This is one delivery slice, but review and rollback are safer as four ordered PRs.

### PR 1 — Honest workflow presentation data

- Workflow parameter description/example grammar, template, routes, tests, and docs.
- Frozen workflow-name migration, create/transition/follow-up propagation, reads, tests, and docs.
- Web response types only; no partial UI which guesses from the new fields.

### PR 2 — Guided composer

- Pure composer validation/preflight helpers.
- Guided TaskComposer and WorkflowParameterFields.
- Plain-language validation, Start task, shortcut, remediation, responsive styles.
- Composer unit/render/browser coverage and design-system inventory.

### PR 3 — Conversation and outcome

- Pure task-outcome derivations.
- TaskRun hierarchy and stored summary rendering.
- TaskOutcome replacement for TaskSide.
- Follow-up composer copy, publication/check presentation, responsive detail layout.
- Unit/render/browser states and documentation.

### PR 4 — State actions, destructive dialog, and visual matrix

- TaskHeader action matrix and closure attribution.
- Overflow danger menu and TaskRemoveDialog.
- Dialog mutation/focus/error wiring.
- Full width matrix, screenshots, style inventory cleanup, and final regression pass.

Do not merge a PR which exposes workflow guidance fields without validation/docs, displays a live
workflow name as historical truth, duplicates old/new task detail, or leaves Remove available
through both `window.confirm` and the dialog.

## Definition of done

Slice C is done when a member can understand and start a task without decoding selector placeholders
or regexes, then review the same task as a trustworthy work record: what was asked, what the agent
reported, what checks ran, what was published, what execution context was used, and what human
action remains. Every displayed fact comes from a frozen or explicitly derived contract, destructive
removal is accessible and consequence-aware, the task remains one conversation across follow-ups,
and the complete state/width matrix is covered by tests and inspected browser screenshots.
