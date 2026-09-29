# Design system — region: entry

Owned by the entry lane. Styles: `web/src/styles/regions/entry.css` — the lane rules plus its
trailing 44px touch-target segment (issue 189). Shared primitives, tokens and the system
contracts: [../design-system.md](../design-system.md).

## Primitives

| Primitive | Classes | Use for |
| --- | --- | --- |
| Login | `login-gate`, `login-card`, `login-button` | The signed-out screen: one raised card centered in the gate (the dialog recipe without the float), its `h1` at the page-title size, and a `banner-bad` alert for a failed session check or a callback's `auth_error` reason. `login-button` is the OAuth anchor skinned as `button.primary` (the CSP forbids a form, a fetch cannot follow the 302); the onboarding restart and the account's tracked-organizations link reuse it |
| Public header | `public-header`, `public-brand`, `public-context`, `public-header-actions` | The compact chrome both public pages (gate, onboarding) carry, on the app bar's 56px line, `--surface` fill and bottom hairline: the product brand (`PRODUCT_NAME`) in the shell's uppercase wordmark, one context word, and the actions cell, which holds the theme control (issue 187; the appearance control arrived in issue 188). No navigation, no session, no `h1` — each page owns its one heading. The theme bootstrap resolves the palette before paint here as everywhere, so nothing on a public page switches its own colors (issue 284) |
| Onboarding | `onboarding`, `onboarding-purpose`, `onboarding-banner-body`, `onboarding-identity`, `onboarding-orgs`, `onboarding-org`, `onboarding-org-head`, `onboarding-org-name`, `onboarding-org-mark`, `onboarding-org-details`, `onboarding-org-summary`, `onboarding-mode`, `onboarding-mode-option`, `onboarding-mode-help`, `onboarding-repos`, `onboarding-repo`, `onboarding-repo-count`, `onboarding-note`, `onboarding-summary`, `onboarding-summary-total`, `onboarding-summary-rows`, `onboarding-summary-row`, `onboarding-actions`, `onboarding-blocker`, `onboarding-loading`, `onboarding-loading-line` | The setup screen (issue 125, recomposed by issue 187, restyled by issue 284): the centered 640px column, the org list of raised cards with each org's initial identity mark and its `Requested for this sign-in` `pill pill-accent`, one org's card — a focus target for a blocked attempt, never a click target — whose disclosure summary names the org's repository mode while collapsed, the explicit mode radios with their helpers, the specific-mode checklist (mono names) with its `N of M` count, the access note, the raised selection summary, and the action region. States keep apart: an expired sign-in is `banner-warn`, a failed load or a refused submission is a `banner-bad` alert, a zero-installation payload is `banner-info` — `onboarding-banner-body` stacks a banner's sentence over its one action — and `onboarding-blocker` is a missing choice, muted like `composer-blocker`: a disabled Continue's reason (nothing chosen, or a named org's empty specific list), visible and wired as Continue's `aria-describedby`, and an org card's own empty-list reason. Continue is `aria-disabled`, never `disabled`, so the action region repaints it with the disabled-primary recipe on that attribute. Inside a card the same split holds: a failed listing is a `banner-bad` alert with its Retry, an unavailable one a `banner-info` with its Retry. A loading or unreadable listing never blocks, so it is never a blocker. `onboarding-loading` shapes the pending-load placeholders: static rows and a status line, no shimmer |
| Identity | `identity-head`, `identity-name` | The account page's identity section |


## Inventory

| File | Primitives |
| --- | --- |
| `AccountPage.tsx` | page-header, panel, banner (info, open mode only: what `AUTH_MODE=none` leaves out), icon |
| `OnboardingPage.tsx` | onboarding, appearance, public-header, banner, icon, muted, avatar, login-button, primary |
| `LoginGate.tsx` | login, appearance, public-header, banner, icon |
| `PublicPageHeader.tsx` | public-header |
| `OnboardingOrganization.tsx` | onboarding, pill, banner, icon, muted |
| `IdentityPanel.tsx` | identity, avatar |
| `AccessTokensPanel.tsx` | panel, status |
| `TrackedOrgsPanel.tsx` | panel, login-button |

