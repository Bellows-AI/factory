# [UI] Slice E — Finish onboarding, accessibility, theming, and responsive polish

## Issue metadata

- **Type:** Feature / onboarding UX / accessibility / design-system completion
- **Priority:** P2 onboarding plus P3 polish; final delivery slice in the UI improvement roadmap
- **Size:** Large; land as the ordered PR sequence at the end of this issue
- **Areas:** OAuth onboarding, organization and repository selection, appearance preference, theme
  bootstrap, interaction states, contrast, reduced motion, typography, control sizing, responsive
  behavior, tests, visual regression, documentation
- **Depends on:** Slices A–D. Rebase onto their final route, primitive, task, and configuration work
  before starting the global audit.
- **Blocks:** Declaring the UI improvement roadmap complete

## Summary

Turn `/onboarding` into a clear, one-page setup decision and complete the cross-application quality
work that earlier slices deliberately deferred.

The onboarding page must explain what Factory does, identify the signed-in person, distinguish
tracking every current and future repository from tracking a specific set, show a per-organization
summary, explain access in plain language, and make the result of **Continue** predictable. Preserve
the existing pending-sign-in flow and API semantics; this is not an authentication redesign.

The polish work is an application-wide audit, not a new coat of paint. Finish the light theme and a
persisted system/light/dark preference, make every shared control's states explicit, remove the
remaining illegible metadata and unnecessary borders, verify contrast in both themes, make the one
ambient status animation safe under reduced motion, and close responsive gaps on every route.

The slice is complete only when keyboard flows, state coverage, contrast checks, overflow checks,
and inspected screenshots prove the result. A passing render test alone is not visual acceptance.

## Baseline and dependency assumptions

Implement this issue after Slices A–D. Do not reproduce their components or reopen their
information architecture unless the final audit finds a concrete defect.

Slice E assumes Slice A has delivered:

- route-aware page identity and a single page-level `h1`;
- the compact desktop shell and focus-managed mobile navigation;
- a skip link and a shared `:focus-visible` foundation;
- task-inbox search, filtering, bounded sections, and deliberate narrow-screen navigation;
- the established 900px shell breakpoint.

Slice E assumes Slice B has delivered:

- the compact analytics toolbar and decision-oriented metric summary;
- bounded, sortable supporting tables;
- chart, tooltip, loading, stale-data, and empty-state conventions;
- the final dashboard surface and spacing language.

Slice E assumes Slice C has delivered:

- the guided task composer and its plain-language validation;
- the conversation and outcome hierarchy;
- state-based task actions, confirmations, and terminal-state language;
- the final task status vocabulary used by navigation and task detail.

Slice E assumes Slice D has delivered:

- the Settings overview and readiness model;
- explicit configuration scope and permission language;
- repository, environment, and executor editing states;
- shared dirty, saving, saved, failed, unavailable, and read-only patterns.

The current tree already provides useful foundations that this slice must finish rather than
replace:

- `web/src/styles.css` has matching dark and light token blocks. Dark is the current default; light
  is selected with `data-theme="light"` on `<html>`.
- Both token blocks define the same 22 color roles, including surfaces, ink, accent, status,
  borders, charts, overlay, and lamp glow.
- `color-scheme` already changes with the theme so native controls and scrollbars can follow it.
- A global two-pixel `:focus-visible` rule exists, but it does not by itself prove that every
  control has a visible, unclipped, correctly contrasted focus indication.
- The only intended ambient animation is the running-status lamp.
- `/onboarding` deliberately renders outside `AppShell`, bypasses `LoginGate`, and completes a
  parked OAuth sign-in through explicit `fetch` calls.
- The production CSP is `script-src 'self'` and forbids inline script. Theme bootstrap must respect
  it.

## Required reading before implementation

Read these files before editing the corresponding code:

- `docs/design-system.md` for tokens, primitives, class inventory, chart treatment, motion, and
  responsive conventions;
- `docs/auth.md` for the pending OAuth flow, session completion, `read:org`, and the separation
  between OAuth identity and GitHub App repository access;
- `docs/organizations.md` for installation-backed organization identity and membership;
- `docs/repos.md` and `docs/configuration.md` for installation repository discovery and
  credential boundaries;
- `docs/api.md` before changing a response, status, or request body;
- `docs/security.md` before touching CSP, external assets, identity images, or stored preferences;
- `docs/ui-designer/PRIORITY-IMPROVEMENTS.md`, items 17–20 and Slice E;
- `docs/ui-designer/ISSUE-SLICE-A-NAVIGATION-HIERARCHY.md` for shell, heading, focus, and width
  assumptions;
- `docs/ui-designer/ISSUE-SLICE-B-DASHBOARD.md` for chart, table, disclosure, and stale-data
  conventions;
- `docs/ui-designer/ISSUE-SLICE-C-TASK-EXECUTION.md` for task state and action language;
- `docs/ui-designer/ISSUE-SLICE-D-CONFIGURATION.md` for configuration state and permission
  language;
- `web/src/pages/OnboardingPage.tsx`, `server/src/routes/auth.ts`, and
  `server/test/auth.completion.test.ts` before changing onboarding selection behavior;
- `web/src/styles.css`, `web/test/styles.test.ts`, and the complete component inventory in
  `docs/design-system.md` before changing visual primitives;
- `e2e/auth.spec.ts`, `e2e/navigation.spec.ts`, and `playwright.config.ts` before adding browser
  coverage or screenshots.

## Problem statement

### Onboarding does not explain the decision

The current screenshot is a 560px panel in a mostly empty 1440px canvas. It begins with the
secondary heading **Choose what to track**, identifies the person in a paragraph, renders
installation names beside checkboxes, hides repositories in disclosures, and ends with
**Continue**. It does not provide:

- Factory identity or a one-sentence product purpose;
- a page-level `h1` or setup context;
- a plain distinction between all current/future repositories and a fixed subset;
- selected counts or a final summary;
- permission/privacy context;
- an explanation of what Continue creates or where it goes;
- organization identity beyond the installation account string.

The existing behavior is careful, but its consequences are encoded in checkbox state and comments
rather than communicated to the person making the choice.

### The light palette exists without a product behavior

Light-theme tokens already exist, but no application control owns a theme preference, no persisted
preference is applied before first paint, and system color-scheme changes are not followed. Setting
`data-theme` manually is a development seam, not a user feature.

### Shared states are present unevenly

The stylesheet includes a global focus rule and some hover/disabled rules, but the application has
many distinct interactive surfaces: links, primary/destructive buttons, native inputs and selects,
Headless UI listboxes and menus, sortable headers, disclosures, dialogs, task actions, tabs, and
mobile-navigation controls. They do not all have a deliberately verified default, hover, active,
selected, disabled, busy, invalid, success, and focus-visible presentation.

### Residual small text and border noise remain

The current stylesheet still contains 10–11px navigation, task-author, chart, pill, and section
labels. Some may be supportable chart annotations; navigation and task information are not. The
final slice must decide each case rather than globally increasing fonts until layouts break.

The product also still relies heavily on one-pixel borders for grouping. Earlier slices should
have improved hierarchy page by page; Slice E removes only the redundant borders left after that
work and must not flatten intentional data-table, input, dialog, or status boundaries.

### Responsive behavior has been checked locally, not closed globally

Earlier slices own their pages, but the final app must work as one system. Focus rings, popovers,
dialogs, sticky actions, charts, tables, validation messages, public auth screens, and the new theme
control must all remain usable together at the supported widths.

## Goals

1. Give onboarding one clear page identity, product purpose, setup step, and signed-in identity.
2. Make repository tracking mode explicit for every selected organization.
3. Show a final, human-readable selection summary immediately before Continue.
4. Preserve the existing OAuth, pending-sign-in, allowlist, expiry, retry, and redirect contracts.
5. Provide a system/light/dark appearance preference that is applied before paint and persists
   locally.
6. Verify every shared interactive surface across keyboard focus and meaningful state changes.
7. Meet WCAG 2.2 AA contrast targets in both themes and retain non-color status distinctions.
8. Respect reduced motion without hiding whether a task is running or stopping.
9. Raise illegible product metadata and standardize control/touch target sizing.
10. Prove that every primary route has no page-level horizontal overflow and keeps critical actions
    reachable at the target widths.
11. Refresh deterministic visual artifacts for the roadmap state matrix and inspect each one.

## Non-goals

- Do not change GitHub OAuth scopes, GitHub App permissions, session duration, cookie behavior, or
  organization membership rules.
- Do not add a migration, account-level theme column, server-side appearance preference, or theme
  API.
- Do not replace `POST /api/auth/github/complete`, change its status codes, or preserve a second
  legacy onboarding payload shape.
- Do not add organization invitations, membership editing, repository installation management, or
  GitHub permission management.
- Do not add a multi-step wizard when the choice fits on one page.
- Do not add repository search, pagination, or virtualization unless a measured fixture proves the
  current installation list cannot remain usable; that is a separate scalability issue.
- Do not add an icon library, custom checkbox/radio implementation, decorative illustration, or
  remote font/image dependency.
- Do not animate page transitions, theme changes, controls, charts, or decorative elements.
- Do not redesign the dashboard, task flows, Settings information architecture, or application
  shell under the label of polish.
- Do not create page-specific colors, one-off button languages, or new breakpoints without a
  captured failure at an existing target width.
- Do not hide access, stale-data, scope, validation, or selection consequences in tooltips.
- Do not treat the theme switch as the primary feature or a substitute for hierarchy work.

## Product and behavior constraints to preserve

### The pending sign-in is authoritative

Onboarding is not a free-standing settings form. It is the UI for a short-lived `pending_sign_in`
row created after GitHub OAuth. Preserve these outcomes:

- `GET /api/auth/github/pending` supplies identity, installation accounts, stored repository
  narrowing, preselected installation ids, the requested organization, reselect status, and the
  validated same-origin return path.
- `401` means the pending sign-in expired or was already spent. The only recovery is the existing
  **Start again** link through `/api/auth/github`.
- `POST /api/auth/github/complete` mints the session itself and returns the safe `returnTo`; the page
  finishes with `window.location.assign`, not client-side route navigation.
- Continue remains an explicit `type="button"` callback. CSP keeps `form-action 'none'`.
- No organization selected is invalid. Continue remains disabled and the inline reason stays
  visible.
- `UNKNOWN_REPO` refreshes affected live listings, intersects now-stale selections, keeps the
  person's remaining choices, and asks for review before retry.
- `REPOS_UNAVAILABLE` preserves the draft and gives an actionable retry message.
- A pending sign-in is single-use. Never optimistically route before the completion response.

### Repository tracking modes must remain semantically exact

The UI must name the two server meanings:

| UI mode | Meaning | Completion payload |
| --- | --- | --- |
| **All current and future repositories** | No stored allowlist narrows the installation. New repositories reported later are included automatically. | `repos[orgId] = []` when explicitly choosing/widening this mode; omission is acceptable only when preserving an untouched existing all-repositories state. |
| **Choose specific repositories** | The stored allowlist contains exactly the selected full names after server validation. Future repositories are not included automatically. | `repos[orgId] = ["owner/name", ...]`, always non-empty. |
| Organization deselected | The installation is not materialized into this sign-in's organization selection. | Omit it from `orgs` and from `repos`. |

Additional rules:

- `tracked === null` initializes **All current and future repositories**.
- `tracked` as an array initializes **Choose specific repositories**, intersected with the current
  live listing before submission.
- Do not convert a stored specific selection to all merely because listing failed.
- If a listing has `source: 'none'`, explain that repository selection is temporarily unavailable.
  Preserve an existing specific selection by omitting its `repos` key. A new organization can
  remain in all-repositories mode because there is no prior narrowing to preserve.
- Switching explicitly from specific to all is always safe: submit `[]`; the server intentionally
  skips repository validation for that widening operation.
- A specific mode with zero selected repositories is invalid. Keep the existing instruction to
  select at least one repository, switch to all repositories, or deselect the organization.
- Never expose numeric installation ids as organization identity. They remain stable keys and API
  values only.

### Access language must match the actual credential boundary

Use this product truth in concise copy:

- GitHub sign-in reads the person's identity, organization membership, and installation list under
  `read:org`.
- Repository names come from the separately configured GitHub App and its installation
  permissions, not from the person's OAuth token.
- The onboarding choice controls what Factory tracks. It does not grant, revoke, or modify GitHub
  permissions.

Do not claim that Factory reads only repository metadata; jobs may use installation credentials for
repository work after sign-in. Do not enumerate low-level scopes in the primary flow. Put the
plain-language statement beside the final decision and keep deeper operational detail in docs.

### Theme is a local display preference

- Theme preference is per browser, not per user or organization.
- The supported preferences are exactly `system`, `light`, and `dark`.
- Missing, corrupt, inaccessible, or unrecognized storage resolves to `system` without an error UI.
- The selected preference and the resolved palette are different facts. The control shows
  `system` even when the current operating-system palette resolves to light or dark.
- Theme changes are immediate and must not trigger a page reload, data refetch, or route change.
- Switching organizations, signing out, and signing in do not clear the local preference.
- The theme change itself has no transition. A cross-palette color animation creates intermediate
  low-contrast states and is unnecessary motion.

### Color is never the only signal

- Task and job statuses retain adjacent text.
- Selected navigation, filters, tabs, radio choices, and listbox options retain structural or text
  indicators in addition to color.
- Error, warning, and success surfaces include a label or message; a tinted border is supplemental.
- Chart series use a legend/name and at least one non-color distinction where multiple series share
  a plot, such as dash pattern, stroke shape, or marker.
- Focus does not rely on a background-color shift alone.

## Information architecture for onboarding

Keep onboarding a single page. At wide widths it may use a selection column and compact summary
column; at narrow widths the same DOM order stacks. The logical order is fixed:

1. Factory identity and appearance control.
2. One-sentence product purpose.
3. Setup context: **Choose organizations and repositories**.
4. Signed-in identity.
5. Organization selection and per-organization repository mode.
6. Permission and privacy note.
7. Final selection summary.
8. Inline global error, disabled reason, and Continue action.

Do not add a marketing hero above the work. On a 1440×1000 viewport, the page heading, purpose,
signed-in identity, first organization, and setup context must be visible without scrolling.

## 1. Onboarding header and context

Render a real page header, not the generic `.panel-head`:

- brand: **Factory**;
- `h1`: **Choose organizations and repositories**;
- eyebrow/context: **Setup · One step**;
- purpose: **Track agent activity, start work, and keep repository setup visible in one place.**

Use the signed-in person's avatar when `identity.avatarUrl` is present, with empty alternative text
because the adjacent name carries identity. Otherwise use the existing initial-based avatar
fallback. Show `displayName` when available and the login as secondary text; show the login alone
when display name is absent.

Do not render provider access tokens, email, numeric GitHub id, installation id, or untrusted return
paths.

The appearance selector belongs in the public-page header so onboarding can be switched and
audited in either theme. It must not compete visually with Continue.

## 2. Organization selection

Render each reported installation as an organization choice with:

- a native checkbox with the organization name in its visible label;
- organization name from `installation.account`;
- an initial-based identity mark when no organization avatar is supplied; do not synthesize a
  remote avatar URL from the account name;
- selected/unselected text available to assistive technology through checkbox state;
- a repository-mode summary visible while the detail is collapsed;
- the requested organization note, when present, rewritten as **Requested for this sign-in** rather
  than **asked for**;
- no numeric installation id.

Selecting an organization reveals its repository choice. Deselecting it hides the controls but
keeps the in-memory draft for the duration of the page so accidental toggles are reversible.
Submission ignores the hidden draft for a deselected organization.

Keep the organization list as semantic list content. Do not make the entire card a click target if
that causes disclosure or radio clicks to toggle the organization checkbox unexpectedly.

## 3. Repository mode and repository choices

Inside each selected organization, render a labeled radio group:

- **All current and future repositories**
  - helper: **Automatically include repositories this GitHub App installation reports later.**
- **Choose specific repositories**
  - helper: **Only the repositories selected below are tracked; new repositories are not added
    automatically.**

Use native radios. Do not encode the mode as a disclosure being open or all checkboxes happening to
be checked.

When specific mode is selected:

- fetch the repository listing lazily if it is not already present;
- label the checklist with the organization name;
- show a local loading state that does not disable unrelated organizations;
- render full `owner/name` labels as machine-originated content without shrinking them below the
  product text floor;
- keep each checkbox and label at least 44px tall at narrow widths;
- show **N of M repositories selected** next to the group legend;
- show the zero-selection validation beside the group and connect it with `aria-describedby`;
- retain the current stale-name intersection behavior after a refreshed listing;
- do not turn **all M checked in specific mode** into all/future silently. Mode is explicit. If the
  person chooses specific and checks every current repository, submit the current list and keep
  future repositories excluded.

That last rule intentionally replaces the current implicit “all checked means all/future” UI
heuristic. There is no compatibility shim: the new radio is the source of truth, callers and tests
must be updated in the same change.

When listing has `source: 'none'`:

- if the existing mode is all, show **Repository choices are temporarily unavailable. Factory will
  track repositories this installation reports.**;
- if the existing mode is specific, show **Your existing specific selection is preserved, but it
  cannot be reviewed right now. Try again before changing repository scope.**;
- provide a local **Retry** action;
- do not show an empty checklist and do not widen a stored selection.

## 4. Final summary and Continue

Immediately before the action, render **Your selection** with:

- total selected organizations;
- one row per selected organization;
- **All current and future repositories** or **N specific repositories** per row;
- the organization that will become active after sign-in when it can be derived from the requested
  organization or first selected organization;
- reselect context: **This replaces which organizations you enter Factory with. Repository modes
  change only where shown above.**

Place this plain-language access note next to the summary:

> GitHub sign-in provides your identity and organization membership. Repository names come from
> the installed GitHub App. This choice changes what Factory tracks, not your GitHub permissions.

Action behavior:

| State | Continue presentation | Supporting behavior |
| --- | --- | --- |
| No organization selected | Disabled **Continue** | Visible reason: **Choose at least one organization to continue.** |
| Any specific mode has zero repositories | Disabled **Continue** | Focus/link the first invalid repository group after an attempted action; keep per-group reason visible. |
| Ready | Enabled **Continue** | Summary describes the exact payload semantics. |
| Submitting | Disabled **Setting up Factory…** | Set the action region `aria-busy="true"`; preserve all choices. |
| Completion failure | Enabled **Try again** or **Continue**, depending on wording | `role="alert"`; retain the full draft and return focus to the error/action region. |
| Success | No optimistic UI | Assign the server-provided safe return path only after the successful JSON response. |

Keep the summary live as checkboxes and modes change, but do not use a chatty `aria-live` region for
every count change. Native checked state plus the visible summary is sufficient. Announce only
submission success/failure and asynchronous repository-list failures.

## 5. Onboarding loading, empty, expiry, and recovery states

Use the same page identity and public header in every state so the canvas does not jump between an
anonymous loading panel and the final page.

| State | Required presentation |
| --- | --- |
| Pending payload loading | Heading and purpose remain; use a compact labeled loading region shaped like the identity and first two organization rows. Do not show fake names or an enabled action. |
| Pending request fails, non-401 | Inline error: **Could not load setup. Try again.** with a Retry action. Do not leave a permanent spinner. |
| Pending request returns 401 | Existing expired message and **Start again** OAuth link. Explain that no selection was saved. |
| No installations, defensive state | Explain that no GitHub App installation is available and provide **Start again**. The normal OAuth callback should redirect to installation before this state, but the UI must not render an empty list with a disabled unexplained button. |
| Repository listing loading | Local status inside that organization only; other choices remain usable. |
| Repository listing fails | Preserve the current mode/draft, show Retry, and keep global Continue available only when submission can be semantically safe. |
| `UNKNOWN_REPO` on submit | Refresh affected listings, reconcile, show the existing review-and-retry meaning, and focus the first changed organization. |
| `REPOS_UNAVAILABLE` on submit | Preserve every draft value; explain that repository choices could not be verified; provide Retry. |
| Unknown completion failure | Preserve every draft value; show **The selection could not be saved. Try again.** |

Loading placeholders are structural, not decorative animation. They must not shimmer. Reduced-motion
users and default-motion users see the same static placeholder.

## 6. Theme preference and bootstrap

### Preference contract

Use one local-storage key, `factory.theme`, with only `light` or `dark` stored. Absence means
`system`; do not store the string `system`.

| Stored value | Control value | System query | Resolved `<html data-theme>` |
| --- | --- | --- | --- |
| absent | `system` | light | `light` |
| absent | `system` | dark | `dark` |
| `light` | `light` | either | `light` |
| `dark` | `dark` | either | `dark` |
| any other value | `system` | current | current system palette |
| storage unavailable | `system` for this load | current | current system palette |

Always set the resolved `data-theme` to `light` or `dark`; do not leave the DOM ambiguous after
bootstrap. The stylesheet may continue to use `:root` as the dark token default and
`:root[data-theme="light"]` as the light override.

### Before-paint bootstrap

Add a tiny same-origin external script under `web/public/` and load it as a blocking script in the
document `<head>` before the application entry. It must:

1. read `factory.theme` inside `try/catch`;
2. accept only `light` or `dark`;
3. otherwise query `matchMedia('(prefers-color-scheme: light)')`;
4. set `document.documentElement.dataset.theme` to the resolved palette;
5. never log, fetch, read identity, or throw.

Do not use an inline script: production CSP is `script-src 'self'`. Do not weaken CSP or add
`'unsafe-inline'` for theming. Do not defer this bootstrap; applying a saved theme after React
mounts creates the flash this script exists to prevent.

### Runtime ownership

Add one theme provider above `LoginGate` and `App` so public and authenticated routes share the same
state. It owns:

- current preference (`system`, `light`, `dark`);
- resolved palette (`light`, `dark`);
- local persistence/removal;
- a `matchMedia` change listener active only while preference is `system`;
- a `storage` listener so another tab's change is reflected;
- updating `data-theme` and `color-scheme` through the existing token blocks;
- safe behavior when `window`, `matchMedia`, or local storage is unavailable in render tests.

The provider must initialize from the already-bootstrapped DOM when possible so the first React
render does not flip themes. Keep pure resolution/storage helpers separately testable even if the
provider and hook share one module.

### Appearance control

Use one shared native select or equivalent accessible single-choice primitive labeled
**Appearance** with **System**, **Light**, and **Dark**. Prefer the native select: it is compact,
keyboard-complete, and touch-friendly without creating another popover language.

Place it:

- in `AppBar` for authenticated routes;
- in the public header used by `LoginGate` and `OnboardingPage`.

At narrow widths the visible label may become visually hidden, but the accessible name remains
**Appearance** and the selected option remains visible. Keep the control secondary to page actions.
It must have a 44px target on narrow screens and fit beside the mobile navigation and account
controls without overflow.

## 7. Theme and contrast audit

### Token discipline

Keep all color literals inside the two theme token blocks. Every new or adjusted role must:

- exist in dark and light blocks;
- have the same semantic name in both;
- be consumed by a primitive;
- remain documented in `docs/design-system.md`;
- pass the existing no-unused-token and no-undocumented-class tests.

Do not make a component theme-aware with JavaScript color values. SVGs, chart strokes, focus rings,
shadows, overlays, and native-control cues consume CSS variables or `currentColor` so a live theme
change updates without remounting.

### Contrast targets

Use WCAG 2.2 AA as the release threshold:

- normal text: at least 4.5:1 against its actual background;
- large text: at least 3:1;
- meaningful control boundaries, icons, chart marks, focus indicators, and selected-state cues: at
  least 3:1 against adjacent colors;
- disabled controls are not required to meet text contrast, but must remain recognizable and must
  not look selected, busy, or editable;
- placeholder text is instructional content here and must meet normal-text contrast when it carries
  meaning. Prefer visible labels and helpers instead.

Measure at least these resolved pairs in both themes:

- `--ink` on `--surface`, `--surface-raised`, and `--surface-sunken`;
- `--ink-muted` on all surfaces where muted copy actually appears;
- `--accent` as text/focus/selection against each adjacent surface;
- `--line` and `--line-strong` where they carry a meaningful input or control boundary;
- `--lamp-run`, `--lamp-wait`, `--lamp-stop`, and `--lamp-done` against their status surfaces;
- `--on-warn` on warning backgrounds and `--on-bad` on destructive/error backgrounds;
- `--chart-primary` and other chart series against the chart background;
- `--chart-grid` against the chart background without overpowering labels;
- overlay/dialog foreground and backdrop boundaries.

Automate the stable token pairs with browser-resolved color probes and a luminance helper. Do not
assert source hex strings or reimplement `color-mix()` in Node. Use computed `rgb()` values from the
browser so tests measure what users receive.

### Light-theme review

Inspect, do not assume, the light rendering of:

- charts, grid lines, tooltips, legends, and empty metrics;
- status pills and task dots;
- muted text on raised and sunken surfaces;
- dialogs, backdrops, popovers, and shadows;
- inputs, date controls, checkboxes, radios, and disabled controls;
- code/log wells and machine-originated monospace text;
- destructive confirmation and warning surfaces;
- browser autofill, selection highlight, and native scrollbars where practical.

## 8. Legibility and visual-noise audit

### Type floors

- Navigation, task information, form labels, helper text, status text, and metadata that affects a
  decision must be at least 12px; prefer 13–14px when space allows.
- Buttons, selects, inputs, and tabs must not rely on text below 14px.
- Chart ticks may be 11px at the narrowest supported chart width only when contrast and collision
  tests pass; chart axis labels should be 12px where space allows.
- Do not shrink repository names, branch names, workflow names, or status reasons to solve
  overflow. Wrap, truncate with an adjacent full-name affordance, or contain scrolling in the
  named data region.
- Reserve monospace for repository/branch names, code, paths, logs, identifiers, and numeric data
  where alignment matters. Product labels and navigation stay in the product face.

Specifically revisit the current `.tick`, `.axis-label`, `.sidenav-task-summary`,
`.sidenav-task-author`, `.sidenav-section`, `.pill-reason`, and `.badge` rules. A rule may remain
compact only with a written reason in `docs/design-system.md` and a screenshot showing it remains
legible.

### Control sizes

- Desktop controls: 36–40px minimum height.
- Controls used in mobile navigation, onboarding choices, task actions, filters, dialogs, and
  settings rows: 44px minimum touch target at narrow widths.
- A small visible glyph may sit inside a 44px target; measure the clickable box, not the ink.
- Inline text links inside prose are exempt from the rectangular target rule but retain visible
  focus and adequate line height.

### Border reduction

Remove a border only when spacing, surface, and typography already preserve grouping. Keep borders
that communicate:

- editable input boundaries;
- table and log containment;
- dialog/popover separation;
- focus and validation;
- destructive or warning status;
- organization/repository choice grouping where adjacent labels would otherwise merge.

Do not run a mechanical `border: 0` sweep. Compare populated, sparse, and empty screenshots before
and after each primitive change.

## 9. Interaction-state completion

Every shared control must define and verify the states that make sense for it. “Not applicable” is
allowed; an accidental browser/library default is not.

| Surface | Required states and cues |
| --- | --- |
| Links and navigation links | default, hover, active press, current/selected where applicable, visited only if product-safe, focus-visible; current page has `aria-current` plus non-color styling |
| Primary/secondary/destructive buttons | default, hover, active press, focus-visible, disabled, busy; destructive meaning remains textual |
| Inputs and textareas | default, hover where useful, focus-visible, disabled/read-only distinction, invalid with linked text, filled, autofill |
| Native selects and theme selector | default, hover, focus-visible, disabled, open/native scheme in both themes; selected value is text |
| Checkboxes and radios | unchecked, checked, indeterminate if used, hover, focus-visible, disabled, invalid group; native control remains present |
| Listboxes and menus | closed/open trigger, focused option, selected option, disabled option, keyboard navigation, Escape, focus return |
| Tabs and filter presets | default, hover, focus-visible, selected with `aria-selected`/`aria-checked` and non-color cue, disabled if applicable |
| Disclosures/`summary` | collapsed/expanded text or chevron, hover, focus-visible, adequate target, contained content |
| Sortable table headers | unsorted, ascending, descending, hover, focus-visible; sort direction is announced and visible without color |
| Dialogs | opening focus, trapped focus, Escape/outside close when safe, busy action, validation/error, close focus restoration, narrow viewport fit |
| Task actions | available, unavailable, requested/in-flight, succeeded/failed outcome; never a permanently disabled button as historical status |
| Status banners and pills | info, loading, stale warning, validation error, server error, success; each has text and appropriate live-region behavior |

Audit these application groups explicitly:

- shell: skip link, desktop navigation, mobile drawer, organization selector, app brand, appearance
  selector, user menu;
- dashboard: range presets, date fields, scope toggle, refresh, chart tooltip, sortable tables;
- tasks: inbox tabs, search, filters, Load more, task links, composer listboxes/fields, task actions,
  disclosures, follow-up composer, confirmation dialogs;
- settings: settings navigation, repository selection, editable rows, tabs, raw editor, executor
  dialogs, save/remove/undo controls;
- account: tracked-organization link and access-token creation/copy/revoke controls;
- public auth: sign-in link, Start again link, appearance selector, organization/repository choices,
  Retry, and Continue.

### Focus requirements

- Keep the shared two-pixel accent outline with a two-pixel gap unless contrast measurement requires
  a token adjustment.
- Focus must never be clipped by `overflow: hidden`, sticky headers, scroll wells, popovers, or
  rounded card boundaries.
- Focus order follows DOM and reading order. Responsive CSS must not visually reorder controls away
  from keyboard order.
- Opening a dialog/listbox/menu moves focus according to the component contract; closing restores
  it to the trigger.
- The onboarding error path focuses the global error or first invalid organization only after a
  user-initiated submit, never during initial render.
- Programmatic focus on `#main-content` after the skip link remains visible to assistive technology
  without introducing a permanent decorative ring.
- Test keyboard focus in both themes; token reuse does not prove contrast on both backgrounds.

### Busy, error, and success announcements

- Use `aria-busy` on the smallest meaningful region, not the whole application.
- Use `role="alert"` for a newly returned blocking error. Do not apply it to persistent helper copy.
- Use polite status announcements for successful saves and asynchronous completion when focus does
  not already move to a clear result.
- Busy labels describe the action: **Setting up Factory…**, **Saving…**, **Stopping…**. Do not use a
  generic spinner as the only cue.
- Preserve inputs and selections on server failure unless the server returned newer authoritative
  data that must be reconciled.

## 10. Motion and reduced motion

The running lamp remains the only ambient animation.

Add an explicit `@media (prefers-reduced-motion: reduce)` contract:

- disable the lamp breathing animation;
- preserve the running/stopping class, text, shape, and static high-contrast lamp;
- remove or make instantaneous any nonessential transition introduced by shared controls,
  popovers, or theme changes;
- do not suppress focus movement, dialog semantics, loading text, or live updates;
- do not add skeleton shimmer.

Under default motion:

- keep the existing 2.4-second lamp timing unless a measured reason requires change;
- do not add hover movement, scale, bounce, pulsing buttons, page transitions, or chart entrance
  animations;
- a color/background state transition may be brief only if it does not cross low-contrast
  intermediate states. Instant state changes are preferred.

Browser tests must emulate `reducedMotion: 'reduce'`, confirm the lamp has `animation-name: none`
or equivalent, and confirm the adjacent textual status remains visible.

## 11. Responsive acceptance matrix

Keep the established shell breakpoints unless a screenshot demonstrates a specific failure. Test
the widths below with 1000px height for route sweeps; use 390×844 additionally for touch-oriented
onboarding and dialog captures.

| Width | Required behavior |
| --- | --- |
| 320px overflow sentinel | No body-level horizontal overflow on any primary route. The page may be dense; this width exists to catch hard-coded minimums and clipped actions. |
| 360px narrow phone | Mobile navigation owns global navigation. App-bar controls fit. Onboarding is one column; organization, repository mode, summary, and Continue remain in DOM order. Tables/logs scroll only inside named regions. Dialog actions remain reachable. |
| 390×844 touch capture | Same as 360px, with every onboarding choice and app-bar control meeting the 44px target. The primary action is not covered by browser-height or sticky UI assumptions. |
| 768px tablet | Mobile navigation remains deliberate. Onboarding may stay one column. Toolbars wrap as groups, not label/control fragments. Popovers remain inside the viewport. |
| 900–1024px transition | No breakpoint flicker, duplicated navigation, or sudden page overflow around the 900px shell boundary. Task detail and Settings layouts keep readable primary content. |
| 1280–1440px desktop | Persistent navigation and route hierarchy are visible. Onboarding uses the canvas without becoming a full-width form; summary may sit beside selection. Primary content begins in the first viewport. |

Global rules:

- `document.body.scrollWidth - document.body.clientWidth <= 0` at every sentinel width;
- a data table or log well may scroll horizontally only inside a labeled/focusable region;
- full repository, branch, and workflow names do not widen the page;
- zoom at 200% still exposes all content and actions without a two-dimensional page scroll;
- browser text scaling does not clip controls or status pills;
- focus rings and validation messages remain visible at container edges;
- open listboxes, menus, tooltips, and dialogs remain within the viewport;
- sticky actions, if retained by an earlier slice, do not cover focused content;
- the appearance selector never pushes the account or navigation trigger out of the app bar.

## Data/API work

No new endpoint or migration is expected.

Use the existing onboarding requests:

| Request | Slice E use |
| --- | --- |
| `GET /api/auth/github/pending` | Identity, installation accounts, prior tracking modes, selected organizations, requested org, reselect context, return path |
| `GET /api/auth/github/pending/installations/:id/repos` | Lazy repository checklist, `source: 'app'` versus `source: 'none'` |
| `POST /api/auth/github/complete` | Exact selected organization ids and explicit repository-mode changes; session completion |
| `GET /api/auth/github?returnTo=…` | Start-again recovery after expiry or missing installations |

The appearance preference uses local storage and `matchMedia`; it must not call the server.

If implementation discovers a missing fact, stop and prove why it cannot be derived from the
existing pending payload before expanding the API. An API change must update `docs/api.md`,
`docs/auth.md`, route tests, frontend types, fixtures, failure behavior, and this issue in the same
PR.

## Implementation instructions by file

### Onboarding state and rendering

#### `web/src/onboarding.ts` (new)

Move pure selection behavior out of the page:

- `RepositoryMode = 'all' | 'specific'`;
- initialization from `tracked` and a live listing;
- selection reconciliation against refreshed repository names;
- selected-organization and per-organization counts;
- invalid-specific-group detection;
- active-organization derivation;
- exact `orgs` and `repos` payload construction, including unavailable-listing preservation;
- final-summary rows.

Pure helpers must not fetch, navigate, read storage, or mutate caller-owned `Set`/`Map` values.
Delete the old implicit “all current boxes checked means all/future” helper path when callers move to
the explicit mode. Do not leave aliases or a compatibility branch.

#### `web/src/components/OnboardingOrganization.tsx` (new)

Render one organization choice:

- organization checkbox and identity;
- requested-sign-in note;
- repository-mode radio group;
- local listing/loading/unavailable/retry behavior supplied through props;
- specific repository checklist and count;
- linked validation/help text.

Keep it presentational. The page owns network effects and submission. Use stable ids derived from
the installation id only for `htmlFor`/`aria-describedby`; do not render the id as copy.

#### `web/src/pages/OnboardingPage.tsx`

- Own pending-payload load, per-organization lazy repo loads, retry, completion, expiry, and final
  redirect.
- Replace the anonymous panel with the hierarchy and copy in this issue.
- Use the pure state model and presentational organization component.
- Preserve draft state through local and completion failures.
- Focus the first reconciled organization after `UNKNOWN_REPO`.
- Preserve `StartAgainPanel`, but place it in the shared public header/page layout.
- Continue accepting injected payload/listings seams for render tests.
- Keep `type="button"`; do not add a native network form.

#### `web/src/components/PublicPageHeader.tsx` (new)

Share only the public-shell pieces genuinely common to sign-in and onboarding:

- Factory brand;
- appearance selector;
- compact max-width/header spacing.

Do not make a second `AppShell`, duplicate authenticated navigation, or move onboarding into the
authenticated shell.

#### `web/src/components/LoginGate.tsx`

- Use the public header so appearance is available before sign-in.
- Preserve the plain OAuth anchor and existing reason mapping.
- Do not add onboarding selection copy to the sign-in gate.

### Theme behavior

#### `web/public/theme-bootstrap.js` (new)

Implement the CSP-safe before-paint resolver exactly as described above. Keep it tiny, dependency
free, and guarded by `try/catch`. This file is source, not a generated build artifact.

#### `web/index.html`

Load `/theme-bootstrap.js` in `<head>` before the application entry. Do not add inline script,
inline style, a CSP meta tag, or a remote dependency.

#### `web/src/theme.tsx` (new)

Provide:

- preference and resolved-theme types;
- pure preference parsing/resolution helpers;
- safe storage helpers;
- `ThemeProvider`;
- `useTheme()` with preference, resolved palette, and setter;
- match-media and cross-tab storage synchronization;
- DOM application of the resolved `data-theme`.

Keep browser access behind guards so `react-dom/server` tests remain deterministic.

#### `web/src/main.tsx`

Mount `ThemeProvider` above `LoginGate` and `App`. Do not create a second provider inside
`AppShell`.

#### `web/src/components/ThemeSelector.tsx` (new)

Render the shared **Appearance** control with System, Light, and Dark. Keep native semantics, visible
selected text, compact styling, and a full accessible label. The component owns no persistence.

#### `web/src/components/AppBar.tsx`

Add the appearance selector to app-bar actions. Verify desktop and mobile space with the
organization selector and user menu. Do not hide it solely because the viewport is narrow.

### Styling and design-system documentation

#### `web/src/styles.css`

- Add onboarding page/header, organization choice, repository mode, summary, and public header
  primitives.
- Style the appearance selector through the existing control language.
- Keep every color tokenized and both token blocks in parity.
- Add explicit active, selected, invalid, busy, and success rules where the audit proves they are
  missing.
- Add reduced-motion and forced-colors safeguards.
- Raise decision-bearing 10–11px text according to the type floors.
- Apply the desktop and narrow control-height rules.
- Remove only redundant borders proven by visual comparison.
- Keep the existing stylesheet order: Tailwind import, font faces/tokens, `@theme`, component
  primitives, then responsive/accessibility media rules.

Do not add component CSS files or CSS-in-JS.

#### `docs/design-system.md`

- Document theme preference versus resolved palette and the before-paint bootstrap.
- Document the reduced-motion and forced-colors contracts.
- Add every new class and component to the inventory.
- Record the final control state, size, type-floor, onboarding, and public-header primitives.
- Explain any deliberate 11px chart exception.
- Keep `web/test/styles.test.ts` green: no color literal outside token blocks, no unused token, and
  no undocumented class.

### Existing application surfaces

Audit and edit only where a measured state, contrast, type, or responsive failure exists:

- `web/src/components/SideNav.tsx`, `MobileNavDialog.tsx`, `OrgSelector.tsx`, `UserMenu.tsx`,
  `RangeSelector.tsx`, `DataTable.tsx`, and shared dialogs;
- dashboard charts and panels;
- `TaskInboxPage.tsx`, task composer/detail/header/side panels;
- Settings pages, repository picker, environment panel, executor panel/dialog;
- account and access-token panels.

Do not churn markup merely to touch every file. Record audited/no-change surfaces in the PR
description and cover representative primitives in tests.

### Product documentation

#### `docs/auth.md`

Update the onboarding UI description to name the explicit all/future versus specific modes and the
summary. Preserve the existing OAuth and completion contracts.

#### `docs/security.md`

Document the same-origin external theme bootstrap only if the implementation changes the current
script loading description. CSP itself must not change.

#### `docs/api.md`

No edit is required if request/response/status behavior remains unchanged. Update it in the same PR
if an API contract changes.

## Accessibility requirements

- One `h1` identifies onboarding in every loading/error/content state.
- Organization and repository groups use `fieldset`/`legend` or equivalent named group semantics.
- Every checkbox/radio has a visible label; helper/error ids are stable and linked.
- Repository-mode radios expose one checked option for every selected organization.
- Selection counts and final summary are visible text, not `title` attributes.
- Async repository and completion failures are announced once without repeatedly announcing
  persistent copy.
- Disabled Continue keeps the reason visible; `disabled` alone is insufficient.
- Busy state uses textual action copy and `aria-busy`.
- Focus is moved only after user-initiated validation, reconciliation, dialog actions, or skip-link
  activation.
- Theme selector has a stable accessible name and reflects the preference, not merely the resolved
  system palette.
- Status, chart, current-page, selected, warning, success, and validation meanings survive grayscale
  and forced colors.
- All functionality used in onboarding, task creation, task review, environment editing, dialogs,
  and theme selection is keyboard-completable.
- Pointer targets meet the narrow-screen size rule.
- At 200% zoom and increased text size, labels do not overlap or disappear and actions remain
  reachable.

## Test plan

### Onboarding pure and render tests

Update `web/test/onboarding.render.test.tsx` and add focused pure-helper tests as needed:

- `tracked === null` initializes all/future;
- stored arrays initialize specific mode and intersect with live names;
- explicit specific mode with every current repository remains specific in the payload;
- explicit all mode posts `[]` and clears a prior narrowing;
- unavailable listing preserves an existing specific selection;
- deselected organizations never contribute repo payload entries;
- zero selected organization and zero-repository specific groups are invalid;
- active organization follows requested selected org, then first selected;
- summary rows name all/future versus exact specific count;
- full-name repository labels and selected counts render;
- identity display-name/login fallback and avatar alt behavior;
- no installation id appears as copy;
- loading, non-401 failure, expired, empty, unavailable, validation, submitting, and normal states;
- forbidden identity/provider fields do not leak into markup;
- public header has one `h1` and an Appearance control;
- no `<form>` is introduced under `form-action 'none'`.

Preserve the existing stale-selection and retry tests, updating them for explicit mode rather than
the old all-checkboxes heuristic.

### Server contract tests

No server change is expected, but run and preserve `server/test/auth.completion.test.ts` coverage
for:

- selected installations only;
- optional per-org repo keys;
- empty array widening;
- unknown repository rejection;
- unavailable listing rejection;
- pending expiry/single use;
- active requested organization fallback;
- rollback after materialization failure.

If the frontend payload builder reveals a server ambiguity, add the failing server test before
changing the route.

### Theme unit/render tests

Add `web/test/theme.test.tsx`:

- missing/invalid storage resolves to system;
- light/dark overrides ignore system changes;
- system preference follows system changes;
- selecting System removes the key;
- selecting Light/Dark writes only the supported value;
- inaccessible storage falls back without throwing;
- provider starts from the bootstrapped DOM palette;
- storage events update another mounted provider;
- ThemeSelector renders three named options and reflects preference;
- public and authenticated placements use the same component.

Add a guard that `web/index.html` references the external bootstrap before the application entry and
contains no inline theme script. Exercise the public script in a small DOM/browser harness rather
than duplicating only its intended behavior in a separate helper test.

### Style and contrast tests

Extend `web/test/styles.test.ts` to pin:

- matching token names in dark and light blocks;
- `color-scheme` in both theme blocks;
- explicit `:focus-visible` and reduced-motion rules;
- no raw color outside token blocks;
- no remote font/image dependency;
- every new class documented and used;
- no removed class left in the inventory.

Use Playwright for actual contrast calculations because the browser must resolve CSS variables and
`color-mix()`. Test the token pairs listed above in both themes and print the pair and measured ratio
on failure.

### Interaction and accessibility browser tests

Extend `e2e/navigation.spec.ts` or add `e2e/polish.spec.ts` for:

- Appearance selector keyboard operation;
- system default, explicit light/dark, persistence across reload/navigation/sign-out, and cross-tab
  storage behavior;
- operating-system color change while System is selected;
- no body overflow at 320, 360, 768, 1024, and 1440 across every primary route;
- focus ring presence and contrast on representative link, button, input, select, disclosure,
  listbox option, sortable header, and destructive action in both themes;
- target heights at 390px for app-bar, navigation, onboarding, task, dialog, and settings controls;
- reduced-motion lamp behavior with textual state retained;
- selected/current/status meaning under grayscale or forced-color emulation where Playwright
  supports it;
- popover/dialog containment and focus return in both themes;
- 200% zoom or equivalent viewport/text-scale stress for the public page and one dense application
  page.

### Authenticated onboarding browser tests

Extend `e2e/auth.spec.ts` using the existing stub IdP and pending-report helpers:

- normal one-page hierarchy, identity, organizations, and final summary;
- explicit all/future mode and specific mode;
- specific selection count and exact saved allowlist;
- disabled Continue plus visible reason with no organization selected;
- zero-selection specific validation and focus;
- repository listing loading/unavailable/retry through deterministic request interception where
  necessary;
- expired pending sign-in recovery;
- submission busy label and preserved draft after a forced failure;
- successful redirect and materialized selected organizations;
- keyboard-only completion;
- 1440×1000 and 390×844 screenshots in dark and light.

Do not put real credentials, tokens, private repository names, or external network dependencies in
fixtures or screenshots.

## Visual regression matrix

Reuse deterministic fixtures from Slices A–D. Do not create a Cartesian explosion of every state,
theme, route, and width; cover each risk deliberately.

### Required cross-application captures

| Scenario | Theme/width | Purpose |
| --- | --- | --- |
| Dashboard populated | dark + light at 1440 | palette, chart, metric, table, app chrome |
| Dashboard sparse/stale | one theme at 1440; alternate theme at 390 if relevant | muted text, status, empty density |
| Task inbox populated and empty | dark + light split across 1440/390 | filters, statuses, navigation, target sizes |
| Task composer validation/in-flight | both palettes across 1440/390 | form, selected, invalid, busy states |
| Task detail running/terminal | dark + light at representative widths | lamp/motion, outcome, actions, logs |
| Settings ready/read-only/unavailable | both palettes across 1440/390 | scope, tables/forms, status surfaces |
| Dialog/popover open | both palettes at 390 and one desktop width | overlay, containment, focus boundary |
| Keyboard focus | both palettes | visible focus on multiple surface backgrounds |

### Required onboarding captures

- populated all/future selection at 1440×1000, dark;
- populated specific selection with repository counts at 1440×1000, light;
- final summary and disabled reason at 390×844;
- repository listing loading;
- repository listing unavailable with preserved selection;
- validation error after attempted submit;
- submission in flight;
- expired pending-sign-in recovery;
- defensive no-installation empty state.

Name artifacts by route/state/theme/width so a screenshot can be identified without opening it.
Inspect every generated image for hierarchy, contrast, wrapping, clipping, unintended scrollbars,
focus visibility, misleading disabled state, and accidental data leakage.

## Acceptance criteria

### Onboarding

- [ ] `/onboarding` shows Factory identity, one `h1`, one-sentence purpose, one-step context, and the
      signed-in person.
- [ ] Organization names are visible; numeric installation ids are never user-facing copy.
- [ ] Every selected organization explicitly chooses all current/future or specific repositories.
- [ ] Specific mode shows selected/available counts and requires at least one repository.
- [ ] Selecting every current repository in specific mode does not silently opt into future repos.
- [ ] The summary names organization count and repository mode/count per organization.
- [ ] The access note accurately separates OAuth identity/membership from GitHub App repository
      access.
- [ ] Continue remains disabled with a visible reason when no organization is selected or a
      specific group is empty.
- [ ] Loading, expiry, empty, unavailable, stale-reconciled, in-flight, and server-error states are
      recoverable and preserve safe draft state.
- [ ] Completion still uses the existing API, creates the session, and performs a full navigation
      to the validated return path.

### Theme

- [ ] System, Light, and Dark are available on public and authenticated surfaces.
- [ ] System follows the operating-system preference; explicit Light/Dark ignore later system
      changes.
- [ ] Preference persists across reloads and routes without a server call.
- [ ] The resolved palette is applied before first paint through a same-origin external script.
- [ ] CSP remains `script-src 'self'`; no inline script or `'unsafe-inline'` is added.
- [ ] Missing/corrupt/inaccessible storage never blocks rendering.
- [ ] Live theme changes update native controls, charts, dialogs, and every route without reload.

### Interaction, accessibility, and motion

- [ ] Every shared control has verified applicable default, hover, active, selected, disabled,
      busy, invalid/success, and focus-visible behavior.
- [ ] Keyboard users can complete onboarding, task creation, task review, environment editing,
      theme selection, and dialogs.
- [ ] Focus indicators are visible, at least two pixels, sufficiently contrasted, and not clipped in
      either theme.
- [ ] Current, selected, status, warning, error, and success meanings do not depend on color alone.
- [ ] Blocking errors are announced once; busy and success states have text.
- [ ] Reduced motion disables lamp breathing while retaining a static visual and textual running
      cue.
- [ ] No new ambient or decorative animation exists.
- [ ] Touch-oriented controls measure at least 44px at narrow widths.

### Contrast and legibility

- [ ] Automated browser-resolved checks meet the documented WCAG 2.2 AA ratios in dark and light.
- [ ] Navigation/task/form decision text is at least 12px and controls are at least 14px text.
- [ ] Any 11px chart exception is documented, contrasted, and visually inspected.
- [ ] Muted text, chart labels, status colors, focus rings, control boundaries, and overlays remain
      legible in both themes.
- [ ] Borders removed during polish do not erase grouping in sparse or empty states.

### Responsive and quality

- [ ] No primary route has page-level horizontal overflow at 320, 360, 768, 1024, or 1440px.
- [ ] Onboarding and dialogs remain usable at 390×844 and 200% zoom.
- [ ] Tables/logs contain their own scrolling; menus/popovers/dialogs stay in the viewport.
- [ ] The appearance selector does not displace mobile navigation or account controls.
- [ ] Updated screenshots cover populated, sparse, loading, stale error, empty, read-only,
      in-flight, validation-error, and narrow-screen states across the route set.
- [ ] Every screenshot has been manually inspected, not merely generated.
- [ ] Design-system inventory, auth documentation, tests, typecheck, lint, build, and browser suite
      are green.

## Verification commands

Run focused tests while implementing:

```bash
npx vitest run web/test/onboarding.render.test.tsx
npx vitest run web/test/theme.test.tsx web/test/styles.test.ts
npx vitest run server/test/auth.completion.test.ts
```

Run the full offline gates:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Run focused browser coverage while iterating:

```bash
npx playwright test e2e/auth.spec.ts --project=auth
npx playwright test e2e/navigation.spec.ts e2e/polish.spec.ts --project=chromium
```

Finally run the repository browser gate, which resets/seeds disposable databases, builds the app,
starts the open and authenticated boards, and writes screenshots:

```bash
npm run verify:ui
```

Open and inspect the generated files under `artifacts/ui/`. A green command without screenshot
review does not satisfy this issue.

## Suggested PR sequence

### PR 1 — Onboarding model, explanation, and summary

- Add the explicit all/future versus specific state model.
- Recompose the public onboarding hierarchy and organization controls.
- Add final summary, access language, and state/failure behavior.
- Update render, helper, server-contract, and authenticated browser tests.
- Capture onboarding state and width screenshots.

This PR must remain dark-theme compatible and reuse the current tokens; do not wait for PR 2 to
make its focus order or narrow layout correct.

### PR 2 — Appearance preference and light-theme completion

- Add CSP-safe before-paint bootstrap, provider, and shared selector.
- Place the selector in public and authenticated chrome.
- Add persistence/system/cross-tab tests.
- Audit light-theme tokens and capture paired route screenshots.

### PR 3 — Interaction, contrast, legibility, and motion audit

- Complete shared state rules and focus verification.
- Add browser-resolved contrast checks.
- Raise type floors and control sizes.
- Add reduced-motion and forced-colors safeguards.
- Remove only proven redundant borders.

Keep primitive changes centralized. Do not scatter page-specific overrides to make screenshots pass.

### PR 4 — Final responsive and visual matrix

- Run the full route/width/theme overflow sweep.
- Close focus clipping, popup containment, wrapping, zoom, and touch-target failures.
- Regenerate and inspect the complete state matrix.
- Update design-system/auth docs and remove superseded classes/helpers.
- Run all verification commands.

## Definition of done

Slice E is done when a first-time user can explain what Factory will track before pressing
Continue, deliberately choose all/future or specific repositories, understand the access boundary,
and finish setup with keyboard alone; when every route can switch among system, light, and dark
without reload or first-paint mismatch; when status and interaction meaning survives reduced motion
and loss of color; when both palettes meet measured contrast targets; when no supported width has
page-level horizontal overflow or hidden critical actions; and when the complete deterministic
state/width screenshot set has been inspected.

Do not close the slice with known “polish later” exceptions. This is the polish slice.
