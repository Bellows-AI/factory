# Security posture

Read before: changing a bind address, a header, a GitHub App permission, or any `OTEL_LOG_*`
setting.

**There are two postures, and `AUTH_MODE` picks between them explicitly.** With `AUTH_MODE=github`
every `/api/*` route requires a credential — a session cookie for people, a `Bearer fwt_…` worker
token for the driver. With `AUTH_MODE=none`, the default, there is no application-level auth at all
and the `127.0.0.1` bind is the access control, exactly as it always was; `loadConfig` refuses that
mode on a non-loopback `HOST` unless `AUTH_ALLOW_PUBLIC_BIND=1` says something else is doing the
authenticating. See [auth.md](auth.md). CSP and `X-Content-Type-Options` / `Referrer-Policy` are set
as response headers in `app.ts` (a `meta` tag would not let dev allow the Vite HMR websocket).

**The SPA's own document is served unauthenticated on purpose, in both modes.** If `index.html`
answered 401 there would be nothing left to render a sign-in button in. The wall is on `/api/*`.

**Authentication is not a sandbox.** Signing in narrows "anyone who can reach the port" to "any
member of this organization"; it does not make any route safe to hand out. See the job board below.

**Two GitHub registrations, on purpose.** An OAuth App signs people in and requests *zero* scopes;
a separate GitHub App reads repositories. One credential doing both would mean every person who
signs in grants repository access, which is exactly the conflation `docs/auth.md` warns about.

Required GitHub App installation permissions: `Metadata: read`, `Pull requests: read`, and
`Contents: read` (revert rate only). An operator who wants runners to orchestrate GitHub — commits,
PRs, reading CI — grants more in the installation settings (`Contents: write`, `Pull requests:
write`, `Actions: read`): the token minted onto each claim (see [env.md](env.md)) carries the
installation's permissions, and code cannot grant what the installation does not have.

**The App private key is the worst secret in this repository to leak, and it replaced the least
bad.** A PAT carries whatever scopes it was issued with, can be revoked from a list, and expires; a
private key mints installation tokens indefinitely, and rotating it means generating a new key in
GitHub's UI and redeploying. It may sit inline in `.env` — gitignored and dockerignored —
or in a `.pem` that `GITHUB_APP_PRIVATE_KEY_FILE` points at. `chmod 600` either: the boot warning
about a group/world-readable mode is not decorative, because no application-level auth plus a
readable key is worse than either alone. The same care covers `GITHUB_OAUTH_CLIENT_SECRET`,
`SESSION_SECRET` and `INGEST_TOKEN` — a `.env` holding only a session secret is exactly as bad
to leak as one holding the key.

**What the App improved:** the credential that reaches `git` is now an *installation token* that
expires in an hour, rather than a long-lived PAT. A leaked one is a bounded problem, and it is
minted fresh per clone precisely because a batch can outlive one.

`SESSION_SECRET` signs the session cookie, so rotating it logs everyone out — which is the only
lever there is when something has leaked. Session rows hold the sha-256 of a token, never the token,
because the table would otherwise be a list of every live credential.

With `ORG_WORKSPACE_ROOT` set, that installation token is also used to clone private source onto the
host, and that source then sits in a plain directory. It is passed to `git` through the child
environment and never on a command line or into `.git/config` — see [workspace.md](workspace.md) for
why that distinction is load-bearing.

**Checkouts are per member, and the isolation is a path.** Each person's clones live under their own
`app_user.id`, and a runner is given `WORKDIR=<mount>/<org>/<user id>` — never `<mount>` or
`<mount>/<org>`, both of which are the *parent* of everybody's tree. A job whose author cannot be
resolved is failed rather than run somewhere broader, and the driver re-asserts the whole
`<org>/<uuid>` shape before interpolating it into a `docker run`. This is a boundary against
accident, not against a determined member: anyone who can queue a job can ask the agent to read any
path the container can see.

**Runner secrets are stored plaintext, and that is a stated tradeoff, not an oversight.** The env
vars and secrets an operator configures for runners (see [env.md](env.md)) must be RETRIEVED to be
injected, so hashing is impossible and encryption with a key that lives in the same `.env` is
theatre with extra steps — the App private key already ships that way. The honest statement: read
access to the database is equivalent to holding every runner credential. What the application does
promise is write-only at the API — every list read nulls a secret's value, admin included — so the
browser never holds one, and the claim never persists one onto the job row that every member can
read. The values do cross the board→driver hop in the claim JSON; that hop already carries the
worker token's authority and supports https, and under `AUTH_MODE=none` the whole board is open
anyway. The App's installation token rides that same hop, minted onto the claim env under
`GITHUB_TOKEN` (#28): it is the one-hour, installation-scoped credential this file already trusted
for clones, now handed to the runner by name — a leak of it expires within the hour, which is the
property that makes the App better than a PAT. On the driver they reach the container through a
0600 `--env-file` written around the
spawn — never through the driver process's own environment, where member-controlled names could
steer the docker CLI on the host — and an agent can always `printenv` inside its own container:
masking runner output would be decoration on top of a boundary that does not exist.

**The driver mounts `/var/run/docker.sock`, which is root on the host.** A process holding that
socket can start a container with the host filesystem mounted, so it is not "docker access", it is
uid 0. It once sat behind a compose profile so `docker compose up` could not start it by surprise;
it now starts with the stack by operator decision, which makes running this file on a shared host a
deliberate act — and the socket is still never given to the dashboard, whose port is
unauthenticated. Anything that can queue a job can already ask an agent to run commands; keeping
the socket one process away is what stops that from being trivially root.

**The job board is a different class of risk from every other route here.** `POST /api/jobs` queues
a shell command that a worker then runs against the organization's checkouts, with whatever
credentials that worker holds. Under `AUTH_MODE=none` the `127.0.0.1` bind is the only thing standing
between an unauthenticated request and remote code execution, and a driver running off-host removes
exactly that — so put authentication in front of the port *before* moving it, not after. Under
`AUTH_MODE=github` it is narrowed to **any member of the organization**, which is smaller and still
real: membership is not a sandbox, and `RUNNER_SKIP_PERMISSIONS` decides how much an agent may then
do. Queueing records `job.created_by`, so at least the request has a name against it. The claim side
takes a worker token rather than a session, because a member holding a lease is a member able to take
work away from the driver running it. See [jobs.md](jobs.md) and [auth.md](auth.md).

The telemetry ingest routes are unauthenticated unless `auth.ingest_token` is set, and the collector
listens on 4317/4318. Both are bound to `127.0.0.1` for the same reason as the dashboard. The token
is optional because the two callers are a collector on the compose network and a plugin installed on
developer laptops, and requiring it would break both with no migration path; it travels as
`X-Factory-Ingest-Token`, never as a query parameter, which would land in every access log. It is an
*authenticity* check rather than an authorization one: `metric_point` has no `org_id` by design, so a
shared token cannot bind an export to an organization either. **Keep
`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` and `OTEL_LOG_TOOL_DETAILS` off** — set
to `0` in `.claude/settings.json`. Enabling any of them puts prompt text and source code into the
database, and the attribute allowlist does not save you: that content arrives as the log record
*body*, not as an attribute.
