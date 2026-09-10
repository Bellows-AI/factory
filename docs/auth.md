# Authentication

Read before: touching `server/src/auth/*`, `server/migrations/010_auth.sql`, the `[auth]` block, the
session cookie, or anything that decides which routes need a credential.

**A caller is a GitHub account that somebody invited to this organization.** Membership is Factory's,
not GitHub's; a session is a row, not a token; and the driver gets a different credential from the
one a browser gets. Before this existed, `docs/security.md`'s opening sentence was that the
`127.0.0.1` bind *is* the access control — which on a port serving `POST /api/jobs` meant an
unauthenticated request was remote code execution.

- **`AUTH_MODE` is an explicit enum, never inferred from whether a client id happens to be set.**
  A mode reached by typo is exactly what `docs/persistence.md` warns about, where the service "used
  to have a second, silent behaviour reachable by forgetting `DATABASE_URL`". `GITHUB_OAUTH_CLIENT_IDD`
  must leave a deployment loudly open, not half-configured. For the same reason `github` with an
  incomplete `[auth]` is **fatal and names the missing key**: half-configured auth silently
  degrading to open is the one failure nobody notices.
- **`AUTH_MODE=none` is a supported state, and four things depend on it**: `npm run seed`,
  `npm run verify:ui`, `scripts/test-jobs.sh` and the route-test harness. There is also no offline
  way to obtain an OAuth client id, so requiring auth would make `git clone && npm run dev`
  impossible. It is the default, because a newly required variable that fails every existing case is
  the signal not to require it — but `index.ts` logs unconditionally that every route is open, in
  the register of the `[fetch] no GitHub credential` line.
  - **The GitHub side has no such default, and the asymmetry is deliberate.** The App id and key
    are required outright — there is no env-reachable no-fetch state to land in by accident,
    because an empty dashboard that fetches nothing reads as data loss. The tooling that must run
    credential-free says so in code, never in the environment. See
    [configuration.md](configuration.md).
- **`none` refuses a non-loopback `HOST`**, which makes "open on a public interface" *inexpressible*
  rather than warned about — stronger than anything the bind address guaranteed on its own. The one
  hatch, `AUTH_ALLOW_PUBLIC_BIND=1`, exists because `docker/Dockerfile` sets `ENV HOST=0.0.0.0`:
  inside a container that is normal and the isolation is compose's `127.0.0.1:8080:8080` publish,
  which `loadConfig` cannot see and must not guess at.
- **`docker-compose.yml` pins `AUTH_MODE=github` as a literal, and no longer sets that hatch.** It
  is the one key in that file `.env` is not allowed to win, which is the whole point: a wall that
  an environment variable can lower is not a wall. That stack keeps the organization's
  checkouts and serves `POST /api/jobs`, so it identifies its callers — while `none` stays the
  default everywhere else, because the four things in the bullet above need it. Turning the port
  open is now an edit to that line, and the hatch has to come back with it.
- **`none` synthesises a caller rather than skipping the auth path.** `migrate()` seeds a stand-in
  account — `github_user_id = 0`, a value GitHub never issues, under the login `__local__`, which is
  unrepresentable as a real GitHub login because underscores are not permitted in one — and the hook
  resolves it like any other. There is then exactly one downstream code path, `job.created_by` is
  always populated, and the auth path is exercised by the environment the feature is developed in. A
  mode that *skips* the hook is a mode whose hook nothing tests.
- **In `none` mode the worker routes are open too.** Requiring a worker token there would buy
  nothing — anyone who can reach the port can already queue a command an agent runs — while breaking
  `npm run driver` against a local board and `scripts/test-jobs.sh`, which drives the whole lease
  protocol with no credential at all. The two credentials are disjoint when there *are* credentials.
- **`bootstrapAdmin` exists because an upgrade is otherwise a lockout.** After 010 an existing
  database has rows, zero users and zero memberships; turn auth on and every route 401s forever with
  nothing in the log, which reads as "auth is broken" rather than "nobody has been invited". Exactly
  the class of silent failure `adoptOrg()` exists to prevent, one level up — and it lives beside it
  in `db/migrate.ts` for the same reason: a `.sql` file cannot see the config. It fires **only when
  the organization has no real members**, so an admin who removes themselves is not reinstated on the
  next restart, and it ignores the `__local__` membership — otherwise booting once without auth
  would suppress the bootstrap forever.

## Membership

- **A Factory organization is not a GitHub organization** (`docs/organizations.md`), so there is
  nothing to read from GitHub to find out who belongs here. An admin invites a login; the account is
  bound the first time that person signs in. Consequence: an invite exists **before** the account
  does, which is why `org_membership`'s primary key is `(org_id, github_login)` and `user_id` is
  nullable, and why nothing can validate that the login exists.
- **`auth.auto_join_github_org` borrows a GitHub organization as the boundary instead**, and is the
  one thing that admits somebody nobody named in advance. It does not make a Factory organization a
  GitHub one: the membership row is still Factory's, still `member`, and an invite still admits
  people outside the org — which is what keeps `bootstrap_admin` and outside collaborators working.
  What it removes is the second roster that had to be kept in step by hand.
  - **The store never decides it.** `signIn` takes an `autoJoin` flag, and the callback passes it
    only after GitHub has confirmed the org. A store that could admit anyone on its own authority
    would be one bad default away from an open deployment.
  - **`pending` is refused, and that is the security property here.** An unaccepted GitHub
    invitation means somebody was *offered* a seat; treating it as membership would let a GitHub org
    admin add a login to Factory without that person ever agreeing to it.
  - **The check runs only when an invite did not already settle it**, so an ordinary member pays no
    extra GitHub call, and a role an invite granted is never overwritten by a fresh `member` — the
    insert is `on conflict do nothing` for exactly that reason.
  - **It costs the zero-scopes property**: `read:org` is requested whenever it is set, because an
    unscoped token reports every organization absent, which would refuse every sign-in with
    `no_membership` and nothing to say why. Off, no scope is requested at all.
  - **The empty-roster warning is suppressed while it is on.** Zero members is the *expected* state
    there — the first person to sign in creates their own row — so the lockout warning would be
    noise that trains people to ignore it.
- **`github_user_id` is the identity; `github_login` is a label.** GitHub permits renames and then
  lets the freed login be claimed by somebody else, so a schema keyed on the login is an
  account-takeover path rather than a convenience.
- **The claim carries `and user_id is null`, and that predicate is the whole security property.**
  Without it: A is invited as `alice` and claims it; A renames away, freeing the login; B registers
  `alice`, signs in, and the update hands them A's membership *including its admin role*. Guarded by
  "does NOT let a new account claim a membership by taking a freed login" in both
  `auth.oauth.test.ts` and `test-db/auth-store.test.ts`.
- **It also carries a `not exists` guard**, skipping any organization the account is already a
  member of. Somebody invited under both an old and a new login would otherwise claim both rows,
  violate `org_membership_user_uk`, and turn a legitimate sign-in into a 500.
- **Residual risk, not fixable in schema:** an invite created *after* somebody renamed away is a live
  invite for whoever takes that login next. Inherent to inviting by login.
- **`github_login` is stored lowercase, where `ORG_ID_PATTERN` is rejected-never-normalised.** Not an
  inconsistency: an org id is operator-chosen and lives in three places that have to agree, so
  silently lowercasing it would let them disagree invisibly; a GitHub login is chosen by GitHub,
  which is itself case-insensitive, so normalising is the only way an invite matches what the
  identity endpoint reports back.
- **`app_user` and `session` are global; only `org_membership` leads with `org_id`.**
  `005_organizations.sql` states the rule as "exactly those tables that already carry `repo`", and an
  identity carries none. Keying an account by organization would give one human two ids — and the
  per-user Claude credential planned on top of that id is the person's, not the organization's.

## Sessions

A random 32-byte token in a signed, httpOnly cookie, with a row keyed by its **sha-256**.

- **Rows, not self-contained tokens, because revocation has to be immediate.** Removing somebody
  must stop their next request, not their next fortnight, on a deployment where `POST /api/jobs` runs
  shell commands. `findSession` joins through `org_membership`, so losing the membership ends the
  session on the very next request; `removeMember` deletes their sessions outright as well. A
  stateless token reaches that only with a denylist, and a denylist is this table with worse
  ergonomics.
- **The table holds the hash, never the token.** The row is a bearer credential at rest — anyone with
  a read on it would otherwise hold every live session. Same reasoning as the `chmod 600` warning in
  `docs/security.md`.
- **`SameSite=Lax`, never `Strict`.** The OAuth callback is a top-level GET arriving *from
  github.com*; `Strict` withholds cookies on a cross-site top-level navigation, so the state cookie
  would be absent at the callback and **login would fail every single time**, with a state-mismatch
  error that reads exactly like an attack. Anyone reaching for "the most secure option" picks
  `Strict`, so the reason lives next to the value in `session.ts`. Not `None`, which requires
  `Secure` and permits cross-site POST.
- **`Secure` is configured, not derived.** Hard-coding it breaks every `http://127.0.0.1` boot;
  relying on the browsers that except loopback is a trap, because Chromium does and Safari does not,
  so `verify:ui` (which drives Chromium) would pass while a Safari developer could not sign in; and
  deriving it from `X-Forwarded-Proto` means trusting a header from anyone.
- **No `Domain`, and `Path=/`.** Host-only, because `Domain=.example.com` widens the cookie to
  subdomains the deployment does not control. Root-scoped because a path-scoped cookie is a trap the
  first time a page wants to know it is signed in without issuing a fetch. `__Host-` was rejected: it
  requires `Secure`, so the cookie *name* would differ between dev and prod.
- **The cookie is signed even though the token is already unguessable.** A forged cookie is then
  rejected with an HMAC compare *before* any database round trip, so an unauthenticated flood costs a
  hash rather than a query each — and rotating `SESSION_SECRET` logs everyone out, which is the only
  lever an operator has when something has leaked.
- **`Max-Age` and `expires_at` describe the same instant.** The first stops the browser sending it,
  the second stops this server honouring a copy no browser is enforcing.
- **The expiry is absolute, not sliding.** There is no touch on the read path, so a session ends on
  schedule rather than being extended by use. That costs a signed-in person one sign-in a fortnight
  and buys a write-free read path — which matters because the SPA polls `/api/stats` every two
  seconds for as long as a tab is open, so sliding would mean a write every two seconds per tab, or
  a rate-limiting heuristic to avoid one.

## The OAuth flow

`GET /api/auth/github` → GitHub → `GET /api/auth/github/callback` → session → redirect.
Plus `POST /api/auth/logout` and `GET /api/auth/me`.

- **Zero scopes are requested, unless `auth.auto_join_github_org` is set.** `read:org` is
  unnecessary by construction under invite-based membership, and `user:email` is unnecessary because
  nothing keys on an email. An unscoped token still reads `/user` for the id and login. Documented
  side effect: GitHub's consent screen then says the app "will not be able to access your data",
  which reads as broken to some people — that is the honest description of a login that reads
  nothing. With auto-join on, `read:org` is the whole membership decision and is requested; the
  org lookup derives its URL from `userUrl`, so the one environment seam that redirects `/user`
  redirects it too and the stub IdP needs no second knob.
- **The state lives in a short-lived signed cookie, not a row.** No table, no reaper, and the login
  entry point keeps working while the migrations are still retrying — the same instinct that keeps
  `/api/health` off the database. Single-use, because the callback clears it either way.
- **The return path travels *inside* the signed state**, so one signature covers both the nonce and
  the destination, and it is validated as a same-origin absolute path. `//evil.test` is the subtle
  case: a URL to another origin that merely looks like a path. Without that check the callback is an
  open redirect for anyone who can craft a login link.
- **Failures redirect with `?auth_error=`; they do not return JSON.** The callback is reached by a
  top-level browser navigation, and a `403 {"error":…}` body is a dead end for the human in front of
  it. `no_membership` is its own reason because "your login failed" and "you are not a member here"
  send the reader to completely different places.
- **`POST` for logout.** A GET logout is CSRF-able by any third-party image tag, and link prefetchers
  fire it on hover. It answers 204 for an already-dead session, because "already signed out" is the
  desired end state.
- **The two GitHub calls are hand-rolled behind an injected `GitHubIdentityClient`.** A library would
  own the state and CSRF decision, which is the part of this flow most worth being able to read here,
  and would bring a provider registry and a refresh-token model this codebase does not share. The
  seam is also what keeps `npm test` offline. `@fastify/cookie` **is** a dependency, because cookie
  serialisation is a spec with edge cases and no design decisions in it.
- **The three endpoint URLs are overridable from the environment only** — deliberately undocumented
  as deployment configuration. A configurable authorize URL that ships with a deployment is a
  phishing vector; as an environment variable it is a test seam that `index.ts` logs loudly when it
  is in use. `e2e/stub-idp.mjs` is the only thing that sets them.
- **`auth.public_url` is required once `HOST` is not loopback.** The `redirect_uri` must be absolute
  and must never be derived from the request's `Host` header — that lets the caller choose the
  redirect target. `http://0.0.0.0:8080` is not somewhere a browser is ever sent back to, so guessing
  is worse than refusing.
- **An OAuth App for sign-in, and a SEPARATE GitHub App for repo-read.** Two registrations to set
  up, deliberately. This file used to say "an OAuth App, not a GitHub App"; that was about not
  conflating the two credentials, and the conclusion still holds now that both exist. Signing
  somebody in needs zero scopes and reads only their numeric id and login. Reading repositories
  needs installation permissions and is nothing to do with the person in front of the browser — one
  credential doing both would mean every sign-in grants repository access, and would tie the
  dashboard's ability to fetch to whoever happened to log in last. See
  [configuration.md](configuration.md) for the App credential.

## Who needs which credential

| Route | Credential |
| --- | --- |
| `GET /api/health` | **open** — must answer while migrations retry, and the compose healthcheck carries none. Authenticating it restarts the container that was about to succeed. |
| `/api/auth/*` | open. `/me` 401s on its own; being what *tells* the SPA it is unauthenticated is its purpose. |
| the SPA's document and bundle | **open** — if `index.html` 401'd there would be nothing left to render a sign-in button in. The wall is on `/api/*`, never on the document. |
| `/api/stats`, `/api/refresh`, `POST /api/jobs`, `GET /api/jobs[/:id][/thread]`, `/api/jobs/:id/resume`, `/api/jobs/:id/follow-up`, `/api/jobs/:id/done` | session cookie |
| `/api/jobs/claim`, `/heartbeat`, `/session`, `/output`, `/suspend`, `/complete`, `/gates`, `/gates-reread` | `Bearer fwt_…` worker token |
| OTLP + `POST /api/sessions/branch` | optional `X-Factory-Ingest-Token` |

- **The two sets are disjoint, and that is the point.** A session accepted on `/claim` would let any
  member steal another worker's lease; a worker token accepted on `POST /api/jobs` would produce a
  job with no author, silently breaking the audit trail on the route that runs shell commands.
  `/api/jobs/:id/resume`, `/follow-up` and `/done` are *human* routes: nobody holds a parked job, and
  a finished task is over — which is exactly what makes resuming, adjusting and closing one a
  person's action.
- **The worker token is minted by CLI only.** `npm run worker-token -- --name driver-1`, printed
  once, hash stored. No HTTP route mints a credential: everything else a member can do is bounded by
  the organization, whereas this issues something that claims work and reports results with no human
  anywhere. (The one precision since #28: the claim route mints a GitHub App installation token onto
  the claim env, but that token is bounded by the installation, scoped to GitHub, and dead within
  the hour — see [env.md](env.md). The worker token is the only credential that answers for the
  board itself.) The `fwt_` prefix makes a leaked token greppable and makes "cookie or worker token?"
  answerable without a database lookup.
- **The token is also the driver's org binding** — it is how a process with no session says which
  organization it is working for, which is why `worker_token.token_hash` is uniquely indexed even
  though the primary key leads with `org_id`.
- **The driver's whole share of this is one header.** `JOB_BOARD_TOKEN` in `driver/src/config.ts` and
  an `authorization` header in `board.ts`. It stays that way because that package depends on nothing
  — see `AGENTS.md`. The header is **omitted** rather than sent empty against an open board: an empty
  Bearer is a credential that failed, where no header is one that was never offered.
- **The ingest token is optional, and unset means today's behaviour.** Two callers, and the second is
  the awkward one: a collector on the compose network, and the `agent-telemetry` plugin installed at
  user scope on developer laptops. Requiring it would break both with no migration path. Header only,
  never a query parameter, which would land in every access log. Honest limitation: `metric_point`
  has no `org_id` by design (`docs/organizations.md`), so this is an *authenticity* check, not an
  authorization one.

## What this does not do

- **Membership is not a sandbox.** Any member can still queue a command that an agent runs against
  *their own* checkouts. This narrows "anyone who can reach the port" to "any member"; it does not
  make the job board safe to hand out.
- **There is still one organization per deployment.** `meta.organization.mode` remains the literal
  `'config'` and the topbar selector stays disabled — see `docs/organizations.md`. Sign-in checks a
  caller's membership against that one organization rather than selecting between several.
- **Signing in now has a side effect on disk.** `ensureUserWorkspace` creates
  `<root>/<orgId>/<userId>/` in the callback — a `mkdir`, nothing more. It cannot block the sign-in:
  a failure logs, and `GET /api/workspace` calls the same function, so a session that got in without
  one recovers on its first visit to the page. See [workspace.md](workspace.md).
- **`job.created_by` has one reader now, and one still to come.** `POST /api/jobs/claim` turns it
  into `workspacePath`, which is how a driver finds the author's checkouts without ever touching the
  database. The per-user Claude credential is the half that has not arrived, and `userId` is still
  reported on the claim for it.
