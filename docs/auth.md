# Authentication

Who a caller is, and which credential each route accepts.

| Concern | Code | Test |
| --- | --- | --- |
| Which routes accept which credential | `server/src/auth/plugin.ts` | `server/test/auth.enforcement.test.ts` |
| `AUTH_MODE`, its boot refusals, `AUTH_ALLOW_PUBLIC_BIND` | `server/src/config.ts` | `server/test/config.auth.test.ts` |
| Session cookie: signing, flags, expiry | `server/src/auth/session.ts` | `server/test/auth.session.test.ts` |
| OAuth round trip, state, redirect validation, `/me` | `server/src/routes/auth.ts`, `auth-shared.ts`, `server/src/auth/github.ts` | `server/test/auth.oauth*.test.ts`, `server/test/auth.github-client.test.ts` |
| Installation-selection screen, pending sign-in, repo scope | `server/src/routes/auth-onboarding.ts` | `server/test/auth.completion.test.ts` |
| Accounts, sessions, memberships, roles (SQL) | `server/src/auth/store.ts`, `server/migrations/010_auth.sql` | `server/test-db/auth-store.test.ts` |
| Personal (`fat_`) and org (`oat_`) access tokens | `server/src/auth/access-token.ts`, `server/src/routes/tokens.ts` | `server/test/auth.tokens.test.ts`, `server/test-db/auth-store.access-tokens.test.ts`, `…lifecycle.test.ts`, `…org.test.ts` |
| Roster reads and role writes | `server/src/routes/org-members.ts` | `server/test/routes.org-members.test.ts` |
| GitHub-side removal, signed webhook | `server/src/routes/webhook.ts` | `server/test/webhook.test.ts` |
| Sign-in in a real browser | `e2e/auth.spec.ts`, `e2e/stub-idp.mjs`, `e2e/signin.ts` | the `auth` Playwright project (`playwright.config.ts`) |

Org scoping: [organizations.md](organizations.md) · App credential: [configuration.md](configuration.md) ·
posture: [security.md](security.md) · routes and codes: [api.md](api.md).

## Invariants

- **Installation access IS membership.** `signIn` upserts one `organization` and one
  `org_membership` per SELECTED installation and deletes memberships outside it, in one pass; no
  invite, no auto-join. `server/src/auth/store.ts`, `server/test-db/auth-store.test.ts`.
- **Every credential's reach is a live `org_membership` join** — `findSession`,
  `findPersonalToken`, `findOrgToken` — so a removed membership ends sessions and both token kinds
  on the next request. `server/src/auth/store.ts`, `server/test-db/auth-store.access-tokens.org.test.ts`.
- **An org's first materialized membership lands `admin`**, and demoting the last admin is refused
  in the statement (`409 LAST_ADMIN`). `server/src/auth/store.ts`, `server/test/routes.org-members.test.ts`.
- **`github_user_id` is the identity; `github_login` is a lowercase label** nothing keys on —
  GitHub frees a renamed login for anyone to claim. `server/src/auth/store.ts`.
- **Only the sha-256 is stored** — sessions, both token kinds, the pending sign-in row. And the
  cookie is `SameSite=Lax`, never `Strict`: the callback is a cross-site top-level GET, so
  `Strict` withholds the state cookie and every login fails. `server/src/auth/session.ts`,
  `server/src/auth/access-token.ts`, `server/test/auth.session.test.ts`.
- **Three credential kinds, one per request, no fall-through.** A bearer on a session route wins
  over the cookie and a bad one is a 401; a worker token is refused on human routes and vice
  versa; an `oat_` reaches only `ORG_TOKEN_ROUTES` and is `403` off it, since no person stands
  behind it. `server/src/auth/plugin.ts`, `server/test/auth.enforcement.test.ts`.
- **`AUTH_MODE=none` synthesises a caller rather than skipping the hook**, so `job.created_by` is
  always populated. It refuses a non-loopback `HOST` unless `AUTH_ALLOW_PUBLIC_BIND=1`;
  `docker-compose.yml` pins `AUTH_MODE: github` as a literal `.env` cannot win, and
  `charts/factory/` has no open mode. `server/src/config.ts`, `server/src/db/migrate.ts` (`LOCAL_LOGIN`).
- **An idempotency key is scoped to org, caller and operation, and a replay re-passes the route's
  credential and the follow-up/retry author check** — a stored result never answers another
  caller, another org, or a parent that changed hands. `server/src/db/job-store-idempotency.ts`,
  `server/src/db/job-store-actions.ts`, `server/test-db/job-store.idempotency.test.ts`.
- **The worker credential is one deployment-wide shared secret**, `JOB_BOARD_TOKEN`: constant-time
  compare, no row, no mint route, fatal at boot in github mode when missing or under 32 characters
  — so a claim names no org and is offered every org's queue. `server/src/config.ts`.
- **`POST /api/sessions/branch` demands an org-bound credential in github mode** — the runner's
  `x-factory-job-id` + `x-factory-job-lease-token` pair, or a `fat_` token; the deployment-wide
  ingest token does not open it (CWE-862). `server/src/routes/ingest.ts`,
  `server/test/auth.enforcement.test.ts`.
- **The three GitHub endpoint URLs are an environment-only test seam** — `playwright.config.ts`
  points them at `e2e/stub-idp.mjs`; a configurable authorize URL in a deployment is phishing.

## Stated limits

- Membership is not a sandbox: every member sees every repo the installation reports and may
  queue a command an agent runs ([security.md](security.md)).
- Org `member_removed` events fire for organization installations only; a user-account
  installation's removal is caught one sign-in late by the selection sweep.
