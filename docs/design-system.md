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
  `data-theme="light"` on `<html>` swaps the palette with no CSS regeneration. The toggle,
  persistence and `prefers-color-scheme` handling are issue 117; the light palette shipped with
  the theme (#148).
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
| Status dots | `sidenav-dot`, `sidenav-dot-running`, `sidenav-dot-stopping`, `sidenav-dot-paused`, `sidenav-dot-failed`, `sidenav-dot-done` | Task state as one painted pixel; running/stopping breathe (halo via `lamp-glow`) |
| App bar | `appbar`, `appbar-trigger`, `appbar-brand`, `appbar-org`, `appbar-actions` | The global chrome row: sticky, raised, no `h1`; org selector and account menu end-aligned. The trigger (`aria-controls="mobile-nav"`) and the brand reveal at ≤900px, where the org moves into the drawer |
| Page header | `page-header`, `page-header-eyebrow`, `page-header-leading`, `page-header-description`, `page-header-meta`, `page-header-actions` | The routed page's one `h1` and its slots: eyebrow, title + description lead, meta and actions trail (issue 159) |
| Grids | `two-up`, `task-layout` | Two-panel dashboards; conversation + sidebar |

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

| Primitive | Classes | Use for |
| --- | --- | --- |
| Button | `button` (element), `primary` | The default control; `primary` for the page's one main action |
| Popover | `popover`, `popover-option` | The shared floating surface for the anchored Headless UI panels — user menu, org and composer listboxes; `data-focus`/`data-selected` state the options; dialogs sit at z-index 40, popovers at 30 |
| Range | `range-selector`, `range-presets`, `range-option.active`, `range-custom` | The date-range picker |
| Org | `org-selector`, `org-select` | The organization switcher in the app bar, or in the navigation drawer at ≤900px (Headless UI Listbox) |
| Login | `login-gate`, `login-button`, `login-error` | The signed-out screen |
| Onboarding | `onboarding`, `onboarding-orgs`, `onboarding-org`, `onboarding-repos` | The sign-in selection screen (#125): the centered column, the org checkbox list, one org's bordered row and its repo checkboxes |
| User menu | `user-menu-button`, `user-menu-login`, `user-menu-panel`, `popover` | The app bar's identity disclosure (Headless UI Menu) |
| Avatar | `avatar`, `avatar-fallback`, `avatar-lg` | Identity images; `-fallback` is the initial stand-in |
| Picker | `picker`, `picker-search`, `picker-list`, `picker-name`, `picker-option`, `picker-actions`, `dialog-layer`, `dialog-backdrop`, `dialog-position` | The Headless UI Dialog/Combobox repo/executor pickers; options carry `data-focus`/`data-selected`; the backdrop div uses `--overlay` |
| State marks | `active`, `is-active` | The active member of a toggle row or nav list |

### Data display

| Primitive | Classes | Use for |
| --- | --- | --- |
| Table | `table-wrap`, `data`, `sortable`, `align-end`, `th.asc`, `th.desc` | Every tabular readout; the wrap scrolls, never shrinks — a named, keyboard-focusable `<section>` (the region role, implicitly), so a scrolled-off column stays reachable. Sort controls are real buttons inside the `th`; the active column carries `aria-sort` (and the `th.asc`/`th.desc` arrow), sorting reads raw values with nulls last in both directions, and rows are keyed by caller-chosen stable keys. `align-end` right-aligns a numeric column's header and cells. |
| Key-values | `kv` | The dt/dd definition grid |
| Per-user | `by-user-user` | The avatar+name cell the attribution and board tables share |
| Usage bar | `usage-track`, `usage-bar` | The proportional New-tokens bar in the by-user table: a sunken-well track with a chart-blue fill, `aria-hidden` — width is decoration, the cell's accessible name carries the exact figure |
| Task title | `task-title` | The board section's linked task identity cell, clamped after two lines |
| Pills | `pill`, `pill-ready`, `pill-cloning`, `pill-queued`, `pill-failed`, `pill-reason` | Repo/workspace state chips; the reason travels in the pill |

### Charts

| Primitive | Classes | Use for |
| --- | --- | --- |
| Frame | `chart-wrap`, `chart` | The overflow scroll and the SVG itself |
| Grid | `grid`, `grid-alt`, `tick`, `axis-label` | Gridlines (alt = dashed), ticks and labels — all `--ink-muted`/`--chart-grid` |
| Marks | `bar` (+ `bar-primary`, `bar-ok`, `bar-warn`, `bar-bad`), `line`, `dot` (+ `dot-warn`, `dot-bad`) | Series fills; `dot` default is `--lamp-done` |
| Legend | `legend`, `swatch`, `swatch-primary`, `swatch-ok` | The color key; swatches stay in step with their bars |

### Task conversation

| Primitive | Classes | Use for |
| --- | --- | --- |
| Exchange | `chat-exchange`, `msg-user`, `msg-meta`, `chat-exit`, `chat-detail` | One turn: prompt, metadata, exit code |
| Runtime | `chat-runtime`, `chat-activity`, `task-summary`, `task-clock` | The "is it stuck or working" strips |
| Gates | `chat-gates`, `chat-gate-list`, `gate-passed`, `gate-failed`, `gate-running` | The verification-gate tree |
| Output | `chat-output` | The scrolled raw-run well (`--surface`) |
| Verdicts | `chat-resume`, `chat-toggle`, `chat-done`, `chat-stop`, `chat-remove` | The task's action buttons, status-tinted |
| Composer | `composer`, `composer-input`, `composer-row`, `composer-label`, `composer-select`, `task-compose` | The message input and its row; `task-compose` is the full-page variant |
| Task head | `task-actions`, `task-layout`, `task-queued-by`, `task-avatar` | The task's action row (now inside the page header), the two-column frame, attribution |

### Environment panel

| Primitive | Classes | Use for |
| --- | --- | --- |
| Env | `env-tab`, `env-tabs`, `env-raw`, `env-errors` | The Variables/Secrets tab strip and the `.env` raw editor |

### Mobile navigation

| Primitive | Classes | Use for |
| --- | --- | --- |
| Drawer | `mobile-nav`, `mobile-nav-head`, `mobile-nav-title`, `mobile-nav-close`, `mobile-nav-count`, `mobile-nav-org` | The ≤900px navigation drawer (issue 160), a Headless UI `Dialog` rendered into the picker's `dialog-layer`/`dialog-backdrop`/`dialog-position` shell. Reuses `sidenav-link`/`sidenav-sublink`/`sidenav-newtask` inside; counts are plain sentences, never live regions, and no task preview rows render here |

### One-offs

`identity-head`, `identity-name` — the account page's identity section; `dashboard-controls` —
the dashboard's range/scope row under the page header, which carries the telemetry caption and
Refresh that moved here from the old global topbar (issues 160 and 159). Everything else above
is a family; these exist because
no family fits, and a new one-off needs a sentence here saying the same.

## Inventory

Every UI unit under `web/src`, mapped to the primitives it uses. Kept honest by
`web/test/styles.test.ts`: a new file under `components/`, `panels/`, `pages/` or `charts/` fails
the suite until it has a row, and a new class in `styles.css` fails until this document names it.

Components:

| File | Primitives |
| --- | --- |
| `AppBar.tsx` | appbar, org, user-menu-button |
| `AppShell.tsx` | shell, page, skip-link, appbar, mobile-nav |
| `Card.tsx` | card |
| `DataTable.tsx` | table-wrap, data, sortable, th.asc, th.desc, align-end |
| `ExecutorDialog.tsx` | picker, status |
| `KeyValues.tsx` | kv |
| `LoginGate.tsx` | login |
| `MobileNavDialog.tsx` | mobile-nav, sidenav, org |
| `OrgSelector.tsx` | org |
| `PageHeader.tsx` | page-header |
| `RangeSelector.tsx` | range |
| `RelativeTime.tsx` | none — renders a `<time>` element only |
| `RepoPickerDialog.tsx` | picker, pill, status |
| `RepoStatus.tsx` | pill |
| `ScopeToggle.tsx` | range-presets |
| `SideNav.tsx` | sidenav |
| `StatusBanner.tsx` | status |
| `UserMenu.tsx` | user-menu-button, popover, user-menu-panel, avatar |

Panels (`env-raw.ts` is the `.env` raw-editor parser the env panel imports — a helper, not a panel):

| File | Primitives |
| --- | --- |
| `AccessTokensPanel.tsx` | panel, status |
| `AiUsagePanel.tsx` | cards |
| `ByUserPanel.tsx` | data, align-end, usage-track, usage-bar, task-avatar, by-user-user |
| `EnvVarsPanel.tsx` | panel, env |
| `IdentityPanel.tsx` | identity, avatar |
| `TrackedOrgsPanel.tsx` | panel, login-button |
| `RecentTasksPanel.tsx` | panel, alert, muted, data, task-title, task-avatar, by-user-user |
| `TaskComposer.tsx` | panel, composer, chat-resume, task-compose |
| `TaskDetail.tsx` | task-layout, chat, gate, composer, pill |
| `TaskHeader.tsx` | page-header, pill, task head |
| `TaskSide.tsx` | panel, pill, chat-done, chat-exit, msg-meta, task-avatar |
| `TaskUsagePanel.tsx` | data, align-end, muted |
| `TelemetryFrame.tsx` | alert, badge |
| `TokenUsagePanel.tsx` | chart-wrap, legend, swatch |
| `WorkspaceExecutorsPanel.tsx` | panel, pill, table |
| `WorkspaceReposPanel.tsx` | panel, table |
| `env-raw.ts` | helper — no markup |

Pages:

| File | Primitives |
| --- | --- |
| `AccountPage.tsx` | page-header, panel |
| `DashboardPage.tsx` | page-header, dashboard-controls |
| `OnboardingPage.tsx` | onboarding, panel, status, muted |
| `SettingsExecutorsPage.tsx` | page-header, panel |
| `SettingsLayout.tsx` | none — renders the outlet |
| `SettingsOrganizationPage.tsx` | page-header, panel |
| `SettingsRepositoriesPage.tsx` | page-header, panel |
| `SettingsWorkspacePage.tsx` | page-header, panel |
| `TaskComposerPage.tsx` | page-header, status |
| `TaskDetailPage.tsx` | page-header, status |
| `TasksLayout.tsx` | none — renders the shell, sidenav and outlet |

Charts (`scale.ts` is the band/linear scale helper — no markup):

| File | Primitives |
| --- | --- |
| `Axes.tsx` | grid, tick, axis-label |
| `BarChart.tsx` | bar, line |
| `HBarChart.tsx` | bar |
| `Scatter.tsx` | dot, axis-label |
| `scale.ts` | helper — no markup |

A class used but not defined here (`visually-hidden`, `token-once`) is a hook with no styles or a
leftover — do not style it by inventing a rule without a row above.
