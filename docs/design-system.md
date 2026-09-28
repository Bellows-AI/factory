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
literal may appear. The palette is the Bellows redesign's (plan §1.1, 2026-09-26), sampled from
the concept screens and adjusted to pass contrast; the values are written in `oklch`, and the hex
column is for review only — it never appears in code.

Dark (`:root`, the default):

| Token | Role | Value | Hex |
| --- | --- | --- | --- |
| `--surface-sunken` | Inputs, textareas, code and log wells, `kbd` | `oklch(0.170 0.016 249)` | `#0a1016` |
| `--surface` | Page canvas, sidebar, top bar | `oklch(0.189 0.017 253)` | `#0e141b` |
| `--surface-raised` | Cards, panels, table bodies, menus, dialogs | `oklch(0.227 0.021 252)` | `#151d26` |
| `--surface-strong` | Hover fills (secondary button), the disabled primary fill, the avatar disc — never under status text | `oklch(0.281 0.026 253)` | `#202a36` |
| `--line` | Every hairline: panel edges, row rules, card borders | `oklch(0.273 0.024 254)` | `#1f2833` |
| `--line-strong` | Input and secondary-button borders, the dialog edge | `oklch(0.347 0.028 251)` | `#2f3b48` |
| `--ink` | Primary foreground | `oklch(0.938 0.010 253)` | `#e6ebf1` |
| `--ink-muted` | Secondary text, labels, placeholders, disabled text | `oklch(0.717 0.028 254)` | `#98a5b5` |
| `--ink-inverse` | Text on an accent fill | `oklch(0.174 0.030 251)` | `#06111d` |
| `--accent` | Bellows blue: primary buttons, links, focus rings, "your turn" | `oklch(0.720 0.142 251)` | `#5aa9fa` |
| `--lamp-run` | Running, passed, ready — the green lamp | `oklch(0.775 0.162 154)` | `#4fd384` |
| `--lamp-wait` | Warnings only: banners, "setting up", unsaved changes, the sessions line | `oklch(0.774 0.143 80)` | `#e5aa35` |
| `--lamp-stop` | Failed, destructive, invalid — the red lamp | `oklch(0.688 0.172 17)` | `#f26673` |
| `--lamp-done` | Done, queued, waiting for review, parked — the grey lamp | `oklch(0.657 0.029 252)` | `#8593a3` |

Light (`:root[data-theme="light"]`):

| Token | Value | Hex |
| --- | --- | --- |
| `--surface-sunken` | `oklch(0.960 0.008 254)` | `#eef2f7` |
| `--surface` | `oklch(0.978 0.005 258)` | `#f6f8fb` |
| `--surface-raised` | `oklch(1 0 0)` | `#ffffff` |
| `--surface-strong` | `oklch(0.935 0.013 256)` | `#e4eaf2` |
| `--line` | `oklch(0.926 0.013 256)` | `#e1e7ef` |
| `--line-strong` | `oklch(0.853 0.021 250)` | `#c5d0dc` |
| `--ink` | `oklch(0.216 0.036 258)` | `#0f1a2a` |
| `--ink-muted` | `oklch(0.477 0.037 256)` | `#4f5e72` |
| `--ink-inverse` | `oklch(1 0 0)` | `#ffffff` |
| `--accent` | `oklch(0.540 0.179 258)` | `#1d6ad4` — blue, not the purple of the light concept screens |
| `--lamp-run` | `oklch(0.512 0.120 155)` | `#147a46` |
| `--lamp-wait` | `oklch(0.531 0.119 65)` | `#9a5b00` |
| `--lamp-stop` | `oklch(0.553 0.188 21)` | `#c9303e` |
| `--lamp-done` | `oklch(0.520 0.031 257)` | `#5e6a7b` |

Derived tokens, mixed per theme with `color-mix(in oklab, …)` — each recipe reads against that
block's tokens, and where a pair's contrast demands it the two blocks deliberately diverge (the
`--on-*` and wash rows say which):

| Token | Role | Recipe |
| --- | --- | --- |
| `--overlay` | Modal backdrop behind a Headless UI dialog (the `.dialog-backdrop` div) | ink 60% over transparent |
| `--ok-border` | Status-tinted edge for a run state (pills, banners) | lamp-run 30% over surface-raised |
| `--warn-border` | Status-tinted edge for a warning | lamp-wait 30% over surface-raised |
| `--bad-border` | Status-tinted edge for a stop state; the danger button's outline | lamp-stop 30% over surface-raised |
| `--ok-wash` | The `pill-ok` fill | dark: lamp-run 16% over transparent · light: lamp-run 8% over surface-raised |
| `--warn-wash` | The `banner-warn` and `pill-warn` fill | dark: lamp-wait 16% over transparent · light: lamp-wait 8% over surface-raised |
| `--bad-wash` | The `pill-bad` and `banner-bad` fill; the danger button's hover | dark: lamp-stop 14% over transparent (16% measured 4.52:1, too tight) · light: lamp-stop 8% over surface-raised |
| `--done-wash` | The `pill-done` fill | dark: lamp-done 10% over transparent (16% measured 4.27:1, a fail) · light: lamp-done 8% over surface-raised |
| `--accent-wash` | `pill-accent`, `inbox-chip`, `banner-info`; a selector trigger's hover/focus/open highlight and an option row's hover/focus fill (issue 224) | dark: accent 16% over transparent · light: accent 8% over surface-raised (was 12% over transparent; 10% measured 4.50:1) |
| `--accent-hover` | The primary button's hover fill | accent 88% over ink |
| `--accent-border` | The `inbox-chip` and `banner-info` edge (decorative) | accent 30% over surface-raised |
| `--on-warn` | Foreground on a lamp-wait fill | dark: black 88% over lamp-wait · light: `var(--ink-inverse)` — the light theme's deep amber cannot carry a darker ink at AA |
| `--on-bad` | Foreground on a lamp-stop fill | dark: black 88% over lamp-stop (the dark theme's red is bright enough to wash light text below AA) · light: white 92% over lamp-stop |
| `--chart-grid` | Chart gridlines — a step behind `--line` (lines behind data, not edges) | line 60% over surface |
| `--chart-primary` | Chart series fill and its legend swatch | accent 70% over black |
| `--lamp-glow` | The halo behind a breathing lamp | currentColor 26% over transparent |
| `--shadow-float` | The floating popover's and dialog's soft shadow (issue 224) | black 40% (dark) / ink 14% (light) over transparent |

Typography and shape tokens live in the static `@theme` block (`@theme static`, so they are
emitted even where only a `var()` points at them):

| Token | Role |
| --- | --- |
| `--font-sans` | Barlow — body text and headings alike |
| `--font-mono` | IBM Plex Mono — identifiers and logs |
| `--radius-md` | 4px — pills, `kbd`, inline code, checkboxes |
| `--radius-lg` | 6px — buttons, inputs, selectors |
| `--radius-xl` | 8px — panels, dialogs, banners |

Rules the token set carries:

- **The surface ladder is `--surface-sunken` → `--surface` → `--surface-raised` →
  `--surface-strong`, never a raw grey.** Sunken sits below the canvas (controls, wells); raised
  sits above it (cards, dialogs); strong is the hover and disabled fill. A new surface picks the
  rung that matches its elevation; nothing sits between them.
- **Status text is always a `--lamp-*` (or `--accent`) on its own `--*-wash`, or on raised or
  canvas.** Never on `--surface-strong` without re-measuring: the composite probe in
  `e2e/polish.spec.ts` covers the washes, not that pairing.
- **The light washes are opaque tints; the dark ones are translucent.** The plan's recipe was 8%
  over transparent in both themes, but over the light canvas or a sunken row that veil darkens the
  ground enough to sink `pill-bad` to 4.41:1 and `pill-accent` to 4.37:1 (4.18 and 4.14 on
  sunken). Mixed into `--surface-raised` instead, each light wash reads the same on every surface
  — 4.64:1 or better — and matches the translucent version on a panel. The dark washes clear AA on
  all three surfaces as written. The composite probe measures every pill, chip and banner on
  raised, canvas and sunken, plus the button fills, in both themes.
- **`--on-*` is foreground-on-a-fill, and exists for each fill that carries text.** A new
  text-bearing fill needs an `--on-*` token in the same change (derived, like the rest).
- **`--*-border` are the status edges** for pills and banners. They pair 1:1 with
  `--lamp-run`/`--lamp-wait`/`--lamp-stop`, as the `--*-wash` fills do (plus `--done-wash`).
- **`--accent` and `--chart-primary` are deliberately two blues.** The accent colors text and
  control states — it is the "your turn" blue, so it stays quiet; the series fill leans on its hue
  but sits deeper. `.bar`'s default and `button.primary` stay on `--accent` — unifying the two is
  a pixel change.
- **Tokens with no call site do not exist.** The suite fails on a defined-but-unused token
  (`--ink-faint` was pruned for exactly this). None of the new tokens is exposed in `@theme inline`:
  no utility spells them, and an exposure is not a call site.

### Status semantics

One table, used everywhere a task state is drawn (plan §1.2). **Blue is your turn, green is the
machine working or finished well, red is failed, grey is parked or nobody's turn, amber is for
warnings only** — banners, checkout in progress, unsaved changes; it is no longer a task state.
The text label is always present and the icon is `aria-hidden`; a zero count or exit code 0
never renders red.

| Presentation | Pill | Icon | Dot |
| --- | --- | --- | --- |
| Queued | `pill-done` | `clock` | `sidenav-dot-paused` |
| Running | `pill-ok` | the embedded `sidenav-dot-running` | `sidenav-dot-running` |
| Stopping | `pill-done` | the embedded `sidenav-dot-stopping` | `sidenav-dot-stopping` |
| Waiting for review | `pill-done` + a 1px `--line-strong` border | `clock` | `sidenav-dot-paused` |
| Succeeded · Needs review | `pill-accent` | `circle-dot` | `sidenav-dot-review` |
| Failed · Needs review | `pill-bad` | `alert-circle` | `sidenav-dot-failed` |
| Stopped · Needs review | `pill-done` | `minus-circle` | the plain dot |
| Done | `pill-done` | `check-circle` in `--lamp-run` | `sidenav-dot-done` |
| Verification failed | `pill-bad` | `alert-circle` | — |
| Verification passed | `pill-ok` | `check-circle` | — |

### Type scale

Barlow for body and headings, IBM Plex Mono for identifiers and logs. The base layer sets the
three heading levels; the rest are the named primitives' own rules.

| Role | Where | Size / line-height / weight |
| --- | --- | --- |
| Page title | `h1` (the `page-header`'s) | 28 / 36 / 600, tracking −0.01em; 24 / 32 at ≤640px |
| Page description | `page-header-description` | 15 / 22 / 400, `--ink-muted`, 72ch |
| Section title | `h2` | 18 / 26 / 600 |
| Sub-section | `h3` | 15 / 22 / 600 |
| Body, controls | `body` | 14 / 21 / 400 |
| Supporting text | helpers, row summaries | 13 / 18 / 400, `--ink-muted` |
| Rail eyebrow | `task-outcome-label` (and `run-label`) | 12 / 16 / 600, uppercase, 0.06em, `--ink-muted` |
| Status pill | `pill` | 12 / 16 / 600 |
| Metric value | `card strong`, `usage-group strong` | 28 / 34 / 600, tabular figures |

### Spacing, radius, sizes

- **Spacing** comes from one scale — 4, 8, 12, 16, 24, 32, 48px. A rule that is touched moves its
  off-scale values (5, 6, 7, 9, 10, 14, 20) onto it; untouched rules are not swept.
- **Radius**: `--radius-md` (4px) for pills, `kbd` and checkboxes, `--radius-lg` (6px) for
  controls, `--radius-xl` (8px) for panels, dialogs and banners; 50% for avatars and dots, 999px
  for the filter chip's capsule. Nothing else.
- **Elevation** is borders and fill; `0 8px 24px var(--shadow-float)` only on popovers and dialogs.
- **Panels** pad 24px, 16px at ≤640px.
- **Controls**: 40px on desktop, set in the primitives' own rules (`button.primary`, `.field`,
  `.select-trigger`, `.page-header-actions button`); the three 36px floor rules stay the floor,
  and the shared touch-target rule raises everything on its list to 44px at ≤900px.

## Type, targets, motion, forced colors

The application-wide interaction contracts (issue 189). `web/test/styles.test.ts` pins them as
static suites; `e2e/polish.spec.ts` measures the rendered values in both themes.

- **Type floors.** Decision-bearing text — navigation, task information, form labels and
  helpers, statuses, metadata — never renders under 12px; buttons, inputs, selects and tabs
  carry 14px through `font: inherit`. The one documented exception is `.tick`: the narrowest
  plot's mono ticks sit at 11px, with collision covered by the overflow matrix; chart axis
  labels stay at 12px. Muted text renders its token bare — no extra `opacity` on top, or the
  audited pair is not the rendered one.
- **Control sizes.** Desktop controls clear 36px in height: the `button` element, non-checkbox
  `input`/`select` (a base-layer floor — there is no global input skin), and the `.inbox-tab`
  links. `.toolbar-value` is exempt — it echoes a value, it is not a control. Sidenav links are
  prose navigation, and inline prose links are exempt everywhere. At ≤900px the compact shell's
  control list (navigation, filters, task actions, dialog actions, editor tabs, composer
  controls) clears 44px — the smallest reliable finger target; new mobile-visible controls join
  that one rule, which lives in the shared touch-target block at the end of the layer.
- **Focus.** The shared ring is a two-pixel accent outline with a two-pixel gap, applied to
  every focusable control through a zero-specificity `:where(...):focus-visible` rule so
  self-skinned primitives never have to fight it. The chart's `.bucket-hit` paints its own
  accent stroke — the ring's equivalent on an SVG rect. The skip link is the first stop and
  lands on `#main-content`.
- **Motion.** One ambient animation exists — the breathing running/stopping lamp. Under
  `prefers-reduced-motion: reduce` it stills at full strength: the classes keep their color,
  shape, halo and adjacent text, so no state ever rides on the movement. There are no CSS
  transitions: state changes are instantaneous, and none may be added through intermediate
  color sweeps.
- **Forced colors.** Under `forced-colors: active` the system repaint carries the UI — tokens
  resolve, borders and fills survive. The one casualty is the accent ring, whose color is
  pinned to the system highlight so keyboard focus stays visible.
- **Deliberately decorative pairs.** Chart gridlines (`--chart-grid`, ~1.2–1.5:1) and the
  `--line`/`--line-strong` hairlines (~1.3–2.3:1) sit below the 3:1 boundary threshold on
  purpose: gridlines carry no data, and a hairline never carries meaning alone — grouping comes
  from the sunken fill, the label, or the text beside it. Status meaning rides on text plus
  tint, never tint alone.

## Primitives

What exists, and when to reach for which. Families first. The names are the pre-theme names (#148
re-tokenized them, it did not rename them), so the inventory rows stand.

**The specimen** (#275) renders these primitives in every state they have — default, selected,
invalid, disabled, busy, a 60-character unbroken label — in one grid, from this stylesheet and the
real components: `e2e/specimen/main.tsx`, served by its own test-only Vite server and shot by
`e2e/specimen.spec.ts` (the `specimen` Playwright project). Hover and focus-visible are reached
with the pointer and the keyboard, never with a class. Its four sheets, committed under
`docs/plans/bellows-redesign-2026-09-26/specimen/`, are the reference the redesign lanes match; a
new shared primitive gets a row there, and the sheets are re-shot when one changes. Its own layout
lives in `e2e/specimen/specimen.css` — grid only, tokens by `var()`, held to this file's color and
motion rules by `web/test/styles.test.ts`.

`@layer components` is laid out in the order of this section: the shared primitives first, then
one `/* ── region: <name> ── */` banner per lane — `inbox`, `composer`, `task-detail`,
`settings`, `dashboard`, `entry` — and last, outside every region, the
`/* ── shared: touch targets ── */` block that holds the one ≤900px 44px rule. A lane edits only
its own region and its own rows below, plus append-only lines (its own selectors, one per line) in
the touch-target list; a shared primitive changes in its shared section. The touch-target block
sits last so it outranks each region's own control rules at equal specificity; the two members
whose region rule used to follow it — `settings-toggle`'s `display: flex` and
`repo-search input`'s `min-width` — restate that value right after the list.

### Shared

#### Layout

| Primitive | Classes | Use for |
| --- | --- | --- |
| Shell | `shell`, `shell-main` | The two-column frame: a 224px sticky sidenav that scrolls within `100dvh`, and the content track |
| Page | `page` | The routed page's content container, carried by the shell's one `main` region (`#main-content`, the skip link's target): 1400px cap, `min-width: 0` — a class, not a `main` selector, so a dialog never inherits page chrome |
| Skip link | `skip-link` | The off-screen "Skip to main content" anchor that slides in on `:focus-visible`, the first focusable element on every page |
| Sidenav | `sidenav`, `sidenav-brand`, `sidenav-items`, `sidenav-link`, `sidenav-count`, `sidenav-sublink`, `sidenav-subitems` | The nav column (issue 274). `sidenav-brand` is the text wordmark (15px/600, 0.12em) on the app bar's 56px line. `sidenav-link` is 40px tall, 6px radius, 12px padding, a 20px glyph (`home`/`list`/`settings`) before the label; muted at rest, `--surface-strong` fill with `--ink` text on hover and when `.is-active`, and only the active item's glyph takes `--accent`. `sidenav-count` is the Tasks item's review-count pill (`--surface-strong`, 12px/600, tabular-nums), hidden at 0 and off `/tasks*`; it is `aria-hidden` and the link's `aria-label` speaks it ("Tasks, 12 tasks need review"). `sidenav-sublink.is-active` marks the settings section; the Settings tree opens with Overview (`/settings`, end-matched), which owns `aria-current="page"` there — the parent Settings link is lit but always `aria-current="false"` |
| Sidenav task tree | `sidenav-preview`, `sidenav-task`, `sidenav-task-title`, `sidenav-task-summary`, `sidenav-task-author`, `sidenav-newtask`, `sidenav-section`, `sidenav-empty` | Task rows under the nav, 13px; the title alone clips. The whole preview is one `<details open className="sidenav-preview">` whose `<summary>` is `sidenav-section` (the count line, 12px/600 muted, native marker); its open state is SideNav's local state, never stored. An organization with no tasks gets the plain `sidenav-empty` sentence and no disclosure |
| Status dots | `sidenav-dot`, `sidenav-dot-running`, `sidenav-dot-stopping`, `sidenav-dot-paused`, `sidenav-dot-failed`, `sidenav-dot-done`, `sidenav-dot-review` | Task state as one painted pixel, a lookup on `taskTone`; running/stopping breathe (halo via `lamp-glow`); review (a success the user has not closed) is `--accent` |
| App bar | `appbar`, `appbar-trigger`, `appbar-brand`, `appbar-org`, `appbar-actions` | The global chrome row: 56px, sticky, `--surface` with a `--line` bottom edge, no `h1`; one appearance control (`ThemeSelector`), no second toggle; org selector and account menu end-aligned. The trigger (`aria-controls="mobile-nav"`) and the brand reveal at ≤900px, where the org moves into the drawer |
| Page header | `page-header`, `page-header-eyebrow`, `page-header-leading`, `page-header-description`, `page-header-meta`, `page-header-actions` | The routed page's one `h1` and its slots: eyebrow, title + description lead, meta and actions trail (issue 159) |

`PageHeader` is the page-heading primitive and the one-`h1` rule's enforcer (issue 159): every
routed page renders exactly one of them, and the `h1` it wraps is the page's only `h1` — panel
headings below it are `h2`s and must not restate the page title. It is presentational by
contract (no fetching, no route inspection, no Factory knowledge), slot-driven: `eyebrow` is the
section above the title, `title` the `h1` itself, `description` the leading column's second
line, `meta` the state beside the title (pills, clocks, timestamps) and `actions` the page's
buttons — siblings of the heading, never children of it. An empty slot renders no wrapper, and
`flex-wrap` drops meta and actions below the title at narrow widths without changing DOM order.

#### Surfaces and feedback

| Primitive | Classes | Use for |
| --- | --- | --- |
| Panel | `panel`, `panel-head`, `panel-actions` | The card a page section lives in; `+ warn` / `bad` tints the edge |
| Status line | `status`, `alert`, `error`, `muted` | One-line state text; `muted` for secondary prose anywhere |
| Badge | `badge`, `badge-warn` | Loud inline marker — reserved for synthetic data |
| Limits | `limits` | The bulleted limitations list |
| Halo | `lamp-glow` | The soft box-shadow halo in the lamp's own color (`currentColor`); worn by the breathing status dots |

#### Controls

##### Selector (issue 224)

The shared trigger and option-row language behind every dropdown: the app-bar account and
organization menus, the appearance control, and the composer's workflow, repository and executor
listboxes. All are Headless UI (`Menu` or `Listbox`) — a native `<select>` cannot be anchored,
capped to the viewport, or given a checkmark, which is why the appearance control (issue 188)
moved off one.

- **Trigger — `select-trigger`.** Unframed at rest (`border` stays a transparent 1px, so nothing
  shifts size later): a real `button`'s usual `--line` border and sunken fill are both suppressed
  by this class's higher specificity. Hover, keyboard focus and "panel open" (`[data-open]`, the
  Headless UI attribute) all paint the same `--accent-wash` background — one highlight, however it
  was reached — and keyboard focus keeps the global accent ring on top of it, so it never
  degrades to the hover look alone. A trailing `▾` (`::after`) marks "a choice is available here"
  and disappears on `:disabled`, which otherwise only mutes the text. Long values wrap inside the
  trigger (`overflow-wrap: anywhere`), never the page.
- **Panel — `popover`.** A raised surface with a soft shadow (`--shadow-float`) instead of a
  harder outline. It never flips above its trigger: `web/src/anchor.ts`'s `useDownwardAnchor`
  hook builds its own floating-ui middleware stack (`offset`, `shift`, `size`, deliberately no
  `flip` — Headless UI's own `anchor` prop always adds one, with no way to turn it off) and caps
  the panel's height to the space actually below the trigger, so `overflow-y: auto` scrolls it
  internally rather than clipping or flipping. `portal` keeps it out of any clipping ancestor
  (the mobile drawer included).
- **Option rows — `popover-option`.** Comfortable flex rows (`gap`, roomier padding than the old
  block layout) sharing the trigger's `--accent-wash` on hover and keyboard focus (`[data-focus]`)
  — one coherent highlight language between the open trigger and its rows. The selected row
  (`[data-selected]`) bolds its text and adds a trailing `✓`, never color alone.
  `popover-separator` is the one restrained divider, used between the user menu's Account link and
  Sign out.

##### Appearance (issue 188)

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
| Appearance | `theme-field`, `theme-label`, `select-trigger` | The one System/Light/Dark choice (a Headless UI `Listbox`, `id="theme-select"` on its trigger for the label's `for`), worn by the app bar and the public header's actions cell; the label is clipped below 640px while the accessible name stays |

| Primitive | Classes | Use for |
| --- | --- | --- |
| Button | `button` (element), `primary`, `danger` | The secondary button is every button's default: transparent, a `--line-strong` outline, `--ink` text, `--surface-strong` on hover; disabled mutes the text and drops to the `--line` edge. `primary` is the page's one main action — accent fill, `--ink-inverse` 600-weight text, 40px tall, `--accent-hover` on hover; disabled it turns `--surface-strong` with muted text and a not-allowed cursor, and a busy primary swaps its label ("Starting…") and disables. `danger` is the destructive variant: `--lamp-stop` text on a `--bad-border` outline, `--bad-wash` on hover |
| Field | `field` | The one text-field skin, for inputs, selects and textareas alike: `--surface-sunken` fill, a `--line-strong` edge (`--ink-muted` on hover, `--accent` while focused, the global ring on top), 6px radius, 40px tall, muted placeholder; disabled drops to `--surface` with muted text, and `aria-invalid="true"` turns the edge `--lamp-stop` (its message sits below, linked by `aria-describedby`). The composer textarea, the inbox filters, the repository search and the executor picker's fields wear it; their own classes only size them |
| Popover | `select-trigger`, `popover`, `popover-option`, `popover-separator` | The shared quiet-selector language above — user menu, org, composer and dashboard listboxes (Range, Scope); `data-focus`/`data-selected` state the options; dialogs sit at z-index 40, popovers at 30 |
| Org | `org-selector`, `org-select`, `select-trigger` | The organization switcher in the app bar, or in the navigation drawer at ≤900px (Headless UI Listbox) |
| User menu | `select-trigger`, `user-menu-button`, `user-menu-login`, `user-menu-panel`, `popover`, `popover-separator` | The app bar's identity disclosure (Headless UI Menu): Account, a separator, then Sign out |
| Avatar | `avatar`, `avatar-fallback`, `avatar-lg` | A 28px identity circle on `--surface-strong` (40px with `avatar-lg`); `-fallback` is the initials stand-in, 12px/600 `--ink` |
| State marks | `active`, `is-active` | The active member of a toggle row or nav list |
| Keyboard mark | `kbd` (element) | The shortcut text beside the composer's launch button — documentation of the button, never an affordance: sunken, a `--line` edge, 4px radius, Plex Mono 12px, 24px tall |

#### Data display

| Primitive | Classes | Use for |
| --- | --- | --- |
| Table | `table-wrap`, `data`, `sortable`, `align-end`, `th.asc`, `th.desc` | Every tabular readout; the wrap scrolls, never shrinks — a named, keyboard-focusable `<section>` (the region role, implicitly), so a scrolled-off column stays reachable. Sort controls are real buttons inside the `th`; the active column carries `aria-sort` (and the `th.asc`/`th.desc` arrow), sorting reads raw values with nulls last in both directions, and rows are keyed by caller-chosen stable keys. `align-end` right-aligns a numeric column's header and cells. |
| Key-values | `kv` | The dt/dd definition grid |
| Per-user | `by-user-user` | The avatar+name cell the attribution and board tables share |
| Pills | `pill`, `pill-ok`, `pill-warn`, `pill-bad`, `pill-done`, `pill-accent` | State/type chips — task statuses, gate results, readiness, executor types, the private repo mark: 24px tall, 4px radius, 12px/600, a 4px gap for a leading 14px icon. A pill's text is the whole message, never a color. Untoned it keeps the neutral `--line` edge; each tone is its lamp's text on that lamp's wash — `pill-ok` (`--lamp-run`, `--ok-wash`, `--ok-border`), `pill-bad` (`--lamp-stop`, `--bad-wash`, `--bad-border`), `pill-warn` (`--lamp-wait`, `--warn-wash`, `--warn-border`; only the readiness "pending" state), `pill-done` (`--lamp-done` on `--done-wash`, no edge) and `pill-accent` (`--accent` on `--accent-wash`, no edge) — per the status table above. `badge` stays the synthetic-data marker and is not a tone |
| Filter chip | `inbox-chip` | An applied filter, "Label: value" plus a remove button (named "Remove filter: Label", an `x` icon): a 28px capsule on `--accent-wash` with an `--accent-border` edge and `--ink` text; the inner button drops the button skin |
| Banner | `banner-warn`, `banner-bad`, `banner-info`, `banner-title` | A page-level notice: its lamp's wash and edge (the accent's for `banner-info`), 8px radius, 16px 24px padding, `--ink` text, the leading `icon` in the lamp's color (`alert-triangle` / `alert-circle` / `info`), a 15px/600 `banner-title` |
| Icon | `icon` | The `Icon` component's svg: never shrunk by a flex row, centered on its text (glyph list below) |

#### Dialogs and mobile navigation

| Primitive | Classes | Use for |
| --- | --- | --- |
| Dialog | `dialog`, `dialog-layer`, `dialog-backdrop`, `dialog-position` | The Headless UI dialog shell every dialog renders into: the layer carries the z-index policy (dialogs 40, popovers 30), the backdrop div uses `--overlay`, the positioner centers the panel. `dialog` is the panel itself — raised, the `--line-strong` edge, 8px radius, the popovers' shadow, 24px padding, 560px at most, its own scroll inside the viewport, full width with 16px padding at ≤640px; a dialog's own class (`picker`, `task-remove`, `unsaved`, `range-dialog`) only narrows it |
| Drawer | `mobile-nav`, `mobile-nav-head`, `mobile-nav-title`, `mobile-nav-close`, `mobile-nav-count`, `mobile-nav-org` | The ≤900px navigation drawer (issue 160), a Headless UI `Dialog` rendered into the picker's `dialog-layer`/`dialog-backdrop`/`dialog-position` shell. Reuses `sidenav-link` (glyphs included, never the count pill)/`sidenav-sublink`/`sidenav-newtask` inside; counts are plain sentences, never live regions, and no task preview rows render here |

#### Icons

`web/src/components/Icon.tsx` exports `Icon({ name, size = 16, label })` and `ICON_NAMES`: a 24×24
viewBox, a 1.75px round-capped stroke, `fill="none"`, `stroke="currentColor"` — so whatever
carries it tints it — and `aria-hidden` unless `label` is given, which makes it `role="img"` with
that `aria-label`. The paths are drawn by hand in the Lucide idiom; there is no icon dependency.
Sizes: 16px inline, 20px in buttons and navigation, 24px in section heads and metric discs.

The set is frozen at the foundation (`web/test/icon.test.tsx` pins it): `home`, `list`,
`settings`, `plus`, `search`, `chevron-down`, `chevron-right`, `arrow-left`, `arrow-right`, `x`,
`check`, `check-circle`, `alert-circle`, `alert-triangle`, `info`, `clock`, `circle-dot`,
`minus-circle`, `refresh`, `external-link`, `copy`, `git-branch`, `git-pull-request`, `repo`,
`user`, `users`, `layers`, `sparkles`, `terminal`, `file`, `sliders`, `menu`, `calendar`. A lane
that needs another glyph asks for a foundation change; it does not add one. The CSS glyphs that
remain — the selector's `▾`, the selected option's `✓`, the table's `↑`/`↓` sort arrows — stay
CSS until their owners move to `Icon`: the sort arrows would need markup in every table header.

#### Removed

The foundation deleted these in the same change that replaced them — do not bring them back:
`--font-display` and Barlow Semi Condensed (its three faces, woff2 files and license entry;
headings are Barlow); `gate-passed`, `gate-failed`, `gate-running` (now `pill-ok`, `pill-bad`,
`pill-done`); `readiness-item.is-ok`, `.is-attention`, `.is-pending` (the status is a toned pill);
the per-field skins of `composer-input`, `inbox-search input`/`select`, `repo-search input` and
`picker-search input` (now `field`); and the per-dialog skins of `picker`, `task-remove`,
`unsaved` and `range-dialog` (now `dialog`).

### Region: inbox

| Primitive | Classes | Use for |
| --- | --- | --- |
| Task inbox | `inbox`, `inbox-new` | The `/tasks` page (issue 279) and its header action: New task is the primary recipe (accent fill, `--ink-inverse` text, 40px, 20px `plus`) on a link, since `button.primary` skins buttons only |
| Count cards | `inbox-cards`, `inbox-card`, `inbox-card-review`, `inbox-card-running`, `inbox-card-past`, `inbox-card-disc`, `inbox-card-text`, `inbox-card-line`, `inbox-card-value`, `inbox-card-label`, `inbox-card-caption` | Three 88px raised cards, one link each to `?state=review/running/past`, from `navigation.counts` — they never read the filters. A 40px disc on the count's wash (`--accent-wash` + `circle-dot`, `--ok-wash` + `refresh`, `--done-wash` + `check-circle`), the value 28px/600 tabular, the label 14px/600 in the tone's color, "Organization total" 13px muted; the link's `aria-label` is the sentence ("12 tasks need review across the organization"). One column at ≤900px |
| Filters | `inbox-filters`, `inbox-tabs`, `inbox-tab`, `inbox-search`, `inbox-sort` | The state tabs and the sort links are two segmented controls (`--surface` track, the active `inbox-tab` raised with a `--line-strong` edge); the search form keeps its labels, `field` skins and its Filter button. The inputs are controlled, re-synced from the URL, so a removed chip or Back never leaves stale text |
| Chips | `inbox-chips`, `inbox-chip-remove`, `inbox-clear` | One `inbox-chip` per applied `q`/`repo`/`author` (never state or sort); `inbox-chip-remove` is the × — a link, not the primitive's inner button, so removal is a history entry Back undoes — to the same URL without that one param, on a 24px target tucked into the chip's end padding; `inbox-clear` the "Clear filters" link to `/tasks` |
| Rows | `inbox-list`, `inbox-columns`, `inbox-rows`, `inbox-row`, `inbox-title`, `inbox-summary`, `inbox-state`, `inbox-state-waiting`, `inbox-state-done`, `inbox-repo`, `inbox-author`, `inbox-cell-text`, `inbox-when` | A raised frame around an `aria-hidden` column header and the rows, grid `minmax(12rem, 1fr) 168px minmax(0, 160px) minmax(0, 144px) 96px` — the plan's `minmax(0,1fr) 168px 160px 144px 96px` at desktop widths, but between the drawer and the desktop the title keeps a 12rem floor and the repository/author tracks give way instead — 60px min, `--surface-sunken` on hover. The title is the row's one link, 14px/600, over a one-line 13px summary (activity while running, the head's summary once terminal, full text in `title`); the state is a `pill` per the status table, allowed to wrap in its fixed track so a long title never hides it (`inbox-state-waiting` adds the `--line-strong` edge, `inbox-state-done` greens the check); repository with the `repo` glyph, author as `avatar` + login ("?" and "Unknown author" when none), the `RelativeTime` right-aligned. At ≤900px each row stacks into a card: title, pill, then the metadata line |
| States | `inbox-empty`, `inbox-banner-body`, `inbox-error`, `inbox-footer`, `inbox-note` | Empty board and zero matches are distinct centered panels with a 24px glyph (`list`, `search`); a first-page failure is a `banner-bad` whose `inbox-banner-body` holds the message and Retry, a failed refresh a `banner-warn` above rows that stay; `inbox-error` is the inline Load more failure; `inbox-footer` is "Showing N loaded tasks" (no total) beside Load more; `inbox-note` the polite append announcement |

### Region: composer

| Primitive | Classes | Use for |
| --- | --- | --- |
| Composer | `composer`, `composer-input`, `composer-row`, `composer-label`, `select-trigger`, `composer-param-input`, `task-compose`, `composer-field`, `composer-fields`, `composer-context`, `composer-context-item`, `composer-context-value`, `composer-steps`, `composer-helper`, `composer-preflight`, `composer-start`, `composer-blocker`, `composer-param-error`, `composer-param-details` | The message input and its row (the detail view's chat footer); `task-compose` is the full-page variant. A chosen workflow's declared parameters render as the `composer-fields` list, each a `composer-field` with a `composer-label`, `composer-helper` guidance, per-field `composer-param-error` lines, and the raw rule only inside `composer-param-details`; a failed field tints its `.composer-param-input` edge via `aria-invalid`. The `composer-start` action row holds Discard draft, Start, the `kbd` shortcut and the `composer-blocker` status (quiet reasons only — an empty prompt, a launch in flight), after the `composer-preflight` sentence. The trigger and menu skin itself (`select-trigger`, `popover`, `popover-option`) is shared with every other selector and owned by #224, not this pattern |
| New-task page | `composer-section`, `composer-section-head`, `composer-section-title`, `composer-step`, `composer-example`, `composer-counter`, `is-over`, `composer-trigger-missing`, `composer-notices`, `composer-notices-body`, `composer-notices-dismiss`, `composer-skeleton`, `composer-skeleton-block`, `composer-skeleton-line` | `/tasks/new` (#280, concept 02): four numbered `panel composer-section`s — Request, Execution context, Workflow details, Readiness — each headed by a `composer-section-head` with a 28px `--accent` `composer-step` disc (`aria-hidden`; the h2 in `composer-section-title` carries the words). Request: a 160px/15px textarea, "Try an example" (`composer-example`, `sparkles`, enabled only on an empty draft) and the `composer-counter` (`{length} / 16,384` from core's `COMMAND_LIMIT`, `is-over` in `--lamp-stop`). Execution context: `composer-context`, three `composer-context-item` columns ≥1024px (stacked below), each a glyphed `composer-label` over a full-width framed `select-trigger`, its value in an ellipsis-truncating `composer-context-value` (full value in the trigger's `title`); `composer-trigger-missing` is the executor's stop-lamp edge. Workflow details: a named workflow's fields, or the spine sentence and the closed `composer-steps` disclosure ("Optional steps (n of 2 on)"). Readiness: `banner-bad` only for a missing executor (with its settings link), incomplete workflow details and an over-limit request; `banner-info` while a chosen workflow's list or the saved preferences load — Start's `aria-describedby` names the banner or the status text. A draft restored from the shell (F1) says what it lost in a dismissible `banner-info composer-notices`; `composer-skeleton` holds the page, static, while the session is checked |

### Region: task-detail

| Primitive | Classes | Use for |
| --- | --- | --- |
| Grid | `task-layout`, `task-main` | The task page's grid: the outcome rail (`task-outcome`) and the main column (`task-main`: conversation → run history → verification → services → published work → follow-up). Rail first in the DOM; a 320px right column from 1024px, a two-column summary above the main column below it — DOM order is visual order |
| Exchange | `chat-exchange`, `msg-user`, `msg-meta`, `chat-exit` | One turn: prompt as plain prose (line breaks kept, not mono), metadata, exit code |
| Run article | `run-label`, `run-summary`, `run-output`, `run-well` | One run's sections in reading order: labels (Request / Follow-up / Agent response / activity), the stored summary as flowing prose, and the raw-output disclosure (collapsed behind a summary, expanded when it is all there is) — never a fabricated response. Gates and publication are the task's panels, not a run's |
| Run history | `task-history`, `task-history-item` | The recorded stamps only, oldest first — created, started, finished, stop requested, `waitingSince`, `doneAt` + `doneBy` — each with its relative `time`. No inferred rows ("Implemented changes", "Published PR") |
| Verification | `task-verification`, `task-verification-counts`, `gate-output-wrap`, `gate-output` | The newest run's gates as a panel (`#task-verification`, a focus target for the rail's View checks): "N failed" `pill-bad` / "N passed" `pill-ok` / "N running" `pill-done`, each only when N > 0; each gate a `<details>`, failed ones `open`; the output a 12px mono well on `--surface-sunken`, lines kept whole and scrolled in its own well, with a copy button. No durations, no per-test tree |
| Published work | `task-published`, `task-branch`, `run-publish`, `task-copy` | The branch as a mono chip with its copy button, and the PR link only through `isHttpUrl`. `task-copy` is the copy button (a `chat-resume`, so the 44px rule already covers it) |
| Runtime | `chat-runtime`, `chat-activity`, `task-summary`, `task-clock` | The "is it stuck or working" strips |
| Gates | `chat-gate-list` | The verification-gate list; each gate's status (and the counts) is a `pill` in the tone the `GATE_PILL` map in `task-outcome.ts` names — passed `pill-ok`, failed `pill-bad`, running `pill-done`; a zero count is not drawn at all |
| Output | `chat-output` | The scrolled raw-run well (`--surface`); `gate-output` is the gate variant |
| Verdicts | `chat-resume`, `chat-toggle`, `chat-done`, `chat-stop`, `chat-remove` | The task's action buttons, status-tinted; the tinted ones (`chat-done`, `chat-stop`, `chat-remove`) hover on their own lamp's wash, never on the strong surface their status text may not sit on |
| Outcome | `task-outcome`, `task-outcome-summary`, `task-outcome-body`, `task-outcome-label` | The task page's summary disclosure: result (the header's own state pill, not a second live region), a failure's next action (Ask for another pass when `followUpEligibility` allows it, else the same not-author sentence as the follow-up slot; nothing while the session loads), execution, verification counts, published work — one `<details>`, expanded by default, a two-column summary above the main column (600–1023px; one column on a phone, where two key/value columns cannot hold a label) and a one-column 320px rail (≥1024px) without a second component |
| Task head | `task-actions`, `task-action-help`, `task-closed`, `task-meta-line`, `task-opened-by`, `task-pill-wait`, `task-pill-done`, `task-avatar` | The page header's parts: the state pill (`taskStatusLabel` in the `taskTone` tone, per the status table — `task-pill-wait` is the wait's `--line-strong` edge, `task-pill-done` the done check in `--lamp-run`), `#id · Opened … by (avatar) login · repo`, and the action row — one primary action from the plan §3.2 matrix, the More task actions overflow, and the one sentence that says what the primary does (`task-action-help`), or the closure as "Closed by X · time" (`task-closed`), never a disabled control. The row wraps, so narrow screens drop its second line rather than clip it |
| Follow up | `task-follow-up` | The composer, offered only when `followUpEligibility` answers `eligible`; another member's task says who can continue instead, and a loading session renders nothing |
| Remove dialog | `task-remove`, `task-remove-title`, `task-remove-actions` | The remove confirmation over the task page (issue 178): in the shared `dialog` panel at 440px, the body copy carries every consequence, Cancel and the destructive Remove task end-aligned |

### Region: settings

| Primitive | Classes | Use for |
| --- | --- | --- |
| Toggle | `settings-toggle` | A labelled checkbox row — the design system's one boolean-control primitive (no dedicated switch family exists): the default-workflow settings panel's two switches and the composer's matching pair of optional-step checkboxes (issue 208), the latter now inside the composer's `composer-steps` disclosure (issue 228) |
| Picker | `picker`, `picker-search`, `picker-list`, `picker-name`, `picker-option`, `picker-actions` | The Headless UI Dialog/Combobox executor picker, rendered into the shared `dialog` panel and shell, its fields wearing `field`; options carry `data-focus`/`data-selected` |
| Repository setup | `repo-search`, `repo-columns`, `repo-summary`, `repo-table`, `repo-save` | The repositories page (issue 181, compacted by issue 223): a visibly labeled search row carrying the selection-ceiling sentence, a `repo-summary` one-liner folding the enabled counts and installation context, and the summary/list/detail stack that becomes master/detail (`repo-columns.has-detail`) at ≥1100px only once a repository is actually configured — below that width, or with nothing configured, the DOM order (summary, list, detail) is the reading order. The Save action (`repo-save`) sits in the list panel's `panel-head` beside the table it saves, `primary` only while a dirty, unblocked selection is worth prompting for. `repo-table` is a fixed-layout `data` table with sized secondary columns and a sticky Configure column that stays reachable while scrolled; at ≤640px it stacks into `data-label` cards like `env-vars` |
| Unsaved-changes dialog | `unsaved`, `unsaved-title`, `unsaved-actions` | The settings area's discard confirmation (issue 182), one instance raised by the dirty-draft coordinator before a blocked navigation or a repository switch: the shared `dialog` panel at the remove dialog's width, Continue editing safe-focused, Discard changes destructive |
| Env | `env-tab`, `env-tabs`, `env-vars`, `env-pending`, `env-advanced-note`, `env-raw`, `env-errors`, `env-row-actions`, `env-add`, `env-advanced-toggle`, `env-row-remove` | The compact draft editor (issue 182, restyled by issue 222): a real `tablist` of Variables/Secrets tabs whose selected tab is the `aria-selected` one; the scope's editable table with aligned, bounded Name/Value/Actions columns (`table-layout: fixed`, the Value column absorbing the width the fixed Name/Actions columns leave, so a long value wraps instead of clipping); a pending-removal row that waits with its Undo until the whole-list save; a compact `env-row-actions` row beneath the table holding the quiet `env-add` control (accent text, hovering on the accent wash) and, for Variables only, the de-emphasized text-style `env-advanced-toggle` disclosure trigger — neither styled `.primary`, so Save stays the panel's one prominent action; `env-row-remove` sizes the row's own remove button as a small square icon control; the advanced `.env` disclosure's warning line, the textarea editor, and the row/scope validation lines (`env-errors`, paired with `.error` for its red tint and attached per-field via `aria-describedby` so a name problem renders under the name input, not the value one). At ≤640px an `env-vars` row becomes a bordered card that reflows into labeled groups via each cell's `data-label` |
| Readiness | `readiness`, `readiness-item`, `readiness-status`, `readiness-fact`, `readiness-action` | The configuration overview's five ordered items (#180): raised cards in a grid — two columns above 700px, one at and below it; each item's status is a toned `pill` on its own row (ok `pill-ok`, attention `pill-bad`, pending `pill-warn`, a neutral fact the untoned pill) while the card edge stays the neutral hairline; the words carry the meaning, never color alone, and `overflow-wrap` keeps long paths from widening the page |
| Scope context | `scope-context`, `scope-context-label` | The readable scope/impact/editability block every environment editor renders before its controls (#180); the label is a small uppercase caption, the precedence sentence `muted` |

### Region: dashboard

| Primitive | Classes | Use for |
| --- | --- | --- |
| Grid | `two-up` | Two-panel dashboards |
| Controls row | `dashboard-controls` | The dashboard's control row under the page header: the analytics toolbar, which moved here from the old global topbar (issues 160 and 159) |
| Cards | `cards`, `card` | Numeric figure tiles inside a panel |
| Analytics toolbar | `analytics-toolbar`, `toolbar-group`, `toolbar-label`, `toolbar-value` | The dashboard's visibly labeled Range / Scope / Repositories groups (#166, refined by #246): each a real `fieldset`/`legend` — the caption groups the trigger without stealing its own accessible name — read-only values sunken like the inputs they echo |
| Range | `range-dialog`, `range-dialog-title`, `range-draft`, `range-draft-fields`, `range-draft-actions` | The Range group's one dropdown (issue 246): a `select-trigger`/`popover`/`popover-option` Listbox over the presets plus Custom; picking a preset commits it, picking Custom opens the `range-dialog` — a Headless UI Dialog in the shared `dialog` panel and shell — holding the draft form (`range-draft`, `range-draft-fields` for the two labeled date fields); Apply, Cancel and Clear are the only ways to commit or discard it |
| Rendered-data summary | `analytics-summary` | The one-line payload sentence under the toolbar groups — mono, muted, a polite live region |
| Freshness | `updated-at`, `updated-at-full` | Relative "Updated …" copy; the precise stamp is revealed on hover and keyboard focus and carried by a `<time dateTime>` |
| Metric summary | `usage-summary`, `usage-groups`, `usage-group`, `usage-tokens`, `usage-label`, `usage-measures`, `usage-measure` | The dashboard's six measures in four groups (#166): the hierarchy IS the grid — Sessions and the wider Token usage group first — and narrow widths restack the same DOM order. Each `usage-measure` stacks its figure, label and cache detail in its own column (#246) so nothing collides; Token usage holds Total input (with its uncached, cache-read and cache-write parts beneath it), Cache hit rate and Output, and Output carries none of the input parts |
| Analytics empty state | `usage-empty` | The one "nothing measured in this selection" state that replaces the dash-card chorus, naming the selection and one next action |
| Usage bar | `usage-track`, `usage-bar` | The proportional New-tokens bar in the by-user table: a sunken-well track with a chart-blue fill, `aria-hidden` — width is decoration, the cell's accessible name carries the exact figure |
| Task title | `task-title` | The board section's linked task identity cell, clamped after two lines |

Charts:

| Primitive | Classes | Use for |
| --- | --- | --- |
| Frame | `chart-wrap`, `chart` | The overflow scroll and the SVG itself |
| Grid | `grid`, `grid-alt`, `tick`, `axis-label` | Gridlines (alt = dashed), ticks and labels — all `--ink-muted`/`--chart-grid` |
| Marks | `bar` (+ `bar-primary`, `bar-ok`, `bar-warn`, `bar-bad`), `line`, `dot` (+ `dot-warn`, `dot-bad`) | Series fills; `dot` default is `--lamp-done` |
| Partial | `bar-partial`, `bar-partial-hatch` | The hatch over a partial bucket (the current day/week), painted behind the bars — a non-color mark, grayscale-safe |
| Bucket target | `bucket-hit` | The transparent rect over each bucket; one roving tab stop, accent edge on `:focus-visible` |
| Tooltip | `chart-tooltip`, `chart-tooltip-box` | The active bucket's exact readout, rendered inside the SVG so it scales with it |
| Legend | `legend`, `legend-button`, `swatch`, `swatch-primary`, `swatch-ok`, `swatch-warn` | Series toggle buttons (`aria-pressed`); swatches stay in step with their marks and dim when the series is off; a toggle paints no hover fill |
| Caption | `chart-caption`, `chart-disclosure` | The one-line caption (keying the hatched partial bucket when one exists) and the calculation `<details>` after the chart |
| Empty | `chart-empty` | The all-hidden readout — **All series hidden** instead of a broken plot |

### Region: entry

| Primitive | Classes | Use for |
| --- | --- | --- |
| Login | `login-gate`, `login-button`, `login-error` | The signed-out screen |
| Public header | `public-header`, `public-brand`, `public-context`, `public-header-actions` | The compact chrome both public pages (gate, onboarding) carry: the product brand (`PRODUCT_NAME`), one context word, and the actions cell, which holds the theme control (issue 187; the appearance control arrived in issue 188). No navigation, no session, no `h1` — each page owns its one heading |
| Onboarding | `onboarding`, `onboarding-purpose`, `onboarding-identity`, `onboarding-orgs`, `onboarding-org`, `onboarding-org-head`, `onboarding-org-name`, `onboarding-org-mark`, `onboarding-requested`, `onboarding-org-details`, `onboarding-org-summary`, `onboarding-mode`, `onboarding-mode-option`, `onboarding-mode-help`, `onboarding-repos`, `onboarding-repo`, `onboarding-repo-count`, `onboarding-note`, `onboarding-summary`, `onboarding-summary-total`, `onboarding-summary-rows`, `onboarding-summary-row`, `onboarding-actions`, `onboarding-loading`, `onboarding-loading-line` | The setup screen (issue 125, recomposed by issue 187): the centered column, the org checkbox list with each org's initial identity mark and its `Requested for this sign-in` mark, one org's bordered row — a focus target for a blocked attempt, never a click target — whose disclosure summary names the org's repository mode while collapsed, the explicit mode radios with their helpers, the specific-mode checklist with its `N of M` count, the access note, the final selection summary, and the action region (global error, disabled reason, Continue). `onboarding-loading` shapes the pending-load placeholders: static rows and a status line, no shimmer |
| Identity | `identity-head`, `identity-name` | The account page's identity section |

### One-offs

None left: every class above has a family and a home. A new one-off needs a sentence here saying
why no family fits.

## Inventory

Every UI unit under `web/src`, mapped to the primitives it uses and grouped by the region that owns
it — the same six regions as the stylesheet, plus the shared shell. Kept honest by
`web/test/styles.test.ts`: a new file under `components/`, `panels/`, `pages/` or `charts/` fails
the suite until it has a row, and a new class in `styles.css` fails until this document names it.
Helpers with no markup: `env-raw.ts` is the `.env` raw-editor parser the env panel imports, and
`scale.ts` is the charts' band/linear scale helper.

### Shared

| File | Primitives |
| --- | --- |
| `AppBar.tsx` | appbar, appearance, org, user-menu-button |
| `AppShell.tsx` | shell, page, skip-link, appbar, mobile-nav |
| `DraftReturnBanner.tsx` | banner-info |
| `Icon.tsx` | icon — the foundation glyph set (below); `NavItems.tsx` draws the nav glyphs, the lanes consume the rest |
| `KeyValues.tsx` | kv |
| `MobileNavDialog.tsx` | mobile-nav, sidenav, org |
| `NavItems.tsx` | sidenav, sidenav-count, icon — the nav links both `SideNav.tsx` and `MobileNavDialog.tsx` render |
| `OrgSelector.tsx` | org, selector |
| `PageHeader.tsx` | page-header |
| `RelativeTime.tsx` | none — renders a `<time>` element only |
| `SideNav.tsx` | sidenav |
| `StatusBanner.tsx` | status |
| `ThemeSelector.tsx` | appearance, selector |
| `UserMenu.tsx` | selector, user-menu-button, popover, popover-separator, user-menu-panel, avatar |
| `SettingsLayout.tsx` | none — renders the outlet |
| `TasksLayout.tsx` | none — renders the shell, sidenav and outlet |

### Region: inbox

| File | Primitives |
| --- | --- |
| `TaskInboxPage.tsx` | page-header, icon, inbox, inbox-new, inbox-cards, inbox-card, inbox-card-review, inbox-card-running, inbox-card-past, inbox-card-disc, inbox-card-text, inbox-card-line, inbox-card-value, inbox-card-label, inbox-card-caption, inbox-filters, inbox-tabs, inbox-tab, inbox-search, field, inbox-sort, inbox-chips, inbox-chip, inbox-chip-remove, inbox-clear, inbox-list, inbox-columns, inbox-rows, inbox-row, inbox-title, inbox-summary, inbox-state, inbox-state-waiting, inbox-state-done, pill, pill-ok, pill-done, pill-accent, pill-bad, inbox-repo, inbox-author, inbox-cell-text, avatar, avatar-fallback, inbox-when, inbox-empty, banner-bad, banner-warn, banner-title, inbox-banner-body, inbox-error, inbox-footer, inbox-note, sidenav-dot, muted |

### Region: composer

| File | Primitives |
| --- | --- |
| `TaskComposer.tsx` | panel, composer, task-compose, composer-section, composer-section-head, composer-section-title, composer-step, composer-example, composer-counter, field, selector, composer-label, composer-context, composer-context-item, composer-context-value, composer-trigger-missing, composer-steps, composer-helper, composer-preflight, composer-start, composer-blocker, banner-bad, banner-info, banner-title, composer-notices, composer-skeleton, icon, settings-toggle, kbd, chat-resume, unsaved (the discard confirmation) |
| `TaskComposerPage.tsx` | page-header, status, composer-skeleton |
| `WorkflowParameterFields.tsx` | composer-field, composer-fields, composer-label, composer-param-input, composer-helper, composer-param-error, composer-param-details |

### Region: task-detail

| File | Primitives |
| --- | --- |
| `TaskDetailPage.tsx` | page-header, status |
| `TaskHeader.tsx` | page-header, pill, pill-ok, pill-bad, pill-done, pill-accent, task-pill-wait, task-pill-done, sidenav-dot, icon, task-meta-line, task-opened-by, avatar, avatar-fallback, task head, task-action-help, task-closed, popover, popover-option, primary, chat-resume, chat-stop, chat-remove, muted |
| `TaskDetail.tsx` | task-layout, task-main, task-conversation, task-history, task-history-item, task-follow-up, panel-head, panel, kv, composer, field, status, muted |
| `TaskRun.tsx` | chat-exchange, run-label, run-summary, run-output, run-well, run-publish, msg-user, msg-meta, chat-runtime, chat-activity, chat-exit, chat-done, chat-stop, task-verification, task-verification-counts, chat-gate-list, gate-output-wrap, gate-output, task-published, task-branch, task-copy, chat-resume, icon, pill-ok, pill-bad, pill-done, chat-output, panel, panel-head, pill, muted, code |
| `TaskOutcome.tsx` | task-outcome, task-outcome-summary, task-outcome-body, task-outcome-label, panel, pill, pill-ok, pill-bad, pill-done, msg-meta, chat-done, chat-stop, chat-exit, task-avatar, by-user-user, kv, muted, code |
| `TaskRemoveDialog.tsx` | dialog, task-remove, status, chat-resume, chat-remove |

### Region: settings

| File | Primitives |
| --- | --- |
| `SettingsExecutorsPage.tsx` | page-header, panel, status, muted |
| `SettingsOrganizationPage.tsx` | page-header, kv, scope-context, panel |
| `SettingsOverviewPage.tsx` | page-header, kv, panel, readiness, pill, pill-ok, pill-bad, pill-warn |
| `SettingsRepositoriesPage.tsx` | page-header, repo-columns, repo-columns.has-detail, scope-context, status, muted |
| `SettingsWorkflowsPage.tsx` | page-header, status |
| `SettingsWorkspacePage.tsx` | page-header, scope-context, panel, status, muted |
| `RepositorySetup.tsx` | panel, panel-head, panel-actions, table-wrap, data, pill, repo-search, field, repo-summary, repo-table, repo-save, scope-context, status, muted, primary |
| `repository-setup.ts` | helper — no markup |
| `ConfigurationScope.tsx` | scope-context |
| `ExecutorDialog.tsx` | dialog, picker, field, status, muted |
| `UnsavedChangesDialog.tsx` | dialog, unsaved, chat-resume, chat-remove |
| `EnvVarsPanel.tsx` | panel, env |
| `env-vars-panel-parts.tsx` | presentational helper `EnvVarsPanel.tsx` imports (tablist, table, banner, tab panels) — no primitives beyond `env` |
| `env-draft.ts` | helper — no markup |
| `env-raw.ts` | helper — no markup |
| `DefaultWorkflowPanel.tsx` | panel, panel-head, panel-actions, muted, status, settings-toggle |
| `default-workflow-draft.ts` | helper — no markup |
| `WorkflowsPanel.tsx` | panel, panel-head, table-wrap, data, pill, muted, status, primary, env-raw |
| `WorkspaceExecutorsPanel.tsx` | panel, pill, table-wrap, data, muted |

### Region: dashboard

| File | Primitives |
| --- | --- |
| `DashboardPage.tsx` | page-header, dashboard-controls |
| `AnalyticsToolbar.tsx` | analytics toolbar, rendered-data summary, range |
| `RangeSelector.tsx` | analytics toolbar, selector, range, dialog, primary, status |
| `ScopeToggle.tsx` | analytics toolbar, selector |
| `DataTable.tsx` | table-wrap, data, sortable, th.asc, th.desc, align-end |
| `Card.tsx` | card |
| `TaskUsagePanel.tsx` | data, align-end, muted |
| `ByUserPanel.tsx` | data, align-end, usage-track, usage-bar, task-avatar, by-user-user |
| `RecentTasksPanel.tsx` | panel, alert, muted, data, task-title, task-avatar, by-user-user |
| `UsageSummaryPanel.tsx` | metric summary, badge |
| `TokenUsagePanel.tsx` | chart-wrap, legend, legend-button, swatch, chart-caption, chart-disclosure |
| `TelemetryFrame.tsx` | alert, badge |
| `Axes.tsx` | grid, tick, axis-label |
| `BarChart.tsx` | bar, line, bucket-hit, bar-partial, bar-partial-hatch, chart-tooltip, chart-tooltip-box, chart-empty |
| `HBarChart.tsx` | bar |
| `Scatter.tsx` | dot, axis-label |
| `scale.ts` | helper — no markup |

### Region: entry

| File | Primitives |
| --- | --- |
| `AccountPage.tsx` | page-header, panel |
| `OnboardingPage.tsx` | onboarding, appearance, public-header, status, muted, avatar, login-button, primary |
| `LoginGate.tsx` | login, appearance, public-header |
| `PublicPageHeader.tsx` | public-header |
| `OnboardingOrganization.tsx` | onboarding |
| `IdentityPanel.tsx` | identity, avatar |
| `AccessTokensPanel.tsx` | panel, status |
| `TrackedOrgsPanel.tsx` | panel, login-button |

A class used but not defined here (`visually-hidden`, `token-once`) is a hook with no styles or a
leftover — do not style it by inventing a rule without a row above.

