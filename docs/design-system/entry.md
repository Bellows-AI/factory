# Design system — region: entry

Gate, onboarding, account page. `web/src/styles/regions/entry.css`; shared system:
[../design-system.md](../design-system.md).

| Concern | Code | Test |
| --- | --- | --- |
| Signed-out gate and the public chrome both public pages carry | `web/src/components/LoginGate.tsx`, `web/src/components/PublicPageHeader.tsx` | `e2e/auth.spec.ts`, `web/test/theme.test.tsx` |
| Onboarding screen, one org's card, selection state and blockers | `web/src/pages/OnboardingPage.tsx`, `web/src/components/OnboardingOrganization.tsx`, `web/src/onboarding.ts` | `web/test/onboarding.render.test.tsx` |
| Account page: identity, access tokens, tracked orgs | `web/src/pages/AccountPage.tsx`, `web/src/panels/IdentityPanel.tsx`, `web/src/panels/AccessTokensPanel.tsx`, `web/src/panels/TrackedOrgsPanel.tsx` | `web/test/settings.render.test.tsx` |

## Invariants

- A public page owns its one `h1`; `PublicPageHeader` carries no heading, navigation or session.
- `login-button` is an anchor skinned as a primary button: the CSP forbids a form, and a fetch
  cannot follow the OAuth 302.
- Continue is `aria-disabled`, never `disabled`, so its reason stays focusable and `aria-describedby`-wired.

Classes defined here: `login-gate`, `login-card`, `login-button`, `public-brand`, `public-context`,
`public-header-actions`, `onboarding-purpose`, `onboarding-banner-body`, `onboarding-identity`,
`onboarding-orgs`, `onboarding-org-head`, `onboarding-org-name`, `onboarding-org-mark`,
`onboarding-org-summary`, `onboarding-mode-option`, `onboarding-mode-help`, `onboarding-repos`,
`onboarding-repo-count`, `onboarding-note`, `onboarding-summary-total`, `onboarding-summary-rows`,
`onboarding-actions`, `onboarding-blocker`, `onboarding-loading-line`, `identity-head`,
`identity-name`, `token-create`.
