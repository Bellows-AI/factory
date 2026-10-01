Part **1 of 4** of Slice E — *Finish onboarding, accessibility, theming, and responsive polish*
(P2/P3).

Full spec: `docs/ui-designer/ISSUE-SLICE-E-ONBOARDING-POLISH.md` — sections **Product and behavior
constraints to preserve**, **Information architecture for onboarding**, **1–5**, **Data/API work**,
**Implementation instructions by file → Onboarding state and rendering**, and **Test plan →
Onboarding / Server contract / Authenticated onboarding**.

**Baseline:** Slice D closeout issue #183 and the completed Slice A–C issue chain.

## Summary

Turn `/onboarding` from a small anonymous installation checklist into a clear one-page setup
decision. Explain what Factory does, identify the signed-in person, distinguish tracking all current
and future repositories from selecting a fixed set, show a final selection summary, and make the
result of **Continue** predictable.

Preserve the existing pending-sign-in, completion, expiry, retry, allowlist, and redirect contracts.
This issue is an onboarding recomposition, not an OAuth or authorization redesign.

## 1. Page hierarchy and context

Keep onboarding outside `AppShell` and keep `LoginGate` bypassing `/onboarding`.

Render in this order:

1. Factory brand;
2. context **Setup · One step**;
3. one `h1`: **Choose organizations and repositories**;
4. purpose: **Track agent activity, start work, and keep repository setup visible in one place.**;
5. signed-in identity;
6. organization/repository selection;
7. access note;
8. final summary;
9. global error or disabled reason and Continue.

At 1440×1000, the heading, purpose, signed-in identity, setup context, and first organization must
be visible without scrolling. Do not add a marketing hero, decorative illustration, or multi-step
wizard.

Identity:

- show `displayName` plus login when available, otherwise login;
- use `identity.avatarUrl` with empty alt text when present because adjacent text names the person;
- use the existing initial fallback otherwise;
- never render provider tokens, email, numeric GitHub user id, installation id, or an untrusted
  return path.

Create a compact public-page header shared with `LoginGate`, but do not make a second authenticated
shell. It must leave a stable placement seam for Slice E 2/4's Appearance control.

## 2. Organization choices

Render each reported installation as a semantic list item with:

- a native checkbox and visible organization-name label;
- `installation.account` as the organization name;
- an initial-based identity mark when no organization avatar exists;
- **Requested for this sign-in** when `payload.org` names the row;
- a repository-mode summary visible while details are collapsed;
- no numeric installation id in user-facing copy.

Selecting an organization reveals its repository choice. Deselecting it hides the controls but
retains the in-memory draft for the life of the page; submission ignores that hidden draft.

Do not make the whole card a click target if radio, disclosure, Retry, or repository checkbox clicks
would also toggle the organization.

## 3. Explicit repository mode

Inside every selected organization, render a named native radio group:

- **All current and future repositories**
  - helper: **Automatically include repositories this GitHub App installation reports later.**
- **Choose specific repositories**
  - helper: **Only the repositories selected below are tracked; new repositories are not added
    automatically.**

The mode is explicit. It is not inferred from a disclosure or whether all current checkboxes happen
to be checked.

| Input state | Initial UI mode | Completion behavior |
| --- | --- | --- |
| `tracked === null` | All current and future | Omit an untouched all-state key or send `[]` when explicitly widening to all. |
| `tracked` is an array | Specific, intersected with the current live listing | Send the non-empty selected full names. |
| Organization deselected | Hidden draft only | Omit organization from `orgs` and `repos`. |
| Existing specific selection, listing unavailable | Specific preserved but not reviewable | Omit `repos[orgId]`; never widen because a read failed. |
| New/all organization, listing unavailable | All current and future | Keep all mode; no repository validation is required. |

Specific-mode checklist requirements:

- fetch lazily and only once unless Retry/reconciliation requires refresh;
- keep unrelated organizations usable while one listing loads;
- use full `owner/name` labels;
- show **N of M repositories selected**;
- connect the zero-selection reason with `aria-describedby`;
- preserve current stale-name intersection after a refreshed listing;
- use 44px checkbox/label targets at narrow widths;
- never turn “all M current repositories checked” into all/future. Specific remains specific and
  future repositories remain excluded.

That final rule replaces the current implicit all-checkboxes heuristic. Delete the superseded path
and update its callers/tests; do not preserve a compatibility alias.

Specific mode with zero selected repositories is invalid. Tell the user to select one, switch to
all, or deselect the organization.

When listing reports `source: 'none'`:

- all mode: **Repository choices are temporarily unavailable. Factory will track repositories this
  installation reports.**;
- preserved specific mode: **Your existing specific selection is preserved, but it cannot be
  reviewed right now. Try again before changing repository scope.**;
- show a local Retry action;
- do not render an empty checklist.

## 4. Access note, summary, and Continue

Render this plain-language access note beside the final decision:

> GitHub sign-in provides your identity and organization membership. Repository names come from
> the installed GitHub App. This choice changes what Factory tracks, not your GitHub permissions.

Do not claim that Factory reads only repository metadata. Do not put scope internals in a tooltip.

Render **Your selection** immediately before Continue:

- total selected organizations;
- organization name per row;
- **All current and future repositories** or **N specific repositories**;
- active organization derived from the requested selected organization, otherwise the first
  selected organization;
- reselect context: **This replaces which organizations you enter Factory with. Repository modes
  change only where shown above.**

| State | Action | Required behavior |
| --- | --- | --- |
| No organization selected | Disabled **Continue** | Visible **Choose at least one organization to continue.** |
| Any specific group empty | Disabled **Continue** | Per-group reason remains visible; an attempted action focuses the first invalid group. |
| Ready | Enabled **Continue** | Summary describes the exact payload. |
| Submitting | Disabled **Setting up Factory…** | Action region has `aria-busy="true"`; all draft values remain. |
| Completion failure | Enabled retry/Continue | `role="alert"`; preserve draft and focus the error/action region. |
| Success | No optimistic route | `window.location.assign(done.returnTo || '/')` only after the successful JSON response. |

Do not use a chatty live region for every count change. Native state plus the visible summary is
sufficient; announce blocking async failures and submission outcome.

## 5. Loading, expiry, failure, and recovery

Every state retains the Factory/public header and the same `h1`:

- pending load: compact labeled static placeholders shaped like identity and organization rows; no
  shimmer, fake names, or enabled action;
- non-401 pending failure: **Could not load setup. Try again.** plus Retry;
- `401`: existing expired meaning and **Start again** OAuth anchor; state that nothing was saved;
- defensive zero-installation payload: explain no installation is available and provide
  **Start again** rather than an unexplained disabled button;
- local repo load: local loading status only;
- local repo failure: keep current mode/draft and show Retry;
- `UNKNOWN_REPO`: refresh, intersect stale names, keep valid choices, explain that selections
  changed, and focus the first reconciled organization;
- `REPOS_UNAVAILABLE`: preserve all draft state and explain that choices could not be verified;
- unknown completion error: **The selection could not be saved. Try again.**

## API and security invariants

Use the existing requests only:

- `GET /api/auth/github/pending`;
- `GET /api/auth/github/pending/installations/:id/repos`;
- `POST /api/auth/github/complete`;
- `GET /api/auth/github?returnTo=…` for Start again.

Preserve:

- the short-lived, single-use pending row;
- `401 NO_PENDING`, `400 UNKNOWN_REPO`, `400 REPOS_UNAVAILABLE`, and `BAD_SELECTION` behavior;
- server validation of repo names against installation visibility;
- full-page navigation to the server-provided safe return path;
- `type="button"` callbacks because CSP keeps `form-action 'none'`;
- the separation between OAuth `read:org` identity/membership and GitHub App repo access.

No endpoint, migration, auth scope, cookie, GitHub App permission, driver, Docker, or Kubernetes
change is expected.

## Implementation map

- `web/src/onboarding.ts` (new)
  - explicit repository-mode state, initialization, reconciliation, validation, counts, active-org
    derivation, summary rows, exact payload builder;
- `web/src/components/OnboardingOrganization.tsx` (new)
  - organization choice, mode radios, repository checklist/count, local statuses, linked help;
- `web/src/pages/OnboardingPage.tsx`
  - pending/repo network effects, draft ownership, retries, completion, focus, full redirect;
- `web/src/components/PublicPageHeader.tsx` (new)
  - Factory brand and public layout seam; no authenticated navigation;
- `web/src/components/LoginGate.tsx`
  - adopt public header; preserve OAuth anchor and reason mapping;
- `web/src/styles.css`
  - public page, onboarding header, organization/mode/checklist/summary/status primitives and narrow
    behavior using existing dark tokens;
- `docs/design-system.md`
  - onboarding/public-header primitives and exact component/class inventory;
- `docs/auth.md`
  - explicit all/future versus specific UI meaning without changing the API description;
- `web/test/onboarding.render.test.tsx`, `server/test/auth.completion.test.ts`, `e2e/auth.spec.ts`
  - pure/render/server/browser coverage and screenshots.

Keep fetch/navigation out of presentational components. Pure helpers do not mutate caller-owned
sets/maps or read browser state.

## Accessibility and responsive requirements

- One `h1` in every onboarding state.
- Use `fieldset`/`legend` or equivalent named semantics for organization and repository groups.
- Every checkbox/radio has a visible label; help/error ids are stable and linked.
- Busy/error copy is textual and announced appropriately.
- Focus moves only after user-triggered validation or reconciliation, never during initial render.
- Keyboard alone completes the full selection and retry flow.
- DOM order remains header → selection → access note → summary → action at every width.
- At 360px/390×844, rows stack, long repo names wrap/contain, controls are at least 44px, and no
  body-level horizontal overflow or covered action exists.
- At 1440×1000, use the canvas without turning the choice into a full-width form; a summary column
  is allowed when DOM/focus order stays logical.

## Tests

Pure/render coverage:

- null tracking initializes all; stored array initializes specific and intersects live names;
- all checked in specific stays specific;
- explicit all sends `[]` and clears a prior narrowing;
- unavailable listing preserves stored specific selection;
- deselected organization contributes no repo payload;
- zero organizations and empty specific groups are invalid;
- requested-active fallback and summary rows;
- identity display/login/avatar fallback and no internal ids;
- loading, failure, expired, empty, unavailable, validation, submitting, and normal markup;
- no `<form>` and no forbidden identity/provider values.

Server coverage:

- selected installations only, optional repo keys, empty-array widening, exact allowlists;
- unknown repo, unavailable listing, pending expiry/single use, requested-org fallback, rollback.

Browser coverage:

- all/future and specific flows against the stub IdP;
- selected counts and saved allowlist;
- disabled reason and validation focus;
- deterministic loading/unavailable/failure interception;
- expired recovery, busy label, preserved failure draft, successful materialization/redirect;
- keyboard-only completion;
- inspected dark screenshots at 1440×1000 and 390×844 for populated, loading, unavailable,
  validation, in-flight, expired, and defensive empty states.

Never put real credentials, tokens, or private repository names in fixtures/screenshots.

## Acceptance criteria

- [ ] Onboarding carries Factory identity, one `h1`, purpose, setup context, and signed-in identity.
- [ ] Organization names are visible and installation ids are not user-facing.
- [ ] Every selected organization explicitly chooses all/future or specific repositories.
- [ ] Specific mode shows counts, requires one repo, and remains specific when all current repos are
      checked.
- [ ] Unavailable listing never silently widens an existing specific allowlist.
- [ ] Access copy accurately separates OAuth identity/membership from GitHub App repo access.
- [ ] Final summary names organization count, per-org mode/count, and active organization.
- [ ] Continue has correct disabled, busy, failure, and success behavior with draft preservation.
- [ ] Loading, expiry, empty, unavailable, stale-reconciled, in-flight, and server-error states are
      recoverable.
- [ ] Existing API/status/security contracts remain unchanged and server tests pass.
- [ ] Keyboard and 360/390/1440 visual checks pass with no page-level overflow.
- [ ] Styles and new components are documented in the design-system inventory.

## Verification

```bash
npx vitest run web/test/onboarding.render.test.tsx
npx vitest run server/test/auth.completion.test.ts
npx playwright test e2e/auth.spec.ts --project=auth
npm test
npm run typecheck
npm run lint
npm run build
npm run verify:ui
```

Inspect every onboarding artifact at full size.

## Out of scope

- Theme bootstrap/control and light-theme audit — Slice E 2/4.
- Global state, contrast, legibility, and reduced-motion audit — Slice E 3/4.
- Cross-route responsive and final visual matrix — Slice E 4/4.
- OAuth scopes, App permissions, session policy, membership, installation management, repo search,
  pagination, account-synced preferences, illustration, or a new icon library.
