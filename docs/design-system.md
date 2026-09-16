# Design system

Read before: adding or restyling anything under `web/src`, touching `web/src/styles.css`, or
introducing a color.

The web app's styling is one stylesheet, `web/src/styles.css`: a token set in `:root`, then the
primitives that consume it. There is no CSS framework, no CSS-in-JS and no per-component files —
a component participates by carrying primitive classes, and every color it renders flows through a
token. `web/test/styles.test.ts` holds both lines: no color literal outside the `:root` block, and
every class the stylesheet defines appears in this document (the inventory cannot silently rot).

## Tokens

All 21 live in the `:root` block of `styles.css` — dark values only today, and that block is the
whole theme surface (issue 117 is a second `:root` block, not a restyle).

| Token | Role |
| --- | --- |
| `--bg` | Page canvas; also wells inside panels (chat output, textareas, list rows on hover) |
| `--panel` | Card and panel surface |
| `--panel-raised` | One step above `--panel`: controls, inline `code`, the avatar placeholder, hover fills |
| `--border` | Every hairline: panel edges, table row rules, control outlines |
| `--overlay` | Modal backdrop behind a `dialog` — `var()` resolves in `::backdrop` on every engine since the 2024 originating-element inheritance change (Chrome 122, Firefox 120, Safari 17.4) |
| `--text` | Primary foreground |
| `--muted` | Secondary foreground: labels, captions, ticks, disabled text |
| `--primary` | The accent: links, active controls, the default chart bar |
| `--on-primary` | Foreground on a `--primary` fill |
| `--ok` | Success / running / done |
| `--ok-border` | Status-tinted edge for an ok state (pills, quiet banners) |
| `--warn` | In-flight / queued / stopping |
| `--warn-border` | Status-tinted edge for a warn state |
| `--on-warn` | Foreground on a `--warn` fill |
| `--bad` | Failure / the synthetic-data badge |
| `--bad-border` | Status-tinted edge for a bad state |
| `--on-bad` | Foreground on a `--bad` fill |
| `--chart-grid` | Chart gridlines (a step darker than `--border` — lines behind data, not edges) |
| `--chart-neutral` | A data mark with no verdict: the parked scatter dot |
| `--chart-primary` | Chart series fill in the primary color, and its legend swatch |
| `--mono` | The monospace font stack — typography, not a color |

Rules the token set carries:

- **The surface ladder is `--bg` → `--panel` → `--panel-raised`, never a raw grey.** A new surface
  picks the rung that matches its elevation; nothing sits between them.
- **`--on-*` is foreground-on-a-fill, and exists for each fill that carries text.** A new
  text-bearing fill needs an `--on-*` token in the same change.
- **`--*-border` are the status edges** for controls that tint their outline instead of their
  surface (pills, quiet banners). They pair 1:1 with `--ok`/`--warn`/`--bad`.
- **`--primary` and `--chart-primary` are deliberately two blues.** The accent (`--primary`) colors
  text and control states; the series fill (`--chart-primary`) colors chart marks and swatches.
  `.bar`'s default and `button.primary` stay on `--primary` — unifying the two is a pixel change.
- **`color-scheme: dark` lives in exactly one place** (the `.range-custom input, .org-select`
  rule), so native controls pop in the page's scheme. A themed build moves it with the block.

## Primitives

What exists, and when to reach for which. Families first; one-offs at the end.

### Layout

| Primitive | Classes | Use for |
| --- | --- | --- |
| Shell | `shell`, `shell-main` | The two-column frame: sticky sidenav + scrolling main |
| Sidenav | `sidenav`, `sidenav-brand`, `sidenav-items`, `sidenav-link`, `sidenav-subitems` | The nav column; `sidenav-link.is-active` marks the page |
| Sidenav task tree | `sidenav-task`, `sidenav-task-title`, `sidenav-task-summary`, `sidenav-task-author`, `sidenav-newtask`, `sidenav-section`, `sidenav-empty` | Task rows under the nav; the title alone clips |
| Status dots | `sidenav-dot`, `sidenav-dot-running`, `sidenav-dot-stopping`, `sidenav-dot-paused`, `sidenav-dot-failed`, `sidenav-dot-done` | Task state as one painted pixel; running/stopping blink |
| Topbar | `topbar`, `topbar-actions` | The page head row and its control cluster |
| Grids | `two-up`, `task-layout` | Two-panel dashboards; conversation + sidebar |

### Surfaces and feedback

| Primitive | Classes | Use for |
| --- | --- | --- |
| Panel | `panel`, `panel-head`, `panel-actions` | The card a page section lives in; `+ warn` / `bad` tints the edge |
| Cards | `cards`, `card` | Numeric figure tiles inside a panel |
| Status line | `status`, `alert`, `error`, `muted` | One-line state text; `muted` for secondary prose anywhere |
| Badge | `badge`, `badge-warn` | Loud inline marker — reserved for synthetic data |
| Limits | `limits` | The bulleted limitations list |
| Screen-reader only | `sr-only` | Visually hidden, assistive-tech visible |

### Controls

| Primitive | Classes | Use for |
| --- | --- | --- |
| Button | `button` (element), `primary` | The default control; `primary` for the page's one main action |
| Range | `range-selector`, `range-presets`, `range-option.active`, `range-custom` | The date-range picker |
| Org | `org-selector`, `org-select` | The organization dropdown in the topbar |
| Login | `login-gate`, `login-button`, `login-error` | The signed-out screen |
| User menu | `user-menu`, `user-menu-login`, `user-menu-panel` | The topbar identity disclosure |
| Avatar | `avatar`, `avatar-fallback`, `avatar-lg` | Identity images; `-fallback` is the initial stand-in |
| Picker | `picker`, `picker-search`, `picker-list`, `picker-name`, `picker-actions` | The native `<dialog>` repo/executor pickers; backdrop uses `--overlay` |
| State marks | `active`, `is-active` | The active member of a toggle row or nav list |

### Data display

| Primitive | Classes | Use for |
| --- | --- | --- |
| Table | `table-wrap`, `data`, `sortable`, `th.asc`, `th.desc` | Every tabular readout; the wrap scrolls, never shrinks |
| Key-values | `kv` | The dt/dd definition grid |
| Per-user | `by-user`, `by-user-user` | The attribution table and its avatar+name cell |
| Pills | `pill`, `pill-ready`, `pill-cloning`, `pill-queued`, `pill-failed`, `pill-reason` | Repo/workspace state chips; the reason travels in the pill |

### Charts

| Primitive | Classes | Use for |
| --- | --- | --- |
| Frame | `chart-wrap`, `chart` | The overflow scroll and the SVG itself |
| Grid | `grid`, `grid-alt`, `tick`, `axis-label` | Gridlines (alt = dashed), ticks and labels — all `--muted`/`--chart-grid` |
| Marks | `bar` (+ `bar-primary`, `bar-ok`, `bar-warn`, `bar-bad`), `line`, `dot` (+ `dot-warn`, `dot-bad`) | Series fills; `dot` default is `--chart-neutral` |
| Legend | `legend`, `swatch`, `swatch-primary`, `swatch-ok` | The color key; swatches stay in step with their bars |

### Task conversation

| Primitive | Classes | Use for |
| --- | --- | --- |
| Exchange | `chat-exchange`, `msg-user`, `msg-meta`, `chat-exit`, `chat-detail` | One turn: prompt, metadata, exit code |
| Runtime | `chat-runtime`, `chat-activity`, `task-summary`, `task-clock` | The "is it stuck or working" strips |
| Gates | `chat-gates`, `chat-gate-list`, `gate-passed`, `gate-failed`, `gate-running` | The verification-gate tree |
| Output | `chat-output` | The scrolled raw-run well (`--bg`) |
| Verdicts | `chat-resume`, `chat-toggle`, `chat-done`, `chat-stop`, `chat-remove` | The task's action buttons, status-tinted |
| Composer | `composer`, `composer-input`, `composer-row`, `composer-label`, `composer-select`, `task-compose` | The message input and its row; `task-compose` is the full-page variant |
| Task head | `task-actions`, `task-layout`, `task-queued-by`, `task-avatar` | The control row, the two-column frame, attribution |

### Environment panel

| Primitive | Classes | Use for |
| --- | --- | --- |
| Env | `env-tab`, `env-tabs`, `env-raw`, `env-errors` | The Variables/Secrets tab strip and the raw `.env` editor toggle |

### One-offs

`identity-head`, `identity-name` — the settings page's identity section; `dashboard-controls` —
the topbar's control row on the dashboard. Everything else above is a family; these exist because
no family fits, and a new one-off needs a sentence here saying the same.

## Inventory

Every UI unit under `web/src`, mapped to the primitives it uses. Kept honest by
`web/test/styles.test.ts`: a new file under `components/`, `panels/`, `pages/` or `charts/` fails
the suite until it has a row, and a new class in `styles.css` fails until this document names it.

Components:

| File | Primitives |
| --- | --- |
| `AppShell.tsx` | shell |
| `Card.tsx` | card |
| `DataTable.tsx` | table |
| `ExecutorDialog.tsx` | picker, status |
| `KeyValues.tsx` | kv |
| `Limitations.tsx` | panel, limits |
| `LoginGate.tsx` | login |
| `OrgSelector.tsx` | org |
| `RangeSelector.tsx` | range |
| `RepoPickerDialog.tsx` | picker, pill, status |
| `RepoStatus.tsx` | pill |
| `ScopeToggle.tsx` | range-presets, sr-only |
| `SideNav.tsx` | sidenav |
| `StatusBanner.tsx` | status |
| `TopBar.tsx` | topbar |
| `UserMenu.tsx` | user-menu, avatar |

Panels (`env-raw.ts` is the raw-`.env` parser the env panel imports — a helper, not a panel):

| File | Primitives |
| --- | --- |
| `AccessTokensPanel.tsx` | panel, status |
| `AiUsagePanel.tsx` | cards |
| `ByUserPanel.tsx` | by-user, chart-wrap, task-avatar |
| `DataQualityPanel.tsx` | panel warn |
| `EnvVarsPanel.tsx` | panel, env |
| `IdentityPanel.tsx` | identity, avatar |
| `RecentTasksPanel.tsx` | panel, by-user, chart-wrap, task-avatar, alert |
| `TaskComposer.tsx` | panel, composer, chat-resume, task-compose |
| `TaskDetail.tsx` | task-layout, chat, gate, composer, pill, task head |
| `TaskSide.tsx` | panel, pill, chat-done, chat-exit, msg-meta, task-avatar |
| `TaskUsagePanel.tsx` | cards, card |
| `TelemetryFrame.tsx` | alert, badge |
| `TokenUsagePanel.tsx` | chart-wrap, legend, swatch |
| `WorkspaceExecutorsPanel.tsx` | panel, pill, table |
| `WorkspaceReposPanel.tsx` | panel, table |
| `env-raw.ts` | helper — no markup |

Pages:

| File | Primitives |
| --- | --- |
| `DashboardPage.tsx` | dashboard-controls |
| `EnvPage.tsx` | panel |
| `SettingsPage.tsx` | panel |
| `TaskComposerPage.tsx` | status |
| `TaskDetailPage.tsx` | status |
| `TasksLayout.tsx` | none — renders the shell, sidenav and outlet |
| `WorkspacePage.tsx` | panel |

Charts (`scale.ts` is the band/linear scale helper — no markup):

| File | Primitives |
| --- | --- |
| `Axes.tsx` | grid, tick, axis-label |
| `BarChart.tsx` | bar, line |
| `HBarChart.tsx` | bar |
| `Scatter.tsx` | dot, axis-label |
| `scale.ts` | helper — no markup |

A class used but not defined here (`scope-toggle`, `visually-hidden`, `token-once`, …) is a hook
with no styles or a leftover — do not style it by inventing a rule without a row above.
