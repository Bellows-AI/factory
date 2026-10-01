Part **2 of 4** of Slice C — *Make task execution deliberate and auditable* (P1).

Full spec: `docs/ui-designer/ISSUE-SLICE-C-TASK-EXECUTION.md` — sections **Target composer
structure**, **1–6**, **Workflow parameter guidance**, **Accessibility requirements**,
**Responsive acceptance matrix**, and **Test plan → Composer**.

**Depends on:** #175 and Slice A issue #158.

## Summary

Replace the current prompt-plus-selector strip with a guided task form. A member must be able to
understand what will run, where it will run, which reusable workflow will guide it, what still
blocks launch, and whether the prompt runs verbatim before pressing **Start task**.

This issue consumes the workflow parameter guidance added by Slice C 1/4. It does not infer
human-facing copy from raw regexes.

## Target structure

On `/tasks/new`, render:

1. Slice A `PageHeader`;
2. page/workspace/action error when present;
3. prompt;
4. execution context;
5. optional reusable workflow;
6. workflow details;
7. live preflight sentence;
8. Start action, shortcut, and explicit blocker.

Keep queueing and navigation in `TaskComposerPage`. Presentational components do not fetch.

## 1. Prompt

- Visible label: **What should the agent do?**
- Helper:
  **Include the outcome you want, relevant files or issue, and checks the agent should run.**
- Placeholder:
  **Example: Fix issue #123, update the affected tests, and run the relevant checks.**
- Do not prefill the example.
- Preserve command whitespace; trim only for the empty check.
- Keep `Ctrl/⌘ + Enter` and route it through the same guarded start function as the button.

## 2. Execution context

Group repository and executor under **Execution context**.

### Repository

- Null label: **No repository**.
- Null helper: **Run without a repository checkout.**
- Named value: `owner/name`.
- Preserve first-selected default, touched choice, and disappeared-option clamp.
- A repository change clears workflow choice and parameter values before the new workflow context
  is usable.
- When no repositories are selected, keep no-repository tasks valid and show:
  **Select repositories in Settings to run against a codebase** → `/settings/repositories`.
- Do not treat `workspace.root === null` as an error.

### Executor

- Null label: **Default executor**.
- Null helper: **Use the deployment's default runner.**
- Preserve first-configured default, touched choice, and disappeared-option clamp.
- No configured executor is not a blocker; null is a valid deployment default.

Keep the existing accessible Headless UI `Listbox` pattern.

## 3. Reusable workflow

- Heading: **Reusable workflow**.
- Help:
  **A workflow can turn this request into a repeatable multi-step process.**
- Null label: **No workflow — run prompt as written**.
- No automatic selection.
- Preserve effective repo > user > org collapse per name.
- Omit the selector when no workflow list is served.
- If a selected workflow disappears, reset to no workflow and clear its values.

## 4. Workflow details and validation

Add `WorkflowParameterFields.tsx` and group selected inputs under **Workflow details**.

- Humanize identifier labels as a fallback.
- Render author `description` and `example` from Slice C 1/4.
- Keep every parameter required, trimmed for submission, and capped at 512 characters.
- Add per-field **Format details** containing the raw pattern.
- Remove regex source from `title`, normal helper text, inline error, and action blocker.
- Use unique label/helper/error ids per field.
- Untouched empty fields say **Required** but are not painted as failed.
- Show errors after blur, invalid keyboard submission, or while correcting a touched field.

Required error states:

| State | Copy |
| --- | --- |
| Empty | **<Label> is required.** |
| Too long | **<Label> must be 512 characters or fewer.** |
| Mismatch with guidance | Reuse the author guidance. |
| Mismatch without guidance | **<Label> does not match the required format. Open Format details for the technical rule.** |
| Stored rule cannot compile | **This workflow's format rule could not be checked. Ask an administrator to fix the workflow.** |

Keep client `paramValueMatches` behavior aligned with server `checkWorkflowParams`. Server refusal
remains authoritative.

## 5. Preflight sentence

Render ordinary text immediately before the action. Required examples:

- **Will run in bellows.ai using Main executor, with the Fix issue workflow.**
- **Will run in bellows.ai using the default executor. Your prompt will run as written.**
- **Will run without a repository using the default executor. Your prompt will run as written.**

Use actual choices. Do not claim that workflow interpolation has already occurred.

## 6. Start action and state model

- Rename **Send** to **Start task**.
- Pending label: **Starting…**.
- Show semantic `kbd` shortcut text beside the action.
- Do not add `accesskey`.
- Disable for empty prompt, invalid selected-workflow fields, or in-flight queue.
- Pair every disabled state with visible copy:
  - **Describe the task to continue.**
  - **Complete the required workflow details to continue.**
  - **Starting the task…**
- Invalid keyboard submission marks fields touched, focuses the first invalid field, and sends no
  request.
- A server refusal uses `role="alert"` and preserves every draft value.
- Successful `201` navigates directly to `/tasks/:id`.

The CSP still uses `form-action 'none'`. Use `type="button"` and explicit callbacks rather than a
native network form submit.

## Implementation map

- `web/src/task-composer.ts` — new pure state/validation/preflight helpers.
- `web/src/panels/TaskComposer.tsx` — guided composition and existing selection ownership.
- `web/src/components/WorkflowParameterFields.tsx` — accessible parameter fields/touched state.
- `web/src/pages/TaskComposerPage.tsx` — data/mutation ownership and `/tasks/new` navigation.
- `web/src/api/useWorkflows.ts` — consume description/example from 1/4.
- `web/src/styles.css` — documented guided-composer primitives only.
- `docs/design-system.md` — classes and component inventory.
- `web/test/tasks.render.test.tsx` — pure/render matrix.
- `web/test/styles.test.ts` — inventory/style gates.
- `e2e/composer.spec.ts` — real browser behavior at `/tasks/new`.

Delete superseded helper exports/classes instead of keeping aliases.

## Accessibility and responsive requirements

- Every textarea, Listbox, and workflow input has a visible label.
- `aria-describedby` points to unique existing ids.
- Routine guidance is polite; request refusal is an alert.
- The shortcut never bypasses validation.
- At 360px controls stack and use available width.
- At 768px use two columns only if help/labels do not compress.
- Start action and blocker remain visible together.
- Long repository/workflow names wrap or truncate inside controls without page overflow.
- No page-level overflow at 360px, 768px, 1024px, or 1440px.

## Tests

Cover:

- explicit No repository / Default executor / No workflow labels;
- prompt label/helper/example;
- preflight combinations;
- Start/Starting labels and blocker matrix;
- valid/missing/too-long/mismatch/invalid-rule parameter states;
- guidance visible while raw regex is absent from normal content/title;
- regex visible only inside Format details;
- two invalid fields have unique descriptions;
- invalid shortcut focuses first field and does not queue;
- repository/workflow reset semantics;
- failed queue preserves draft;
- settings remediation without false blocking;
- screenshots at 360px and 1440px.

## Acceptance criteria

- [ ] A member can state repository, executor, workflow, and prompt behavior before starting.
- [ ] Null choices use explicit product language.
- [ ] Workflow parameter errors are actionable without exposing regex syntax.
- [ ] Raw regex is available only under Format details.
- [ ] Every disabled Start state explains itself.
- [ ] Click and keyboard paths share validation and queue logic.
- [ ] No-repository/default-executor tasks remain supported.
- [ ] Queue refusal preserves the complete draft.
- [ ] Workspace loading/error/Retry behavior remains honest.
- [ ] Responsive, focus, and style-inventory tests pass.

## Verification

```bash
npx vitest run web/test/tasks.render.test.tsx web/test/tasks.wiring.test.tsx web/test/styles.test.ts
npm run typecheck
npm run lint
npm run build
npm run verify:ui
```

Inspect the generated composer screenshots; DOM assertions do not prove hierarchy or clipping.

## Out of scope

- Task detail/conversation redesign.
- Task action/removal changes.
- Prompt interpolation preview.
- Making repository or a named executor mandatory.
- Any server contract beyond Slice C 1/4.
