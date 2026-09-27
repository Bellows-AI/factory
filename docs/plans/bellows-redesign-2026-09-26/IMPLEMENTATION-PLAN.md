# Bellows redesign — executor implementation plan

Date: 2026-09-26. Source baseline: `e19fce1`. Status: **handoff-ready (rev. 3 — code-verified and reconciled with EXECUTION-GRAPH, see §7)**.
No application code changed by this document. **Ordering and parallelization: [EXECUTION-GRAPH.md](EXECUTION-GRAPH.md)**
— it supersedes the R0…R8 sequence below and pulls some shared pieces (e2e port/DB parameterization,
`sessionLoading`, `COMMAND_LIMIT`, the draft-return banner, the complete draft store, F2 precedence) into ground work.

This plan turns [PLAN.md](PLAN.md) + [REVIEW.md](REVIEW.md) + [FINAL-REPORT.md](FINAL-REPORT.md) into concrete, ordered work.
Where the three disagree, **FINAL-REPORT wins**, then this document. Visual references: [references/](references/) (01–06
Bellows screens, dark; 07–09 theme/surface inspiration only — ignore their purple branding and product features).

Everything below marked **DECISION** is a default chosen so the executor does not have to stop. If the product owner
overrides one, only the named section changes.

---

## 0. Ground rules for the executor

Read before touching anything:

1. `AGENTS.md` (repo root) and `docs/design-system.md`. Every rule below that says "update the doc" is enforced by
   `web/test/styles.test.ts` (inventory is a substring check: every class in `styles.css` and every file under
   `components/`, `panels/`, `pages/`, `charts/` must appear in `docs/design-system.md`).
2. **Color literals live only in the two `:root` blocks** of `web/src/styles.css` (dark `:root`, light
   `:root[data-theme="light"]`). That includes `color-mix()`, `black`, `white`, hex, oklch — anywhere in `.css/.ts/.tsx`,
   comments included. Both blocks must define the **identical token set**, and every token needs a real `var()` caller.
3. **No `transition:`** anywhere; no new animation. The only motion is the existing `--animate-lamp`.
4. **No Tailwind utilities in TSX.** Tailwind v4 is the engine only; component classes live in `@layer components`.
5. **Font-size floor 12px** (px values are checked; `.tick` stays exactly 11px).
6. Control min-heights: the three 36px floor rules (`button`; `input:not([type='checkbox']):not([type='radio']), select`;
   `.inbox-tab`) keep `min-height: 36px` and their exact selectors — raise heights in **separate** rules. The test finds
   the first `@media (max-width: 900px)` block that **contains** a `min-height: 44px` rule, and reads only the first
   such rule in it (`styles.test.ts:305-307`); it lists **26** selectors today (incl. `.settings-toggle`,
   `styles.css:2014`). That rule is **shared and append-only**: G4 moves it out of any lane region into a
   `/* ── shared: touch targets ── */` block; each lane appends only its own selectors, one per line, never reorders or
   removes others', and never adds a separate 44px rule in a 900px block ahead of it.
7. No backward compatibility: rename a class → update every caller and the doc in the same change, delete the old one.
8. No backend/driver behavior changes. Allowed non-UI changes (all in Phase 0, see EXECUTION-GRAPH): one server DB
   test (G3, §3.2); a specimen Vite server (G6, §1.7); env-driven e2e ports/databases in `playwright.config.ts`,
   `e2e/reset-db.mjs`, `e2e/stub-idp.mjs` plus their documentation in `AGENTS.md` (G8); moving the duplicated
   `COMMAND_LIMIT` constant into core (G8, §2.3 — value unchanged). **No `driver/` change ⇒ no Kubernetes parity work is triggered.** If you find yourself editing `driver/` or
   server production code, stop and ask.
9. Relative imports carry `.js` even in `.tsx`. Build core first: `npm run build -w core`.
10. Each package (R0…R8) = one PR (or a short series). PR body: visible behavior, before/after screenshots **both themes,
    desktop + 390px**, design-contract changes, exact commands run with pass/fail.
11. `.badge`/`.badge-warn` are **reserved for the loud synthetic-data marker** (`styles.css:949`, `design-system.md:173`).
    Status chips are `pill` (+ tone modifiers, §1.5). Do not repurpose `badge`.

Standard check set per PR (run all, report actual output):

```bash
npm run build -w core
npx vitest run web/test            # focused first, then:
npm run typecheck
npm run lint
npm test
npm run verify:ui                  # needs timescale + factory_e2e + factory_auth_e2e; read artifacts/ui/*.png
```

---

## 1. Visual foundation (R1 source of truth)

### 1.1 Color tokens — exact values

Values were sampled from concept images 01–06 (dark) and 07–09 (light surfaces), then adjusted to pass contrast.
House style is `oklch()`; hex is given for review only. **Replace the values of existing tokens in place; add only
the tokens marked NEW.** Contrast figures are WCAG ratios computed for these exact values.

#### Dark (`:root`, default)

| Token | Hex (ref) | Value to write | Use | Contrast notes |
| --- | --- | --- | --- | --- |
| `--surface-sunken` | `#0a1016` | `oklch(0.170 0.016 249)` | inputs, textarea, code/log wells, kbd | — |
| `--surface` | `#0e141b` | `oklch(0.189 0.017 253)` | page canvas, sidebar, top bar | — |
| `--surface-raised` | `#151d26` | `oklch(0.227 0.021 252)` | cards, panels, table body, menus, dialogs | — |
| `--surface-strong` **NEW** | `#202a36` | `oklch(0.281 0.026 253)` | active nav item, nav count pill, secondary-button hover, disabled primary fill | no status text on it |
| `--line` | `#1f2833` | `oklch(0.273 0.024 254)` | hairlines, row dividers, card borders | — |
| `--line-strong` | `#2f3b48` | `oklch(0.347 0.028 251)` | input/secondary-button borders, dialogs | 1.49:1 vs raised (decorative; inputs also differ by fill) |
| `--ink` | `#e6ebf1` | `oklch(0.938 0.010 253)` | primary text | 14.2 on raised |
| `--ink-muted` | `#98a5b5` | `oklch(0.717 0.028 254)` | secondary text, labels, placeholders | 6.8 on raised |
| `--ink-inverse` | `#06111d` | `oklch(0.174 0.030 251)` | text on accent fill | 7.7 on accent |
| `--accent` | `#5aa9fa` | `oklch(0.720 0.142 251)` | Bellows blue: primary buttons, links, focus, "your turn" | 6.9 on raised |
| `--lamp-run` | `#4fd384` | `oklch(0.775 0.162 154)` | running lamp, passed gate, ready | 8.9 on raised |
| `--lamp-wait` | `#e5aa35` | `oklch(0.774 0.143 80)` | warnings only: banners, repo "setting up", unsaved changes, sessions chart line | 8.2 on raised |
| `--lamp-stop` | `#f26673` | `oklch(0.688 0.172 17)` | failed, destructive, invalid | 5.6 on raised |
| `--lamp-done` | `#8593a3` | `oklch(0.657 0.029 252)` | done, waiting-for-review, not checked out | 5.4 on raised |
| `--accent-wash` | — | `color-mix(in oklab, var(--accent) 16%, transparent)` (unchanged) | needs-review pill, chips, selector hover, selected row | accent text on it ≈5.2 |
| `--ok-wash` **NEW** | ≈`#1e3a35` | `color-mix(in oklab, var(--lamp-run) 16%, transparent)` | passed/ready pills, success icon disc | 6.4 |
| `--warn-wash` **NEW** | ≈`#363428` | `color-mix(in oklab, var(--lamp-wait) 16%, transparent)` | warning banner fill, "setting up" disc | 6.0 |
| `--bad-wash` **NEW** | ≈`#352830` | `color-mix(in oklab, var(--lamp-stop) 14%, transparent)` | failed pills, blocker panel, failed gate header | ≥4.5 (14% not 16%: 16% measured 4.52 — too tight) |
| `--done-wash` **NEW** | — | `color-mix(in oklab, var(--lamp-done) 10%, transparent)` | done / queued / waiting-for-review / stopped pills | 4.70 (16% measured 4.27 — fails) |
| `--accent-hover` **NEW** | ≈`#6bb1f9` | `color-mix(in oklab, var(--accent) 88%, var(--ink))` | primary button hover fill | `--ink-inverse` on it 8.4 |
| `--accent-border` **NEW** | ≈`#2a4766` | `color-mix(in oklab, var(--accent) 30%, var(--surface-raised))` | filter-chip border, selected-row outline | decorative |
| `--ok-border`, `--warn-border`, `--bad-border` | — | unchanged recipes | pill/banner 1px borders | — |
| `--chart-primary` | — | unchanged (`accent` 70% + black) | input-token bars (concept `#3179be`) | — |
| others (`--overlay`, `--on-warn`, `--on-bad`, `--chart-grid`, `--lamp-glow`, `--shadow-float`) | — | unchanged | — | — |

#### Light (`:root[data-theme="light"]`)

| Token | Hex (ref) | Value to write | Contrast notes |
| --- | --- | --- | --- |
| `--surface-sunken` | `#eef2f7` | `oklch(0.960 0.008 254)` | — |
| `--surface` | `#f6f8fb` | `oklch(0.978 0.005 258)` | concept 07 canvas `#f6f9fc` |
| `--surface-raised` | `#ffffff` | `oklch(1 0 0)` | — |
| `--surface-strong` **NEW** | `#e4eaf2` | `oklch(0.935 0.013 256)` | — |
| `--line` | `#e1e7ef` | `oklch(0.926 0.013 256)` | — |
| `--line-strong` | `#c5d0dc` | `oklch(0.853 0.021 250)` | — |
| `--ink` | `#0f1a2a` | `oklch(0.216 0.036 258)` | 17.5 on raised |
| `--ink-muted` | `#4f5e72` | `oklch(0.477 0.037 256)` | 6.6 raised / 5.9 sunken |
| `--ink-inverse` | `#ffffff` | `oklch(1 0 0)` | 5.2 on accent |
| `--accent` | `#1d6ad4` | `oklch(0.540 0.179 258)` | 5.2 raised / 4.6 sunken — **blue, not the purple of 07–09** |
| `--lamp-run` | `#147a46` | `oklch(0.512 0.120 155)` | 5.4 raised / 4.8 sunken |
| `--lamp-wait` | `#9a5b00` | `oklch(0.531 0.119 65)` | 5.4 raised / 4.8 sunken |
| `--lamp-stop` | `#c9303e` | `oklch(0.553 0.188 21)` | 5.3 raised / 4.7 sunken |
| `--lamp-done` | `#5e6a7b` | `oklch(0.520 0.031 257)` | 5.5 raised / 4.9 sunken |
| `--accent-wash` | — | `color-mix(in oklab, var(--accent) 8%, transparent)` (was 12%) | accent text on it 4.63 (10% measured 4.50 — too tight) |
| `--ok-wash` / `--warn-wash` / `--bad-wash` / `--done-wash` **NEW** | — | same recipes at **8%** | all ≥4.5 at 8% (done 4.94; 10% measured 4.50–4.82) |
| `--accent-hover` **NEW** | ≈`#1b60c0` | same recipe as dark (`accent` 88% + `ink`) | white on it 6.0 |
| `--accent-border` **NEW** | ≈`#bbd2f2` | same recipe as dark | decorative |
| `--on-warn`, `--on-bad`, `--shadow-float` | — | keep current light overrides | — |

Rules:
- `--accent` (UI) and `--chart-primary` (data) stay distinct tokens.
- Status text is always `var(--lamp-*)` on `var(--*-wash)` or on raised/surface. Never put status text on `--surface-strong`
  without re-measuring.
- Add every NEW token to the `@theme inline` block (`--color-surface-strong: var(--surface-strong);` etc.) **only if** a
  Tailwind utility needs it; otherwise do not (the parity test does not count `@theme` exposures as callers).
- `e2e/polish.spec.ts:58-86` measures contrast by painting each token **opaque** on a canvas — alpha is dropped, so it
  would mis-measure the translucent washes. Add a composite probe: read the computed colors of the wash and of the
  surface it sits on (`--surface-raised` for pills in panels, `--surface` for the page), alpha-composite in JS
  (`c = a·fg + (1−a)·bg` per gamma-encoded sRGB channel — how the browser blends), then compute the ratio against the text token. Cover every pill tone,
  chip, banner, primary/hover/disabled button, both themes.

### 1.2 Status semantics (one table, used everywhere)

**DECISION:** keep the documented meaning of the palette and the **existing dot semantics** (`taskDotClass`,
`task-tree.ts:112-121`: live breathes, parked/queued grey, failed red, finished green, stopped plain) — change only
what F2 and "your turn" require. **Blue = your turn**, **green = machine working / finished well**, **red = failed**,
**grey = parked / nobody's turn**, **amber = warnings only** (banners, checkout in progress, unsaved changes — no
longer a task state). Review-wait is neutral grey with a clock (PLAN §5; the external reviewer owns the next step),
not the amber of concept 03. Done matches concept 01: grey pill with a green check icon.

| Presentation (from `taskTone`, §3.2) | Pill class → text / fill / border | Icon (color) | Dot class |
| --- | --- | --- | --- |
| Queued | `pill-done` → `--lamp-done` / `--done-wash` / none | `clock` (inherit) | `sidenav-dot-paused` (unchanged) |
| Running | `pill-ok` → `--lamp-run` / `--ok-wash` / `--ok-border` | pill-embedded `sidenav-dot-running` | `sidenav-dot-running` (unchanged) |
| Stopping | `pill-done` | embedded `sidenav-dot-stopping` (grey, breathing) | `sidenav-dot-stopping` (unchanged) |
| Waiting for review | `pill-done` + 1px `--line-strong` border | `clock` | `sidenav-dot-paused` (unchanged) |
| Succeeded · Needs review | `pill-accent` → `--accent` / `--accent-wash` / none | `circle-dot` | **NEW `sidenav-dot-review`** (`--accent`) — was `done` |
| Failed · Needs review (failed/dead) | `pill-bad` → `--lamp-stop` / `--bad-wash` / `--bad-border` | `alert-circle` | `sidenav-dot-failed` (unchanged) |
| Stopped · Needs review | `pill-done` | `minus-circle` | `''` plain dot (unchanged) |
| Done | `pill-done` | `check-circle` in `--lamp-run` | `sidenav-dot-done` (green, unchanged) |
| Verification failed (secondary pill, header + rail) | `pill-bad` | `alert-circle` | — |
| Verification passed | `pill-ok` | `check-circle` | — |

Dot changes this implies (land with F2 in G7, Phase 0, §3.2): (a) `doneAt` check moves **above** the open-wait
check; (b) `succeeded` with `doneAt === null` and no open wait returns `sidenav-dot-review`; (c) add
`.sidenav-dot-review { color: var(--accent); }`. Update `web/test/task-tree.test.ts` and `web/test/sidenav.test.tsx`
assertions for both, and the `taskDotClass` doc comment.

Text label is always present; icon is `aria-hidden`. Zero failures / exit code 0 never render red.

### 1.3 Typography

**DECISION:** body and headings in **Barlow** (sans), identifiers/logs in **IBM Plex Mono**. Remove Barlow Semi
Condensed: delete its three `@font-face` rules, the woff2 files under `web/public/fonts/`, its `LICENSES.md` entry and
`--font-display` once no caller remains (`@apply font-display` on h1–h3 → `font-sans`).

| Role | Class (new/renamed) | Size / line-height / weight | Notes |
| --- | --- | --- | --- |
| Page title (h1) | `page-header` h1 | 28px / 36px / 600 desktop; 24px / 32px ≤640px | tracking −0.01em |
| Page description | `page-header-description` | 15px / 22px / 400, `--ink-muted` | max 72ch |
| Section title (h2) | panel h2 | 18px / 26px / 600 | |
| Sub-section (h3) | | 15px / 22px / 600 | |
| Body, controls | base | 14px / 21px / 400 (controls 500) | body stays 14px; composer textarea 15px |
| Row title | `inbox-row-title` | 14px / 20px / 600 | |
| Supporting text | | 13px / 18px / 400, `--ink-muted` | row summaries, helpers |
| Label / table header | | 13px / 18px / 500, `--ink-muted`, sentence case | |
| Rail eyebrow | `task-outcome-label` | 12px / 16px / 600, uppercase, 0.06em, `--ink-muted` | concept 03 "STATUS / RUN RESULT" |
| Status pill | `pill` (+ tones) | 12px / 16px / 600 | `badge` stays the synthetic marker |
| Metric value | `card-value` | 28px / 34px / 600, `font-variant-numeric: tabular-nums` | 24px ≤640px |
| Mono | `code`, ids, branch, logs | 13px / 20px Plex Mono 400; logs 12px / 18px | |

### 1.4 Spacing, radius, elevation, sizes

- **Spacing scale (raw px only from this list):** 4, 8, 12, 16, 24, 32, 48. Replace off-scale values (5, 6, 7, 9, 10, 14,
  20) in any rule you touch; do not sweep untouched rules.
- **Page gutters:** 32px ≥1201px, 24px 901–1200px, 16px ≤900px. Top padding 32px desktop / 16px phone.
- **Content max-width:** 1440px (was 1400). Prose ≤ 72ch.
- **Panel:** padding 24px desktop, 16px ≤640px; 1px `--line` border; `--surface-raised` fill; radius 8px.
- **Radius:** `--radius-md` 4px (pills, kbd, checkboxes), `--radius-lg` 6px (buttons, inputs, selectors),
  **NEW `--radius-xl: 0.5rem`** in `@theme static` (panels, cards, dialogs, banners). Avatars and dots 50%; filter chips
  999px (capsule — the existing house value). Nothing else.
- **Elevation:** borders + fill only. Shadow `0 8px 24px var(--shadow-float)` only on popovers/menus/dialogs.
- **Controls:** 40px desktop height, set in **new** rules scoped to the primitives (`button.primary`, `.field`,
  `.select-trigger`, header action buttons). Leave the three 36px floor rules exactly as they are (§0 rule 6).
  44px ≤900px by appending selectors to the existing 44px rule. Icon-only buttons 40×40 desktop; append their class
  to the 44px rule for compact.
- **Icons:** 16px inline, 20px in buttons/nav, 24px section headers & metric discs (disc 40px circle, `--*-wash` fill).
- **Shell:** sidebar **224px** (was 240), top bar **56px**, sidebar item 40px tall, radius 6px, 12px horizontal padding.

### 1.5 Primitive recipes

| Primitive | Default | Hover | Focus-visible | Disabled | Busy |
| --- | --- | --- | --- | --- | --- |
| Primary button (`button.primary`) | fill `--accent`, text `--ink-inverse`, 14px/600, 0 16px, radius 6px, 40px | fill `--accent-hover` | existing focus ring (2px accent outline, 2px offset) | fill `--surface-strong`, text `--ink-muted`, `cursor: not-allowed` (concept 02 "Start task") | label swaps to "Starting…", `aria-busy`, disabled |
| Secondary button (`button`) | transparent, 1px `--line-strong`, text `--ink` | fill `--surface-strong` | same ring | text `--ink-muted`, border `--line` | same |
| Destructive (`button.danger` **NEW class**) | transparent, 1px `--bad-border`, text `--lamp-stop` | fill `--bad-wash` | same | same as secondary | same |
| Destructive confirm (dialog) | fill `--lamp-stop`, text `--on-bad` | — | same | — | — |
| Text field / textarea | fill `--surface-sunken`, 1px `--line-strong`, radius 6px, 40px, 0 12px, placeholder `--ink-muted` | border `--ink-muted` | ring + border `--accent` | fill `--surface`, text `--ink-muted` | — |
| Invalid field | border `--lamp-stop`, `aria-invalid`, message 13px `--lamp-stop` below, linked by `aria-describedby` | | | | |
| Selector (`select-trigger`) | as text field + chevron icon (replace `::after ▾` with `Icon`) | | | | |
| Status pill (`pill` + tones `pill-ok/-bad/-done/-accent`; `pill-warn` only if a warning pill gets a caller) | 24px tall, 0 8px, radius 4px, 12px/600, icon 14px + 4px gap, tone table §1.2. Restyle the existing `pill`; do **not** touch `badge` | — | — | — | — |
| Filter chip (`inbox-chip` **NEW**) | `--accent-wash` fill, 1px `--accent-border`, radius 999px, 28px, 0 12px, "Label: value" + ×-button (named "Remove filter: Label") | | | | |
| Count pill (nav) | `--surface-strong`, 12px/600, 0 8px, radius 4px, tabular-nums | | | | |
| Banner (`banner-warn/-bad/-info` **NEW**) | 1px `--*-border`, fill `--*-wash`, radius 8px, 16px 24px, 24px icon disc, title 15px/600, body 14px | | | | |
| Disclosure | `<details>` with chevron-right rotating by `[open]` selector (no transition) | | | | |
| Table (`data`) | header row fill `--surface`, 13px/500 muted, 1px `--line` bottom; body `--surface-raised`, rows 1px `--line` dividers; row hover fill `--surface-sunken` (pills on hovered rows keep ≥4.5 — covered by the composite probe; never put pills on `--surface-strong`) | | | | |
| Selected row | 1px `--accent-border` inset outline + `--accent-wash` fill (concept 06) | | | | |
| Dialog | `--surface-raised`, 1px `--line-strong`, radius 8px, shadow-float, 24px padding, max 560px; ≤640px full-width, contained scroll | | | | |
| kbd | `--surface-sunken`, 1px `--line`, radius 4px, Plex Mono 12px, 0 8px, 24px | | | | |
| Avatar | 28px circle, `--surface-strong` fill, 12px/600 initials; image when `avatarUrl` known; unknown → "?" with `aria-label="Unknown author"` | | | | |

### 1.6 Icons

**DECISION:** one file `web/src/components/Icon.tsx` exporting `Icon({ name, size = 16, label? })`: 24×24 viewBox,
1.75px stroke, round caps/joins, `fill="none"`, `stroke="currentColor"`, `aria-hidden="true"` unless `label` given
(then `role="img"` + `aria-label`). Hand-written paths (Lucide-style shapes, MIT-compatible originals or drawn anew —
no new dependency). Only these glyphs (add more only with a caller):

`home`, `list`, `settings`, `plus`, `search`, `chevron-down`, `chevron-right`, `arrow-left`, `arrow-right`, `x`,
`check`, `check-circle`, `alert-circle`, `alert-triangle`, `info`, `clock`, `circle-dot`, `minus-circle`, `refresh`,
`external-link`, `copy`, `git-branch`, `git-pull-request`, `repo`, `user`, `users`, `layers`, `sparkles`, `terminal`,
`file`, `sliders`, `menu`, `calendar`.

`Icon.tsx` is frozen at Checkpoint A, so every glyph a lane needs is fixed here:

| Where | Glyph |
| --- | --- |
| Nav: Dashboard / Tasks / Settings | `home` / `list` / `settings` |
| Inbox count cards: Needs review / Running / Past | `circle-dot` / `refresh` / `check-circle` |
| Composer: step headings | none (numbered circles); "Try an example" `sparkles`; blocker banner `alert-circle`; info banner `info` |
| Composer context labels: Repository / Executor / Workflow | `repo` / `terminal` / `git-branch` |
| Detail: back link / copy / external / branch / PR | `arrow-left` / `copy` / `external-link` / `git-branch` / `git-pull-request` |
| Detail: disclosures | `chevron-right` |
| Dashboard metric discs: Sessions / Tokens / Active time / Edit acceptance | `users` / `layers` / `clock` / `check` |
| Dashboard toolbar: range / refresh | `calendar` / `refresh` |
| Repository cards: Selected / Ready / Setting up / Failed | `repo` / `check-circle` / `refresh` / `alert-circle` |
| Banners: warn / bad / info | `alert-triangle` / `alert-circle` / `info` |
| Filter chip remove, dialog close | `x` |
| Search fields | `search` |
| Selector chevron | `chevron-down` |
| Mobile drawer trigger | `menu` |
| Status pills | per §1.2 |

`currentColor` and `none` are excluded from the color scan (`styles.test.ts:9-11,152`), so the attributes are fine in
TSX. Add `Icon.tsx` (and an `.icon` class if you add one) to `design-system.md`. Replace `::after` glyphs (`▾`, `✓`, `↑/↓`) with `Icon` where the owner is a component; keep the
`th.asc/desc` CSS arrows if replacing them would need markup in every table (note it in the doc).

### 1.7 Component-state specimen (H1 — R1 exit deliverable)

- Hosting constraint: Playwright's webServer runs one `npm run build` and the API serves `web/dist` via
  `@fastify/static` (`playwright.config.ts:92`, `server/src/app.ts:167`). A fixture HTML under `e2e/` is never served,
  and a second Vite entry in `web/vite.config.ts` would ship publicly.
- **DECISION:** a separate, test-only Vite server. Add `e2e/specimen/vite.config.ts` (root `e2e/specimen`, React +
  `@tailwindcss/vite` plugins, `server.port` = `E2E_PORT_BASE + 3` read from env (default 8126), `fs.allow` including
  `web/src`), `e2e/specimen/index.html`,
  `e2e/specimen/main.tsx` importing `web/src/styles.css` and real primitives (`Icon`, `PageHeader`, selector,
  dialog shell…). Register it as a **second `webServer` entry** in `playwright.config.ts`
  (`npx vite --config e2e/specimen/vite.config.ts`, url on the same derived port) and a `specimen` project whose
  `testMatch` is `specimen.spec.ts` only. Uses existing dependencies; nothing lands in `web/dist`. Theme is toggled by
  setting `document.documentElement.dataset.theme` in the spec. Add `e2e/specimen/**` to `e2e/tsconfig.json` and make
  sure Biome covers it (it's under `e2e/`).
- Grid: rows = primary / secondary / destructive button, text field, textarea, selector (closed + open), checkbox,
  pill (all tones §1.2), chip, banner ×3, dialog, disclosure (closed/open), table row (default/hover/selected),
  avatar (image/initials/unknown), kbd. Columns = default, selected, invalid, disabled, busy, long content (60-char
  unbroken label). Hover and focus-visible are **not** faked with extra CSS classes: the spec captures them as extra
  element screenshots after `locator.hover()` and after keyboard `Tab` focus.
- Output: `artifacts/ui/specimen-{dark,light}-{1440,390}.png`. Commit a copy of the four PNGs under
  `docs/plans/bellows-redesign-2026-09-26/specimen/` as the R2–R7 reference.

---

## 2. Screen specifications (what "done" looks like)

Measurements are for 1440px desktop. ASCII is structure, not pixels. Concept reference in brackets.

### 2.1 Shell [all]

```
┌──────────────────────────────────────────────────────────────────────────────┐ 56px top bar, --surface, 1px --line bottom
│ [≋] BELLOWS                              Appearance ▾   org default ▾   (JD) │
├──────────────┬───────────────────────────────────────────────────────────────┤
│ ⌂ Dashboard  │  page content, 32px gutters, max 1440px                        │
│ ☰ Tasks   12 │  (pill = needs-review count; hidden at 0)                       │
│   ▾ Running (3) · Need review (12)   ← existing CountLine as <summary>        │
│     + New task                                                                │
│     ● task row / ● task row …  (existing single mixed preview, MAX_PREVIEW=5)  │
│     +7 more need review · View all tasks                                      │
│ ⚙ Settings   │                                                                │
│   Overview…  │ (settings sub-items only on /settings*)                        │
└──────────────┴───────────────────────────────────────────────────────────────┘
 224px, --surface, 1px --line right border
```

- Wordmark: keep text "BELLOWS" (15px/600, 0.12em tracking) + existing mark; no generated logo.
- Active nav: `--surface-strong` fill, `--ink` text, icon `--accent`; inactive `--ink-muted` text, hover `--surface-strong`.
- **Tasks count pill (NEW):** on the Tasks nav item show `navigation.counts.review` (the "your turn" number) in a
  `sidenav-count` pill (`--surface-strong`, 12px/600, tabular-nums); hidden when 0 or when `navigation` is null. It
  is `aria-hidden`; the link gets `aria-label` "Tasks, " + `countLabel('review', n)` (reuse `nav-model.ts:59`, today
  used only by `MobileNavDialog.tsx:77-79`). Add a `sidenav.test.tsx` case.
- **Previews:** keep SideNav's existing single mixed preview (`SideNav.tsx:75-131`: `CountLine`, `NewTaskLink`,
  `preview.rows`, "+N more need review", "View all tasks") — **no** split into groups. Wrap that block in one
  `<details open className="sidenav-preview">` whose `<summary>` renders the existing `CountLine` text ("All caught up"
  when empty). 13px rows, summary 12px/600 muted. Open/closed is local component state, no storage. The drawer's
  content is unchanged (restyle only).
- One appearance control (existing `ThemeSelector`). **Do not** add the moon toggle from the concepts.
- Settings sub-items: Overview, Organization, Workspace, Repositories, Executors, Workflows (add Overview →
  `/settings` to `SETTINGS_SECTIONS` with `end` matching). No top-level "Agents" or "Repositories" nav.
- ≤900px: existing drawer (`MobileNavDialog`) — restyle only; counts, no full task list.

### 2.2 Task inbox `/tasks` [01]

```
Tasks                                                         [+ New task]
Delegate software work to AI agents and review their changes.

┌─(◉) 12 Needs review──┐ ┌─(↻) 3 Running────────┐ ┌─(✓) 86 Past───────────┐   3 cards, 12px gap, 88px tall
│ Organization total   │ │ Organization total   │ │ Organization total    │
└──────────────────────┘ └──────────────────────┘ └───────────────────────┘
[Needs attention] [Running] [Needs review] [Past]      ← existing state tabs (inbox-tab), segmented style
[🔍 Search task requests……………] [All repositories ▾] [Author login…] [Filter]   Sort: [Newest] [Oldest]
(Search: "oauth" ×) (Repository: web-app ×) (Author: alice ×)  Clear filters
┌ Task ───────────────────────────── State ──────── Repository ── Author ── Updated ┐
│ ● Add user onboarding flow          [◉ Needs review] web-app      (AL) alice  16m ago│  min 60px rows
│   Implement a multi-step onboarding…                                              │
└───────────────────────────────────────────────────────────────────────────────────┘
Showing 24 loaded tasks                                            [Load more]
```

- Count cards = `navigation.counts.review / running / past` (three only). Each is a `<Link>` to `?state=review|running|past`
  with `aria-label="12 tasks need review across the organization"`. Icon disc 40px: review `--accent-wash`+accent,
  running `--ok-wash`+lamp-run, past `--done-wash`+lamp-done. Value 28px/600; label 14px/600 in tone color; caption
  13px muted "Organization total". Counts ignore filters (unchanged data source).
- Controls are the existing ones, restyled: state tabs labelled exactly as today ("Needs attention" is pinned by
  `task-inbox.render.test.tsx:293`), the search/repo/author form with its **Filter** submit button, and sort as
  `inbox-tab` **links** (`TaskInboxPage.tsx:112-121`) rendered as a small segmented control — not a dropdown.
- Chips: one per non-default `q`, `repo`, `author` (state is shown by the active tab; sort by the segmented control,
  so neither gets a chip). × removes that one param via `inboxQueryString`; "Clear filters" → `/tasks`.
- Row grid: `minmax(0,1fr) 168px 160px 144px 96px`; title link first (the only link in the row), 14px/600, summary
  13px muted one line with ellipsis (full text in `title` attr); running rows show activity, terminal rows summary.
  State pill per §1.2 from `taskStatusLabel` + new `taskTone` helper (F2 precedence, landed in G7). Repo with `repo` icon; author
  avatar + login; updated = `RelativeTime` of `activityAt`, right-aligned. No checkbox, checks, branch/PR, duration,
  ⋯ menu (PLAN §4 boundary).
- ≤900px (existing breakpoint): row becomes stacked card — title, pill, then "repo · author · time" 13px muted.
- Footer: "Showing N loaded tasks" (no total), existing Load more.
- Empty states unchanged in behavior; restyle as centered panel with 24px icon.

### 2.3 New task `/tasks/new` [02]

```
← Tasks › New task
New task
Describe what you want done, choose where it runs, and check readiness before starting.

┌ (1) What should the agent do? ─────────────────────────────── [✦ Try an example] ┐ example only enabled on empty draft
│ Include the outcome, relevant files or issue, and checks to run.                 │
│ ┌ textarea, --surface-sunken, min 160px, 15px ────────────────────────────────┐  │
│ └──────────────────────────────────────────────────────────── 184 / 16,384 ─┘  │ server COMMAND_LIMIT
└──────────────────────────────────────────────────────────────────────────────────┘
┌ (2) Execution context ──────────────────────────────────────────────────────────┐
│ Repository ▾ (helper)        Executor ▾ (helper, red border if missing)  Workflow ▾ │ 3 cols ≥1024, stack below
└──────────────────────────────────────────────────────────────────────────────────┘
┌ (3) Workflow details ───────────────────────────────────────────────────────────┐
│ named workflow → WorkflowParameterFields                                          │
│ default → "Every task runs: prompt → gates → publish." (text, no checkboxes)       │
│           ▾ Optional steps (2 of 2 on)                (existing <details>)         │
│             [✓] Iterate on PR review comments                                      │
│             [✓] Repair merge conflicts        (real labels, TaskComposer.tsx:488,496)│
└──────────────────────────────────────────────────────────────────────────────────┘
┌ (!) Not ready to start ── banner-bad ───────────────────────────────────────────┐ only for the 3 kinds below
│ ● No executor configured   Add one to run tasks.  [Add an executor in Settings →]  │
└──────────────────────────────────────────────────────────────────────────────────┘
                                          [Discard draft]  [Start task] ⌘/Ctrl + Enter
```

- Step circles: 28px, `--accent` fill, `--ink-inverse` 13px/600 digit; `aria-hidden` (headings carry the text).
- Blockers come from `startBlocker` (`web/src/task-composer.ts:280-293`), one at a time as today. Its kinds split:
  - **Banner (`banner-bad`) only for** `missing-executor` (action: link to `/settings/executors?return=/tasks/new`),
    `defaults-unresolved` (no link; "Loading workflow preferences…" is `banner-info`, not red), `invalid-params`
    (no link; points at the invalid fields, which carry their own messages).
  - `empty-prompt` and `in-flight` **never** raise a banner — a fresh composer must not open red. They keep today's
    quiet `composer-blocker` status text next to Start (`TaskComposer.tsx:752-754`).
  - No "Repository access not verified" row (no such probe exists).
  The Start button's `aria-describedby` points at whichever of banner / status text is showing.
- Character counter is **required**: `{draft.length} / 16,384` using `COMMAND_LIMIT` (`server/src/routes/job-limits.ts:19`,
  enforced in `job-field-validation.ts:70`). The constant is **already duplicated** in
  `server/src/db/workflow-schema.ts:33`. **DECISION (DRY):** move it to a new `core/src/limits.ts`
  (`export const COMMAND_LIMIT = 16_384;`), re-export from `core/src/index.ts`, delete both server definitions and
  import from `@factory-ai/core` in server (`job-limits.ts` callers, `workflow-engine.ts`, `job-field-validation.ts`)
  and web. Count with `draft.length` (UTF-16 units — the same measure the server uses). Counter turns `--lamp-stop`
  and Start is blocked above the limit (add `too-long` to `startBlocker`, banner kind). Rebuild core before
  typechecking server/web.
- **No** attachment / mention / template buttons.
- Discard draft (secondary) — see F1 §3.1.

### 2.4 Task detail `/tasks/:id` [03, 04]

```
Tasks › Fix password reset flow
Fix password reset flow                          [status pill] [primary action] [More ▾]
#id · Opened 3h ago by (AL) alice · repo web-app
┌ main (fluid) ─────────────────────────────────────┐ ┌ Outcome rail 320px ────────────┐ ≥1024px
│ Conversation: request / agent response            │ │ STATUS       [pill] + 1 line   │
│   ▸ View raw output                               │ │ RUN RESULT   [pill] finished…  │
│ Run history (recorded timestamps only)            │ │ VERIFICATION [pill] 4/4 pass   │
│ Verification: gates, failed expanded first        │ │ PUBLISHED    branch [copy] PR↗ │
│ Services                                          │ │ EXECUTION    executor, platform│
│ Published work (links only, no diff)              │ │ ATTRIBUTION  author, closed by │
│ Follow up (composer or reason it's unavailable)   │ │ NEXT ACTION  (failure only)    │
└───────────────────────────────────────────────────┘ └────────────────────────────────┘
```

- Header primary action by matrix §3.2 (at most one primary). "More" menu (Headless UI `Menu`) holds Remove and the
  secondary of Stop/Mark done.
- Run history: vertical list, 20px status icon + 1px `--line` connector, 14px title, 13px muted detail, right-aligned
  `RelativeTime`. Items only from recorded fields: created, started, finished (per run/follow-up), `waitingSince`,
  `doneAt` (+`doneBy`), stop request/stopped. Never "Implemented changes"/"Published PR" rows.
- Verification: header "Verification" + count pills from `gateCounts`: "N failed" (`pill-bad`), "N passed"
  (`pill-ok`), "N running" (`pill-done`). Render a pill only when its count is > 0 — never a "0 failed" pill. Each gate
  is a `<details>`; failed gates `open` initially.
  Output in `--surface-sunken` mono 12px block, own horizontal scroll, `aria-label="Output of <gate>"`, copy button.
  No durations, no per-test tree.
- Published work: branch chip (mono, copy button) + "Pull request ↗" link only via existing safe-URL check.
- Failure rail "Next action" card: "Ask for another pass" primary (focuses follow-up textarea; does not submit) when
  follow-up eligible; otherwise explanation text (§3.3).
- ≤1023px: rail content moves above main as a 2-column summary grid; DOM order = visual order.

### 2.5 Dashboard `/` [05]

```
Usage overview
Monitor agent activity, token usage and task execution across your organization.
┌ toolbar (panel, 64px): [📅 Last 30 days ▾ Aug 23–Sep 21] | Scope [Org ▾] | ● 12 repositories (coverage) | ↻ Updated 12m ago ┐
┌139 Sessions┐ ┌4.34M Tokens┐ ┌7.8d Active time┐ ┌84% Edit acceptance┐       4 cards (no cost card), no trend arrows
│ caption    │ │2.97M in·1.37M out·cache …│ │across 139 sessions│ │4,642 of 5,259 edits│
┌ Token usage and sessions (main chart, full width, 360px plot) ─────────────────────────────┐
│ legend: ■ Input (--chart-primary) ■ Output (--lamp-run) ● Sessions line (--lamp-wait)      │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌ Per-task usage (existing, keep) ┐
┌ Usage by user [Agent telemetry] ┐ ┌ Recent tasks [Task board · not affected by range] ┐   side by side ≥1200px
```

- Metric card: 40px icon disc (`--accent-wash` + accent icon; edit acceptance `--ok-wash`), value 28px, label 14px/600,
  caption 13px muted with denominators. Keep unknown/“—” vs 0 distinction.
- Chart colors: input bars `--chart-primary`, output bars `var(--lamp-run)` via existing `swatch-ok`/`bar-ok`, sessions
  line + dots `--lamp-wait` (`swatch-warn`). Keep partial-bucket hatch, legend buttons, keyboard inspection, caption.
  **No** chart-type or Weekly/aggregation controls, no "vs previous period".
- Repository coverage shown as informational text with a dot, not a selector.

### 2.6 Settings › Repositories `/settings/repos` [06]

```
Settings › Repositories                                    ┌ Workspace default │ Organization org ┐ scope context
Repositories
Choose which repositories are checked out for this workspace…
┌ (!) banner-warn: Workspace root not configured ────────────────────────────────────────┐ only when root null
│ An operator must set ORG_WORKSPACE_ROOT on the deployment. Until then… [Learn about workspaces →] (link to /settings/workspace) │
└──────────────────────────────────────────────────────────────────────────────────────────┘ NO "Configure workspace root" button
[4 summary cards from counts(): Selected (enabled / 20) · Ready · Setting up · Failed]
[🔍 Search repositories…]
┌ n selected · Selection limited to 20 repositories.                       [Save selection] ┐
│ ☐ Repository            Checkout status        Branch   Last commit   Size     [Configure] │ full width table
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌ Selected repository: owner/name  GitHub ↗                                        [×] ┐
│ Checkout facts (branch/commit/size or "Not available")  │  Environment editor (existing) │ no Health tab
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- Summary cards come straight from `counts()` (`web/src/components/repository-setup.ts:149-165`), which counts
  **only chosen repos**: `enabled` → "Selected" with caption "of 20 allowed" (and "{available} available"), `ready` →
  "Ready" (ok disc), `settingUp` (queued + cloning) → "Setting up" (warn disc), `failed` → "Failed" (bad disc). No
  "Not checked out" card — `counts()` has no such figure; when the root is null the warning banner already says why
  nothing is checked out. Before the workspace poll answers (`WorkspaceState` 'loading'), show "—" with
  `aria-label="Loading"`, not 0.
- Status/Environment filter dropdowns from the concept are **omitted** (no aggregate env contract).
- Unmeasured = "Not available" (13px muted), never `0` or `—` without text alternative.

### 2.7 Other settings, account, onboarding, sign-in

Apply: page header + scope context → optional banner → panels with 24px padding → table or form → sticky-free footer
with Save (primary) / Cancel (secondary) and dirty indicator ("Unsaved changes" 13px `--lamp-wait`). Existing
`UnsavedChangesDialog`, env Variables/Secrets tabs, raw/table modes, reveal/copy behavior unchanged. Public pages
(`LoginGate`, `PublicPageHeader`, `OnboardingPage`) use the same tokens and honor the theme bootstrap.

---

## 3. Behavioral requirements from FINAL-REPORT (must ship with R3/R4)

### 3.1 F1 — composer draft survives the configuration detour (R3)

**DECISION:** in-memory, route-surviving draft owner; **no** reload persistence (no localStorage/sessionStorage).

Facts (verified):
- Draft state is nine `useState`s inside `useComposerDraft` (`web/src/panels/TaskComposer.tsx:77-255`): `draft`,
  `executor`, `repo`, `repoTouched`, `workflow`, `storedParams` (shape from `freshWorkflowDraft`,
  `web/src/task-composer.ts:311` — `{ workflowId, values }`, **not** a nested record), `paramTouched`,
  `defaultStepOverrides`, `reportedRepo`.
- Four effects already keep the draft honest against the lists and must stay authoritative:
  repo autoselect (`:131-135`), executor autoselect when `''` (`:140-144`), executor clamp to
  `defaultExecutorName(executors)` when the chosen one vanished (`:150-154`), repo clamp (`:159-163`). So a user who
  returns after **creating** an executor gets it auto-selected, and a **deleted** executor is already clamped — no new
  `executorTouched` flag or reconcile function is needed for selection.
- The repo-reset effect (`:172-177`) runs on **every** `[repo]` change **and on mount**; its comment relies on the
  mount run being a no-op because reset targets equal the mount values. With a restored draft that is no longer true:
  the mount run would wipe the restored workflow, params and overrides.
- `AppShell` (`web/src/components/AppShell.tsx:60-137`) is the lowest component that survives `/tasks/new` ↔
  `/settings/*`. It calls `useSession()` and passes `session: Session | null` through `ShellContext` (`:31`), dropping
  `loading` (`:83`). Ids: `session.user.id` and **`session.organization.id`** (`web/src/api/useSession.ts:19`).
- Org switch already calls `window.location.reload()` (`web/src/api/org.ts:16`), which wipes any in-memory state.

Who does what: **G8 (Phase 0)** delivers steps 1, 5 and 7–8 in full: the store, the owner check, the settings
links, the return banner and the route fix. These files are then frozen: `composer-draft.tsx`, `AppShell.tsx`,
`DraftReturnBanner.tsx` and the two settings pages' mount line. **L2** delivers steps 2–4 and 6 inside
`TaskComposer.tsx` / `task-composer.ts` only.

Implementation:
1. **(G8)** New `web/src/composer-draft.tsx`: `ComposerDraftProvider` + `useComposerDraftStore(): { state:
   ComposerDraftState | null; save(next: Omit<ComposerDraftState, 'owner'>): void; clear(): void }`. The provider
   holds one `ComposerDraftState | null` in `useState`, is mounted in `AppShell` around `<Outlet>`, stamps `owner` on
   `save`, and returns `state: null` when `owner` ≠ the current session's owner (step 5). Unit-test it in G8:
   ```ts
   interface ComposerDraftState {
       owner: string;                    // `${session.organization.id}:${session.user.id}`
       draft: string;
       executor: string;
       repo: string;
       repoTouched: boolean;
       workflowRepo: string;             // NEW: the repo the workflow/params/overrides were chosen under
       workflow: string;
       storedParams: ReturnType<typeof freshWorkflowDraft>['storedParams'];
       paramTouched: ReturnType<typeof freshWorkflowDraft>['paramTouched'];
       defaultStepOverrides: DefaultStepOverrides;
   }
   ```
   (`reportedRepo` stays local — it tracks what was reported to the page, not user input.)
2. **(L2)** `useComposerDraft` initialises each `useState` from the store when a draft for the current owner exists (else
   today's initialisers), and writes every change back to the store (one `useEffect` syncing the tuple is fine).
3. **(L2) Repo-reset fix:** replace the unconditional `[repo]` effect with: "if `repo !== workflowRepo` → reset
   workflow/params/touched/overrides **and** set `workflowRepo = repo`". On a restore `repo === workflowRepo`, so
   nothing resets; the select, the autoselect and both clamps still change `repo` and therefore still reset — the
   existing contract ("every path a change arrives by is this one state") holds. Update the effect's comment. On a
   fresh mount initialise `workflowRepo` to the initial `repo`.
4. **(L2) Notices (only new logic):** pure helper `restoredDraftNotices(restored, { repos, executors, workflows })` in
   `task-composer.ts`, run once after a restore when the lists first resolve (non-null). Returns messages for: restored
   executor no longer listed ("Executor ‘X’ is no longer available — {new} selected" / "— add one to continue"),
   restored repo no longer selected, restored workflow no longer offered. The existing effects do the actual clamping.
   Render as a dismissible `banner-info` above section 2. The request text is never touched.
5. **(G8 store; L2 skeleton)** Owner scoping: when `owner` ≠ the current `${org}:${user}` — a different account after
   sign-out/401 re-auth — the provider discards the draft before any restore. Org switch is already covered by the reload (in-memory state is
   gone); state that in the code comment rather than building a second mechanism. While the session is loading
   (see §3.3's `sessionLoading`), do not restore yet — show the composer skeleton.
6. **(L2)** Clear on: successful `send()` (where it clears `draft` today — clear the whole store entry), a new **Discard draft**
   secondary button (only shown when the draft differs from a fresh one; confirm with the existing dialog pattern when
   `draft` is non-empty). Never auto-launch on return.
7. **(G8)** Return path: the executor link is today's "Add an executor in Settings" (`TaskComposer.tsx:373`) → change
   its `to` to `/settings/executors?return=/tasks/new`; the repo link (`:378`) → `/settings/repos?return=/tasks/new`.
   New `web/src/components/DraftReturnBanner.tsx` reads `useSearchParams().get('return')` and accepts **only the
   exact string `/tasks/new`**. When accepted, it renders a top `banner-info`: "You have a task draft in progress.
   [Back to new task]", visible before and after save and on cancel. No auto-redirect. It is mounted with one line at
   the top of `SettingsExecutorsPage.tsx` and `SettingsRepositoriesPage.tsx` (neither reads params today).
8. **(G8) Bug fix:** `TaskComposer.tsx:378` links to `/settings/repositories`, which does not exist (route is `repos`;
   the catch-all redirects to `/`). Covered by step 7; add a render assertion on the href.

Tests:
- Unit (`web/test/task-composer-logic.test.ts`): `restoredDraftNotices` — executor removed with/without a replacement,
  repo removed, workflow removed, nothing removed → no notices.
- **(G8)** `web/test/composer-draft.test.tsx` (NEW): save stamps owner; owner mismatch returns null; clear.
  `web/test/draft-return-banner.test.tsx` (NEW): only exact `/tasks/new` accepted. `task-composer.render.test.tsx`:
  both settings links carry `?return=/tasks/new` and the repos href is `/settings/repos`.
- **(L2)** `web/test/task-composer.render.test.tsx` / a composer draft render case: restore keeps
  workflow/params/overrides (the mount-reset regression); repo change after restore still resets; clear after send;
  discard.
- Browser (`e2e/composer.spec.ts`): fill request + workflow params + an optional-step override → "Add an executor in
  Settings" → create a profile → "Back to new task" → all values intact and the new executor selected → Start →
  assert exactly **one** POST whose body matches the restored choices. Repeat: return via Cancel; executor deleted
  while away (notice shown, text kept); `return=https://evil.example` ignored (no banner).

### 3.2 F2 — status precedence and action matrix (R4)

Change `taskStatusLabel` (`web/src/task-tree.ts:56-73`) to (first match wins):

1. `status === null` → `—`
2. `running` → `Stopping` if `cancelRequestedAt`, else `Running`
3. **`doneAt !== null` → `Done`**  ← moved above wait
4. open wait (`waitReason !== null && waitTerminalReason === null`) → `Waiting for review`
5. `queued` → `Queued`
6. succeeded / failed|dead / stopped → verdict `· Needs review` (with `withWaitReason` suffix as today)

And `isWaitingForReview` (`web/src/task-outcome.ts:180`) → also require `job.doneAt === null`. Add
`taskTone(status): 'queued'|'running'|'stopping'|'waiting'|'review'|'failed'|'stopped'|'done'|'none'` beside the label,
same precedence, feeding the pill classes (§1.2).

Every place that shows a task state must use these functions — there are five (the first two change in G7, the
next two in L3, the fifth in L5):
- `taskStatusLabel` (inbox row, `TaskInboxPage.tsx:143`).
- `taskDotClass` (`task-tree.ts:112-121`, used by inbox `:137` and `SideNav.tsx:50`) — it checks the open wait
  **before** `doneAt`, so it would keep a closed task grey-waiting. Re-implement it as a lookup on `taskTone`
  (mapping in §1.2, incl. the new `sidenav-dot-review`).
- `TaskHeader.tsx:199` — the header pill computes `waiting ? … : latestTask.status` itself. Replace with
  `taskStatusLabel` / `taskTone` of the latest task.
- `TaskOutcome.tsx:205-214` — uses `closureOf` + `isWaitingForReview`; fixed by the `isWaitingForReview` change, but
  assert it.
- `RecentTasksPanel.tsx:27` (dashboard) — renders raw `job.status`. Replace with `taskStatusLabel` + the `pill` tone
  from `taskTone` (L5, §2.5).

**Delivery:** this precedence change (label, tone, dot, `isWaitingForReview`, their unit tests, `docs/jobs.md`) is
**G7 in Phase 0** (EXECUTION-GRAPH §2), because the inbox, sidebar, detail and dashboard lanes all consume `taskTone`.
Lanes never edit `task-tree.ts`. L3 wires the header, rail and action matrix onto it.

Action matrix (header + rail; server refusals still handled and shown):

| Latest run state | Closure | Wait | Primary | Secondary (More menu) | Notes |
| --- | --- | --- | --- | --- | --- |
| queued / running | — | any | **Stop run** | Remove **hidden** while any thread member is `running` (queued members don't hide it — `TaskHeader.tsx:179-181`) | keep "Stopping cancels remaining automation without closing or merging the PR" copy when waiting |
| running + cancelRequested | — | any | "Stopping…" (disabled, busy) | — | never show stopped early |
| terminal | open | open (parked) | **Mark done** | Remove | explain "No executor is running. The workflow is waiting for review." No Stop (API rejects terminal) |
| terminal succeeded | open | none | **Mark done** | Remove | follow-up per §3.3 |
| terminal failed/dead or verification failed | open | none | **Ask for another pass** if eligible, else **Mark done** | Mark done / Remove | ask = focus follow-up composer |
| terminal stopped | open | none | **Mark done** | Remove | |
| any | done | any | none | Remove | show "Closed by X · time"; no follow-up |

"More" is the existing Headless UI menu (`TaskHeader.tsx:108`); Remove keeps its current availability rule everywhere
in this table. Copy rule: "Mark done" description "Closes this task in Bellows. Does not merge or close the pull
request."

Tests:
- `web/test/task-tree.test.ts`: the three FINAL-REPORT probe rows (succeeded+open wait+no closure → Waiting; +doneAt →
  **Done**; terminal wait+doneAt → Done), running+wait → Running, queued+wait → Waiting, stopping precedence; the
  same rows for `taskTone` and `taskDotClass` (incl. succeeded-open → `sidenav-dot-review`).
- `web/test/sidenav.test.tsx`: update dot assertions for the review dot and done-over-wait.
- `web/test/task-header.render.test.tsx`: every matrix row; keep the queued-wait Stop test; header pill for
  done+open wait reads Done.
- `web/test/task-outcome.render.test.tsx`: done+open wait shows no wait explanation.
- Server DB test (test only, no production code): in `server/test-db/job-store.block-wait.test.ts` (harness already
  imports `sweepRuntimeWakes`, `:7`) add "Mark done on a terminal parked wait stops wakes". The sweep also skips waits
  with `pending = 0` (`runtime.ts:190`), so the test must: park a wait → `markJobDone` → **deliver a review event**
  (so `pending > 0`) → run `sweepRuntimeWakes` → assert no continuation job was inserted. A control case without
  Mark done must show the sweep **does** wake, proving the assertion isn't vacuous.
- Update `docs/jobs.md` (display precedence) and `docs/design-system.md` (status table).

### 3.3 F3 — author-aware follow-up (R4)

Server: follow-up allowed iff the **posted-to job's** `created_by IS NOT DISTINCT FROM caller.user.id`, that job is
terminal, not done, and has a session (`server/src/db/job-store-actions.ts:80-100`, parent = the job posted to,
`:92`). Continuations copy `root.created_by` (`runtime.ts:243`), so every row in a thread carries the same author
today. In `AUTH_MODE=none` the caller is the seeded local stand-in user, so it has an id.

Session loading must be observable: `ShellContext.session` is `Session | null` and `AppShell` discards `loading`
(`AppShell.tsx:31,83`). `sessionLoading: boolean` is added to `ShellContext` (from `useSession().loading`) **in G8**
(EXECUTION-GRAPH §2.1) together with the type, provider and test-helper updates. L3 only reads it.

Client (`web/src/panels/TaskDetail.tsx:72`):

```ts
// task-outcome.ts — `latest` is the job the follow-up is posted to; mirror the server on that row.
export type FollowUpEligibility = 'pending' | 'not-finished' | 'closed' | 'no-session' | 'not-author' | 'eligible';
export const followUpEligibility = (latest: Job, viewer: { loading: boolean; id: string | null }): FollowUpEligibility =>
    viewer.loading ? 'pending'
    : !isTerminal(latest.status) ? 'not-finished'
    : latest.doneAt !== null ? 'closed'
    : latest.sessionId === null ? 'no-session'
    : (latest.author?.id ?? null) !== viewer.id ? 'not-author'           // null-safe, mirrors IS NOT DISTINCT FROM
    : 'eligible';
```

Call with `{ loading: sessionLoading, id: session?.user.id ?? null }`. Messages (13px muted, in the follow-up slot
and in the rail's Next action):
- `not-author`: "Only {latest.author?.login ?? 'the task author'} can continue this session. You can still mark it done."
- `no-session`: existing sessionless copy. `closed`: nothing (closure shown elsewhere). `pending`: render nothing
  (no flash of `not-author` for your own task while the session loads).

Stop / Mark done / Remove keep their own contracts (no author restriction). Keep server refusal handling: a 403
`FORBIDDEN` on follow-up ("Only the account that queued the task can follow it up",
`server/src/routes/job-field-validation.ts:364-370`) still renders in the composer.

Tests:
- `web/test/task-derivations.test.ts`: own task; other member; null author + signed-in viewer → `not-author`; null
  author + null viewer → `eligible`; missing session; closed; loading → `pending`.
- `web/test/task-detail.render.test.tsx`: `not-author` shows explanation and no composer; `pending` shows neither; a
  mocked 403 follow-up response renders the refusal.
- Browser, authenticated (new `e2e/follow-up-auth.spec.ts`, in the `auth` project whose `testMatch` G8 widens; base URL
  from the exported `AUTH_PORT`, which G8 derives from `E2E_PORT_BASE`; real stub-IdP sign-in): **DECISION** —
  sign in as the stub user, read `/api/auth/me` (what `useSession` fetches, `useSession.ts:101`) for its id, then `page.route` the task thread with (a) `author.id`
  = that id → composer visible; (b) a different `author.id` → explanation, no composer; (c) `author: null` →
  explanation. This exercises the real authenticated session without a second IdP user. Server enforcement is
  already covered by `server/test-db/job-store.follow-ups.test.ts:256`. (A true two-account browser run needs
  `e2e/stub-idp.mjs` to carry identity through code → token → `/user`; it is listed as optional in §6 D7.)

---

## 4. Work packages (execute in order)

### R0 — Baseline and fixtures (G0–G3, ≈2 d)

1. Run `npm run verify:ui` on `e19fce1`; record pass/fail per test into
   `docs/plans/bellows-redesign-2026-09-26/baseline/RESULTS.md` (command, commit, timestamp, output tail per failure).
   Diagnose each of the historical 13 failures: stale selector vs real defect. Fix selectors that assume native
   `<select>` where the app now uses the accessible selector (`select-trigger` / listbox roles).
2. Create `e2e/fixtures/threads.ts` with **backend-shaped** thread payloads (shape copied from
   `server/test-db/job-store.block-wait.test.ts:73-100` and `job-store-reads.ts:18`):
   - running (with activity), stopping (`cancelRequestedAt`), queued
   - **terminal parked wait**: `status:'succeeded'`, `waitReason:'review'`, `waitingSince`, `waitTerminalReason:null`,
     `doneAt:null`
   - same after Mark done: `doneAt` + `doneBy` set, wait fields unchanged
   - queued woken continuation with wait metadata; running follow-up over a wait
   - failed gate (1 failed + passed gates, long unbroken output line); agent failed; stopped with `stoppedBy`
   - succeeded open with PR link; done; multi-follow-up; missing summary; other-author task; null-author task
   Refactor `e2e/task-detail.spec.ts` mocks (`:372`, `:440`, `:526-563`, `:598`) to import these.
3. Screenshot baseline: `e2e/baseline.spec.ts` capturing every route family × {dark, light} × {1440, 390} into
   `artifacts/ui/baseline/…`; filename encodes route/theme/viewport/state. Copy to `baseline/` dir with a manifest
   (route, viewport, theme, fixture, commit, timestamp).
4. Add the F2 server DB test (§3.2) — it documents current backend behavior before R4 changes the UI.

Exit: RESULTS.md with real numbers; fixtures merged; baseline gallery committed.

### R1 — Foundations and shell (G4–G6, 3–4 d; G7 + G8 add 1–1.5 d in Phase 0)

Files: `web/src/styles.css`, `web/test/styles.test.ts` (only if a pinned contract deliberately changes),
`docs/design-system.md`, `web/public/fonts/*`, `web/src/components/{Icon,AppShell,SideNav,AppBar,NavItems,
MobileNavDialog,PageHeader}.tsx`, `web/src/nav-model.ts`, `e2e/specimen.spec.ts`, `e2e/specimen/*` (Vite config,
index.html, main.tsx), `playwright.config.ts` (second webServer + `specimen` project), `e2e/tsconfig.json`,
`e2e/polish.spec.ts` (composite contrast probe).

1. Tokens: rewrite both `:root` blocks per §1.1 (add NEW: `--surface-strong`, `--ok-wash`, `--warn-wash`, `--bad-wash`,
   `--done-wash`, `--accent-hover`, `--accent-border`). Add `--radius-xl` to `@theme static`.
2. Type: §1.3; drop Semi Condensed (fonts, face rules, `--font-display`, LICENSES entry).
3. Primitives: §1.5 classes — `button.primary`, `button`, `button.danger`, field skin (introduce one shared `.field`
   class and migrate `composer-input`, `inbox-search`, `repo-search`, `picker-search` to it; delete their duplicate
   rules), `pill` + tone modifiers `pill-ok/-bad/-done/-accent` (fold `gate-passed/-failed/-running` and
   `readiness-item.is-ok/-attention/-pending` color rules into the tone set where they express the same status —
   update callers; **leave `badge`/`badge-warn` alone**, they are the synthetic-data marker), `banner-*`,
   `inbox-chip`, `kbd`, avatar, dialog. 40px heights go in new primitive rules; the 36px floor rules stay untouched;
   new touch targets are appended to the existing 44px rule (§0 rule 6). Keep `select-trigger`/`popover` geometry and
   `useDownwardAnchor` downward-only anchoring.
4. `Icon.tsx` §1.6.
5. Shell §2.1: 224px sidebar, 56px bar, nav icons, Tasks review-count pill, single collapsible preview, Settings
   Overview item. Keep skip link
   (`#main-content`), `aria-current`, focus management, drawer at ≤900px.
6. Specimen §1.7.
7. Update `design-system.md`: token tables (both themes), status table §1.2, type scale, spacing scale, primitives,
   Icon glyph list, removed classes. Update 44px rule selector list for any new control class.

Tests: `styles.test.ts`, `theme.test.tsx`, `shell.test.tsx`, `nav-model.test.ts`, `mobile-nav.test.tsx`,
`sidenav.test.tsx` (count pill + aria-label); `e2e/navigation.spec.ts`, `polish.spec.ts` (composite probe §1.1: every
pill tone, chip, banner, primary/hover/disabled button, both themes), `e2e/specimen.spec.ts`.
Exit: specimen PNGs reviewed and committed; shell screenshots at 1440/1024/390 both themes.

> Mapping to EXECUTION-GRAPH: R0 = G0–G3, R1 = G4–G6, plus G7 (F2 precedence) and G8 (shared contracts) in Phase 0;
> R2…R7 = lanes L1…L6; R8 = F1–F4. File lists below are **lane-owned files only**. Anything frozen at Checkpoint A
> (EXECUTION-GRAPH §2.3) is consumed, never edited. A needed change there is a foundation change request.

### R2 — Task inbox (L1, 2 d)

Files: `web/src/pages/TaskInboxPage.tsx` (extract `InboxCountCards`, `InboxRow` only if reused); styles region
`inbox`; design-system `inbox` rows; its selectors appended to the shared 44px rule. **Not** `task-tree.ts`,
`task-outcome.ts` or `SideNav.tsx`: the precedence, tone and dot work is G7.

Steps: §2.2 layout: count cards, restyled tabs / form / Filter button / sort segmented links, chips for
`q`/`repo`/`author` (× via `inboxQueryString`; "Clear filters" → `/tasks`), rows using `taskStatusLabel` +
`taskTone`, footer. Search placeholder "Search task requests". Author stays a labeled text input.
Acceptance (PLAN §7.1): long titles/repos never hide the state pill; reload/Back keep filters; counts unchanged under filters;
each loaded row once; zero-results ≠ empty board; stale warning keeps rows; poll keeps focus + loaded depth.
Tests: `task-inbox.render.test.tsx`, `use-tasks.test.ts`, `e2e/navigation.spec.ts` (inbox cases: chip removal,
count-card links).

### R3 — Task creation + F1 (L2, 3–4 d)

Files: `web/src/pages/TaskComposerPage.tsx`, `web/src/panels/TaskComposer.tsx`, `web/src/task-composer.ts`,
`web/src/components/WorkflowParameterFields.tsx`; styles region `composer`; design-system `composer` rows. **Consumed,
done in G8:** `composer-draft.tsx` store (incl. owner check), `ShellContext.sessionLoading`, `COMMAND_LIMIT` in core,
`DraftReturnBanner` + settings-page mounts + fixed links. L2 does not run `test:db`.

Steps: §2.3 + §3.1 steps 2–4 and 6 (the L2-tagged steps): draft wiring, repo-reset fix, restore notices,
discard/clear, the four-section layout, blocker banner rules, the required 16,384 counter + `too-long` blocker.
Acceptance (PLAN §7.2 + F1): repo and no-repo launch; missing executor; missing/invalid params; delayed preferences;
API rejection keeps draft; keyboard launch; over-limit blocked; configure-and-return launches once; cancel; deleted
executor while away; hostile `return` ignored; a fresh composer shows no red banner.
Tests: `task-composer-logic.test.ts`, `task-composer.render.test.tsx`, `default-workflow.render.test.tsx`,
`e2e/composer.spec.ts`.

### R4 — Task result and recovery + F2 + F3 (L3, 4–5 d)

Files: `web/src/pages/TaskDetailPage.tsx`, `web/src/panels/{TaskHeader,TaskDetail,TaskRun,TaskOutcome}.tsx`,
`web/src/components/TaskRemoveDialog.tsx`, `web/src/task-outcome.ts` (**only** to add `followUpEligibility`);
styles region `task-detail`; design-system `task-detail` rows; `e2e/task-detail.spec.ts`, new
`e2e/follow-up-auth.spec.ts`; `e2e/fixtures/threads.ts` append-only. **Not** `task-tree.ts`, `docs/jobs.md` (G7) or
`auth.spec.ts` (L6).

Steps: §2.4 + the header/rail/matrix half of §3.2 (precedence already landed in G7) + §3.3. Stale-result guard: action promises resolved after navigating to another task id must
be ignored (compare id at resolve time).
Acceptance: all FINAL-REPORT F2/F3 cases + PLAN §7.3 list (queued, running, stopping, stopped, succeeded/open, done,
failed, gate-failed, review-wait, multi follow-ups, missing summary, long logs, unsafe PR URL rejected, no stale action).
Tests: `task-header.render.test.tsx`, `task-detail.render.test.tsx`, `task-run.render.test.tsx`,
`task-outcome.render.test.tsx`, `task-derivations.test.ts`, `e2e/task-detail.spec.ts`,
`e2e/follow-up-auth.spec.ts` (authenticated follow-up eligibility, §3.3).

### R5 — Configuration (L4, 3–4 d)

Files: `web/src/pages/Settings*.tsx` (leave the `DraftReturnBanner` mount line as G8 placed it),
`web/src/components/{RepositorySetup,ConfigurationScope,ExecutorDialog,UnsavedChangesDialog}.tsx`,
`web/src/components/repository-setup.ts`, related `panels/` env editors; styles region `settings`; design-system
`settings` rows; `e2e/workspace.spec.ts`, `env.spec.ts`.
Steps: §2.6 + §2.7. **Restyle the existing overview index route** (`SettingsOverviewPage`, `App.tsx:51`) as a
readiness list with links (executor configured? workspace root? repos selected?) from data `SettingsLayout` already
fetches. Do not build a new page. The workspace-root banner never offers an edit button.
Acceptance: PLAN §7.4 (no wrapped action words at 1024px, no lost dirty edits, refused save shown, no secrets in
summaries, scoped updates, 20-repo ceiling, root-null).
Tests: repository setup, settings, executor dialog, env, unsaved-change suites; `e2e/workspace.spec.ts`, `env.spec.ts`.

### R6 — Analytics (L5, 2–3 d)

Files: `web/src/pages/DashboardPage.tsx`, `web/src/components/{AnalyticsToolbar,RangeSelector,ScopeToggle,DataTable}.tsx`
(`DataTable` is only used by the dashboard panels), `web/src/panels/{TaskUsagePanel,ByUserPanel,RecentTasksPanel,
UsageSummaryPanel}.tsx` and other dashboard panels, `web/src/charts/*`; styles region `dashboard`; design-system
`dashboard` rows; `e2e/dashboard.spec.ts`.
Steps: §2.5. Keep every existing metric, per-task panel, cache detail, partial hatch (`partial-hatch` id stays),
legend/keyboard. Recent tasks status → `taskStatusLabel` + `pill` tone from `taskTone` (the fifth site in §3.2); header
`pill-done` "Task board" + caption "Not affected by range or scope". `UsageSummaryPanel`/`TelemetryFrame` keep the
red synthetic `badge` untouched.
Acceptance: PLAN §7.5. Tests: dashboard/telemetry/chart/range/recent suites; `e2e/dashboard.spec.ts`.

### R7 — Entry and account (L6, 1–2 d)

Files: `web/src/pages/AccountPage.tsx`, `web/src/pages/OnboardingPage.tsx`, `web/src/components/LoginGate.tsx`,
`web/src/components/PublicPageHeader.tsx`, `web/src/components/OnboardingOrganization.tsx`; styles region `entry`;
design-system `entry` rows; `e2e/auth.spec.ts`. **Not** `OrgSelector.tsx`, the app-bar org selector, which is
frozen shell (G5).
Steps: §2.7; token create/reveal/revoke unchanged; disabled Continue gets visible reason via `aria-describedby`.
Tests: onboarding/account render suites; `e2e/auth.spec.ts`.

### R8 — Integrated quality pass (F1–F4, 3–3.5 d)

1. Matrix: 320/390/768/1024/1440 × dark/light × every route family; 200% zoom; keyboard-only; reduced motion; forced
   colors; long names; unbroken log lines. No page-level horizontal scroll (add a Playwright assertion
   `document.documentElement.scrollWidth <= innerWidth` per route/viewport).
2. Journeys (F1/F2/F3 end to end): configure → launch → wait/failure → follow-up / refused follow-up → done, both themes.
3. Remove dead classes/tokens (the inventory + parity tests catch leftovers), after-gallery with manifest in
   `docs/plans/bellows-redesign-2026-09-26/after/`.
4. Full check set §0; record actual results in the PR.

Revised estimate: **24–31 focused days**, the sum of the EXECUTION-GRAPH nodes:

| Phase | Nodes | Days |
| --- | --- | --- |
| Phase 0 | G0 0.5–1, G1 0.5, G2 0.5, G3 0.25, G4 1.5–2, G5 1, G6 0.5–1, G7 0.5, G8 0.5–1 | 5.75–7.75 |
| Phase 1 | L1 2, L2 3–4, L3 4–5, L4 3–4, L5 2–3, L6 1–2 | 15–20 |
| Phase 2 | F1 1, F2 1, F3 0.5–1, F4 0.5 | 3–3.5 |
| **Total** | | **≈24–31** |

Wall-clock with parallel lanes is ≈11–14 days (EXECUTION-GRAPH §6). Re-estimate after G0.

---

## 5. Out of scope (do not build)

Checks/branch/PR/duration inbox columns, failed/done totals, numbered pagination, bulk selection, author directory,
attachments/mentions/templates, six-stage checkbox workflow, changed-files list / native diff, stage timeline events
not recorded, per-test tree/durations, cost card and period deltas, chart-type/aggregation switch, repository
status/environment filters, Health tab, "Configure workspace root" button, Agents page, moon toggle, purple palette.
Each is listed in PLAN §10 as optional follow-on work with its own contract.

## 6. Open decisions (defaults applied; confirm or override)

| # | Decision | Default in this plan |
| --- | --- | --- |
| D1 | Review-wait color | Neutral grey + clock (§1.2), not concept-03 amber |
| D2 | Running color | Green lamp (existing semantics); blue reserved for "needs review"; amber no longer a task state |
| D3 | Draft persistence across reload | None (in-memory only) |
| D4 | Headings font | Barlow; Semi Condensed removed |
| D5 | Specimen hosting | Separate test-only Vite server on `E2E_PORT_BASE + 3` (default 8126) registered in `playwright.config.ts`; nothing in `web/dist` |
| D6 | Status precedence | Closure outranks open wait (F2); lands in G7 (Phase 0) |
| D7 | Multi-user browser coverage for F3 | Real stub sign-in + mocked thread authors (§3.3). Optional extra (+0.5 d): make `e2e/stub-idp.mjs` carry identity through code → token → `/user` (e.g. a `stub_user` cookie read at `/login/oauth/authorize`, encoded into the code) for a true two-account run |
| D8 | `COMMAND_LIMIT` home | Moved to `core/src/limits.ts` (DRY; it is already duplicated in server) |
| D9 | Succeeded-open dot | New accent `sidenav-dot-review` (was green `done`); Done keeps green dot |

## 7. Revision log

**Rev. 2 (2026-09-26)** — folded in a code-verified review of rev. 1:
- Status chips moved from `badge` (reserved synthetic-data marker) to `pill` + tones.
- Colors: dark `--done-wash` 16% → 10% (16% failed at 4.27:1); light `--accent-wash` 10% → 8%; added
  `--accent-hover` / `--accent-border` to both tables; contrast probe must composite translucent washes.
- Dot mapping aligned to the real `taskDotClass`; only done-over-wait and the new review dot change.
- Test contracts: 36px floor rules untouched; 44px list is 26 selectors and must be appended to, not preceded.
- Sidebar: single existing preview wrapped in one `<details>`; new review-count pill defined.
- Inbox: real tab label "Needs attention", Filter button, sort links; chips only for q/repo/author.
- Composer: real optional-step labels; red banner only for actionable blockers; counter required (16,384) with the
  constant moved to core.
- F1: reuse the existing clamp/autoselect effects; fix the repo-reset mount wipe via `workflowRepo`; correct session
  paths and `storedParams` shape; org switch already reloads; return banner lives in the two named settings pages.
- F2: all four state predicates listed (label, dot, header pill, outcome); precedence lands first in R2; DB test must
  deliver a review event and include a control case.
- F3: compare `latest.author` (the posted-to row); add `sessionLoading` to `ShellContext`; browser coverage via real
  sign-in + mocked authors (D7); 403 refusal still rendered.
- Specimen: separate Vite server (the API only serves `web/dist`).
- Repositories: four cards from `counts()`; path is `web/src/components/repository-setup.ts`.

**Rev. 3 (2026-09-26)** — reconciled with EXECUTION-GRAPH after a cross-document review:
- R-package file lists are now lane-owned files only. Work that G7/G8 absorbed (precedence, `sessionLoading`,
  `COMMAND_LIMIT`, draft store incl. owner check, return banner, link fix) is removed from R2–R4, and §3.1 steps are
  tagged G8 or L2.
- F3's browser test moves to `e2e/follow-up-auth.spec.ts` on the derived `AUTH_PORT`.
- Fifth state site added: `RecentTasksPanel` (L5).
- The 44px rule is shared and append-only, and G4 moves it out of the lane regions. §0 rule 6 now says the test takes
  the first 900px block that *contains* a 44px rule.
- Icon glyphs assigned per surface (§1.6), adding `users`, `layers` and `sparkles`, so lanes never need a new glyph.
- Specimen port derives from `E2E_PORT_BASE`.
- §0 rule 8 lists every Phase 0 non-UI change.
- `DataTable` → L5; L6 files named; `OrgSelector` frozen.
- R5 restyles the existing settings overview instead of building a new page.
- Estimate = sum of graph nodes: ≈24–31 days.
