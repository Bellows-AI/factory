# Design system

Read before: adding or restyling anything under `web/src`, touching `web/src/styles.css`, or
introducing a color.

The web app's styling is one stylesheet, `web/src/styles.css`, compiled by Tailwind CSS v4
(`@tailwindcss/vite`, registered in `web/vite.config.ts`). There is no CSS-in-JS and no
per-component files — a component participates by carrying primitive classes, and every color it
renders flows through a token. The stylesheet's order: `@import "tailwindcss"` (preflight and the
utility engine), the two token blocks, the `@theme` exposures, then the primitives in
`@layer components`. `web/test/styles.test.ts` holds the lines: no color literal outside the two
token blocks, every defined token used, every class the stylesheet defines appears in this
document (the inventory cannot silently rot).

## Tailwind setup

- **Engine, not vocabulary.** Utilities exist, but the primitives are the components'
  vocabulary; markup does not carry utility classes. Tailwind supplies preflight, the `@theme`
  token machinery and the build.
- **`@theme inline` is what makes the runtime theme switch work.** The `--color-*` rows point at
  `var(--surface)`-style tokens, so a utility's value is the variable itself: flipping
  `data-theme="light"` on `<html>` swaps the palette with no CSS regeneration. The preference
  that drives the attribute is the appearance control (#188, below).
- **`color-scheme` lives in each theme block** (`:root` dark, `:root[data-theme="light"]`
  light), so native controls — date-input popups, scrollbars — follow the page.
- **Fonts are self-hosted** under `web/public/fonts/` with `@font-face` at the top of the
  stylesheet: the CSP is `font-src 'self'`, and `verify:ui` runs offline, so a Google Fonts link
  would silently fall back exactly where faces are checked (a guard test pins this).
- **One ambient motion:** a running lamp breathes — `--animate-lamp` (2.4s ease-in-out,
  opacity 1 → 0.45). Nothing else on the page moves by itself.

## Tokens

Two `:root` blocks in `styles.css` — dark is the default, light rides
`:root[data-theme="light"]` — and they are the whole theme surface, and the only place a color
literal may appear. Base palette from issue 148 (the andon board), in `oklch`:

| Token | Role | Dark | Light |
| --- | --- | --- | --- |
| `--surface` | Page canvas; also wells inside panels (chat output, textareas, inputs, list rows on hover) | `oklch(0.19 0.012 250)` | `oklch(0.975 0.004 250)` |
| `--surface-raised` | Panels, menus, popovers, pickers | `oklch(0.235 0.014 250)` | `oklch(1 0 0)` |
| `--surface-sunken` | One step below raised: controls, inline `code`, the avatar placeholder, hover fills | `oklch(0.16 0.012 250)` | `oklch(0.945 0.006 250)` |
| `--line` | Every hairline: panel edges, table row rules, control outlines | `oklch(0.32 0.014 250)` | `oklch(0.89 0.008 250)` |
| `--line-strong` | A hairline that must read harder (the picker dialog's edge, floating over the dimmed page) | `oklch(0.43 0.016 250)` | `oklch(0.78 0.012 250)` |
| `--ink` | Primary foreground | `oklch(0.93 0.008 250)` | `oklch(0.24 0.02 250)` |
| `--ink-muted` | Secondary foreground: labels, captions, ticks, disabled text | `oklch(0.73 0.014 250)` | `oklch(0.45 0.02 250)` |
| `--ink-inverse` | Foreground on an accent fill | `oklch(0.19 0.012 250)` | `oklch(0.975 0.004 250)` |
| `--accent` | The one blue: "a human is needed here", links, active controls, focus rings | `oklch(0.74 0.12 240)` | `oklch(0.52 0.16 250)` |
| `--lamp-run` | Running / ready — the green lamp | `oklch(0.80 0.17 150)` | `oklch(0.58 0.15 150)` |
| `--lamp-wait` | Queued / stopping / in flight — the amber lamp | `oklch(0.84 0.15 85)` | `oklch(0.70 0.15 75)` |
| `--lamp-stop` | Failed / loud — the red lamp | `oklch(0.69 0.20 25)` | `oklch(0.56 0.21 27)` |
| `--lamp-done` | Parked marks, done dots — the grey lamp | `oklch(0.66 0.03 250)` | `oklch(0.58 0.03 250)` |

Derived tokens, mixed per theme with `color-mix(in oklab, …)` — the recipes are identical in
both blocks and read against that block's tokens:

| Token | Role | Recipe |
| --- | --- | --- |
| `--overlay` | Modal backdrop behind a Headless UI dialog (the `.dialog-backdrop` div) | ink 60% over transparent |
| `--ok-border` | Status-tinted edge for a run state (pills, quiet banners) | lamp-run 30% over surface-raised |
| `--warn-border` | Status-tinted edge for a wait state | lamp-wait 30% over surface-raised |
| `--bad-border` | Status-tinted edge for a stop state | lamp-stop 30% over surface-raised |
| `--on-warn` | Foreground on a lamp-wait fill (dark text) | black 88% over lamp-wait |
| `--on-bad` | Foreground on a lamp-stop fill (light text, as in the pre-theme set) | white 92% over lamp-stop |
| `--chart-grid` | Chart gridlines — a step behind `--line` (lines behind data, not edges) | line 60% over surface |
| `--chart-primary` | Chart series fill and its legend swatch | accent 70% over black |
| `--lamp-glow` | The halo behind a breathing lamp | currentColor 26% over transparent |

Typography and shape tokens live in the static `@theme` block (`@theme static`, so they are
emitted even where only a `var()` points at them):

| Token | Role |
| --- | --- |
| `--font-sans` | Barlow — body text |
| `--font-display` | Barlow Semi Condensed — headings |
| `--font-mono` | IBM Plex Mono — identifiers and logs |
| `--radius-md` | 4px — chips, inline code, small controls |
| `--radius-lg` | 6px — buttons, panels, inputs, everything panel-sized |

Rules the token set carries:

- **The surface ladder is `--surface` → `--surface-raised` → `--surface-sunken`, never a raw
  grey.** Raised sits above the canvas (cards); sunken sits below it (controls, wells). A new
  surface picks the rung that matches its elevation; nothing sits between them.
- **`--on-*` is foreground-on-a-fill, and exists for each fill that carries text.** A new
  text-bearing fill needs an `--on-*` token in the same change (derived, like the rest).
- **`--*-border` are the status edges** for controls that tint their outline instead of their
  surface (pills, quiet banners). They pair 1:1 with `--lamp-run`/`--lamp-wait`/`--lamp-stop`.
- **`--accent` and `--chart-primary` are deliberately two blues.** The accent colors text and
  control states — it is the "a human is needed" blue, so it stays quiet; the series fill leans
  on its hue but sits deeper. `.bar`'s default and `button.primary` stay on `--accent` —
  unifying the two is a pixel change.
- **Tokens with no call site do not exist.** The suite fails on a defined-but-unused token
  (`--ink-faint` was pruned for exactly this; `--line-strong` stays because the picker's edge
  uses it).

## Primitives

What exists, and when to reach for which. Families first; one-offs at the end. The names are the
pre-theme names (#148 re-tokenized them, it did not rename them), so the inventory rows stand.

### Layout

| Primitive | Classes | Use for |
| --- | --- | --- |
| Shell | `shell`, `shell-main` | The two-column frame: a 240px sticky sidenav that scrolls within `100dvh`, and the content track |
| Page | `page` | The routed page's content container, carried by the shell's one `main` region (`#main-content`, the skip link's target): 1400px cap, `min-width: 0` — a class, not a `main` selector, so a dialog never inherits page chrome |
| Skip link | `skip-link` | The off-screen "Skip to main content" anchor that slides in on `:focus-visible`, the first focusable element on every page |
| Sidenav | `sidenav`, `sidenav-brand`, `sidenav-items`, `sidenav-link`, `sidenav-sublink`, `sidenav-subitems` | The nav column; `sidenav-link.is-active` marks the page, `sidenav-sublink.is-active` the settings section |
| Sidenav task tree | `sidenav-task`, `sidenav-task-title`, `sidenav-task-summary`, `sidenav-task-author`, `sidenav-newtask`, `sidenav-section`, `sidenav-empty` | Task rows under the nav; the title alone clips |
| Task inbox | `inbox`, `inbox-head`, `inbox-meta`, `inbox-new`, `inbox-filters`, `inbox-tabs`, `inbox-tab`, `inbox-search`, `inbox-sort`, `inbox-rows`, `inbox-row`, `inbox-status`, `inbox-title`, `inbox-activity`, `inbox-repo`, `inbox-author`, `inbox-when`, `inbox-empty`, `inbox-error`, `inbox-note` | The `/tasks` inbox: one responsive grid per row (status label, title link, repo, author, relative age in a `<time>`), URL-state filters, Load more |
| Status dots | `sidenav-dot`, `sidenav-dot-running`, `sidenav-dot-stopping`, `sidenav-dot-paused`, `sidenav-dot-failed`, `sidenav-dot-done` | Task state as one painted pixel; running/stopping breathe (halo via `lamp-glow`) |
| App bar | `appbar`, `appbar-trigger`, `appbar-brand`, `appbar-org`, `appbar-actions` | The global chrome row: sticky, raised, no `h1`; org selector and account menu end-aligned. The trigger (`aria-controls="mobile-nav"`) and the brand reveal at ≤900px, where the org moves into the drawer |
| Page header | `page-header`, `page-header-eyebrow`, `page-header-leading`, `page-header-description`, `page-header-meta`, `page-header-actions` | The routed page's one `h1` and its slots: eyebrow, title + description lead, meta and actions trail (issue 159) |
| Grids | `two-up`, `task-layout` | Two-panel dashboards; the task page's outcome + conversation grid (`task-outcome`/`task-conversation` are its areas) |

`PageHeader` is the page-heading primitive and the one-`h1` rule's enforcer (issue 159): every
routed page renders exactly one of them, and the `h1` it wraps is the page's only `h1` — panel
headings below it are `h2`s and must not restate the page title. It is presentational by
contract (no fetching, no route inspection, no Factory knowledge), slot-driven: `eyebrow` is the
section above the title, `title` the `h1` itself, `description` the leading column's second
line, `meta` the state beside the title (pills, clocks, timestamps) and `actions` the page's
buttons — siblings of the heading, never children of it. An empty slot renders no wrapper, and
`flex-wrap` drops meta and actions below the title at narrow widths without changing DOM order.

### Surfaces and feedback

| Primitive | Classes | Use for |
| --- | --- | --- |
| Panel | `panel`, `panel-head`, `panel-actions` | The card a page section lives in; `+ warn` / `bad` tints the edge |
| Cards | `cards`, `card` | Numeric figure tiles inside a panel |
| Status line | `status`, `alert`, `error`, `muted` | One-line state text; `muted` for secondary prose anywhere |
| Badge | `badge`, `badge-warn` | Loud inline marker — reserved for synthetic data |
| Limits | `limits` | The bulleted limitations list |
| Halo | `lamp-glow` | The soft box-shadow halo in the lamp's own color (`currentColor`); worn by the breathing status dots |

### Controls

#### Appearance (issue 188)

The System/Light/Dark preference is a client-only display setting, never a server one: it lives
in `localStorage['factory.theme']`, which stores only `light` or `dark` and is removed entirely
for System — missing, invalid, or inaccessible storage reads as System, silently. The control
shows the **preference**, not the resolved palette: System stays selected while the OS resolves
dark. The resolved palette is `data-theme="light"|"dark"` on `<html>`, the one attribute the
token blocks read. `web/public/theme-bootstrap.js` sets it before first paint — a plain
same-origin script from `<head>`, the shape `script-src 'self'` already permits (no inline code,
no remote dependency). The provider in `web/src/theme.tsx` owns the attribute from React's side:
it follows OS changes while System is selected, syncs across tabs through the `storage` event,
and switches immediately — no reload, no refetch, no transition, no sign-out clearing.

| Primitive | Classes | Use for |
| --- | --- | --- |
| Appearance | `theme-field`, `theme-label`, `theme-select` | The one System/Light/Dark select (native, keyboard-complete), worn by the app bar and the public header's actions cell; the label is clipped below 640px while the accessible name stays |

| Primitive | Classes | Use for |
| --- | --- | --- |
| Button | `button` (element), `primary` | The default control; `primary` for the page's one main action |
| Popover | `popover`, `popover-option` | The shared floating surface for the anchored Headless UI panels — user menu, org and composer listboxes; `data-focus`/`data-selected` state the options; dialogs sit at z-index 40, popovers at 30 |
| Analytics toolbar | `analytics-toolbar`, `toolbar-group`, `toolbar-label`, `toolbar-value` | The dashboard's visibly labeled Range / Scope / Repositories groups (#166): label above control, read-only values sunken like the inputs they echo |
| Range | `range-presets`, `range-option.active`, `range-picker`, `range-popover-root`, `range-popover`, `range-draft`, `range-draft-actions` | The date-range presets and the Custom trigger; the dates live in the anchored popover (`--line-strong` edge, z-index 30), whose draft form commits only through Apply or Clear |
| Rendered-data summary | `analytics-summary` | The one-line payload sentence under the toolbar groups — mono, muted, a polite live region |
| Freshness | `updated-at`, `updated-at-full` | Relative "Updated …" copy; the precise stamp is revealed on hover and keyboard focus and carried by a `<time dateTime>` |
| Org | `org-selector`, `org-select` | The organization switcher in the app bar, or in the navigation drawer at ≤900px (Headless UI Listbox) |
| Login | `login-gate`, `login-button`, `login-error` | The signed-out screen |
| Public header | `public-header`, `public-brand`, `public-context`, `public-header-actions` | The compact chrome both public pages (gate, onboarding) carry: the Factory brand, one context word, and the actions cell, which holds the theme control (issue 187; the appearance control arrived in issue 188). No navigation, no session, no `h1` — each page owns its one heading |
| Onboarding | `onboarding`, `onboarding-purpose`, `onboarding-identity`, `onboarding-orgs`, `onboarding-org`, `onboarding-org-head`, `onboarding-org-name`, `onboarding-org-mark`, `onboarding-requested`, `onboarding-org-details`, `onboarding-org-summary`, `onboarding-mode`, `onboarding-mode-option`, `onboarding-mode-help`, `onboarding-repos`, `onboarding-repo`, `onboarding-repo-count`, `onboarding-note`, `onboarding-summary`, `onboarding-summary-total`, `onboarding-summary-rows`, `onboarding-summary-row`, `onboarding-actions`, `onboarding-loading`, `onboarding-loading-line` | The setup screen (issue 125, recomposed by issue 187): the centered column, the org checkbox list with each org's initial identity mark and its `Requested for this sign-in` mark, one org's bordered row — a focus target for a blocked attempt, never a click target — whose disclosure summary names the org's repository mode while collapsed, the explicit mode radios with their helpers, the specific-mode checklist with its `N of M` count, the access note, the final selection summary, and the action region (global error, disabled reason, Continue). `onboarding-loading` shapes the pending-load placeholders: static rows and a status line, no shimmer |
| User menu | `user-menu-button`, `user-menu-login`, `user-menu-panel`, `popover` | The app bar's identity disclosure (Headless UI Menu) |
| Avatar | `avatar`, `avatar-fallback`, `avatar-lg` | Identity images; `-fallback` is the initial stand-in |
| Picker | `picker`, `picker-search`, `picker-list`, `picker-name`, `picker-option`, `picker-actions`, `dialog-layer`, `dialog-backdrop`, `dialog-position` | The Headless UI Dialog/Combobox executor picker; options carry `data-focus`/`data-selected`; the backdrop div uses `--overlay`. The `dialog-*` shell is shared with the dialogs below |
| Repository setup | `repo-search`, `repo-columns` | The repositories page's visibly labeled search row, and the summary/list/detail stack that becomes master/detail at ≥1100px; below that the DOM order — summary, list, detail — is the reading order (issue 181) |
| State marks | `active`, `is-active` | The active member of a toggle row or nav list |
| Keyboard mark | `kbd` (element) | The shortcut text beside the composer's launch button — documentation of the button, never an affordance |

### Data display

| Primitive | Classes | Use for |
| --- | --- | --- |
| Table | `table-wrap`, `data`, `sortable`, `align-end`, `th.asc`, `th.desc` | Every tabular readout; the wrap scrolls, never shrinks — a named, keyboard-focusable `<section>` (the region role, implicitly), so a scrolled-off column stays reachable. Sort controls are real buttons inside the `th`; the active column carries `aria-sort` (and the `th.asc`/`th.desc` arrow), sorting reads raw values with nulls last in both directions, and rows are keyed by caller-chosen stable keys. `align-end` right-aligns a numeric column's header and cells. |
| Key-values | `kv` | The dt/dd definition grid |
| Metric summary | `usage-summary`, `usage-groups`, `usage-group`, `usage-tokens`, `usage-label`, `usage-measures`, `usage-measure` | The dashboard's five measures in four groups (#166): the hierarchy IS the grid — Sessions and the wider Token usage group first — and narrow widths restack the same DOM order |
| Analytics empty state | `usage-empty` | The one "nothing measured in this selection" state that replaces the dash-card chorus, naming the selection and one next action |
| Per-user | `by-user-user` | The avatar+name cell the attribution and board tables share |
| Usage bar | `usage-track`, `usage-bar` | The proportional New-tokens bar in the by-user table: a sunken-well track with a chart-blue fill, `aria-hidden` — width is decoration, the cell's accessible name carries the exact figure |
| Task title | `task-title` | The board section's linked task identity cell, clamped after two lines |
| Pills | `pill` | State/type chips — task statuses, executor types, the private repo mark; a pill's text is the whole message, never a color |

### Charts

| Primitive | Classes | Use for |
| --- | --- | --- |
| Frame | `chart-wrap`, `chart` | The overflow scroll and the SVG itself |
| Grid | `grid`, `grid-alt`, `tick`, `axis-label` | Gridlines (alt = dashed), ticks and labels — all `--ink-muted`/`--chart-grid` |
| Marks | `bar` (+ `bar-primary`, `bar-ok`, `bar-warn`, `bar-bad`), `line`, `dot` (+ `dot-warn`, `dot-bad`) | Series fills; `dot` default is `--lamp-done` |
| Partial | `bar-partial`, `bar-partial-hatch` | The hatch over a partial bucket (the current day/week), painted behind the bars — a non-color mark, grayscale-safe |
| Bucket target | `bucket-hit` | The transparent rect over each bucket; one roving tab stop, accent edge on `:focus-visible` |
| Tooltip | `chart-tooltip`, `chart-tooltip-box` | The active bucket's exact readout, rendered inside the SVG so it scales with it |
| Legend | `legend`, `legend-button`, `swatch`, `swatch-primary`, `swatch-ok`, `swatch-warn` | Series toggle buttons (`aria-pressed`); swatches stay in step with their marks and dim when the series is off |
| Caption | `chart-caption`, `chart-disclosure` | The one-line caption (keying the hatched partial bucket when one exists) and the calculation `<details>` after the chart |
| Empty | `chart-empty` | The all-hidden readout — **All series hidden** instead of a broken plot |

### Task conversation

| Primitive | Classes | Use for |
| --- | --- | --- |
| Exchange | `chat-exchange`, `msg-user`, `msg-meta`, `chat-exit` | One turn: prompt as plain prose (line breaks kept, not mono), metadata, exit code |
| Run article | `run-label`, `run-summary`, `run-output`, `run-well`, `run-work`, `run-publish` | One run's sections in reading order: labels (Request / Follow-up / Agent response / activity), the stored summary as flowing prose, the raw-output disclosure (collapsed behind a summary, expanded when it is all there is), the checks-and-publication focus anchor, the publish line |
| Runtime | `chat-runtime`, `chat-activity`, `task-summary`, `task-clock` | The "is it stuck or working" strips |
| Gates | `chat-gates`, `chat-gate-list`, `gate-passed`, `gate-failed`, `gate-running` | The verification-gate tree |
| Output | `chat-output` | The scrolled raw-run well (`--surface`) |
| Verdicts | `chat-resume`, `chat-toggle`, `chat-done`, `chat-stop`, `chat-remove` | The task's action buttons, status-tinted |
| Composer | `composer`, `composer-input`, `composer-row`, `composer-label`, `composer-select`, `task-compose`, `composer-field`, `composer-fields`, `composer-grid`, `composer-helper`, `composer-preflight`, `composer-start`, `composer-blocker`, `composer-param-error`, `composer-param-details` | The message input and its row; `task-compose` is the full-page variant. The guided composer (#176) stacks label-above-control `composer-field` groups — prompt, execution context in a `composer-grid` (one column until 768px), the workflow select, and the `composer-fields` parameter inputs — each with `composer-helper` guidance, a `composer-preflight` sentence before the `composer-start` action row (button, `kbd` shortcut, `composer-blocker` reason), per-field `composer-param-error` lines, and the raw rule only inside `composer-param-details`. A failed field tints its `.composer-select` edge via `aria-invalid` |
| Outcome | `task-outcome`, `task-outcome-summary`, `task-outcome-body`, `task-outcome-label` | The task page's summary disclosure: result, execution, verification, published work, services — one `<details>`, expanded by default, whose grid area flips from above the conversation (narrow) to a bounded right column (≥1024px) without a second component |
| Task head | `task-actions`, `task-layout`, `task-avatar` | The task's action row (now inside the page header), the outcome/conversation grid frame, attribution; the row wraps, so narrow screens drop its second line rather than clip it |
| Remove dialog | `task-remove`, `task-remove-title`, `task-remove-actions` | The remove confirmation over the task page (issue 178): raised with the `--line-strong` floating edge, the body copy carries every consequence, Cancel and the destructive Remove task end-aligned |
| Unsaved-changes dialog | `unsaved`, `unsaved-title`, `unsaved-actions` | The settings area's discard confirmation (issue 182), one instance raised by the dirty-draft coordinator before a blocked navigation or a repository switch: the remove dialog's floating shape, Continue editing safe-focused, Discard changes destructive |

### Environment panel

| Primitive | Classes | Use for |
| --- | --- | --- |
| Env | `env-tab`, `env-tabs`, `env-vars`, `env-pending`, `env-advanced-note`, `env-raw`, `env-errors` | The draft editor (issue 182): a real `tablist` of Variables/Secrets tabs whose selected tab is the `aria-selected` one, the scope's editable table, a pending-removal row that waits with its Undo until the whole-list save, the advanced `.env` disclosure's warning line, the textarea editor, and the row/scope validation lines. At ≤640px an `env-vars` row reflows into labeled groups via each cell's `data-label` |

### Configuration readiness

| Primitive | Classes | Use for |
| --- | --- | --- |
| Readiness | `readiness`, `readiness-item`, `readiness-item.is-ok`, `readiness-item.is-attention`, `readiness-item.is-pending`, `readiness-status`, `readiness-fact`, `readiness-action` | The configuration overview's five ordered items (#180): raised cards in a grid — two columns above 700px, one at and below it; the tone modifiers tint the item's edge through the status-border tokens while the status text carries the meaning (never color alone), and `overflow-wrap` keeps long paths from widening the page |
| Scope context | `scope-context`, `scope-context-label` | The readable scope/impact/editability block every environment editor renders before its controls (#180); the label is a small uppercase caption, the precedence sentence `muted` |

### Mobile navigation

| Primitive | Classes | Use for |
| --- | --- | --- |
| Drawer | `mobile-nav`, `mobile-nav-head`, `mobile-nav-title`, `mobile-nav-close`, `mobile-nav-count`, `mobile-nav-org` | The ≤900px navigation drawer (issue 160), a Headless UI `Dialog` rendered into the picker's `dialog-layer`/`dialog-backdrop`/`dialog-position` shell. Reuses `sidenav-link`/`sidenav-sublink`/`sidenav-newtask` inside; counts are plain sentences, never live regions, and no task preview rows render here |

### One-offs

`identity-head`, `identity-name` — the account page's identity section; `dashboard-controls` —
the dashboard's control row under the page header: the analytics toolbar, then the freshness
stamp and Refresh that moved here from the old global topbar (issues 160 and 159). Everything
else above is a family; these exist because
no family fits, and a new one-off needs a sentence here saying the same.

## Inventory

Every UI unit under `web/src`, mapped to the primitives it uses. Kept honest by
`web/test/styles.test.ts`: a new file under `components/`, `panels/`, `pages/` or `charts/` fails
the suite until it has a row, and a new class in `styles.css` fails until this document names it.

Components:

| File | Primitives |
| --- | --- |
| `AnalyticsToolbar.tsx` | analytics toolbar, rendered-data summary, range |
| `AppBar.tsx` | appbar, appearance, org, user-menu-button |
| `AppShell.tsx` | shell, page, skip-link, appbar, mobile-nav |
| `Card.tsx` | card |
| `DataTable.tsx` | table-wrap, data, sortable, th.asc, th.desc, align-end |
| `ExecutorDialog.tsx` | picker, status, muted |
| `KeyValues.tsx` | kv |
| `LoginGate.tsx` | login, appearance, public-header |
| `MobileNavDialog.tsx` | mobile-nav, sidenav, org |
| `OnboardingOrganization.tsx` | onboarding |
| `OrgSelector.tsx` | org |
| `PageHeader.tsx` | page-header |
| `PublicPageHeader.tsx` | public-header |
| `RangeSelector.tsx` | analytics toolbar, range, range-draft |
| `ConfigurationScope.tsx` | scope-context |
| `RelativeTime.tsx` | none — renders a `<time>` element only |
| `RepositorySetup.tsx` | panel, panel-head, table-wrap, data, pill, repo-search, scope-context, status, muted, primary |
| `repository-setup.ts` | helper — no markup |
| `ScopeToggle.tsx` | analytics toolbar, range-presets |
| `SideNav.tsx` | sidenav |
| `StatusBanner.tsx` | status |
| `ThemeSelector.tsx` | appearance |
| `TaskRemoveDialog.tsx` | picker (dialog shell), task-remove, status, chat-resume, chat-remove |
| `UnsavedChangesDialog.tsx` | picker (dialog shell), unsaved, chat-resume, chat-remove |
| `UserMenu.tsx` | user-menu-button, popover, user-menu-panel, avatar |
| `WorkflowParameterFields.tsx` | composer-field, composer-fields, composer-label, composer-select, composer-helper, composer-param-error, composer-param-details |

Panels (`env-raw.ts` is the `.env` raw-editor parser the env panel imports — a helper, not a panel):

| File | Primitives |
| --- | --- |
| `AccessTokensPanel.tsx` | panel, status |
| `ByUserPanel.tsx` | data, align-end, usage-track, usage-bar, task-avatar, by-user-user |
| `EnvVarsPanel.tsx` | panel, env |
| `IdentityPanel.tsx` | identity, avatar |
| `TrackedOrgsPanel.tsx` | panel, login-button |
| `RecentTasksPanel.tsx` | panel, alert, muted, data, task-title, task-avatar, by-user-user |
| `TaskComposer.tsx` | panel, composer, composer-field, composer-grid, composer-helper, composer-preflight, composer-start, composer-blocker, composer-param-details, kbd, chat-resume, task-compose |
| `TaskDetail.tsx` | task-layout, task-conversation, panel-head, panel, composer, status, muted |
| `TaskHeader.tsx` | page-header, pill, task head, popover, primary, chat-resume, chat-stop, chat-remove, chat-done |
| `TaskOutcome.tsx` | task-outcome, task-outcome-summary, task-outcome-body, task-outcome-label, panel, pill, msg-meta, chat-done, chat-stop, chat-exit, task-avatar, by-user-user, kv, muted, code |
| `TaskRun.tsx` | chat-exchange, run-label, run-summary, run-output, run-well, run-work, run-publish, msg-user, msg-meta, chat-runtime, chat-activity, chat-exit, chat-done, chat-stop, chat-gates, chat-gate-list, gate-passed, gate-failed, gate-running, chat-output, pill, muted, code |
| `TaskUsagePanel.tsx` | data, align-end, muted |
| `TelemetryFrame.tsx` | alert, badge |
| `TokenUsagePanel.tsx` | chart-wrap, legend, legend-button, swatch, chart-caption, chart-disclosure |
| `UsageSummaryPanel.tsx` | metric summary, badge |
| `WorkspaceExecutorsPanel.tsx` | panel, pill, table-wrap, data, muted |
| `env-draft.ts` | helper — no markup |
| `env-raw.ts` | helper — no markup |

Pages:

| File | Primitives |
| --- | --- |
| `AccountPage.tsx` | page-header, panel |
| `DashboardPage.tsx` | page-header, dashboard-controls |
| `OnboardingPage.tsx` | onboarding, appearance, public-header, status, muted, avatar, login-button, primary |
| `SettingsExecutorsPage.tsx` | page-header, panel, status, muted |
| `SettingsLayout.tsx` | none — renders the outlet |
| `SettingsOrganizationPage.tsx` | page-header, kv, scope-context, panel |
| `SettingsOverviewPage.tsx` | page-header, kv, panel, readiness |
| `SettingsRepositoriesPage.tsx` | page-header, repo-columns, scope-context, status, muted |
| `SettingsWorkspacePage.tsx` | page-header, scope-context, panel, status, muted |
| `TaskComposerPage.tsx` | page-header, status |
| `TaskDetailPage.tsx` | page-header, status |
| `TasksLayout.tsx` | none — renders the shell, sidenav and outlet |
| `TaskInboxPage.tsx` | page-header, inbox, inbox-filters, inbox-tabs, inbox-tab, inbox-search, inbox-sort, inbox-rows, inbox-row, inbox-status, inbox-title, inbox-activity, inbox-repo, inbox-author, inbox-when, inbox-empty, inbox-error, inbox-note, sidenav-dot, muted |

Charts (`scale.ts` is the band/linear scale helper — no markup):

| File | Primitives |
| --- | --- |
| `Axes.tsx` | grid, tick, axis-label |
| `BarChart.tsx` | bar, line, bucket-hit, bar-partial, bar-partial-hatch, chart-tooltip, chart-tooltip-box, chart-empty |
| `HBarChart.tsx` | bar |
| `Scatter.tsx` | dot, axis-label |
| `scale.ts` | helper — no markup |

A class used but not defined here (`visually-hidden`, `token-once`) is a hook with no styles or a
leftover — do not style it by inventing a rule without a row above.
