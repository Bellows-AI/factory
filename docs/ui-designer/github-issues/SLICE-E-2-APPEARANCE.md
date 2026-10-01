Part **2 of 4** of Slice E — *Finish onboarding, accessibility, theming, and responsive polish*
(P2/P3).

Full spec: `docs/ui-designer/ISSUE-SLICE-E-ONBOARDING-POLISH.md` — sections **Theme is a local
display preference**, **6. Theme preference and bootstrap**, **7. Theme and contrast audit → Token
discipline / Light-theme review**, **Implementation instructions by file → Theme behavior**, and
**Test plan → Theme unit/render tests**.

**Depends on:** #187 and Slice D closeout issue #183.

## Summary

Add a local System/Light/Dark appearance preference, apply its resolved palette before first paint,
and make the existing light token set a supported runtime product behavior.

The preference must work on public and authenticated routes, follow operating-system changes while
System is selected, persist explicit overrides locally, synchronize across tabs, and update native
controls/charts/dialogs without reload. Keep the theme switch visually secondary and preserve the
current CSP.

## 1. Preference contract

Supported preferences are exactly:

- `system`;
- `light`;
- `dark`.

Use local-storage key `factory.theme`:

- store only `light` or `dark`;
- remove the key for System;
- treat missing, invalid, corrupt, or inaccessible storage as System;
- do not show an error when storage is unavailable;
- do not write a user id, organization id, or server-side setting.

| Stored value | Control value | System query | Resolved `<html data-theme>` |
| --- | --- | --- | --- |
| absent | System | light | `light` |
| absent | System | dark | `dark` |
| `light` | Light | either | `light` |
| `dark` | Dark | either | `dark` |
| other/unreadable | System | current | current system palette |

The control shows the preference, not only the resolved palette. When System currently resolves to
dark, the selected option remains **System**.

Always set the resolved `data-theme` to `light` or `dark`. The stylesheet may keep dark tokens in
`:root` and light overrides in `:root[data-theme="light"]`.

Theme changes are immediate and must not:

- reload the page;
- refetch application data;
- change route or organization;
- clear on sign-out/sign-in;
- animate between palettes.

## 2. CSP-safe before-paint bootstrap

Add a tiny dependency-free same-origin script under `web/public/` and load it in `<head>` before the
application entry as a blocking script.

It must:

1. read `factory.theme` inside `try/catch`;
2. accept only `light` and `dark`;
3. otherwise resolve `matchMedia('(prefers-color-scheme: light)')`;
4. set `document.documentElement.dataset.theme` to `light` or `dark`;
5. never fetch, log, inspect identity, or throw.

Production CSP is `script-src 'self'`. Do not:

- add an inline theme script;
- add `'unsafe-inline'`, a nonce system, or a CSP meta tag;
- defer the bootstrap until after React mount;
- add a remote dependency.

The built runtime and Vite development server must both serve the script from the same path.

## 3. Runtime theme owner

Add one provider above `LoginGate` and `App`.

It owns:

- current preference and resolved palette;
- safe local-storage read/write/remove;
- `document.documentElement.dataset.theme`;
- one `matchMedia` change listener active only for System;
- one `storage` listener for changes from other tabs;
- listener cleanup;
- safe behavior when `window`, storage, or `matchMedia` is unavailable in render tests.

Initialize from the bootstrapped DOM when possible so the first React render does not flip the
palette. Keep parsing/resolution/storage helpers pure and directly testable.

Cross-tab behavior:

- another tab writing `light`/`dark` updates the mounted provider;
- another tab removing the key returns the control to System and resolves the current OS palette;
- a storage event with an unsupported value behaves like key removal;
- the tab initiating the change updates synchronously rather than waiting for a storage event.

System changes:

- update resolved theme only while preference is System;
- explicit Light/Dark ignores later OS changes;
- switching back to System immediately resolves the current OS value.

## 4. Appearance control

Create one shared control labeled **Appearance** with options:

- **System**;
- **Light**;
- **Dark**.

Use a native select unless implementation can prove an existing shared single-choice primitive is
more accessible and no heavier. Requirements:

- visible selected text;
- stable accessible name **Appearance**;
- keyboard and pointer operation without a custom focus trap;
- existing form-control language and focus ring;
- 36–40px desktop height and 44px narrow-screen target;
- no icon-only state and no tooltip-only label.

Place it:

- in `AppBar` for authenticated routes;
- in the public header introduced by #187 for `LoginGate` and `OnboardingPage`.

At narrow widths, the visible label may be visually hidden but the accessible name and selected
option remain. The control must not displace the mobile navigation trigger, Factory brand, or user
menu and must remain secondary to sign-in/Continue/page actions.

## 5. Runtime light-theme completion

The current dark and light blocks already expose the same 22 semantic color roles. Preserve token
parity and inspect the actual live switch across:

- application/public page backgrounds and raised/sunken surfaces;
- app bar, desktop navigation, mobile drawer, selected/current navigation;
- native inputs, date fields, checkboxes, radios, selects, scrollbars, and browser autofill;
- menus, listboxes, tooltips, dialogs, overlays, and shadows;
- dashboard charts, grid lines, legends, tooltips, and tables;
- task status dots/pills, action buttons, outcome surfaces, code/log wells;
- settings status, table, editor, warning, error, success, and disabled states;
- onboarding organization/mode/summary states from #187.

Every color continues through a token or `currentColor`. Do not pass light/dark JavaScript colors
into SVG/chart components or remount a chart to recolor it.

Do not introduce global color transitions. Theme switching should be visually immediate so it
cannot pass through low-contrast intermediate colors.

Fix obvious illegibility or missing token usage in this issue. The measured WCAG contrast and full
interaction-state closeout belongs to Slice E 3/4; do not duplicate its whole audit here.

## Implementation map

- `web/public/theme-bootstrap.js` (new)
  - safe before-paint storage/system resolver;
- `web/index.html`
  - blocking same-origin bootstrap before application entry; no inline code;
- `web/src/theme.tsx` (new)
  - types, pure helpers, `ThemeProvider`, `useTheme`, media/storage synchronization, DOM apply;
- `web/src/main.tsx`
  - one provider above public/authenticated route ownership;
- `web/src/components/ThemeSelector.tsx` (new)
  - shared System/Light/Dark control with no persistence ownership;
- `web/src/components/AppBar.tsx`
  - authenticated placement and responsive fit;
- `web/src/components/PublicPageHeader.tsx`, `LoginGate.tsx`, `pages/OnboardingPage.tsx`
  - public placement through the one shared header from #187;
- `web/src/styles.css`
  - appearance primitive, live light-token fixes, target sizes; no raw component colors;
- `docs/design-system.md`
  - preference versus resolved palette, bootstrap, selector, token usage, inventory;
- `docs/security.md`
  - document same-origin bootstrap only if needed; CSP stays unchanged;
- `web/test/theme.test.tsx`, `web/test/styles.test.ts`, `e2e/navigation.spec.ts`
  - preference/bootstrap/token/browser behavior and paired screenshots.

No endpoint, migration, session, auth, driver, Docker, or Kubernetes change is expected.

## Accessibility and responsive requirements

- The control's value is announced as System/Light/Dark and has a visible or programmatic
  Appearance label.
- Focus remains visible in both palettes on every surface where the control appears.
- Theme is never conveyed by icon/color alone.
- Selecting an option does not steal focus, navigate, or announce unrelated page content.
- Public and app-bar controls preserve logical DOM/tab order.
- At 360/390px, the selector is at least 44px high and does not cause body overflow or hide global
  controls.
- At 200% zoom, public/authenticated headers wrap deliberately and retain every action.
- Native controls receive the correct `color-scheme` after live switching.

## Tests

Unit/render coverage:

- missing and invalid storage resolve to System;
- Light/Dark overrides ignore system changes;
- System follows system changes and removes the storage key;
- inaccessible storage never throws;
- provider begins from bootstrapped DOM and cleans up listeners;
- storage events update another mounted provider;
- selector renders exactly three named options and reflects preference;
- public and authenticated placements use the shared component;
- `index.html` references the external bootstrap before app entry and contains no inline theme
  script;
- bootstrap executes safely with missing storage/matchMedia and applies every supported case.

Style coverage:

- exact dark/light token-name parity;
- `color-scheme` in both blocks;
- no raw color outside token blocks;
- no remote font/image/script dependency;
- new classes documented and used.

Browser coverage:

- System initial resolution under emulated light and dark OS preference;
- explicit Light/Dark switch and persistence across route/reload/sign-out/sign-in;
- System reacting to an OS change and explicit override ignoring it;
- cross-tab storage synchronization;
- public onboarding/sign-in and authenticated app placement;
- no app-bar overflow at 360, 390, 768, 1024, and 1440;
- native input/select, chart, dialog/popover, status, code well, and scrollbar update without reload;
- paired dark/light 1440 screenshots for Dashboard and one dense task/settings route;
- paired public/onboarding screenshots at 390 and 1440.

## Acceptance criteria

- [ ] System, Light, and Dark are available on public and authenticated surfaces.
- [ ] System follows current OS preference and later OS changes.
- [ ] Explicit Light/Dark persists locally and ignores OS changes.
- [ ] Removing/invalidating/inaccessibility of storage safely falls back to System.
- [ ] Resolved `data-theme` is applied before first paint by a same-origin external script.
- [ ] CSP remains `script-src 'self'`; no inline code or `'unsafe-inline'` exists.
- [ ] Preference survives reloads, routes, organization changes, and sign-out/sign-in without a
      server call.
- [ ] Cross-tab changes synchronize and listeners clean up.
- [ ] Native controls, charts, dialogs, status surfaces, and public pages update live without
      remount/reload.
- [ ] Dark/light token names remain in parity and all colors remain tokenized.
- [ ] The control is keyboard-complete, visibly focused, touch-sized, and non-overflowing at target
      widths.
- [ ] Paired dark/light screenshots are generated and inspected.

## Verification

```bash
npx vitest run web/test/theme.test.tsx web/test/styles.test.ts
npx vitest run web/test/onboarding.render.test.tsx
npx playwright test e2e/navigation.spec.ts --project=chromium
npx playwright test e2e/auth.spec.ts --project=auth
npm test
npm run typecheck
npm run lint
npm run build
npm run verify:ui
```

Inspect public, dashboard, task, settings, dialog/popover, chart, and narrow app-bar screenshots in
both palettes.

## Out of scope

- Reopening onboarding state/API semantics from #187.
- Full WCAG contrast, global control-state, legibility, and reduced-motion audit — Slice E 3/4.
- Final route/width/state visual matrix — Slice E 4/4.
- Server/account-synced themes, more palettes, custom color pickers, palette animation, remote
  assets, CSP weakening, or an icon library.
