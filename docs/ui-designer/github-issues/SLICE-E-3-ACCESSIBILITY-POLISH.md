Part **3 of 4** of Slice E — *Finish onboarding, accessibility, theming, and responsive polish*
(P2/P3).

Full spec: `docs/ui-designer/ISSUE-SLICE-E-ONBOARDING-POLISH.md` — sections **Color is never the only
signal**, **7. Theme and contrast audit**, **8. Legibility and visual-noise audit**, **9.
Interaction-state completion**, **10. Motion and reduced motion**, **Accessibility requirements**,
and **Test plan → Style and contrast / Interaction and accessibility browser tests**.

**Depends on:** #187, #188, and Slice D closeout issue #183.

## Summary

Complete the application-wide interaction, accessibility, contrast, legibility, control-size, and
motion audit after the page-specific redesign slices and runtime themes are in place.

This issue owns shared primitive quality. It must centralize fixes, verify both palettes, and change
page markup only where a measured state or accessibility failure requires it. It must not redesign
page information architecture or scatter page-specific overrides to make screenshots pass.

## 1. Shared interaction-state matrix

Every shared control must deliberately support the states that apply. “Not applicable” is valid; an
accidental browser/library default is not.

| Surface | Required states and cues |
| --- | --- |
| Links/navigation | default, hover, active press, current/selected, focus-visible; current page uses `aria-current` and a non-color cue |
| Primary/secondary/destructive buttons | default, hover, active, focus-visible, disabled, busy; destructive meaning remains textual |
| Inputs/textareas | default, hover where useful, focus-visible, filled, disabled/read-only distinction, invalid with linked text, autofill |
| Native selects | default, hover, focus-visible, disabled, correct open/native scheme; selected value is text |
| Checkboxes/radios | unchecked, checked, indeterminate if used, hover, focus-visible, disabled, invalid group; native control remains present |
| Listboxes/menus | closed/open trigger, focused option, selected option, disabled option, keyboard navigation, Escape, focus restoration |
| Tabs/filter presets | default, hover, focus-visible, selected with ARIA and non-color cue, disabled where applicable |
| Disclosures/summary | collapsed/expanded, hover, focus-visible, adequate target, contained content |
| Sortable headers | unsorted, ascending, descending, hover, focus-visible; direction visible/announced without color |
| Dialogs | initial focus, trap, safe Escape/outside close, busy action, validation/error, success focus restoration, narrow fit |
| Task actions | available, unavailable, requested/in-flight, succeeded/failed outcome; historical state is text, not a disabled button |
| Banners/pills | info, loading, stale warning, validation error, server error, success; text plus correct live-region behavior |

Audit these groups explicitly:

- shell: skip link, desktop links, mobile drawer, organization selector, Factory brand, Appearance,
  user menu;
- dashboard: range presets, custom dates, scope toggle, Refresh, chart tooltip, sortable tables;
- tasks: inbox tabs/search/filters/Load more, task links, composer listboxes/fields, task actions,
  disclosures, follow-up composer, confirmations;
- settings: settings links, repository selection, editable rows, tabs, raw editor, executor controls,
  dialogs, save/remove/undo;
- account: tracked-organization link and access-token create/copy/revoke;
- public auth: sign-in, Start again, Appearance, onboarding choices, Retry, Continue.

Record audited/no-change primitives in the PR description. Do not churn a file merely to show it
was reviewed.

## 2. Focus and keyboard behavior

Keep the shared two-pixel accent outline with a two-pixel gap unless measured contrast requires a
token adjustment.

Requirements:

- focus is visible in dark and light on every surface a control can occupy;
- no focus ring is clipped by overflow, sticky regions, rounded cards, data wells, popovers, or
  dialogs;
- DOM/focus order matches visible order at every breakpoint;
- listbox/menu/dialog open/close behavior follows its Headless UI/native contract and restores the
  trigger;
- the skip link remains the first stop and lands on `#main-content`;
- programmatic main focus does not create a permanent decorative ring;
- validation focuses only after a user submit/action, never during initial render;
- onboarding, task creation, task review, environment editing, Appearance, menus, and dialogs are
  keyboard-completable.

Test representative link, button, input, select, checkbox/radio, disclosure, listbox option,
sortable header, tab, and destructive action in both palettes. Token reuse alone does not prove
focus visibility on each background.

## 3. Busy, error, warning, and success behavior

- Put `aria-busy` on the smallest meaningful region.
- Use `role="alert"` for newly returned blocking errors, not persistent helper text.
- Use polite status announcements for completion/success when focus does not move to a clear
  result.
- Busy labels describe the action: **Setting up Factory…**, **Saving…**, **Stopping…**.
- A spinner/lamp is never the only cue.
- Preserve input/draft values after server failure unless newer authoritative data must be
  reconciled.
- Disabled, read-only, unavailable, busy, selected, and historical-complete must remain visually
  and semantically distinct.
- Do not announce poll updates that do not change a user-relevant state.

## 4. Non-color meaning

- Task/job statuses retain adjacent text.
- Current navigation, selected filters/tabs/radios/listbox options retain structural or text cues.
- Warning/error/success surfaces contain a label/message; tint is supplemental.
- Multiple chart series on one plot have legend/name plus a non-color distinction such as dash,
  marker, or stroke shape.
- Focus has an outline, not only background change.
- Sort direction has icon/text/ARIA direction, not only accent color.
- Forced-colors mode leaves controls, focus, selection, statuses, and chart meaning discoverable.

Do not add decorative icons only to satisfy non-color requirements. Prefer existing text, borders,
shape, underline, checked state, and semantic structure.

## 5. Contrast audit

Use WCAG 2.2 AA release thresholds in both themes:

- normal text: at least 4.5:1 against actual background;
- large text: at least 3:1;
- meaningful control boundaries, icons, chart marks, focus indicators, and selected-state cues: at
  least 3:1 against adjacent colors;
- disabled controls may be lower but must remain recognizable and not look editable/selected/busy;
- meaningful placeholder text meets normal-text contrast; visible labels/helpers remain preferred.

Measure browser-resolved values for at least:

- `--ink` on surface, raised, and sunken;
- `--ink-muted` on every surface where it is used;
- `--accent` as text/focus/selection against adjacent surfaces;
- `--line`/`--line-strong` when they carry a meaningful control boundary;
- run/wait/stop/done lamps against their status surfaces;
- `--on-warn` and `--on-bad` against warning/destructive backgrounds;
- chart series and grid against the chart background;
- dialog/popover foregrounds, boundaries, and overlay context.

Implement stable checks in Playwright using computed `rgb()` probes and a luminance helper. Do not
assert source hex values or reimplement `color-mix()` in Node.

On failure, print theme, foreground/background pair, threshold, and measured ratio.

## 6. Legibility and control sizes

Type floors:

- navigation, task information, form labels/helpers, statuses, and decision-bearing metadata:
  at least 12px; prefer 13–14px;
- button/select/input/tab text: at least 14px;
- chart ticks: 11px only at the narrowest supported plot when contrast/collision tests pass;
- chart axis labels: 12px where space permits;
- repository, branch, workflow, status reason, and path text must wrap/truncate/contain rather than
  shrink below the floor;
- monospace only for machine-originated names, code, paths, logs, identifiers, and aligned numeric
  data.

Audit the current `.tick`, `.axis-label`, `.sidenav-task-summary`, `.sidenav-task-author`,
`.sidenav-section`, `.pill-reason`, and `.badge` rules. Document the reason and screenshot for any
11px chart exception.

Control sizes:

- desktop controls: 36–40px minimum height;
- mobile navigation, onboarding, task actions/filters, dialogs, and settings controls: at least 44px
  at narrow widths;
- a small glyph is allowed only inside a compliant clickable box;
- inline prose links are exempt from the rectangular target size but retain focus/line height.

## 7. Border and visual-noise reduction

Remove a border only when spacing, surface, and typography preserve grouping. Keep boundaries that
communicate:

- editable inputs;
- data-table/log containment;
- popover/dialog separation;
- focus and validation;
- warning/destructive status;
- adjacent organization/repository choices that would otherwise merge.

Do not run a mechanical border removal. Compare populated, sparse, and empty screenshots for every
changed primitive. If hierarchy weakens, restore the boundary.

## 8. Motion and reduced motion

The running lamp remains the only ambient animation.

Under `@media (prefers-reduced-motion: reduce)`:

- disable lamp breathing;
- retain running/stopping class, text, shape, and a static high-contrast lamp;
- make nonessential control/popover/theme transitions instantaneous;
- keep focus movement, dialog semantics, loading text, and live updates;
- never add skeleton shimmer.

Under default motion:

- retain the existing 2.4-second lamp timing unless measurement proves a need to change it;
- do not add hover movement, scale, bounce, pulsing buttons, page transitions, or chart entrance
  animation;
- prefer instant state changes over color transitions through low-contrast intermediate values.

Browser coverage must emulate reduced motion, assert that lamp animation is disabled, and assert the
adjacent textual state remains visible.

## Implementation map

- `web/src/styles.css`
  - centralized interaction states, focus, contrast token adjustments, type floors, target sizes,
    reduced-motion/forced-colors rules, proven border cleanup;
- `docs/design-system.md`
  - final control-state/type/size/motion/forced-colors contracts, token roles, exceptions, complete
    component/class inventory;
- shared controls under `web/src/components/`
  - only semantic/state fixes that cannot live in primitives;
- charts/panels/pages under `web/src`
  - only measured non-color, ARIA, focus, wrapping, or state failures;
- `web/test/styles.test.ts`
  - token parity, focus/reduced-motion contracts, raw-color/inventory guards;
- `e2e/navigation.spec.ts`, `e2e/polish.spec.ts` (new if separation is clearer)
  - contrast, focus, keyboard, target sizes, reduced motion, forced colors, representative states;
- existing page-specific render/browser suites
  - exact semantic regressions revealed by the audit.

No endpoint, migration, auth, driver, Docker, or Kubernetes change is expected.

## Tests

Static/render coverage:

- dark/light token-name parity and `color-scheme` in both blocks;
- explicit `:focus-visible`, reduced-motion, and forced-colors contracts;
- no raw color outside token blocks and no undocumented/unused primitive;
- current/selected ARIA and text cues for shared navigation/tabs/options/statuses;
- busy/error/success text and live-region ownership;
- no 10–11px decision-bearing navigation/task/form text.

Browser coverage:

- computed contrast matrix in light/dark with useful failure messages;
- visible, unclipped focus on representative controls/surfaces in both themes;
- keyboard completion of the primary flows listed above;
- dialog/listbox/menu focus trap/Escape/restore;
- 44px target measurements at 390px;
- reduced-motion lamp disabled with textual state retained;
- forced-colors/grayscale non-color cues where browser support permits;
- browser autofill, native controls, disabled/read-only, invalid, busy, success, and destructive
  representative states;
- populated/sparse/empty before-and-after screenshots for border/type primitive changes.

## Acceptance criteria

- [ ] Every shared control has verified applicable default, hover, active, selected, disabled,
      busy, invalid/success, and focus-visible behavior.
- [ ] Keyboard users can complete onboarding, task creation/review, environment editing,
      Appearance, menus, and dialogs.
- [ ] Focus is at least two pixels, sufficiently contrasted, and never clipped in either theme.
- [ ] Current, selected, status, warning, error, success, and sort meaning does not depend on color.
- [ ] Blocking errors announce once; busy and completion states have text.
- [ ] Browser-resolved token/control/chart checks meet documented WCAG 2.2 AA ratios in both themes.
- [ ] Decision-bearing product text and controls meet type floors; any chart exception is documented.
- [ ] Desktop and narrow control/touch targets meet the size rules.
- [ ] Reduced motion disables lamp breathing without hiding live status.
- [ ] No ambient/decorative animation beyond the default running lamp exists.
- [ ] Border cleanup preserves hierarchy in populated, sparse, and empty states.
- [ ] Design-system documentation and class/token inventory are exact.

## Verification

```bash
npx vitest run web/test/styles.test.ts web/test/theme.test.tsx
npx playwright test e2e/navigation.spec.ts e2e/polish.spec.ts --project=chromium
npx playwright test e2e/auth.spec.ts --project=auth
npm test
npm run typecheck
npm run lint
npm run build
npm run verify:ui
```

Inspect focus, contrast, status, dense/sparse/empty, reduced-motion, and forced-colors artifacts in
both themes.

## Out of scope

- Reopening onboarding semantics from #187 or theme persistence/bootstrap from #188.
- Final all-route width/state screenshot matrix and integration closure — Slice E 4/4.
- New page information architecture, charts, palettes, icon library, decorative motion, or one-off
  page-specific visual languages.
