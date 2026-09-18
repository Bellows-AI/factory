# Authentication

Read before: touching `server/src/auth/*`, `server/migrations/010_auth.sql`, the `AUTH_*`
environment variables, the session cookie, or anything that decides which routes need a credential.

**A caller is a GitHub account that can see one of this deployment's GitHub App installations.**
Installation access IS membership (#99); a session is a row, not a token; and the driver gets a
different credential from the one a browser gets. Before any of this existed, `docs/security.md`'s
opening sentence was that the `127.0.0.1` bind *is* the access control — which on a port serving
`POST /api/jobs` meant an unauthenticated request was remote code execution.

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
  the signal not to require it — but `main.ts` logs unconditionally that every route is open, in
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
## Membership

- **The GitHub App's installations are the member roster, narrowed by the sign-in choice (#125).**
  At every sign-in the callback asks `GET /user/installations` with the signing-in person's own
  token, and `store.signIn` upserts one `organization` row (id = the installation id, name = the
  account login) and one membership per **selected** installation — not automatically every
  reported one. A first sign-in with two or more installations parks the round trip and asks the
  person what to track (see The OAuth flow); one installation signs straight in; a stored choice
  is reused without re-prompting, and the membership rows ARE that stored choice — "has a
  selection" and "has memberships" are the same fact, so an abandoned screen leaves nothing
  behind. There is no invite, no auto-join flag, no bootstrap admin, and no roster sweep: what
  the selection materialized at the last sign-in IS the materialized fact — and since #123, the
  sweep at sign-in deletes a membership of ANY org outside the passed selection, whether because
  GitHub stopped reporting it or because the account deselected it: one predicate, two meanings
  of "this account does not reach here", and an org row no installation reports (the none-mode
  local row, a husk in an upgraded database) can never list an account twice. The choice is never
  an authorization decision — it bounds only what this account's sign-in materializes, never
  another member's reach, and re-selecting restores reach through the same upsert.
- **Removal is GitHub's own report first, sign-in second — and the join is still the security
  property.** GitHub delivers `organization.member_removed` to `POST /api/github/webhook`, whose
  credential is the `GITHUB_WEBHOOK_SECRET` HMAC over the raw body; the route deletes the
  membership by the numeric id on the spot — and because `findSession` and `findPersonalToken`
  join through `org_membership`, every credential's reach ends right there. What the webhook buys
  over the sweep is the bound: revocation runs when GitHub says so, not when the removed account
  next signs in. The sweep stays, because a webhook is at-most-once from where this deployment
  stands — a delivery missed while the board was down is repaired at the next sign-in, which is
  what the propagation has always been for. Honest limitation: org events fire for organization
  installations only, so an installation owned by a personal account reports nothing here and
  stays one-sign-in-late. No new permission buys any of this — the webhook authenticates by
  signature, which is why the installation stays at `Metadata: read` + `Contents: read`
  (docs/security.md). Operator step: App settings → webhook URL `<PUBLIC_URL>/api/github/webhook`,
  secret `GITHUB_WEBHOOK_SECRET`, subscribed to `organization` events.

- **`github_user_id` is the identity; `github_login` is a label.** GitHub permits renames and then
  lets the freed login be claimed by somebody else. Nothing here keys on the login: the account
  upsert keys on the numeric id, the membership's primary key is `(org_id, user_id)` (029 moved it
  off the login), and sign-in rewrites the login label wherever it appears. A different numeric id
  registering a freed login is simply a new account.
- **`read:org` is requested unconditionally in github mode**, because listing installations IS the
  membership decision and an unscoped token reports none — every sign-in would be bounced to the
  install page with nothing to say why. The scope is org-level only: sign-in still reads no
  repository data, which is what the OAuth-vs-App split below is for.
- **Roles survive as a column, unused.** GitHub's org role is not mapped onto Factory's, so every
  membership is `member`; the `role` column and the `admin` value remain for the day something
  needs them. Consequently the org-token mint and the env-wide scopes carry no admin gate —
  installation access is one trust level.
- **`github_login` is stored lowercase**, because GitHub logins are case-insensitive and a match
  must survive case differences between what a report says and what the identity endpoint returned.
- **`app_user` and `session` are global; only `org_membership` leads with `org_id`.**
  `005_organizations.sql` states the rule as "exactly those tables that already carry `repo`", and
  an identity carries none. Keying an account by organization would give one human two ids — and
  the per-user Claude credential planned on top of that id is the person's, not the organization's.

## Sessions

A random 32-byte token in a signed, httpOnly cookie, with a row keyed by its **sha-256**.

- **Rows, not self-contained tokens, because revocation has to be immediate.** Losing the
  membership must stop the session on a deployment where `POST /api/jobs` runs shell commands.
  `findSession` joins through `org_membership`, so the membership's end — the webhook's report of
  the removal, or the next sign-in, when GitHub stops reporting the installation — ends the
  session's usefulness on the spot. A
  stateless token reaches that only with a denylist, and a denylist is this table with worse
  ergonomics.
- **The row carries its organization (`session.org_id`, 028), and that is what the caller reads
  through.** Stamped at sign-in (the first selected installation — the first reported one before
  #125 — or the `?org=` deep link, validated against the selection), moved by
  `POST /api/auth/org` — only ever to an org the user is a member of, which is what makes the
  switch safe. NULL on rows predating 028, and the read joins on it, so an upgrade signs everybody
  out rather than guessing an org for anybody: fail closed.
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
  and buys a write-free read path — which matters because every authenticated request reads the
  session row and a cold fetch re-polls `/api/stats` every two seconds, so sliding would mean a
  write on every one of those reads, or a rate-limiting heuristic to avoid one.

## The OAuth flow

`GET /api/auth/github?returnTo=&org=[&reselect=1]` → GitHub → `GET /api/auth/github/callback` →
`GET /user/installations` → then, since #125, one of three outcomes: **zero installations** redirects
to the install page; **one installation, or a stored selection** signs straight in (organizations +
memberships upserted for the selection → session, org-bound); **a first sign-in with two or more**
parks the identity and report in a `pending_sign_in` row and redirects to `/onboarding`, where
`GET /api/auth/github/pending` feeds the screen and `POST /api/auth/github/complete` materializes
the posted choice and finishes the sign-in.
Plus `GET /api/auth/github/setup` (the App's Setup URL target), `POST /api/auth/org` (switch),
`POST /api/auth/logout` and `GET /api/auth/me`.

- **`read:org` is requested unconditionally** — see Membership. The installations lookup derives
  its URL from `userUrl`, so the one environment seam that redirects `/user` redirects it too and
  the stub IdP needs no second knob.
- **The state lives in a short-lived signed cookie, not a row.** No table, no reaper, and the login
  entry point keeps working while the migrations are still retrying — the same instinct that keeps
  `/api/health` off the database. Single-use, because the callback clears it either way.
- **The return path — and any requested organization — travel *inside* the signed state**, so one
  signature covers the nonce, the destination and the org, and the destination is validated as a
  same-origin absolute path. `//evil.test` is the subtle case: a URL to another origin that merely
  looks like a path. Without that check the callback is an open redirect for anyone who can craft a
  login link. The `?org=` deep link is only a preference: it is validated against what GitHub
  actually reported and what the person chose (on the screen it is pre-marked), falling back to the
  first selected installation.
- **Zero installations is the install page, not a refusal.** The callback redirects to
  `https://github.com/apps/<slug>/installations/new` — the slug from `GET /app`, JWT-authenticated
  and cached for the process's life. Offline (no App client) or on a slug failure it reports
  `?auth_error=install` instead of dead-ending on a redirect to nowhere. The App's **Setup URL**
  must be configured to `<publicUrl>/api/auth/github/setup`: an install returns there and the flow
  restarts; a return without an installation id reports `install_cancelled` on the sign-in screen.
- **The selection screen survives the single-use code in a row, not a cookie payload (#125).** The
  OAuth `code` is spent by the time the installations report is in hand, and the person then spends
  seconds-to-minutes choosing — so the identity and report ride a `pending_sign_in` row keyed by
  the hash of an opaque token in a signed, short-lived cookie (the `PENDING_COOKIE`), the same
  at-rest rule as the session. Not the state cookie's payload: a browser cookie is capped around
  4KB, and the report this flow exists for is the enterprise account with many installations. The
  row is single-use — the completion route claims it with one atomic `delete … returning` before
  anything is materialized, so only one of two completions racing the same cookie can get past it —
  expires in ten minutes, is reaped at boot — and its read spends an expired row on sight, so a
  stale cookie can never complete even before the reaper runs.
- **The screen is a first-sign-in affair; changing the choice is a re-run (#125).** The stored
  choice is the membership set, so an account that has one signs straight in — re-prompting every
  sign-in would be hostile. There is deliberately no in-place editor on the settings page: the
  GitHub user token that enumerated the installations is discarded at sign-in, so the list cannot
  be re-asked outside an OAuth round trip. The settings surface is a link that restarts the flow
  with `?reselect=1`, which reopens the screen pre-checked with the stored choice. One
  installation is never a screen — there is nothing to choose, whatever was asked.
- **The completion route is the one auth route that answers JSON instead of redirecting.** The
  callback is a top-level navigation, so its failures carry `?auth_error=`; the completion route is
  reached by the onboarding page's `fetch`, which would swallow a 302 — so it answers
  `401 NO_PENDING` / `400 BAD_SELECTION` / `400 REPOS_UNAVAILABLE` / `400 UNKNOWN_REPO` as JSON,
  with the pending row left alive on every refusal so the same screen can re-post.
- **`POST /api/auth/org` is the selector's write.** It verifies membership, moves the session row's
  org, and answers `{organization}`; unknown org is `400 UNKNOWN_ORG`, a known org the caller
  cannot see is `403 FORBIDDEN`, and an anonymous caller is `401`.
- **Failures redirect with `?auth_error=`; they do not return JSON.** The callback is reached by a
  top-level browser navigation, and a `403 {"error":…}` body is a dead end for the human in front of
  it. The reasons are `denied`, `state`, `github` (the exchange failed), `install` (nobody can be
  sent to the install page) and `install_cancelled`; "your login failed" and "you have no
  installation here" send the reader to completely different places.
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
  phishing vector; as an environment variable it is a test seam that `main.ts` logs loudly when it
  is in use. Only the e2e harness sets them — `playwright.config.ts`, pointing the flow at
  `e2e/stub-idp.mjs`.
- **`auth.public_url` is required once `HOST` is not loopback.** The `redirect_uri` must be absolute
  and must never be derived from the request's `Host` header — that lets the caller choose the
  redirect target. `http://0.0.0.0:8080` is not somewhere a browser is ever sent back to, so guessing
  is worse than refusing.
- **An OAuth App for sign-in, and a SEPARATE GitHub App for repo-read.** Two registrations to set
  up, deliberately. This file used to say "an OAuth App, not a GitHub App"; that was about not
  conflating the two credentials, and the conclusion still holds now that both exist. Signing
  somebody in asks exactly one scope — `read:org`, because listing installations IS the membership
  decision — and reads only the numeric id, the login and that installation list; it reads no
  repository data. Reading repositories needs installation permissions and is nothing to do with
  the person in front of the browser — one credential doing both would mean every sign-in grants
  repository access, and would tie the dashboard's ability to fetch to whoever happened to log in
  last. See [configuration.md](configuration.md) for the App credential.

## Access tokens

`Authorization: Bearer fat_…` (personal) or `Bearer oat_…` (organization) — minted from the settings
page, shown once, only the sha-256 stored, revoked from the same page. The credential for callers
that cannot hold a cookie; the CLI (#21) is why the personal kind exists.

- **A personal token acts as its user, through the same join a session uses — in the org it was
  minted for.** The row carries `org_id`, the lookup is by the globally-unique hash, and the org
  comes back FROM the row: the token acts in its mint org and nowhere else. The membership join
  gives the same immediacy as a session's: when sign-in propagation deletes the membership, the
  token dies on the spot (its row survives unrevoked, as history with no reach). That live
  re-resolution is what makes these mintable from the settings page — minting is still a
  credential-issuing act, so it belongs behind the session cookie
  and HTTPS on anything but a loopback deployment.
- **An org token is the ORG's credential, not its minter's — and its authority is bounded by the
  minter's live membership.** `findOrgToken` resolves the org from the row and no user — no person
  stands behind it, and the org it acts
  in comes from the row. What it does not share with a session or a personal token is independence
  from the
  minter: the lookup joins the creator's `org_membership`, so the token's reach ends exactly when
  a session's or a personal token's does — sign-in propagation deletes the membership, and the
  next request resolves nothing (the row survives unrevoked, history with no reach, the same
  contract the personal kind states). This file used to argue the opposite — that the token's
  authority was "never the continuing membership of whoever minted it", and that a departed
  member's org token outlives them; that was a hole, not a design, since any member could mint a
  credential that survived their own removal. The join is what makes mintability by any member
  defensible, and any current member can still revoke what remains from the same page.
- **`POST /api/jobs` keeps a real author.** A personal token carries its user's id through
  `callerOf` untouched, so `created_by` stays populated on the route that runs shell commands.
- **An organization token names no person, so it stays off every route that needs one.** What an
  `oat_` may reach is an allowlist (`ORG_TOKEN_ROUTES` in `plugin.ts`): the board reads, the repo
  list and the cache poke — routes that consult no `callerOf`. Everything else answers **403
  FORBIDDEN, not 401**: the token did authenticate, the route needs a human behind it. An allowlist,
  because a refusal list would silently admit every route added after it. And no synthetic user
  stands behind an org token — a fake `app_user` row would flow into membership joins, workspace
  paths and member lists as a person who does not exist.
- **Revocation keeps the row.** `revoked_at`, like every other revocation here. Sessions are the
  exception (logout deletes) because a dead session row is worthless; "what tokens existed" is
  history the list is there to show.
- **`last_used_at` is minute-granular, on purpose.** The touch is throttled to one rewrite a minute
  per token: an access token rides the dashboard's two-second poll, and a write on every read is
  exactly what the session's write-free read path exists to avoid. The list must not promise more
  than "used within the last minute".
- **The prefix is the compare-before-query.** `fat_`/`oat_` are dispatched on the string
  alone, before any database round trip — a garbage bearer costs a hash and a 401, not a query.
  A bearer on a session route IS the credential for that request: an unknown one is a 401, never a
  fall-through to the cookie behind it.
- **The settings page hides both sections under `AUTH_MODE=none`.** The mode ignores every
  credential, these included — a mint button for a token nothing will ever honour is a button that
  cannot work.

## Who needs which credential

| Route | Credential |
| --- | --- |
| `GET /api/health` | **open** — must answer while migrations retry, and the compose healthcheck carries none. Authenticating it restarts the container that was about to succeed. |
| `/api/auth/*` | open. `/me` answers `200 {authenticated: false}` on its own — being what *tells* the SPA it is unauthenticated is its purpose, and a 401 there would be logged as a console error by the browser of everybody who has not signed in yet. |
| the SPA's document and bundle | **open** — if `index.html` 401'd there would be nothing left to render a sign-in button in. The wall is on `/api/*`, never on the document. |
| `/api/stats`, `/api/refresh`, `POST /api/jobs`, `GET /api/jobs[/:id][/thread]`, `/api/jobs/:id/follow-up`, `/api/jobs/:id/done`, `/api/jobs/:id/stop`, `/api/jobs/:id/remove`, `/api/tokens` with its org and revoke variants | session cookie, or `Bearer fat_…` — an `oat_` bearer passes on this row's reads plus the `POST /api/refresh` cache poke, and is `403` on the rest (see [Access tokens](#access-tokens)) |
| `/api/jobs/claim`, `/heartbeat`, `/session`, `/output`, `/suspend`, `/complete`, `/gates`, `/gates-reread`, `/publish-token`, `/api/reclaims/claim`, `/api/reclaims/:id/ack` | `Bearer $JOB_BOARD_TOKEN` — the shared board secret |
| OTLP | optional `X-Factory-Ingest-Token` |
| `POST /api/sessions/branch` | github mode: the runner's attempt pair (`x-factory-job-id` + `x-factory-job-lease-token`) or `Bearer fat_…`; none mode: open. The deployment-wide ingest token does **not** authorize this write — see the ingest bullet below. |

- **There is no overlap between the three credential *kinds*, and a request carries one.** A session accepted on
  `/claim` would let any member steal another worker's lease; a worker token accepted on
  `POST /api/jobs` would produce a job with no author, silently breaking the audit trail on the
  route that runs shell commands. On the session routes the cookie and the access-token bearer are
  two *forms* of the same person/org credential, and only one is honoured: the bearer wins, because
  a CLI never sends a cookie and a browser never sends a bearer — when both arrive something between
  them is rewriting, and a failed or foreign bearer is a 401, never a fall-through to whoever the
  cookie names. `/api/jobs/:id/follow-up`, `/done`, `/stop` and
  `/remove` are *human* routes: a finished task is over, and stopping
  or deleting one is a person's verdict — which is exactly what makes adjusting, closing,
  stopping and removing one a person's action. The reclaim queue is the opposite shape: it hands
  the driver worktrees to delete, so its claim and ack take the board secret like the job claim and
  complete do.
- **`GET /api/jobs/:id/thread` is session-only, and an earlier exception for the worker token was
  removed.** The thread carries every job of the conversation — commands, output tails, session
  ids and authorship — so a worker token on that read let a driver process read the audit and
  session data of jobs it never held a lease on; a claim exposes only the currently claimed job,
  and the token's one legitimate use of the thread (deciding the task worktree reclaim, issue
  #47) now rides the lease-guarded `complete` response instead: the store computes
  `threadDone` in the same transaction as the verdict, and the driver reclaims on that. The
  task detail page keeps its session-cookie read, which was the read's original and remaining
  purpose.
- **The worker credential is one shared secret: `JOB_BOARD_TOKEN`, the same value in the board's
  and the driver's environment.** Compared constant-time against the board's configured value —
  no token row, no hash at rest, no CLI to mint one. There is deliberately no HTTP route and no
  database row for it: the credential answers for a process that claims work and reports results
  with no human anywhere, and that process is installed by the same operator who configures the
  board, so the secret travels the same channel every other deployment credential does — the
  environment (`.env` for compose, a Secret key for the chart). Required in `github` mode and
  fatal-at-boot when missing or short (the same 32-character floor the session and webhook secrets
  sit behind): a board that fails every claim with 401s the driver logs forever is the silent
  failure this replaces. Rotation is changing the value on both sides and restarting. (The claim
  route still mints a GitHub App installation token onto the claim env, but that token is bounded
  by the installation, scoped to GitHub, and dead within the hour — see [env.md](env.md). The
  board secret is the only credential that answers for the board itself.)
- **The secret is the deployment's driver credential, not an org binding.** The per-org
  `worker_token` rows this replaced made each driver's token name the one organization it claimed
  from; with one deployment-wide secret that scoping would be theater — the operator who holds the
  secret owns every org anyway. So a claim names no row and no org: it is offered **every**
  organization's queue, first board with work wins. Every other worker route (heartbeat, complete,
  output, gates, publish-token, the reclaim ack) carries the job or reclaim id in its URL, and the
  auth hook resolves the org from that row — the same direction the branch route resolves in, and
  routing rather than authorization, because the secret already answered the authorization
  question. An id that resolves to nothing is a 404, not an org.
- **The driver's whole share of this is one header.** `JOB_BOARD_TOKEN` in `driver/src/config.ts` and
  an `authorization` header in `board.ts`. It stays that way because that package depends on nothing
  — see `AGENTS.md`. The header is **omitted** rather than sent empty against an open board: an empty
  Bearer is a credential that failed, where no header is one that was never offered.
- **The ingest token is optional, and unset means today's behaviour — but the branch write left
  that world.** The optional token's callers are two now: a collector on the compose network, and
  the `agent-telemetry` plugin installed at user scope on developer laptops — which authenticates
  its branch reports with a **personal access token** (`Bearer fat_…`) instead, because the token
  that used to carry them is exactly what the finding (CWE-862) removed. A deployment-wide shared
  secret cannot bind a report to an organization: anyone holding it could name another
  installation's repository and poison that org's telemetry, so branch attribution now comes from
  an org-bound credential, never from a shared one. The third former caller, the branch reporter
  baked into both executor images, presents the **attempt it runs for** — the driver forwards
  `RUNNER_JOB_ID` + `RUNNER_LEASE_TOKEN` (the claim and that attempt's lease), the reporter sends
  them as `x-factory-job-id` + `x-factory-job-lease-token`, and one org-less query (`select org_id
  from job where id = $1 and lease_token = $2 and ((finished_at is not null and finished_at > now()
  - interval '1 hour') or (finished_at is null and lease_expires_at > now()))`) resolves the org
  from the attempt itself: a finished job keeps the pair alive for a tail-sample grace, an
  unfinished one only while its lease is live — a run that died with an expired lease and no
  reclaim takes its captured pair with it. The pair is attempt-scoped
  without a status check: `complete()` retains the lease token so the reporter's final `--once`
  sample — landing after the verdict — still authenticates, while a reclaim rotates the token, so a
  superseded attempt's pair is dead and cannot write into the winner's org; suspend and the dead
  retirement clear it, because those attempts end without a verdict whose tail matters. The hour of
  retention grace is what keeps that honest: the pair resolves from the job row alone — no
  membership join, because the runner is not a person — so a pair captured from a runner's env
  could otherwise outlive its author's removal from the org forever (nothing prunes completed
  jobs). The tail sample needs seconds; the captured credential expires like every other
  credential here. An `oat_` bearer is refused on the branch
  route as everywhere off the read allowlist — `orgTokenAllowed` is read-only, and this is a
  write. Header only, never a query parameter, which would land in every access log. Honest
  limitation: `metric_point` has no `org_id` by design (`docs/organizations.md`), so the OTLP
  token remains an *authenticity* check, not an authorization one — the branch route no longer
  has that problem, which is the point. A second, deliberate one: the runner's pair crosses the
  board hop in whatever scheme `JOB_BOARD_URL`/`FACTORY_STATS_URL` names, and the supported
  topologies (compose, the chart) name plain http on a service network. Encrypting that hop is an
  operator upgrade (a TLS-terminating ingress in front of the board), not something the reporters
  can decide per request — the pair is attempt-scoped, dies with the lease or an hour past the
  verdict, and its only power is branch samples inside its own org, which is what makes that
  trade-off a documented contract rather than a hole.

## What this does not do

- **Membership is not a sandbox.** The board's READS stay open to every member of an installation
  — `GET /api/jobs` and the thread are the org's audit trail, and `job.created_by` records who did
  rather than limiting what they may do — and any member can queue a command that an agent runs
  against *their own* checkouts. GitHub repo permissions are NOT projected into Factory (the
  per-user repo scoping of #66 retired with the auto-join it was built on): any member of an
  installation sees every repo it reports. This still does not make the job board safe to hand out.
- **A GitHub-side removal bites when GitHub reports it, or one sign-in late.** The webhook deletes
  the membership the moment `organization.member_removed` arrives — see Membership — so for
  organization installations the window is bounded by GitHub's own delivery. What is left: a
  delivery missed while the board was down, and user-account installations, whose org events do
  not fire — those fall back to the sign-in sweep, so a member who never signs in again holds a
  working session until its TTL expires.
- **Signing in now has a side effect on disk.** `ensureUserWorkspace` creates
  `<root>/<orgId>/<userId>/` in the callback — a `mkdir`, nothing more. It cannot block the sign-in:
  a failure logs, and `GET /api/workspace` calls the same function, so a session that got in without
  one recovers on its first visit to the page. See [workspace.md](workspace.md).
- **`job.created_by` has three readers now, and one still to come.** `POST /api/jobs/claim` turns it
  into `workspacePath`, which is how a driver finds the author's checkouts without ever touching the
  database. The task UI and the telemetry read resolve it (and the stop/done/removal actors) to
  `app_user` labels at read time — attribution display is the second reader, the per-session
  `byUser` join the third. The per-user Claude credential is the half that has not arrived, and
  `userId` is still reported on the claim for it.
