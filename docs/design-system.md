# Design system

Read before: adding or restyling anything under `web/src`, touching anything under
`web/src/styles/`, or introducing a color.

The web app's styling is an ordered entry, `web/src/styles.css` — an import list and nothing
else — compiled by Tailwind CSS v4 (`@tailwindcss/vite`, registered in `web/vite.config.ts`).
There is no CSS-in-JS and no per-component files — a component participates by carrying primitive
classes, and every color it renders flows through a token. The import order is the cascade:
`@import "tailwindcss"` (preflight and the utility engine), the self-hosted fonts, the two token
blocks, the base layer, the shared primitives, the six lane regions, the shared touch-target
floor, then the unlayered platform conditions. `web/test/styles.test.ts` reads all the shipped
files as one style system and holds the lines: one deliberate import order with each construct in
its own file, no color literal outside the two token blocks, every defined token used, every
class the stylesheets define appears in this document or in the lane docs beside it (the
inventory cannot silently rot), and every defined class has a caller — a literal under `web/src`
or the specimen spells it (a distinctively named rule cannot outlive its markup; a modifier named
like a common word, `warn` or `bad`, is matched by any literal and still needs a reviewer's eye).

## File map and ownership

The redesign lanes (#306) edit distinct files; the shared system is the part with one owner and
one review path. A lane PR touches its own region file and its own lane doc
(`docs/design-system/<lane>.md`); a primitive, token or contract change touches the shared files
and this document.

| File | Owner | Contents |
| --- | --- | --- |
| `web/src/styles.css` | shared | The entry: the ordered import list and nothing else — an order change is a cascade change, reviewed here |
| `web/src/styles/fonts.css` | shared | The five self-hosted `@font-face` blocks (CSP: font-src 'self') |
| `web/src/styles/tokens.css` | shared | Both `:root` token blocks and the `@theme` blocks — the only legal homes for color literals |
| `web/src/styles/base.css` | shared | `@layer base`: the type scale, the bare content link, the 36px control floor |
| `web/src/styles/primitives.css` | shared | `@utility lamp-glow` and the `@layer components` shared primitives — shell, sidenav, app bar, page header, panels, pills, banners, fields, buttons, selectors, dialogs, tables (chart marks live in the dashboard region) |
| `web/src/styles/regions/<lane>.css` | the lane | One file per lane — `inbox`, `composer`, `task-detail`, `settings`, `dashboard`, `entry` — imported in the lanes' historical order; each ends with the lane's 44px touch-target segment |
| `web/src/styles/touch-targets.css` | shared | The ≤900px 44px rule for the controls the whole shell owns; the components layer's last file, so it outranks every lane's own control rules at equal specificity |
| `web/src/styles/platform.css` | shared | The unlayered `prefers-reduced-motion` and `forced-colors` overrides — outside every layer, so they outrank all of them |

Touch targets (#189): the 44px compact-shell floor is owned where the control is owned. A lane's
controls carry their segment at the end of the lane's own region file — its last compact-shell
media block, followed by the value restatements two members need — and the shell-wide controls
(app bar, drawer, selectors, page-header actions) are listed in `touch-targets.css`. A new
mobile-visible control joins its owner's list, never a one-off rule;
`web/test/styles.test.ts` holds the owner map and the lists' disjointness.

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
- **Fonts are self-hosted** under `web/public/fonts/` with `@font-face` in `styles/fonts.css`,
  imported first after the engine: the CSP is `font-src 'self'`, and `verify:ui` runs offline, so
  a Google Fonts link would silently fall back exactly where faces are checked (a guard test
  pins this).
- **One ambient motion:** a running lamp breathes — `--animate-lamp` (2.4s ease-in-out,
  opacity 1 → 0.45). Nothing else on the page moves by itself.

## Tokens

Two `:root` blocks in `styles/tokens.css` — dark is the default, light rides
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
| Metric value | `usage-group strong` | 28 / 34 / 600, tabular figures |

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
`e2e/matrix.spec.ts` (issue 287) walks every route family at 320/390/768/1024/1440 in both
themes and asserts, page by page, no page-level horizontal scroll (`scrollWidth <= innerWidth`),
named controls, polled counts outside live regions, keyboard reach with a ring at every stop
(forced colors too), 44px compact targets, stillness under reduced motion, AA text contrast as
rendered, and dialog focus containment and return. It writes the tables of
`artifacts/ui/matrix/MATRIX.md`; `docs/plans/bellows-redesign-2026-09-26/MATRIX.md` keeps them
beside hand-written findings, coverage notes and the reproduce command, so a refresh replaces
the tables and keeps those sections.

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
  controls clear 44px — the smallest reliable finger target. The floor is owned where the control
  is owned: a lane's controls join the 44px segment at the end of the lane's own region file, the
  shell-wide controls join `styles/touch-targets.css` (the components layer's last file, so the
  floor still outranks every equal-specificity rule); never a one-off rule.
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
lives in `e2e/specimen/specimen.css` — grid only, tokens by `var()`, held to the style system's
color and motion rules by `web/test/styles.test.ts`.

The shared primitives live in `styles/primitives.css` in the order of this section; each lane's
rules live in its own file under `styles/regions/` and its own doc beside this one (below). A
lane edits only its own region file and its own lane doc; a shared primitive changes in
`primitives.css`, reviewed against this document. Each region file ends with the lane's 44px
touch-target segment — its last compact-shell media block, then the value restatements two
members need (`settings-toggle`'s `display: flex`, `repo-search input`'s `min-width` — restated
right after their segment's list, as they always were). `styles/touch-targets.css` imports after
every region file for the reason the shared block always sat last: it outranks each region's own
control rules at equal specificity.

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
| Panel | `panel`, `panel-head`, `panel-actions` | The card a page section lives in; `+ bad` tints the edge (a telemetry panel that failed to load) |
| Status line | `status`, `alert`, `error`, `muted` | One-line state text; `muted` for secondary prose anywhere |
| Badge | `badge`, `badge-warn` | Loud inline marker — reserved for synthetic data |
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
| State marks | `active`, `is-active` | The active member of a toggle row or nav list: `is-active` marks the current sidenav entry (link, sublink, task, new task) and inbox tab; `active` is the class React Router's `NavLink` adds, styled only in the user menu |
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
| Drawer | `mobile-nav`, `mobile-nav-head`, `mobile-nav-title`, `mobile-nav-close`, `mobile-nav-count` (and the unstyled `mobile-nav-org` hook) | The ≤900px navigation drawer (issue 160), a Headless UI `Dialog` rendered into the shared `dialog-layer`/`dialog-backdrop`/`dialog-position` shell. Reuses `sidenav-link` (glyphs included, never the count pill)/`sidenav-sublink`/`sidenav-newtask` inside; counts are plain sentences, never live regions, and no task preview rows render here |

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

The cleanup (#288) deleted what the redesign left without a caller, and the callers suite keeps
it gone: `cards`/`card` and `Card.tsx` (the metric cards are `usage-group`); `HBarChart.tsx`,
`Scatter.tsx` and their `dot`, `dot-warn`, `dot-bad` marks, `bar-warn` and `bar-bad`, and the
`logScale` helper; `limits` and the `panel.warn` tint (a failed panel is `panel bad`);
`picker-list`, `picker-option` and `picker-name` (the executor dialog is a form, not a
list); and `chat-toggle`.

### Regions

Each lane's primitives live in the lane's own doc — one per region file under
`web/src/styles/regions/`, kept in `docs/design-system/`:

- inbox — [design-system/inbox.md](design-system/inbox.md)
- composer — [design-system/composer.md](design-system/composer.md)
- task-detail — [design-system/task-detail.md](design-system/task-detail.md)
- settings — [design-system/settings.md](design-system/settings.md)
- dashboard — [design-system/dashboard.md](design-system/dashboard.md) (its charts too)
- entry — [design-system/entry.md](design-system/entry.md)

### One-offs

None left: every class above has a family and a home. A new one-off needs a sentence here saying
why no family fits.

## Inventory

Every UI unit under `web/src`, mapped to the primitives it uses and grouped by the region that owns
it — the shared shell here, each lane's rows in its own doc beside this one. Kept honest by
`web/test/styles.test.ts`, which reads all these documents together: a new file under
`components/`, `panels/`, `pages/` or `charts/` fails the suite until it has a row, and a new
class in the stylesheets fails until one of these documents names it.
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

Each lane's UI-unit rows live in its own doc, beside its primitives ([Regions](#regions),
above).

A class used in markup but defined by no stylesheet — `visually-hidden`, `token-once`,
`mobile-nav-org`, and the section hooks panels carry beside `panel` (`task-follow-up`,
`repo-detail`, `composer-section` and the like) — is a hook with no styles; do not style one by
inventing a rule without a row in these documents.

