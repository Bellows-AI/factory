# Organizations

Read before: touching `org_id` anywhere, `server/migrations/005_organizations.sql`,
or the org selector in the topbar.

An **organization owns the repo list and partitions every stored row.** The organizations are the
GitHub App's installations (#99): one installation = one organization, its id the installation id
(a decimal string), its name the installation account's login. Sign-in materializes the ones the
signing-in account **chose** (#125) — `GET /user/installations` is the org list a first sign-in
with two or more must narrow on the selection screen, and the chosen ones are upserted into
`organization` together with a membership for the signing-in account. The membership rows are the
stored choice: the next sign-in reuses it without re-prompting, and a member of an enterprise who
never opted into an installation costs the deployment no row, no runtime and no warmed cache —
`warmAll()` warms only what sign-in materialized. `meta.organization.mode` is `'directory'` in
github mode and `'config'` under AUTH_MODE=none, which keeps the single local org named by
`LOCAL_ORG_ID` and the selector disabled.

**The org is a property of the caller, not of the process.** A session carries its org in its row,
a personal token in its own — and every request re-checks it through the
`org_membership` join, so a GitHub-side removal at the next sign-in ends every credential's reach
immediately (see [auth.md](auth.md)). The driver holds no org-bound credential at all: the shared
board secret authenticates the process, and the org a worker call operates on comes from the job
row it names.

- **The id is the installation id.** Stable across account renames, unique, zero config, and it
  passes the `organization_id_ck` the 010 check constraint still enforces (`^[a-z0-9][a-z0-9_-]{0,38}$`).
  The *name* is derived for free on every sign-in, because nothing keys on a label — signIn's
  upsert rewrites it whenever GitHub reports a rename.
- **`ORG_ID`/`ORG_NAME` are fatal, not ignored**, in the same register as `ORG_REPOS`: a variable
  that was meaningful and is now dropped must not silently no-op.
- **`GITHUB_REPOS` and `ORG_REPOS` are fatal, not ignored.** The one deliberate exception to "an
  unknown environment variable is ignored", and for exactly the reason that rule is stated: a
  variable that *was* meaningful and is now dropped reverts a two-repo dashboard to one repo and
  still renders, indistinguishable from a repo genuinely removed.
- **One installation = one organization, and that IS the boundary.** The old "a Factory
  organization is not a GitHub organization" is superseded as a *boundary* statement: the
  installation is the boundary now. What survives of the old rule is the *roster* distinction — an
  org is not GitHub's member list beyond what sign-in reports; repo permissions are not projected
  into Factory (per-user repo scoping retired with auto-join).
- **`org_id` leads every org-owned primary key.** `005` partitioned ten tables; 023 dropped the PR
  tables that made up the rest, leaving `session_branch` the only one that ever needs a direct
  org_id rewrite rather than a cascade (see [persistence.md](persistence.md)). The id leads rather
  than trails because a query always knows its organization, so the key is a prefix scan of the
  partition rather than a filter applied afterwards.
- **`metric_point` has no `org_id`, on purpose.** It has no `repo` either, for the reason stated in
  `001_init.sql`: a datapoint's repo is resolved by joining `session_branch`, so there is one source
  of truth rather than two that disagree. Its organization comes through that same join.
- **Ingest attribution is the credential's, not the report's.** A branch report carries a repo,
  never an org — the reporter holds no session — so the org used to be guessed by matching the
  repo's owner against the installation orgs' account logins. That was a cross-tenant write
  (CWE-862): the `repo` field is caller-controlled payload, and a report naming another
  organization's repository poisoned that org's telemetry. The route now records with the org of
  the credential verified at the ingest boundary — the runner's job-id + lease-token pair (the
  live attempt's own org) or the laptop plugin's personal token (the membership's org) — and the
  repo is just data. `__unclaimed__` survives only for rows written before credentials existed
  (legal since 005, invisible on dashboards, visible in SQL).
- **`session_branch_slice` partitions its `lead()` window by `org_id`, not merely projects it.**
  Otherwise the clamp runs across organizations and one org's slice is truncated by another's start,
  silently dropping the datapoints in between. Guarded by "does not attribute one organization's
  session to another's branch".
- **There is still no `OrgProvider` interface.** `TokenProvider` is the tempting precedent, but it
  earned its interface the hard way: it was async before its second implementation existed, on a bet
  that swapping a personal access token for a GitHub App would touch no call site — and the bet
  paid. #99 changed `resolveOrg`'s body (it now answers "is this caller a member" — unknown org
  400 `UNKNOWN_ORG`, known-but-not-yours 403) and left it one function. The per-org *runtimes*
  (repo source, telemetry, stats cache, stores) live in `server/src/orgs.ts`, a registry keyed by
  org id — construction per org, cached, because an org id is an installation id and is never
  re-pointed. Do not turn either into a provider for symmetry.
- **`app_user` and `session` are NOT org-owned; `org_membership` is** — with one deliberate
  exception since 028: `session` *carries* an `org_id` (nullable). Sessions stay global rows — one
  human, one id, and a uuid that is safe as a docker volume name component (see 010) — but the row
  names the org it was created in, because the org decides what every read returns. `POST
  /api/auth/org` moves it, guarded by the membership.
- **Most stores still bind `orgId` at construction**; the org registry builds them per org and
  caches. **`createAuthStore` remains the exception** and takes the organization per call, because
  it is what *decides* whether a caller belongs to one — the one store whose lookups cannot start
  from an organization, since a session row is what reports which one a caller is working in.
