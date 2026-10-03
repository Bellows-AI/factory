# Design system

Tailwind CSS v4 compiles one ordered entry, `web/src/styles.css`; markup carries primitive classes,
never utilities, and every color it renders resolves through a token.

| Concern | Code | Test |
| --- | --- | --- |
| Entry, import order, cascade | `web/src/styles.css` | `web/test/styles.test.ts` |
| Tokens — both `:root` blocks, the `@theme` blocks | `web/src/styles/tokens.css` | `web/test/styles.test.ts` |
| Self-hosted faces | `web/src/styles/fonts.css`, `web/public/fonts/` | `web/test/styles.test.ts` |
| Type scale, bare content link, 36px control floor | `web/src/styles/base.css` | `e2e/polish.spec.ts` |
| Shared primitives (shell, panels, pills, fields, buttons, selectors, dialogs, tables) | `web/src/styles/primitives.css` | `e2e/polish.spec.ts` |
| A lane's own rules | `web/src/styles/regions/<lane>.css` | `web/test/styles.test.ts` |
| Shell-wide 44px compact targets | `web/src/styles/touch-targets.css` | `e2e/matrix.spec.ts` |
| Reduced motion, forced colors (unlayered) | `web/src/styles/platform.css` | `e2e/matrix.spec.ts` |
| Theme preference, `data-theme`, pre-paint bootstrap | `web/src/theme.tsx`, `web/public/theme-bootstrap.js` | `web/test/theme.test.tsx` |
| Appearance control | `web/src/components/ThemeSelector.tsx` | `e2e/auth.spec.ts` (`e2e/appearance.ts`) |
| Downward-only popover anchoring | `web/src/anchor.ts` | `web/test/anchor.test.ts` |
| Icon set and `ICON_NAMES` | `web/src/components/Icon.tsx` | `web/test/icon.test.tsx` |
| One-`h1` page heading contract | `web/src/components/PageHeader.tsx` | `web/test/page-header.test.tsx` |
| Table sorting, row actions, ≤640px card reflow | `web/src/components/DataTable.tsx`, `RowActions.tsx` | `web/test/data-table.test.tsx`, `web/test/row-actions.render.test.tsx` |
| Shell, sidenav, drawer | `web/src/components/AppShell.tsx`, `SideNav.tsx`, `MobileNavDialog.tsx` | `web/test/shell.test.tsx`, `web/test/sidenav.test.tsx`, `web/test/mobile-nav.test.tsx` |
| Primitive-state reference sheet | `e2e/specimen/main.tsx`, `e2e/specimen/specimen.css` | `e2e/specimen.spec.ts` |
| Every route family × 5 widths × 2 themes | — | `e2e/matrix.spec.ts` |

## Invariants

- The import order in `styles.css` **is** the cascade. `touch-targets.css` imports after every
  region, so the shared 44px floor outranks a lane's own control rules at equal specificity —
  pinned by `web/test/styles.test.ts`.
- Color literals live only in the two `:root` blocks of `tokens.css`; a token with no call site
  fails the suite, and `@theme inline` exposure is not a call site.
- Every class a shipped stylesheet defines must be named in this document or a lane doc under
  `docs/design-system/`, **and** have a caller literal under `web/src` or `e2e/specimen`. Every
  file under `web/src/{components,panels,pages,charts}` needs a row in those same documents.
  `web/test/styles.test.ts` is the enforcement for all three.
- A lane PR edits its own region file and its own lane doc; primitives, tokens and the contracts
  below change here. Each region file ends with that lane's 44px compact-shell segment; shell-wide
  controls belong to `touch-targets.css`, and `web/test/styles.test.ts` holds the owner map and the
  lists' disjointness.
- Status color carries one meaning everywhere: blue is your turn, green the machine working or
  finished well, red failed, grey parked, amber warnings only. The text label always renders and
  the icon is `aria-hidden`. The per-state maps are the `TONE` tables in
  `web/src/panels/TaskHeader.tsx` and `web/src/pages/TaskInboxPage.tsx`.
- The light washes are opaque tints mixed into `--surface-raised`; the dark ones are translucent.
  `e2e/polish.spec.ts` measures every pill, chip and banner on raised, canvas and sunken in both
  themes — a translucent light wash drops below AA on the light canvas.
- `--on-*` is foreground-on-a-fill: a new text-bearing fill needs one in the same change.
- Decorative by contract and below 3:1 on purpose: `--chart-grid` and the `--line`/`--line-strong`
  hairlines. Meaning never rides on tint alone.
- Decision-bearing text never renders under 12px. The one exception is `.tick` at 11px.
- One ambient animation exists — the breathing run/stop lamp — and there are no CSS transitions.
  Under `prefers-reduced-motion` the lamp stills at full strength, so no state rides on movement.
- Fonts are self-hosted: the CSP is `font-src 'self'` and `verify:ui` runs offline, so a remote
  font link falls back silently exactly where faces are checked.
- The icon set is frozen at the foundation; a lane that needs a glyph asks for a foundation change.

## Stated limits

- The specimen sheet is test-only: it is served by `e2e/specimen/vite.config.ts` and never built
  into `web/dist`. `npm run verify:ui` writes its shots to `artifacts/ui/` (gitignored); none are
  committed.
- A popover never flips above its trigger — `useDownwardAnchor` omits floating-ui's `flip`
  deliberately and caps the panel to the space below.
- `visually-hidden`, `token-once`, `mobile-nav-org` and the per-section hooks panels carry beside
  `panel` are markup hooks with no stylesheet rule. Do not style one without a row here.

## Shared classes

Shell and navigation: `shell-main`, `page-header-eyebrow`, `page-header-leading`,
`page-header-description`, `page-header-meta`, `page-header-actions`, `skip-link`, `appbar-brand`,
`appbar-org`, `appbar-trigger`, `appbar-actions`, `sidenav-brand`, `sidenav-items`, `sidenav-link`,
`sidenav-sublink`, `sidenav-subitems`, `sidenav-count`, `sidenav-newtask`, `sidenav-preview`,
`sidenav-section`, `sidenav-empty`, `sidenav-task-title`, `sidenav-task-summary`,
`sidenav-task-author`, `sidenav-dot-running`, `sidenav-dot-stopping`, `sidenav-dot-paused`,
`sidenav-dot-failed`, `sidenav-dot-done`, `sidenav-dot-review`, `mobile-nav-head`,
`mobile-nav-title`, `mobile-nav-close`, `mobile-nav-count`, `is-active`.

Controls and overlays: `primary`, `danger`, `select-trigger`, `popover-option`, `popover-separator`,
`theme-field`, `theme-label`, `org-selector`, `user-menu-button`, `user-menu-login`,
`user-menu-panel`, `avatar-fallback`, `avatar-lg`, `task-avatar`, `row-actions-trigger`,
`dialog-layer`, `dialog-backdrop`, `dialog-position`, `lamp-glow`.

Surfaces and feedback: `panel-head`, `panel-actions`, `status`, `alert`, `error`, `muted`,
`badge-warn`, `banner-warn`, `banner-bad`, `banner-info`, `banner-title`, `pill-ok`, `pill-warn`,
`pill-bad`, `pill-done`, `pill-accent`, `inbox-chip`.

Data display: `table-wrap`, `data`, `sortable`, `align-end`, `asc`, `kv`, `by-user-user`,
`table-cards`, `updated-at`, `icon`.

## Shared UI units

`AppBar.tsx`, `AppShell.tsx`, `DraftReturnBanner.tsx`, `Icon.tsx`, `KeyValues.tsx`,
`MobileNavDialog.tsx`, `NavItems.tsx`, `OrgSelector.tsx`, `PageHeader.tsx`, `RelativeTime.tsx`,
`SideNav.tsx`, `StatusBanner.tsx`, `ThemeSelector.tsx`, `UserMenu.tsx`, `SettingsLayout.tsx`,
`TasksLayout.tsx`.

## Lanes

[inbox](design-system/inbox.md) · [composer](design-system/composer.md) ·
[task-detail](design-system/task-detail.md) · [settings](design-system/settings.md) ·
[dashboard](design-system/dashboard.md) · [entry](design-system/entry.md)
