Part **2 of 4** of Slice D — *Make configuration diagnosable, scoped, and safe to edit* (P2).

Full spec: `docs/ui-designer/ISSUE-SLICE-D-CONFIGURATION.md` — sections **4. Workspace page**,
**5. Repository setup and configuration**, **Shared state and failure behavior**, **Implementation
instructions by file → Repository page**, and **Test plan → Repository selection**.

**Depends on:** #180.

## Summary

Make `/settings/repos` the one place to understand repository availability, personal checkout
selection, checkout status, search, and repository-wide configuration. Simplify Workspace to the
personal root, personal environment, and orphaned-checkout maintenance.

Delete the modal picker after the inline surface owns selection; do not retain two implementations.

## 1. Repository page structure

Header:

- eyebrow **Settings**;
- title **Repositories**;
- description **Choose which repositories are checked out for your workspace and configure
  repository-wide environment.**

Render in this order:

1. organization/install availability summary;
2. personal selection/status summary and save action;
3. labeled search;
4. named repository list/table region;
5. selected repository configuration detail.

After both `/api/repos` and `/api/workspace` settle, show:

- **{enabled} of {available} repositories enabled**;
- enabled ready/setting-up/failed counts;
- installation account and `all` / `selected` access when present;
- cached-list warning when `meta.error` exists;
- workspace-root unavailability when `root === null`.

Do not show `0 of 0` while either answer is unresolved.

## 2. Search and list

Search:

- visible label **Search repositories**;
- case-insensitive `owner/name` match;
- clear action only when non-empty;
- **No repositories match “{query}”** only after successful load;
- filtering never mutates the full selection draft.

Each repository row contains:

- checkbox **Enable owner/name in my workspace**;
- repository name/configure control;
- text checkout state: Not checked out, Queued, Cloning, Ready, or Failed · reason;
- branch, last commit, and size when known; em dash for unmeasured, never fake zero;
- **Configure** action.

Do not make the `<tr>` clickable or nest interactive controls. Selected configuration state is
text/non-color and exposed with `aria-current` or an equivalent semantic state.

## 3. Whole-selection draft

Seed one full set from `workspace.data.repos`, keyed by `owner/name`.

Rules:

- selected keys hidden by search survive;
- a selected repository temporarily absent from GitHub appears under **No longer reported by
  GitHub**;
- an absent repository can be deselected but not newly selected;
- while an absent selected repository remains, disable whole-list save with
  **Remove repositories GitHub no longer reports before saving other selection changes.**;
- enforce the existing 20-repository ceiling before request;
- at the ceiling, disable only additional selections, never deselection;
- dirty copy: **Selection changed — save to update your workspace**;
- primary action: **Save repository selection** near the summary;
- in flight: **Saving selection…** and lock ambiguous selection controls;
- `202`: adopt baseline, announce saved/setup-in-progress, keep polling;
- failure: keep draft and last-good statuses, show server message beside action.

Register the dirty selection with Slice D's shared route/browser leave protection contract. This
issue may add the coordinator interface needed by part 3, but part 3 owns the final dialog and env
editor integration.

## 4. Loading, stale, empty, and unavailable

- Installation loading with no data: **Loading repositories…**.
- Workspace loading after availability is known: show rows but say **Checking checkout status…**;
  do not show unchecked boxes as fact.
- Hard installation error/no data: named error, not empty list.
- `meta.error` with cached data: retain rows and timestamp, show warning.
- Successful zero list: explain the GitHub App is installed on no repositories and an admin must
  update it on GitHub.
- `root === null`: availability/config stays readable; checkout controls disabled with visible
  reason and Workspace link.
- Poll/save failure with last-good data: retain it and mark it stale.

## 5. Repository configuration detail

Choosing **Configure** opens real content on the same page:

- heading **Environment for owner/name**;
- scope **Repository · owner/name**;
- organization-wide impact/editability sentence from part 1;
- current checkout status as context;
- existing repository environment rows, or a successful empty scope.

Do not render an empty selector panel before a choice.

Configuration does not require personal checkout enablement. The route validates installation
visibility, while repository env is organization-wide.

When a dirty detail exists, switching repositories must use the shared unsaved-change contract;
part 3 completes the dialog behavior. Preserve the mounted editor after save so echoed rows and
success feedback are not lost.

Wide layout may use master/detail. At narrow widths, DOM order is summary → search/list → detail;
Configure moves focus to the detail heading on narrow screens only.

## 6. Workspace simplification

Keep `/settings/workspace` responsible for:

- **My workspace** scope;
- root availability/path;
- personal environment editor;
- **Still on disk** orphaned repositories.

Move selected checkout table and Select repositories modal away. Add
**Manage repository checkouts** → `/settings/repos`.

Root-null copy:

**This deployment has no workspace root. Tasks cannot run until an operator sets
`ORG_WORKSPACE_ROOT`.**

Personal environment remains available when its store exists.

Orphaned rows name the repository and say it is no longer enabled but remains on disk. No delete
action is added.

## API invariants

- `GET /api/repos` is organization/install availability and may return cached rows plus error.
- `GET /api/workspace` is personal selection/status and remains the single shared poll.
- `PUT /api/workspace/repos` is full replacement and returns `202`.
- Cloning remains asynchronous with queued/cloning/ready/failed states.
- Selection remains per member.
- Same-name/different-owner collision and repository visibility validation remain server authority.
- No readiness endpoint or organization-wide checkout setting.

## Implementation map

- `web/src/pages/SettingsRepositoriesPage.tsx`
  - combine repo availability with shared workspace/env state;
  - own search, selection draft/save, and selected config identity;
- `web/src/components/RepositorySetup.tsx` (new or equivalent)
  - summary/list/status/configure controls;
  - export pure filtering/selection/count helpers;
- `web/src/components/RepoPickerDialog.tsx`
  - delete after callers migrate;
- `web/src/panels/WorkspaceReposPanel.tsx`
  - fold useful facts into setup list or delete if unused;
- `web/src/pages/SettingsWorkspacePage.tsx`
  - remove picker/selected table; keep root/env/orphaned;
- `web/src/api/useRepos.ts`
  - preserve cached/error distinctions; no polling;
- `web/src/api/useWorkspace.ts`
  - preserve poll/backoff/full PUT/status semantics;
- `web/src/styles.css`, `docs/design-system.md`, `docs/repos.md`, `docs/workspace.md`
  - update primitives and product truth.

No server, migration, driver, Docker, or Kubernetes change is expected.

## Accessibility and responsive requirements

- Search has a visible label.
- Checkboxes name full `owner/name`.
- Checkout status and selected config do not rely on color.
- Table/list is a named, keyboard-focusable region when scrollable.
- No clickable row; each control has one action.
- Disabled selection reason is visible and associated with the group.
- Configure-to-detail focus moves only when needed on narrow screens.
- List/detail stack below 1100px if fields would compress.
- No page-level overflow at 390×844, 900×800, or 1280×900.

## Tests

Replace modal-focused picker tests with `repository-setup.test.ts` or equivalent:

- search filtering without selection mutation;
- hidden selected keys retained;
- absent selected keys visible/deselectable and save-blocking;
- 20-repo ceiling;
- availability/enabled/ready/in-progress/failed counts;
- failed reason;
- root-null disabling versus config availability;
- dirty/saving/success/failure lifecycle;
- saved baseline adoption;
- selected config and scope identity;
- detail-switch blocker handoff.

Update:

- `web/test/workspace.render.test.tsx` for moved checkout rows and retained orphaned rows;
- `web/test/settings-pages.render.test.tsx` for repository states;
- `web/test/settings.wiring.test.tsx` for one workspace poll;
- `server/test/routes.repos.test.ts`, `server/test/routes.workspace.test.ts`, and
  `server/test-db/user-repo-store.test.ts` as regression suites, not behavior rewrites.

Browser:

- search, enable/disable, save, and status update;
- configure a repository independently of its checkbox;
- cached-error/empty/root-null states;
- wide and narrow focus/content order;
- screenshots for populated, stale, empty, saving, failed checkout, and narrow.

## Acceptance criteria

- [ ] Repositories shows availability, personal enablement, status, search, and config together.
- [ ] Summary says **n of m enabled** only after both data sources settle.
- [ ] Search never changes the full selection.
- [ ] Hidden/unreported selected repositories cannot be silently dropped.
- [ ] Existing 20-repository limit is explained before request.
- [ ] Save lifecycle retains draft/data on failure and adopts baseline on `202`.
- [ ] Root-null disables selection with reason but preserves repository availability/config.
- [ ] Config detail opens on-page and does not require personal enablement.
- [ ] Workspace contains root, personal env, and orphaned maintenance only.
- [ ] Modal picker and duplicate selection logic are deleted.
- [ ] Empty, error, cached-stale, loading, and unavailable states remain distinct.
- [ ] Keyboard, focus, responsive, design-system, docs, and screenshot checks pass.

## Verification

```bash
npx vitest run web/test/repository-setup.test.ts web/test/workspace.render.test.tsx
npx vitest run web/test/settings-pages.render.test.tsx web/test/settings.wiring.test.tsx
npx vitest run server/test/routes.repos.test.ts server/test/routes.workspace.test.ts
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test \
  npx vitest run server/test-db/user-repo-store.test.ts
npm run typecheck
npm run lint
npm run build
npm run verify:ui
```

Inspect every repository/workspace screenshot.

## Out of scope

- clone implementation or pruning;
- organization-wide repository selection;
- final environment draft/secret editor redesign (part 3);
- runner behavior.
