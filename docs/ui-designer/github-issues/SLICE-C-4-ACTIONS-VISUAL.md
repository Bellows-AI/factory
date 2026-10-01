Part **4 of 4** of Slice C — *Make task execution deliberate and auditable* (P1).
**Closes the slice.**

Full spec: `docs/ui-designer/ISSUE-SLICE-C-TASK-EXECUTION.md` — sections **7. Page header and action
hierarchy**, **8. Destructive overflow and remove confirmation**, **Accessibility requirements**,
**Responsive acceptance matrix**, complete **Test plan**, **Acceptance criteria**, and
**Definition of done**.

**Depends on:** #175, #176, and #177.

## Summary

Finish Slice C by making task actions state-specific, moving permanent deletion behind an
accessible overflow/dialog flow, and verifying the complete composer/detail experience across task
states and target widths.

This issue owns action hierarchy and integration quality. It must not reopen the composer,
conversation, or outcome information architecture established by 2/4 and 3/4.

## 1. State-based header actions

Apply this matrix to the newest run:

| State | Visible action | Treatment |
| --- | --- | --- |
| `queued` | **Stop run** | Destructive secondary |
| `running` without cancel request | **Stop run** | Destructive secondary |
| `running` with cancel request | **Stopping…** | Non-interactive pending status |
| `standby` | **Stop run** | Destructive secondary |
| Terminal + `doneAt === null` | **Mark done** | One primary action |
| `doneAt !== null` | **Done by <login>** or **Marked done** | Status text; no disabled action |

Requirements:

- Use `!isTerminal(status)` for stoppable presentation. The board accepts queued and standby stops.
- Keep one in-flight guard per mutation.
- While the request is in flight, use **Stopping…** / **Marking done…**.
- A stop request can take worker-heartbeat time to settle. Pending is not terminal.
- State races may still produce board refusals; show the refusal and let polling repaint.
- Follow-up remains in Conversation and is not a header action.
- Do not render an empty action wrapper.

## 2. Destructive overflow

Move **Remove task** out of the main action row.

- Add a Headless UI `Menu` trigger named **More task actions**.
- Render it only when an available overflow action exists.
- Put Remove task in a visually/textually destructive group.
- Hide Remove while any thread member is `running`.
- Keep the server's `409 TASK_RUNNING` refusal authoritative for races.
- Closing the menu restores focus to the trigger.
- Do not make the overflow trigger primary.

## 3. Accessible remove confirmation

Delete the `window.confirm` path.

Add `TaskRemoveDialog.tsx` as a presentational Headless UI `Dialog`.

Required content:

- title: **Remove “<first line of root command>”?**
- body:
  **This permanently deletes all <n> runs and their transcript from Factory. Its worktree will be
  queued for deletion. Published branches and pull requests are not deleted. This cannot be
  undone.**
- buttons: **Cancel** and destructive **Remove task**.

Behavior:

- actual thread length supplies `<n>`;
- initial focus is Cancel;
- Escape/backdrop close before submission;
- Cancel restores focus to More task actions;
- in flight: **Removing…**, both actions disabled, Escape/backdrop blocked;
- failure remains in the open dialog with `role="alert"`;
- success navigates to `/tasks`;
- route-id changes reset dialog/action state;
- no extra “type the task name” ceremony.

The copy must match the actual board contract: Factory rows are deleted immediately, worktree
reclamation is queued, and remote branches/PRs are not deleted.

## 4. Integration and visual matrix

Exercise the final Slice C experience, not only isolated components.

### Composer

- guided order remains prompt → context → workflow → details → preflight → Start;
- invalid shortcut focuses the first field;
- action/blocker remain together at 360px;
- remediation/settings link is reachable;
- no raw regex is visible until Format details opens.

### Task detail states

- queued;
- running with activity/output;
- stopping;
- standby;
- succeeded open;
- failed/dead/stopped open;
- closed with attribution;
- sessionless terminal;
- multi-run follow-up chain;
- successful result without captured response;
- checks and publication;
- removal refusal and success.

### Widths

- 360px;
- 768px;
- 1024px;
- 1440px.

At each width assert no page-level horizontal overflow. Visually inspect:

- title/action wrapping;
- Outcome-before-Conversation on narrow screens;
- dominant Conversation/bounded Outcome on wide screens;
- output wells and long prompt wrapping;
- menu anchoring;
- dialog fit and focus;
- primary/destructive hierarchy;
- status legibility without color dependence.

## Implementation map

- `web/src/panels/TaskHeader.tsx` — action matrix and menu trigger.
- `web/src/components/TaskRemoveDialog.tsx` — accessible confirmation.
- `web/src/pages/TaskDetailPage.tsx` — dialog state, remove mutation/error/navigation.
- `web/src/styles.css` — action/menu/dialog/responsive primitives using existing tokens.
- `docs/design-system.md` — class and component inventory.
- `docs/jobs.md` — only if action copy exposes an undocumented lifecycle fact.
- `web/test/tasks.render.test.tsx` — state matrix/copy.
- `web/test/styles.test.ts` — inventory gates.
- `e2e/task-detail.spec.ts` — menu/dialog/focus/state/width coverage.
- `e2e/composer.spec.ts` — final integrated width/keyboard assertions.

## Accessibility requirements

- Menu and Dialog use Headless UI semantics and keyboard behavior.
- Cancel receives initial focus.
- Cancel/Escape restore focus.
- Removing cannot be dismissed mid-request.
- Failures are announced once as alerts.
- Status and destructive meaning include text.
- Focus rings use the shared design-system primitive.
- No `aria-live` wraps the thread or live log.
- Raw/gate output remains keyboard scrollable.
- No duplicate page `h1` or broken heading order.

## Tests

### Unit/render

- full action matrix;
- in-flight labels/guards;
- closed attribution instead of a disabled button;
- Remove absent from main action row;
- dialog title/body/run count;
- failure remains visible;
- no `window.confirm` reference;
- no empty action wrappers;
- design-system inventory.

### Browser

- Stop run on queued/running/standby transient states;
- Mark done on open terminal task;
- closed attribution/no follow-up;
- menu keyboard open/close;
- dialog initial focus;
- Escape/Cancel and focus restoration;
- removal refusal;
- in-flight dismissal lock;
- successful removal route;
- four-width overflow and screenshots;
- no console/page/request failures.

## Acceptance criteria

- [ ] Queued, running, and standby tasks offer Stop run as destructive secondary.
- [ ] Terminal open tasks offer Mark done as the one primary action.
- [ ] Closed tasks show closure attribution, not a disabled control.
- [ ] Remove task exists only in the overflow danger path.
- [ ] No `window.confirm` remains.
- [ ] Dialog names the task, run count, local deletion, queued worktree deletion, remote-work
      survival, and irreversibility.
- [ ] Cancel/Escape and mutation failure preserve a usable page and correct focus.
- [ ] Successful removal navigates to the task inbox.
- [ ] Complete composer/detail state matrix works by keyboard.
- [ ] No page-level overflow at 360/768/1024/1440.
- [ ] New files/classes are documented and obsolete ones removed.
- [ ] Offline, database, typecheck, lint, build, and real-browser suites pass.
- [ ] Generated screenshots have been inspected, not merely produced.

## Verification

```bash
npx vitest run web/test/tasks.render.test.tsx web/test/tasks.wiring.test.tsx web/test/styles.test.ts
npm run typecheck
npm run lint
npm test
npm run build
docker compose up -d timescale
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test npm run test:db
npm run verify:ui
```

## Slice-level definition of done

A member can understand and start a task without decoding placeholders or regexes, then review it
as a trustworthy work record: what was asked, what the agent reported, what checks ran, what was
published, which execution context was used, and what human action remains. Every fact is frozen or
explicitly derived, removal is accessible and consequence-aware, follow-ups remain one
conversation, and the state/width matrix is covered by tests and inspected screenshots.
