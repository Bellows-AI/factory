# Design system — region: settings

Owned by the settings lane. Styles: `web/src/styles/regions/settings.css` — the lane rules plus its
trailing 44px touch-target segment (issue 189). Shared primitives, tokens and the system
contracts: [../design-system.md](../design-system.md).

## Primitives

| Primitive | Classes | Use for |
| --- | --- | --- |
| Toggle | `settings-toggle` | A labelled checkbox row — the design system's one boolean-control primitive (no dedicated switch family exists): the default-workflow settings panel's two switches and the composer's matching pair of optional-step checkboxes (issue 208), the latter now inside the composer's `composer-steps` disclosure (issue 228) |
| Picker | `picker`, `picker-field`, `picker-field-actions`, `picker-help`, `picker-model`, `picker-advanced`, `picker-managed`, `picker-save-hint`, `picker-actions` | The executor editor (#261): a Headless UI Dialog in the shared `dialog` panel and shell. Each `picker-field` is a column — a 13px semibold label (or, for the Model choice, a fieldset legend) above the `field`, a muted 13px `picker-help` below it, then the field's own `status` error tied by `aria-describedby`, never a live region. Model is a `picker-model` fieldset of two `settings-toggle` radio rows and, when custom, one `field`. `picker-advanced` is the native disclosure holding the JSON editor, its `picker-field-actions` row (Format JSON), the `banner-warn` `picker-managed` list of settings the runner will not honor, and the gate-repair field. `picker-actions` holds the `picker-save-hint` on the leading edge — why Save is disabled — then Cancel and the `primary` save, wrapping as a row at narrow widths |
| JSON editor | `json-editor`, `json-editor-gutter`, `json-editor-area`, `json-editor-highlight`, `json-editor-input`, `json-token-key`, `json-token-string`, `json-token-number`, `json-token-literal`, `json-token-punct`, `json-token-invalid` | The Advanced configuration editor (#261): a sunken, `--line-strong`-framed, 240px-bounded mono well; an `aria-hidden` line-number gutter beside a transparent `textarea` laid over its `aria-hidden` highlighted copy (keys `--accent`, strings `--ink`, numbers and literals `--lamp-done`, punctuation `--ink-muted`, anything JSON cannot hold `--lamp-stop` with a wavy underline). The frame takes the accent edge on focus and the stop edge while invalid, like every `field`. Tab leaves the editor; Enter keeps the line's indent. Forced colors hide the highlight layer (platform.css) |
| Repository setup | `repo-scope`, `repo-cards`, `repo-card`, `repo-card-disc`, `repo-card-disc-accent`, `repo-card-disc-ok`, `repo-card-disc-warn`, `repo-card-disc-bad`, `repo-card-label`, `repo-card-value`, `repo-card-caption`, `repo-search`, `repo-toolbar`, `repo-toolbar-count`, `repo-table`, `repo-row-configured`, `repo-save`, `repo-na`, `repo-detail`, `repo-detail-body` | The repositories page (issue 181, recomposed on concept 06 by issue 282), top to bottom in DOM and reading order at every width: the header's `repo-scope` context (Workspace / Organization, a bordered `kv`); the root-null `banner-warn` (never a button); four `repo-card`s straight from `counts()` — Selected (`repo`, accent disc, captioned "of 20 allowed" and, once the list answered, the available figure on its own line), Ready (`check-circle`, ok), Setting up (`refresh`, warn; queued + cloning) and Failed (`alert-circle`, bad) — each a 40px `repo-card-disc` on its lamp's wash beside a 13px label and a 28px tabular figure, four columns, two at ≤900px, one at ≤640px, with an "—" named `Loading` (or `Not available` after a failed first poll) until the poll answers, never 0; a labeled search row; the `repo-toolbar` selection bar ("n selected · Selection limited to 20 repositories." and Save selection, `primary` only while a dirty, unblocked selection is worth prompting for); the full-width `repo-table`, a fixed-layout `data` table with sized secondary columns and a sticky Configure column that stays reachable while scrolled, the configured row on the accent wash (`repo-row-configured`), and unmeasured facts as `repo-na` words; at ≤640px it stacks into `data-label` cards like `env-vars`. Last, the selected repository's `repo-detail` panel: checkout facts (a `kv`, `Not available` where nothing was measured) beside the repository's scope context and environment editor at ≥1100px (`repo-detail-body`, 1fr/2fr), stacked below it. No Health tab and no status/environment filters |
| Editor footer | `settings-actions`, `settings-dirty` | The end of every settings editor (issue 282): an "Unsaved changes" indicator (13px `--lamp-wait`, text, never a live region) on the leading edge while the draft differs from what is stored, then Cancel (secondary; back to the stored rows) and Save (the panel's one `primary`), after a `--line` hairline. Action words never wrap: `settings-actions`, `repo-toolbar` and `repo-table` buttons are `nowrap` |
| Unsaved-changes dialog | `unsaved`, `unsaved-title`, `unsaved-actions` | The settings area's discard confirmation (issue 182), one instance raised by the dirty-draft coordinator before a blocked navigation or a repository switch: the shared `dialog` panel at the remove dialog's width, Continue editing safe-focused, Discard changes destructive |
| Env | `env-tab`, `env-tabs`, `env-vars`, `env-pending`, `env-advanced-note`, `env-raw`, `env-errors`, `env-row-actions`, `env-add`, `env-advanced-toggle`, `env-row-remove` | The compact draft editor (issue 182, restyled by issue 222): a real `tablist` of Variables/Secrets tabs whose selected tab is the `aria-selected` one; the scope's editable table with aligned, bounded Name/Value/Actions columns (`table-layout: fixed`, the Value column absorbing the width the fixed Name/Actions columns leave, so a long value wraps instead of clipping); a pending-removal row that waits with its Undo until the whole-list save; a compact `env-row-actions` row beneath the table holding the quiet `env-add` control (accent text, hovering on the accent wash) and, for Variables only, the de-emphasized text-style `env-advanced-toggle` disclosure trigger — neither styled `.primary`, so Save stays the panel's one prominent action; `env-row-remove` sizes the row's own remove button as a small square icon control; the advanced `.env` disclosure's warning line, the textarea editor, and the row/scope validation lines (`env-errors`, paired with `.error` for its red tint and attached per-field via `aria-describedby` so a name problem renders under the name input, not the value one). At ≤640px an `env-vars` row becomes a bordered card that reflows into labeled groups via each cell's `data-label` |
| Org executor row actions | the shared `row-actions`, `row-actions-trigger`, `table-cards` ([../design-system.md](../design-system.md)) | The organization executors table is the row-actions pattern's first caller (issue 411). An admin's row shows `Edit` inline and one overflow trigger named for the profile, holding `Make default` (when the row is not the member's default), `Make personal`, then a `danger` `Delete` behind a `popover-separator`; a member's row shows `Make default` alone and no trigger, and a member on the default row shows nothing at all. Both ownership-changing verbs raise `OrgExecutorConfirmDialog` instead of writing on the click — the shared `dialog` panel at the remove dialog's width, Cancel safe-focused, copy naming the profile and saying what every other member loses; the copy and the single write dispatch live in `org-executor-confirm.ts`, so neither is reachable from a row click. The table carries `table-cards` and labels every cell, so at ≤640px the actions reflow into the row's card rather than widening the scroll region |
| Readiness | `readiness`, `readiness-item`, `readiness-status`, `readiness-fact`, `readiness-action` | The configuration overview's five ordered items (#180): raised cards in a grid — two columns above 700px, one at and below it; each item's status is a toned `pill` on its own row (ok `pill-ok`, attention `pill-bad`, pending `pill-warn`, a neutral fact the untoned pill) while the card edge stays the neutral hairline; the words carry the meaning, never color alone, and `overflow-wrap` keeps long paths from widening the page |
| Scope context | `scope-context`, `scope-context-label` | The readable scope/impact/editability block every environment editor renders before its controls (#180); the label is a small uppercase caption, the precedence sentence `muted` |


## JSON editor alignment

The highlighted `code` element inherits the textarea's full font and line height, with no inline
code padding or background (issue #387). The shared `code` primitive's smaller font and inset
would otherwise shift mouse hit testing away from the visible glyphs. Keep both layers' text
metrics identical. `e2e/json-editor.spec.ts` clicks the painted text and checks the native caret,
selection, editing and scrolling at desktop and phone widths in both themes.

## Inventory

| File | Primitives |
| --- | --- |
| `SettingsExecutorsPage.tsx` | page-header, banner-info (via `DraftReturnBanner`), banner-warn (via `WorkspaceRootBanner`), panel, status, muted |
| `SettingsOrganizationPage.tsx` | page-header, kv, scope-context, panel |
| `SettingsOverviewPage.tsx` | page-header, kv, panel, readiness, pill, pill-ok, pill-bad, pill-warn |
| `SettingsRepositoriesPage.tsx` | page-header, repo-scope, kv, status, muted |
| `SettingsWorkflowsPage.tsx` | page-header, status |
| `SettingsWorkspacePage.tsx` | page-header, banner-info (via `DraftReturnBanner`), banner-warn (via `WorkspaceRootBanner`), scope-context, panel, status, muted, chat-remove (via `OrphanDeleteDialog`) |
| `OrphanDeleteDialog.tsx` | dialog, task-remove, status, chat-resume, chat-remove |
| `RepositorySetup.tsx` | panel, icon, kv, table-wrap, data, pill, repo-cards, repo-card, repo-search, field, repo-toolbar, repo-table, repo-row-configured, repo-save, repo-na, repo-detail, repo-detail-body, scope-context, status, muted, primary |
| `SettingsSaveActions.tsx` | settings-actions, settings-dirty, primary |
| `WorkspaceRootBanner.tsx` | banner-warn, banner-title, icon |
| `repository-setup.ts` | helper — no markup |
| `ConfigurationScope.tsx` | scope-context |
| `ExecutorDialog.tsx` | dialog, picker, picker-field, picker-help, picker-model, picker-advanced, picker-managed, picker-save-hint, field, settings-toggle, banner-warn, status, muted, primary, unsaved (via `UnsavedChangesDialog`) |
| `executor-dialog-parts.tsx` | presentational helper `ExecutorDialog.tsx` imports (the Name, Agent, Model, Advanced and action parts) — picker-field, picker-help, picker-model, picker-advanced, picker-managed, picker-save-hint, field, settings-toggle, banner-warn, status, primary |
| `JsonEditor.tsx` | json-editor, json-token-* |
| `UnsavedChangesDialog.tsx` | dialog, unsaved, chat-resume, chat-remove |
| `EnvVarsPanel.tsx` | panel, env, settings-actions (via `SettingsSaveActions`) |
| `env-vars-panel-parts.tsx` | presentational helper `EnvVarsPanel.tsx` imports (tablist, table, banner, tab panels) — no primitives beyond `env` |
| `env-draft.ts` | helper — no markup |
| `env-raw.ts` | helper — no markup |
| `DefaultWorkflowPanel.tsx` | panel, muted, status, settings-toggle, settings-actions (via `SettingsSaveActions`) |
| `default-workflow-draft.ts` | helper — no markup |
| `WorkflowsPanel.tsx` | panel, panel-head, table-wrap, data, pill, muted, status, primary, env-raw |
| `WorkspaceExecutorsPanel.tsx` | panel, pill, table-wrap, data, muted |
| `OrgExecutorsPanel.tsx` | panel, pill, table-wrap, muted, primary, data, table-cards, row-actions (via `RowActions`) — the organization executor profiles' read-only member view and the admin actions (issue 391), the actions cell recomposed on the row-actions pattern (issue 411) |
| `OrgExecutorsSection.tsx` | composition over `OrgExecutorsPanel.tsx` + the shared `ExecutorDialog` and `OrgExecutorConfirmDialog` — no primitives beyond `panel`, `status` |
| `RowActions.tsx` | row-actions, row-actions-trigger, popover, popover-option, popover-separator, danger, icon — the shared row-actions primitive (issue 411), documented in [../design-system.md](../design-system.md) |
| `OrgExecutorConfirmDialog.tsx` | dialog, task-remove, task-remove-title, task-remove-actions, chat-resume, chat-remove, primary |
| `org-executor-confirm.ts` | helper — the confirmation copy and the single confirmed-write dispatch, no markup |

