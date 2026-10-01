Part **4 of 4** of Slice E — *Finish onboarding, accessibility, theming, and responsive polish*
(P2/P3). **Closes the slice and the UI improvement roadmap.**

Full spec: `docs/ui-designer/ISSUE-SLICE-E-ONBOARDING-POLISH.md` — sections **11. Responsive
acceptance matrix**, complete **Accessibility requirements**, **Visual regression matrix**,
**Acceptance criteria**, **Verification commands**, and **Definition of done**.

**Depends on:** #187, #188, #189, and Slice D closeout issue #183.

## Summary

Close Slice E by integrating the completed onboarding, appearance, and shared accessibility work
across every primary route, fixing remaining responsive/zoom/popup/focus containment failures, and
capturing the final deterministic state/theme/width screenshot matrix.

This issue is a verification-and-repair closeout. It must not reopen the information architecture
or product semantics established in Slices A–D and Slice E parts 1–3. When the audit finds a real
defect, fix the owning primitive or page and add the smallest regression test that proves it.

## 1. Primary-route inventory

Exercise at least:

- public sign-in gate;
- onboarding normal, failure, expired, and repository-detail states;
- Dashboard populated, sparse, loading, stale-error, and empty;
- task inbox populated, filtered-empty, and load-more states;
- task composer default, validation, selected workflow/parameters, in-flight, and server failure;
- task detail running, stopping, failed, succeeded, no captured output, confirmation, and follow-up;
- Settings overview, organization, workspace, repositories, environment, and executors;
- account identity, tracked organizations, and access tokens;
- mobile navigation, organization selector, Appearance, user menu, listboxes, popovers, tooltips,
  disclosures, and dialogs.

Use deterministic seeded/test data only. Do not rely on a developer's live GitHub installation,
credentials, clock-sensitive state, or network.

## 2. Width and zoom matrix

Keep the established 900px shell and 1100px task-detail breakpoints unless a captured failure
proves a targeted adjustment is required.

| Width | Required behavior |
| --- | --- |
| 320px overflow sentinel | Every primary route has no body-level horizontal overflow; catches hard-coded minimums and clipped actions. |
| 360px narrow phone | Mobile navigation owns global navigation; onboarding is one column; toolbars group-wrap; tables/logs scroll only in named regions; critical actions remain reachable. |
| 390×844 touch capture | Same narrow layout with 44px onboarding/app-bar/task/dialog/settings targets and no sticky/browser-height overlap. |
| 768px tablet | Deliberate mobile navigation; toolbars wrap as groups; popovers/dialogs remain in viewport; no label/control fragmentation. |
| 900–1024px transition | No duplicate/disappearing navigation, breakpoint flicker, sudden overflow, unreadable task detail, or settings collapse around the shell transition. |
| 1280–1440px desktop | Persistent navigation and route hierarchy are visible; primary content starts in first viewport; onboarding uses a bounded canvas; dense data stays readable. |

Global assertions:

- `document.body.scrollWidth - document.body.clientWidth <= 0` at 320, 360, 768, 1024, and
  1440 for every primary route;
- data tables/log wells scroll horizontally only inside a named, keyboard-focusable region;
- repository, branch, workflow, path, status-reason, and code strings never widen the body;
- open menus/listboxes/tooltips/dialogs remain inside viewport;
- focus rings and validation messages are not clipped at container edges;
- sticky actions do not cover focused content or mobile navigation;
- Appearance never displaces the mobile navigation trigger, brand, or account control;
- 200% zoom exposes every control/content block without hidden actions or two-dimensional body
  scrolling;
- increased text size does not overlap/truncate the only status or action label.

Test 390×844 separately from the 1000px-high overflow sweep; height-dependent action reachability
is part of acceptance.

## 3. Focus and popup containment integration

Verify after responsive layout settles:

- skip link is first, visible on focus, and lands on main;
- mobile drawer traps/restores focus at 360 and 768;
- dialogs trap, close safely, and restore triggers at narrow/desktop widths;
- listboxes/menus/Appearance remain reachable and do not render offscreen;
- custom date popover and chart tooltip stay within viewport;
- sortable tables, scroll wells, and disclosures show unclipped focus;
- validation focus on onboarding/composer/environment points to visible content;
- route changes do not unexpectedly move focus behind a dialog/drawer;
- dark/light focus remains visible after wrapping/reflow.

Do not solve clipping by removing outlines. Fix overflow, offset, or container structure.

## 4. Final visual regression matrix

Reuse deterministic fixtures from prior slices. Cover each risk deliberately; do not create a full
Cartesian product of route × state × theme × width.

### Cross-application captures

| Scenario | Theme/width | Required review |
| --- | --- | --- |
| Dashboard populated | dark + light at 1440 | app chrome, palette, chart, metric hierarchy, tables |
| Dashboard sparse/stale | alternate themes across 1440/390 | muted text, stale status, empty density, toolbar wrapping |
| Task inbox populated/empty | dark + light split across 1440/390 | filters, statuses, task triage, navigation, targets |
| Task composer validation/in-flight | both palettes across 1440/390 | fields, selected states, invalid/busy states, summary/action |
| Task detail running/terminal | dark + light at representative widths | static/animated status, outcome, actions, logs, dialog |
| Settings ready/read-only/unavailable | both palettes across 1440/390 | scope, tables/forms, status, editor/dialog behavior |
| Account/token states | both palettes at one desktop and one narrow width | identity, sensitive-result containment, action hierarchy |
| Dialog/popover open | both palettes at 390 and desktop | overlay, focus boundary, viewport containment |
| Keyboard focus | both palettes, multiple surfaces | ring contrast, gap, clipping |

### Onboarding captures

- populated all/future at 1440×1000, dark;
- populated specific with repository counts at 1440×1000, light;
- summary and disabled reason at 390×844;
- repository listing loading;
- unavailable listing with preserved specific state;
- validation error;
- completion in flight;
- expired pending recovery;
- defensive zero-installation empty state.

### Required state coverage across the route set

The final artifact set must collectively include:

- populated;
- sparse;
- loading;
- error with last-good/stale data;
- empty;
- read-only/unavailable;
- in-flight;
- validation error;
- success/terminal outcome;
- narrow screen;
- keyboard focus;
- dialog/popover open;
- reduced motion where a static image can meaningfully prove it.

Name screenshots by route, state, theme, and width. Open every file at full size and inspect:

- hierarchy and first-viewport placement;
- actual text/background contrast;
- line wrapping and truncated meaning;
- body and nested scrollbars;
- focus visibility;
- selected/disabled/busy distinctions;
- popup/dialog bounds;
- sticky overlap;
- data/credential leakage;
- unexpected blank space or dense border grids.

A generated screenshot is not an inspected screenshot.

## 5. Repair rules

When a regression appears:

1. identify the owning primitive or page;
2. reproduce with a focused test/fixture;
3. fix the shared primitive when multiple surfaces share the defect;
4. use a page-specific rule only when the layout is genuinely unique;
5. rerun adjacent states, both themes, and the nearest breakpoint;
6. update `docs/design-system.md` for every class/primitive change;
7. delete superseded helper/class paths rather than retaining compatibility aliases.

Do not:

- hide content/actions at a breakpoint to make overflow pass;
- globally shrink text or controls;
- remove focus outlines;
- clip popovers/dialogs with overflow;
- make data tables force the entire page wide;
- add another breakpoint without a captured failing case;
- change backend contracts to simplify a fixture;
- use raw colors or theme-specific JavaScript markup.

## 6. Documentation and cleanup

Finish documentation after the code and screenshots are stable:

- `docs/design-system.md`
  - exact theme/bootstrap, state, focus, motion, forced-colors, type, size, onboarding, responsive,
    component, and class inventory;
- `docs/auth.md`
  - explicit onboarding tracking modes and summary, preserving OAuth/completion truth;
- `docs/security.md`
  - same-origin bootstrap note only if implementation warrants it; CSP unchanged;
- `docs/api.md`
  - edit only if a contract actually changed (none expected);
- UI issue/spec references
  - keep the parent spec as the complete contract and this issue pack as implementation slices.

Remove:

- old implicit onboarding all-checkbox helpers/tests;
- unused CSS classes/tokens created during iterations;
- temporary screenshot/debug fixtures;
- duplicate public/theme primitives;
- stale comments that describe pre-Slice-E behavior.

Do not delete prior design screenshots that remain intentional source evidence. Final browser
artifacts live under `artifacts/ui/` and follow the repository's existing lifecycle.

## Implementation map

- `e2e/navigation.spec.ts`
  - all-route overflow, shell focus, drawer, app-bar controls, zoom/containment;
- `e2e/auth.spec.ts`
  - final onboarding/public/authenticated flow and captures;
- `e2e/dashboard.spec.ts`, task/settings/workspace specs
  - state/width/theme scenarios owned by those routes;
- `e2e/polish.spec.ts` (if introduced in #189)
  - cross-cutting contrast/focus/motion/target/visual integration without duplicating route specs;
- `playwright.config.ts`
  - only deterministic project matching/emulation required by the final matrix;
- `web/src/styles.css` and affected components/pages
  - evidence-backed responsive/containment repairs only;
- `docs/design-system.md`, `docs/auth.md`, conditionally `docs/security.md`/`docs/api.md`
  - final truth and inventory;
- `docs/ui-designer/github-issues/README.md`
  - final Slice E order and published issue URLs.

No endpoint, migration, auth, driver, Docker, or Kubernetes behavior is expected to change.

## Accessibility requirements

- One `h1` per route/public state and ordered section hierarchy.
- Keyboard completion remains possible after every responsive reflow.
- DOM/focus order matches visual order.
- Focus is never hidden by clipping, sticky content, drawer/dialog layering, or nested scrolling.
- Status, current, selected, validation, and outcome remain non-color in every theme/width.
- Popovers/dialogs remain named, trapped where modal, escapable where safe, and restore focus.
- 44px touch targets remain after final responsive changes.
- 200% zoom and increased text size retain content, labels, and actions.
- Reduced-motion behavior from #189 is unchanged by final style cleanup.

## Tests

Automated browser matrix:

- primary-route body overflow at 320/360/768/1024/1440;
- 390×844 action reachability and target measurements;
- 200% zoom/text stress on public, dense task, dashboard, and settings pages;
- focus containment/restoration for drawer, dialog, listbox, menu, popover;
- screenshot scenarios listed above in dark/light;
- final contrast and reduced-motion suites from #189;
- onboarding/auth flow from #187 and theme persistence from #188;
- no leaked token/secret/provider/private-repo fixture values.

Repository gates:

- complete Vitest suite;
- project-reference typecheck;
- Biome lint/format verification;
- ordered production build;
- full `verify:ui` with disposable seeded databases and both Playwright projects.

## Acceptance criteria

- [ ] Every primary route has no body-level horizontal overflow at 320, 360, 768, 1024, and
      1440px.
- [ ] Onboarding/dialogs/app shell are usable at 390×844 and 200% zoom.
- [ ] Tables/logs contain their scrolling; menus/popovers/tooltips/dialogs stay in viewport.
- [ ] Focus and validation are not clipped and follow logical order after responsive reflow.
- [ ] Appearance never displaces mobile navigation, brand, organization, or account controls.
- [ ] Populated, sparse, loading, stale-error, empty, read-only/unavailable, in-flight,
      validation-error, terminal/success, narrow, focus, and open-overlay states are represented in
      the final artifacts.
- [ ] Both palettes cover Dashboard, tasks, Settings, account, public auth, onboarding, and overlays.
- [ ] Every screenshot is named deterministically and manually inspected at full size.
- [ ] Any found defect has a focused regression test and is fixed at the correct ownership level.
- [ ] No raw color, undocumented/unused class/token, obsolete helper, or temporary fixture remains.
- [ ] Design-system/auth/security/API documentation matches actual behavior.
- [ ] `npm test`, typecheck, lint, build, and `verify:ui` all pass.

## Verification

Run focused browser suites while repairing:

```bash
npx playwright test e2e/navigation.spec.ts e2e/polish.spec.ts --project=chromium
npx playwright test e2e/auth.spec.ts --project=auth
```

Run the complete gates before closure:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run verify:ui
```

Open every generated file under `artifacts/ui/`. Record the reviewed route/state/theme/width matrix
in the closing PR description.

## Slice-level definition of done

Slice E is done when a first-time user can explain what Factory tracks before continuing,
deliberately choose all/future or specific repositories, understand the access boundary, and finish
with keyboard alone; when every route supports System/Light/Dark without reload or first-paint
mismatch; when state meaning survives reduced motion and loss of color; when both palettes meet
measured contrast targets; when no supported width has page-level overflow or hidden critical
actions; and when the complete deterministic state/theme/width artifacts have been inspected.

Do not close this issue with known “polish later” exceptions. This is the polish closeout.
