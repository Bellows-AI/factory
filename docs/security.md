# Security posture

Read before: changing a bind address, a header, a GitHub App permission, or any `OTEL_LOG_*`
setting.

**There are two postures, and `AUTH_MODE` picks between them explicitly.** With `AUTH_MODE=github`
every `/api/*` route requires a credential — a session cookie, or an access token (`fat_`/`oat_`,
hash-stored like the session) for a caller that cannot hold a cookie, and the shared
`JOB_BOARD_TOKEN` board secret for the driver. With `AUTH_MODE=none`, the default, there is no
application-level auth at all
and the `127.0.0.1` bind is the access control, exactly as it always was; `loadConfig` refuses that
mode on a non-loopback `HOST` unless `AUTH_ALLOW_PUBLIC_BIND=1` says something else is doing the
authenticating. See [auth.md](auth.md). CSP and `X-Content-Type-Options` / `Referrer-Policy` are set
as response headers in `app.ts` (a `meta` tag would not let dev allow the Vite HMR websocket).

**The SPA's own document is served unauthenticated on purpose, in both modes.** If `index.html`
answered 401 there would be nothing left to render a sign-in button in. The wall is on `/api/*`.

**Authentication is not a sandbox.** Signing in narrows "anyone who can reach the port" to "any
member of this organization"; it does not make any route safe to hand out. See the job board below.

**Two GitHub registrations, on purpose.** An OAuth App signs people in and requests one scope —
`read:org`, org-level only, no repository access; a separate GitHub App reads repositories. One
credential doing both would mean every person who
signs in grants repository access, which is exactly the conflation `docs/auth.md` warns about.

Required GitHub App installation permissions: `Metadata: read` (the repository list) and
`Contents: read` (cloning private source). An operator who wants runners to orchestrate GitHub —
commits, PRs, reading CI — grants more in the installation settings (`Contents: write`, `Pull
requests: write`, `Actions: read`): the token minted onto each claim (see [env.md](env.md)) carries
the installation's permissions, and code cannot grant what the installation does not have.

**The App private key is the worst secret in this repository to leak, and it replaced the least
bad.** A PAT carries whatever scopes it was issued with, can be revoked from a list, and expires; a
private key mints installation tokens indefinitely, and rotating it means generating a new key in
GitHub's UI and redeploying. It may sit inline in `.env` — gitignored and dockerignored —
or in a `.pem` that `GITHUB_APP_PRIVATE_KEY_FILE` points at. `chmod 600` either: the boot warning
about a group/world-readable mode is not decorative, because no application-level auth plus a
readable key is worse than either alone. The same care covers `GITHUB_OAUTH_CLIENT_SECRET`,
`SESSION_SECRET`, `INGEST_TOKEN` and `GITHUB_WEBHOOK_SECRET` — a `.env` holding only a session
secret is exactly as bad
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

**The webhook is the one route that authenticates itself.** `POST /api/github/webhook` is open to
the auth hook by design and verifies `x-hub-signature-256` over the RAW body itself — the signature
is the credential, and the route exists only when `GITHUB_WEBHOOK_SECRET` is configured. It is
GitHub's `organization.member_removed` endpoint (see [auth.md](auth.md)) and, since 036, also
ingests the four PR-family events — `pull_request`, `pull_request_review`,
`pull_request_review_comment`, `issue_comment` — which fold into or cancel a thread's durable PR
waits. Ingestion is write-bounded on the fields the delivery carries: no numeric installation id, no
string repo it can name, no positive PR number, or no `x-github-delivery` GUID (at most 64 bytes —
the dedupe key AND the column's bound) and the delivery is acknowledged and dropped without a store
call, and every fold is idempotent on that GUID — whatever GitHub retries, nothing can fold twice.
An event for an installation this board has no runtime for resolves cleanly to a no-op: the folding
never reaches another org's rows.

**Checkouts are per member, and the isolation is the mount itself.** Each person's clones live under
their own `app_user.id`, and every container the driver starts — runner, gate, worktree sync,
readout, publish step — mounts exactly that job's own `<orgId>/<userId>` subtree of the workspaces
volume, at its own path: `subPath` on the kubernetes volumeMount, `volume-subpath` on the docker
`--mount` (docker ≥ 26.1), target `<mount>/<org>/<user id>`. The boundary is the kernel's bind
mount, not a convention: an agent running arbitrary code inside the container cannot reach another
member's or another org's source, transcripts or session state, whatever the code attempts — the
rest of the volume is absent from its filesystem, and `WORKDIR=<mount>/<org>/<user id>` — never
`<mount>` or `<mount>/<org>`, both the *parent* of everybody's tree — is the mount root itself.
A job whose author cannot be resolved is failed rather than run somewhere broader, and the driver
re-asserts the whole `<org>/<uuid>` shape before interpolating it into an argv. A mount whose target
directory does not exist fails the container loudly — a pod stuck in creation, a `docker run` mount
error — and there is deliberately no fallback to a broader mount that would make a provisioning
regression invisible. The one stated exception is the dashboard process itself, which mounts the
whole volume read-write: it is the provisioning plane (it creates those member trees at sign-in) and
the org-level analysis plane (disk statistics and transcript aggregation walk every org's tree by
design). Within the member's own subtree the container runs as one shared uid 1000 — the accepted
residual [workspace.md](workspace.md) documents.

**Runner secrets are stored plaintext, and that is a stated tradeoff, not an oversight.** The env
vars and secrets an operator configures for runners (see [env.md](env.md)) must be RETRIEVED to be
injected, so hashing is impossible and encryption with a key that lives in the same `.env` is
theatre with extra steps — the App private key already ships that way. The honest statement: read
access to the database is equivalent to holding every runner credential. What the application does
promise is write-only at the API — every list read nulls a secret's value, admin included — so the
browser never holds one, and the claim never persists one onto the job row that every member can
read. The values do cross the board→driver hop in the claim JSON; that hop already carries the
board secret's authority and supports https, and under `AUTH_MODE=none` the whole board is open
anyway. The App's installation token rides that same hop, minted onto the claim env under
`GITHUB_TOKEN` (#28): it is the one-hour, installation-scoped credential this file already trusted
for clones, now handed to the runner by name — a leak of it expires within the hour, which is the
property that makes the App better than a PAT. On the driver they reach the container through a
0600 `--env-file` written around the
spawn — never through the driver process's own environment, where member-controlled names could
steer the docker CLI on the host — and an agent can always `printenv` inside its own container:
masking runner output would be decoration on top of a boundary that does not exist.

**The run artifacts never echo a claim env value, and the pins say so.** The full-run log and
agent transcript stored per attempt (issue #325, `docs/jobs.md`) are built from the runner's own
stdio and the volume transcript — the 0600 env file is written around the spawn, read by the
daemon, and removed at the close; no artifact read ever touches it. The driver suite pins this
where the bytes are made: the full log must be STRICTLY EQUAL to the runner's own stream (any
driver-side injection — an env value included — would break the equality), and the argv/script
pins assert no board-derived value ever travels in a script's text. The `printenv` boundary
above is unchanged — an agent can still print its own environment into its own log, which is
exactly why the constraint is on this driver's code, not on the runner's output.

**The driver mounts `/var/run/docker.sock`, which is root on the host.** A process holding that
socket can start a container with the host filesystem mounted, so it is not "docker access", it is
uid 0. It once sat behind a compose profile so `docker compose up` could not start it by surprise;
it now starts with the stack by operator decision, which makes running this file on a shared host a
deliberate act — and the socket is still never given to the dashboard, whose port is
unauthenticated. Anything that can queue a job can already ask an agent to run commands; keeping
the socket one process away is what stops that from being trivially root. Compose runs the driver
from the bind-mounted tree (#174), so the container's `.env` — App key, session secret — is also in
a uid-0 process environment; nothing new is reachable (the socket already was root), but the
.env-holding dashboard and the socket-holding driver are now one stack rather than two postures.

**The job board is a different class of risk from every other route here.** `POST /api/jobs` queues
a shell command that a worker then runs against the organization's checkouts, with whatever
credentials that worker holds. Under `AUTH_MODE=none` the `127.0.0.1` bind is the only thing standing
between an unauthenticated request and remote code execution, and a driver running off-host removes
exactly that — so put authentication in front of the port *before* moving it, not after. Under
`AUTH_MODE=github` it is narrowed to **any member of the organization**, which is smaller and still
real: membership is not a sandbox, and `RUNNER_SKIP_PERMISSIONS` decides how much an agent may then
do. Queueing records `job.created_by`, so at least the request has a name against it. The claim side
takes the board secret rather than a session, because a member holding a lease is a member able to take
work away from the driver running it. See [jobs.md](jobs.md) and [auth.md](auth.md).

The telemetry ingest routes are unauthenticated unless `auth.ingest_token` is set, and the collector
listens on 4317/4318. Both are bound to `127.0.0.1` for the same reason as the dashboard. The token
is optional because the two callers are a collector on the compose network and a plugin installed on
developer laptops, and requiring it would break both with no migration path; it travels as
`X-Factory-Ingest-Token`, never as a query parameter, which would land in every access log. It is an
*authenticity* check rather than an authorization one: `metric_point` has no `org_id` by design, so a
shared token cannot bind an export to an organization either. **`POST /api/sessions/branch` is the
one ingest write that outgrew that stance** — it records into `session_branch`, whose `org_id` is
real, and a shared token there would let any holder attribute sessions to any organization by
naming its repositories (CWE-862). In github mode it therefore demands an org-bound credential: the
runner's job-id + lease-token pair, or a member's personal token. The deployment-wide ingest token
deliberately does not open it. **Keep
`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` and `OTEL_LOG_TOOL_DETAILS` off** — set
to `0` in `.claude/settings.json`. Enabling any of them puts prompt text and source code into the
database, and the attribute allowlist does not save you: that content arrives as the log record
*body*, not as an attribute.

## The executor sandbox: what it is, and what it is not (#382)

Read before: changing a pod spec in `driver/src/k8s-*.ts`, a `docker run` argv in
`driver/src/docker*.ts`, the admission policy, or the runner NetworkPolicy.

**Everything an executor runs is untrusted code.** Not only the agent's own commands — the
repository's scripts, every gate, every block helper, and every image a `.bellows.yaml` declares as
a service. None of it was written by this project, and the boundary has to hold whether the code
inside is hostile or merely careless.

**What is enforced, on every pod and every container, with no switch to turn it off:**

| Control | Kubernetes | Docker |
| --- | --- | --- |
| No capabilities | `capabilities.drop: [ALL]` | `--cap-drop ALL` |
| No privilege escalation | `allowPrivilegeEscalation: false` | `--security-opt no-new-privileges` |
| Syscall filter | `seccompProfile: RuntimeDefault` (pod level) | the daemon's default profile, applied unless told otherwise |
| No cluster credential | `automountServiceAccountToken: false` | no socket, no credential |
| No host | no hostPath, no host namespaces, no host port | no bind mounts, no `--privileged` |

There is deliberately **no** `--seccomp` flag on the docker side: the daemon already applies its
default profile, which is what `RuntimeDefault` asks the kubelet for, and a flag restating it could
only ever be wrong.

On Kubernetes these are not merely *set* by the driver, they are **required by admission**
(`charts/factory/templates/driver-admission.yaml`). That distinction is the point: the policy
already forbade `privileged` and added capabilities, and a driver that silently stopped setting
`capabilities.drop` would have satisfied every one of those expressions. Forbidding a dangerous
shape and requiring a safe one are different controls.

### The declared-service opt-out

A `.bellows.yaml` service may say `unhardened: true`. It gives that container **the image's default
capability set and nothing else** — the escalation bit stays off, the seccomp profile stays on, the
pod still carries no ServiceAccount token and still cannot mount a host path. It exists because a
large share of stock images (`postgres`, `mysql`, `redis` with a data directory) have an entrypoint
that chowns its data directory as root before dropping down, and `drop: [ALL]` takes away the
`CHOWN`/`DAC_OVERRIDE`/`FOWNER` that needs.

**What it gives back is worth naming, not just bounding.** The image's default capability set
includes `CAP_NET_RAW` — raw socket access, on the network the runner and every other declared
service of that attempt share, and the capability `k8s-podfields.ts` cites as a reason for the drop
in the first place. No NetworkPolicy sees traffic forged that way. Grant the opt-out to the one
service whose entrypoint needs it, never to the whole fleet out of habit.

The opt-out is a **declaration in the repository**, visible in review, not a default and not a
cluster setting. The driver stamps `factory.unhardened: "true"` on exactly those pods so the
admission policy can tell a declared opt-out from a driver that quietly stopped hardening; the
label is not a boundary against the driver, which holds its own identity anyway.

### What the hardening does NOT do

**This is not kernel isolation and it is not VM isolation.** Every runner, gate, helper and service
shares one host kernel with every other pod on its node. Ordinary pod hardening gives agent code a
smaller share of that kernel; it does not give it a different one. A kernel privilege-escalation
bug is not mitigated by anything in the table above. If the threat model needs a kernel boundary,
that is a sandboxed runtime (gVisor, Kata, Firecracker) on a dedicated node group — a deployment
decision this chart does not make and does not pretend to.

Also, specifically:

- **There is no opt-out for a GATE image, only for a declared service.** A gate is the other place
  a repository names an image (`.bellows.yaml`'s `environment: image:`), and it gets the full
  hardening with no escape hatch: a gate command that reaches for `sudo`, or for any setuid binary,
  now fails. That asymmetry is deliberate — a gate runs the repository's own verification commands,
  which have no reason to need root, whereas a declared service runs a third-party image whose
  entrypoint the author did not write and cannot change. If a real gate turns out to need a
  capability, the answer is a narrower grant on that one gate, not a second blanket opt-out.
  (Block helpers are not in this category at all: a helper runs the EXECUTOR image with a script
  body, never an author-named image, so there is no third-party entrypoint to accommodate.)
- **No `readOnlyRootFilesystem`.** An agent run writes its caches, its `HOME` and its git worktree;
  a read-only root fails it on the first `npm install`. The workspace is the writable surface by
  design.
- **Same-member tasks share a workspace subtree.** See [workspace.md](workspace.md) — the mount is
  a member boundary, never a task boundary.
- **A NetworkPolicy cannot restrict HTTP routes.** It decides which pod may open a socket to which
  address and port, and nothing about what is then requested over it. Every endpoint a runner is
  allowed to reach must still authorize the caller itself: the board does (the job-id + lease-token
  pair), and the OTLP ingest does under `auth.ingest_token`.
- **The network controls are inert without an enforcing CNI**, and the chart cannot install one.
  See [kubernetes.md](kubernetes.md), "EKS prerequisites".
