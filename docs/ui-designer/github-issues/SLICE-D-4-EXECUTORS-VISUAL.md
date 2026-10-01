Part **4 of 4** of Slice D — *Make configuration diagnosable, scoped, and safe to edit* (P2).
**Closes the slice.**

Full spec: `docs/ui-designer/ISSUE-SLICE-D-CONFIGURATION.md` — sections **7. Executor page and
dialog**, **Shared state and failure behavior**, complete **Accessibility requirements**,
**Responsive acceptance matrix**, **Test plan**, **Acceptance criteria**, and **Definition of done**.

**Depends on:** #180, #181, #182, and Slice C composer issue #176.

## Summary

Finish Slice D by making executor configuration honest and understandable, then verify the complete
Settings experience across populated, sparse, loading, stale-error, empty, unavailable, in-flight,
validation, undo, and narrow-screen states.

This issue owns executor guidance and integration quality. It must not reopen the Overview,
repository, scope, or environment information architecture established by parts 1–3.

## 1. Executor page

Render:

1. PageHeader: **Settings** / **Executors** / **Name the personal runner configuration offered
   when you start a task.**
2. **My workspace** scope context.
3. Guidance:
   **The deployment chooses the runner CLI and image. An executor stores your label and config; it
   does not switch the deployment between Claude Code and OpenCode.**
4. Executor list.
5. Page-header **Add executor** action.

States:

- root null: **Personal executors are unavailable because this deployment has no workspace root.
  Tasks cannot run until workspace setup is complete.** Link Workspace; do not open a dialog that
  later discovers `409 WORKSPACE_DISABLED`;
- empty with root: **No personal executors configured. New tasks use the deployment's image
  default.**;
- populated: mark only the first returned row **Selected first on new tasks**.

The first marker describes current composer behavior. Do not add a persisted default, ordering UI,
or Make default action.

Each row shows:

- name;
- human type label **Claude Code** / **OpenCode**;
- added date;
- first-selection marker when applicable;
- Edit action.

Raw config remains absent from the list and every poll.

## 2. Add/edit dialog

Keep Name, Type, and raw JSON, but add accurate type-specific help.

### Claude Code

Copy:

**This JSON is stored with the executor but is not consumed by the current Claude Code runner. Use
`{}` unless your deployment documents another consumer.**

Example: `{}`.

### OpenCode

Copy:

**When the deployment runs OpenCode, this object is merged over its baked configuration. Model and
provider settings apply; permission rules are ignored to preserve the runner fence.**

Use a safe example with illustrative `model` / `provider` keys and no real credential.

### Common behavior

- **The selected Type describes this config. It does not change the deployment's runner CLI.**
- Unknown keys remain accepted.
- Existing JSON object, name, type, size, duplicate, and ten-row validation remains.
- Config may contain sensitive values and is fetched only when Add/Edit opens.
- Add action **Add executor**; edit action **Save executor**.
- Failure retains dialog/input and shows inline alert.
- Success closes and restores focus to Add/Edit trigger.
- Whole-list merge and rename audit semantics remain.

Do not add a visual schema editor or claim a row chooses the runner image.

## 3. Polling, secrecy, and runtime invariants

- `GET /api/workspace` carries name/type/timestamps only.
- `GET /api/workspace/executors` is the one on-demand full-config read.
- `PUT /api/workspace/executors` replaces the caller's whole list.
- Executor rows remain per member.
- `opencode` config reaches a run only when the deployment uses OpenCode.
- `permission` remains stripped board-side.
- `claude-code` config remains stored-only.
- Missing/deleted label falls back to unlabelled image default.
- No driver, Docker, Kubernetes, claim, env-forwarding, or image change.

## 4. Slice integration and visual matrix

Exercise the final configuration experience, not isolated components only.

### Overview

- populated identity/readiness;
- sparse state with no selected repos/executors/env;
- loading without false zeros;
- workspace root unavailable;
- exact fix links.

### Repositories and Workspace

- loaded selection/status/config detail;
- search no-match;
- cached list plus named error;
- successful empty installation;
- dirty and saving selection;
- failed checkout reason;
- root-null selection disabled but config readable;
- orphaned checkout maintenance.

### Environment

- populated variables/secrets;
- empty scope;
- unsaved changes;
- pending removal/Undo;
- `.env` validation error;
- saving and server failure with draft retained;
- discard dialog Continue/Discard.

### Executors

- root unavailable;
- empty deployment-default state;
- populated first selection;
- add/edit type-help variants;
- invalid JSON and save failure;
- on-demand config fetch only.

### Widths

Verify 1280×900, 900×800, and 390×844:

- one `h1` and coherent order;
- no viewport-level horizontal scroll;
- list/detail stacks when constrained;
- editable rows remain usable;
- dirty/error/success copy remains near controls;
- dialog actions/focus remain reachable;
- no action is covered by mobile navigation.

Required screenshot evidence includes:

- `settings-overview-populated.png`;
- `settings-overview-sparse.png`;
- `settings-repositories-stale.png`;
- `settings-repositories-empty.png`;
- `settings-repositories-saving.png`;
- `settings-env-validation.png`;
- `settings-env-remove-undo.png`;
- `settings-unsaved-dialog.png`;
- `settings-executor-help.png`;
- `settings-overview-narrow.png`;
- `settings-repositories-narrow.png`.

Inspect images at full size; DOM assertions do not prove hierarchy, wrapping, or action placement.

## Implementation map

- `web/src/pages/SettingsExecutorsPage.tsx`
  - scope/guidance/root-null/first-selection states;
- `web/src/panels/WorkspaceExecutorsPanel.tsx`
  - shared table, human type labels, first marker;
- `web/src/components/ExecutorDialog.tsx`
  - type help/examples, action copy, focus/failure behavior;
- `web/src/workspace/executors.ts`
  - pure validation plus shared label/help metadata if useful;
- `web/src/api/useWorkspace.ts`
  - preserve on-demand config and last-good behavior;
- `web/src/styles.css` and `docs/design-system.md`
  - final settings primitives/inventory/responsive states;
- `docs/workspace.md`, `docs/env.md`, `docs/repos.md`
  - final route and behavior truth;
- e2e suites and screenshot matrix.

## Accessibility requirements

- One `h1` per Settings route and ordered section headings.
- Scope/status/selected/error states remain non-color.
- Executor type help is programmatically tied to Type/config fields.
- Dialog traps focus, Escape/backdrop closes before submit, success restores trigger focus.
- Raw JSON parse errors associate to textarea and retain content.
- Tabs, checkboxes, row actions, repository Configure, save actions, and blockers work by keyboard.
- Announcements cover meaningful save/removal/status changes without poll noise.
- Narrow Configure transition focuses detail heading; desktop avoids surprise scroll.

## Tests

Update executor suites:

- every supported type has human label/help/safe example;
- Claude Code says stored/not consumed;
- OpenCode says deployment CLI authoritative and permission ignored;
- first row marker and empty default state;
- root-null action refusal before dialog;
- config absent from summary/poll rendering;
- config fetched only on dialog open;
- parse/object/name/type/size/duplicate/count errors;
- Save executor copy;
- failure retention and success focus restoration.

Complete Settings browser coverage:

- every readiness fix link;
- repo search/selection/status/config;
- env row/tab/undo/raw/blocker;
- executor type help/add/edit;
- signed-out deep links;
- full state/width matrix;
- no console, page, or request failures except deliberately exercised failures.

Run existing server/database suites as regression coverage for env, repositories, workspace, and
executors; do not rewrite contracts to support presentation.

## Acceptance criteria

- [ ] Executor page explains deployment-controlled runner CLI/image.
- [ ] Root-null and zero-executor states are distinct and honest.
- [ ] First executor is selected-first copy, not a persisted-default claim.
- [ ] Claude Code/OpenCode help matches actual consumers and permission behavior.
- [ ] Raw JSON remains precise/validated but is not the only explanation.
- [ ] Config stays out of polls/overview and is fetched on demand only.
- [ ] Add/edit failure retains input; success restores focus.
- [ ] Overview/repository/environment work from parts 1–3 remains intact.
- [ ] Complete populated/sparse/loading/stale/empty/unavailable/in-flight/validation/undo/narrow
      matrix is asserted and visually inspected.
- [ ] All Settings routes have one heading, keyboard access, no color-only meaning, and no viewport
      overflow.
- [ ] Product and design-system docs match final code.
- [ ] Full test/typecheck/lint/build/UI gates pass.

## Verification

```bash
npx vitest run web/test/executors.test.ts web/test/workspace.render.test.tsx
npx vitest run web/test/settings-overview.test.tsx web/test/settings-pages.render.test.tsx
npx vitest run web/test/repository-setup.test.ts web/test/env.render.test.tsx web/test/env-raw.test.ts
npx vitest run web/test/nav-model.test.ts web/test/sidenav.test.tsx web/test/styles.test.ts
npx vitest run server/test/routes.env.test.ts server/test/routes.workspace.test.ts server/test/routes.repos.test.ts
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test \
  npx vitest run server/test-db/env-var-store.test.ts \
  server/test-db/user-repo-store.test.ts server/test-db/user-executor-store.test.ts
npm run typecheck
npm test
npm run lint
npm run build
npm run verify:ui
```

Inspect all new and updated `artifacts/ui/` screenshots.

## Slice-level definition of done

Slice D is complete when a member can answer:

1. which organization and workspace am I configuring;
2. which repositories are available, enabled, and ready;
3. which values affect everyone, only me, or one repository;
4. whether a secret is set without seeing it;
5. whether work is unsaved and how to continue/discard/undo safely;
6. what executor is selected first and what its config actually controls;
7. where to go to fix every unavailable/attention state.

The slice is not complete if Settings redirects past its overview, repository choice/status stay
split, the browser claims permission the server does not enforce, secrets can be inferred, raw
JSON/`.env` is the only explanation, dirty work can be lost silently, or narrow layouts hide the
recovery action.
