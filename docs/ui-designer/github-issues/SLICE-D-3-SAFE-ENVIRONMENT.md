Part **3 of 4** of Slice D — *Make configuration diagnosable, scoped, and safe to edit* (P2).

Full spec: `docs/ui-designer/ISSUE-SLICE-D-CONFIGURATION.md` — section **6. Environment editor**,
**Shared state and failure behavior**, **Implementation instructions by file → Environment
editor**, **Accessibility requirements**, and **Test plan → Environment pure/render**.

**Depends on:** #180 and #181.

## Summary

Turn each environment scope into a safe draft editor: real tabs with counts, explicit secret
state, pending removal with undo, advanced `.env` apply/cancel, canonical dirty state, and guarded
navigation.

Preserve the existing whole-list APIs, write-only secret contract, scope precedence, and
member-write policy. No environment endpoint or storage change is expected.

## 1. Draft and baseline

`EnvVarsPanel` owns one baseline and one local draft for its scope.

Canonical dirty comparison must:

- compare the API payload shape, not React row ids;
- distinguish `null` (keep stored secret) from `''` (new/replacement input);
- include additions and effective edits;
- exclude pending-removal rows from the next payload;
- ignore order only if existing server/UI semantics are non-ordering;
- reset only after a successful echoed `{ vars }` response or explicit discard.

States:

- clean;
- **Unsaved changes**;
- validation error;
- **Saving changes…**;
- **Changes saved**;
- server failure with draft retained.

Disable Save changes when clean, invalid, saving, or holding unapplied `.env` text. Keep it next to
the changed content.

Do not remount the editor after save; adopt echoed rows as the new baseline inside the mounted
panel so success feedback survives.

## 2. Variables and Secrets tabs

Implement a complete tabs contract:

- labeled `role="tablist"`;
- **Variables ({n})** and **Secrets ({n})**;
- `role="tab"`, `aria-selected`, `aria-controls`, roving focus;
- Left/Right, Home, and End keys;
- associated mounted `role="tabpanel"` elements.

Counts include valid unsaved additions and exclude pending removals.

### Variables

Editable table columns:

- Name;
- Value;
- Actions.

Add variable appends a row, focuses Name, and marks dirty. Inputs have visible headers,
row-specific accessible names, and associated validation errors.

### Secrets

Columns:

- Name;
- State / new value;
- Actions.

Stored secret:

- state **Set**;
- blank password input;
- **Leave blank to keep the current secret**;
- typed state **Will replace when saved**;
- blank save sends `null`.

New blank secret:

- state **Not set**;
- cannot save until name/value are valid or row is removed.

Never reveal, infer length, copy, log, screenshot, or place a stored value in the DOM. Secrets never
enter `.env` text.

Adding within a tab determines type. A masked stored secret must not become a variable without a
new explicit value.

## 3. Remove and undo

Replace immediate disappearing removal:

1. **Remove {name}** marks an existing row pending.
2. Keep a compact row/message: **{name} will be removed when you save.**
3. Offer **Undo**.
4. Exclude it from counts and save payload.
5. Announce remove/undo politely.

An untouched blank new row may disappear immediately. Restore focus to Add or the nearest row.

Deletion occurs only when the whole-list save succeeds. A failed save keeps the pending-removal
state and Undo.

## 4. Advanced `.env` editing

Replace **raw** with an **Advanced** disclosure inside Variables:

- disclosure **Edit variables as .env**;
- warning **This replaces the variable draft for this scope. Secrets are never shown here.**;
- textarea **Variables in .env format**;
- strict parser help;
- actions **Apply .env draft** and **Cancel .env changes**.

Opening/closing alone never changes the table draft.

Apply:

- parse the current text;
- on success replace non-secret rows only and keep secret rows;
- on failure keep text/disclosure open, associate line errors, leave table draft unchanged.

Cancel restores seeded text/table state for advanced editing only. Primary scope save remains
disabled while unapplied text differs.

## 5. Validation and save

Mirror existing server rules where already available:

- legal env names;
- maximum rows;
- newline-free and size-bounded values;
- duplicate handling consistent with the existing parser/server.

The server remains authoritative. Show concise row errors plus a save-level summary.

Save lifecycle:

- lock only the current editor;
- on success adopt echoed vars, clear dirty, announce success;
- on failure retain draft, show alert, focus the alert without erasing inputs;
- preserve `null` secret keep and omission delete semantics.

The merged full list includes rows from both mounted tabs; inactive or filtered content is never
dropped.

## 6. Unsaved-change protection

Protect dirty environment editors and the repository-selection draft established in part 2:

- register `beforeunload` only while dirty;
- use React Router blocker for in-app navigation;
- block dirty repository-detail switches;
- coordinate one dialog owner so nested blockers cannot duplicate dialogs.

Dialog:

- title **Discard unsaved changes?**;
- body **Your changes to {scope label} have not been saved.**;
- safe primary **Continue editing**;
- destructive **Discard changes**;
- Escape/backdrop acts as Continue editing;
- Continue returns focus to initiating control;
- Discard resets baseline and resumes the original navigation/switch.

Do not use `window.confirm`.

## Permission and scope invariants

- Organization/repository env remains writable by any member under current routes.
- Workspace env remains personal.
- Scope context from part 1 remains before controls.
- Precedence remains organization < workspace < repository.
- Every list read masks every secret value, admins included.
- Environment stays non-polling so remote changes cannot race a local draft.

## Implementation map

- `web/src/panels/EnvVarsPanel.tsx`
  - baseline/draft, tabs, counts, validation, pending removal, save lifecycle;
- `web/src/panels/env-raw.ts`
  - keep strict pure parse/serialize; add canonical helpers only when needed;
- `web/src/api/useEnv.ts`
  - preserve last-good data, explicit refetch, and echoed result;
- `web/src/pages/SettingsLayout.tsx`
  - smallest dirty-draft coordinator;
- `web/src/components/UnsavedChangesDialog.tsx` (new)
  - route/detail confirmation and focus behavior;
- Organization/Workspace/Repositories pages
  - stable scope ids/labels and guarded repository switching;
- `web/src/styles.css`, `docs/design-system.md`, `docs/env.md`
  - editor states, tab/removal/disclosure primitives, UI behavior docs.

No route, migration, driver, Docker, or Kubernetes change is expected.

## Accessibility and responsive requirements

- Complete keyboard tab behavior and stable relationships.
- Unique input labels/errors per row.
- Errors use alert; dirty/saved/remove/undo use appropriate polite announcements.
- No stored secret value or length clue in accessible text.
- Dialog traps/restores focus and has safe initial action.
- At narrow width, rows reflow to labeled groups rather than compress Name/Value unusably.
- Tab counts and action labels remain visible.
- No page-level overflow at 390×844, 900×800, or 1280×900.

## Tests

Expand `env.render.test.tsx` and `env-raw.test.ts`:

- roles/relationships/keyboard/counts;
- additions/removals and canonical dirty comparison;
- stored Set/null/leave-blank behavior;
- new Not set validation;
- replacement status;
- no secret in `.env`;
- pending remove and Undo;
- blank unsaved-row removal/focus;
- valid Apply changes variables only;
- invalid Apply retains text/table baseline;
- Cancel advanced changes;
- clean/invalid/saving/unapplied Save disables;
- success adopts echo without remount;
- failure retains draft;
- member org/repo editors remain writable.

Add blocker/dialog tests:

- clean route proceeds;
- dirty route opens one dialog;
- Continue cancels and restores focus;
- Discard resets/resumes;
- repository switch uses same contract;
- `beforeunload` lifetime matches dirty state.

Regression:

- `server/test/routes.env.test.ts`;
- `server/test-db/env-var-store.test.ts`.

Browser:

- row add/edit/save;
- tab switch with draft retained;
- remove/undo/save;
- invalid then valid `.env` apply/save;
- route and repository-switch Continue/Discard;
- in-flight/failure behavior;
- populated, validation, undo, dialog, saving, and narrow screenshots.

## Acceptance criteria

- [ ] Variables/Secrets are accessible tabs with live counts.
- [ ] Rows have Name, Value/State, and Actions with unique labels.
- [ ] Stored secret shows Set and never reveals/infer values.
- [ ] Blank stored secret means keep; new blank means not set.
- [ ] Removal is pending until save and offers Undo.
- [ ] Advanced mode is **Edit variables as .env**, excludes secrets, and applies explicitly.
- [ ] Canonical dirty state covers edits/additions/removals/raw changes.
- [ ] Route, browser, and repository switches cannot silently lose dirty work.
- [ ] Failure retains draft; success adopts echo without remount.
- [ ] Whole-list, precedence, permission, and non-polling invariants remain green.
- [ ] Keyboard, focus, responsive, design-system, docs, and screenshot checks pass.

## Verification

```bash
npx vitest run web/test/env.render.test.tsx web/test/env-raw.test.ts
npx vitest run web/test/settings-pages.render.test.tsx web/test/settings.wiring.test.tsx
npx vitest run server/test/routes.env.test.ts
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test \
  npx vitest run server/test-db/env-var-store.test.ts
npm run typecheck
npm run lint
npm run build
npm run verify:ui
```

Inspect every environment/unsaved-dialog screenshot.

## Out of scope

- secret reveal/copy;
- new permission policy;
- server/schema changes;
- executor guidance and final slice matrix (part 4).
