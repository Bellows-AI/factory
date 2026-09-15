# The repo list

Read before: touching `repo-source.ts`, `db/stored-repos.ts`, the scoping in `telemetryStats()`, or
any per-repo rendering in the SPA.

The dashboard reports **every repo the GitHub App installation reports as one set of figures**.
Per-repo pages are not built yet; when they are, they filter `meta.repos` and the `repo` field on
each session rather than refetching.

- **The repo list is whatever the App installation reports (`repos.snapshotNames()`), and there is
  no separate telemetry repo setting.** A second list is a second source of truth that silently
  drops sessions the moment it drifts. The list changes under the process — somebody grants the App
  another repository and it appears without a restart, on the 10-minute TTL in
  [metrics.md](metrics.md) — which is why it is a function over a snapshot rather than a bound
  array.
- **The list is a network read, so it cannot be a config field.** `RepoSource` exposes two
  accessors because its two callers genuinely differ: `list()` may go to GitHub and is always
  awaited (the refresh path); `snapshot()` never blocks and is what `StatsService.current()` reads,
  because aggregating an already-fetched payload must not become a fetch. It returns the last known
  list, empty until something has loaded one.
- **Without an App client the list falls back to the distinct repos in `session_branch`.** The
  offline tooling's code-only `none` arm passes `storedRepoNames()` (`db/stored-repos.ts`) as the
  source. Without it a credential-less process would report no repos, and since every stored read
  is scoped by the repo list, a warm database would render as an empty dashboard — which is what
  `npm run seed` followed by `npm run verify:ui` is. The fallback is derived from the sessions
  already stored, so it cannot disagree with them.
- **Scoping is a three-way bucket, and only one of the buckets is "in".** `telemetryStats()` counts
  a session in its totals only when the hook tagged it with a repo in `repos`. A session tagged with
  a repo outside the list lands in `otherRepoSessions`; a session with telemetry but no hook report
  lands in `sessionsWithoutHook`. Dropping either silently would make a repo removed from the
  installation, or a plugin that stopped reporting, read as an idle week.
- **The hook stamps `owner/name` — the same form the list carries.** That is the whole reason the
  comparison is a string inclusion and not a lookup: there are no ids to join on, so the one
  spelling of a repo name is a contract between the plugin, the branch reporter and the
  installation listing.
- **`meta.repos` travels in the payload, not behind a second request.** A page that cannot name the
  repos the figures were scoped to cannot be read honestly, and the DataQuality panel needs the
  filter (`meta.telemetry.repoFilter`) to say what `otherRepoSessions` was excluded *by*.

## Per-user scoping

The list above is the installation's. What a MEMBER sees is the intersection of that list with what
their GitHub account can reach — computed only where scoping is active (a GitHub App installation
plus `auth.auto_join_github_org`; any deployment short of both is unscoped, and `AUTH_MODE=none` is
unscoped by construction because there is no client to enumerate with).

- **The computation uses the credential the server already holds, not the member's token.** At
  sign-in the server asks, with the installation token: the org's teams (cached org-wide, 10-minute
  TTL — same figure and same reasoning as the installation list), each team's repos (cached the
  same way), whether the member belongs to each team, and a DIRECT collaborator probe per
  not-yet-reachable repo (`?affiliation=direct` — team-reached repos are not re-probed). The union,
  intersected with the installation list, is stored per member (`user_repo_access`, one row, one
  `text[]`). No new OAuth scope, no user-access token, no consent screen change; the cost is a
  handful of rate-limit points per login against the installation's own quota — a minimum of
  5,000 requests/hour, scaling with the org's size (15,000 on Enterprise Cloud).
- **An empty set is a real answer; a missing row is no answer at all.** `user_repo_access` has no
  row for an account that has never been computed — that account is unscoped until their next
  sign-in, which is what keeps accounts that pre-date scoping working. An EMPTY array means GitHub
  grants this account nothing, and the dashboard shows exactly that. Consequence: an invited person
  who signs in before GitHub grants them anything sees an empty dashboard — fail-closed, because
  the alternative (empty ⇒ everything) would make the two states indistinguishable.
- **The stored set is intersected with the installation on every read.** A repo pulled from the App
  stops matching immediately, without waiting for the member's next sign-in; a repo granted to the
  member's team in GitHub appears at their next sign-in, which recomputes their set. (The roster
  sweep maintains membership rows only — it never recomputes repo sets.) A GitHub failure during a
  recompute logs and leaves the last computed set standing — the store is only ever written on a
  successful enumeration, so the set is last-known-truth, never half of one.
- **Every consumer of the repo list scopes.** `/api/repos` (the picker), `/api/stats` (`meta.repos`
  and `repoFilter` reflect the caller's subset, and the figures are recomputed for it — the shared
  cache stays org-wide, exactly like the date range), `POST /api/jobs` (`403 REPO_NOT_ACCESSIBLE`
  outside the set — hiding the picker while the API accepted the name would make honesty depend on
  the SPA's politeness), `PUT /api/workspace/repos` (the clone must not widen what the stats
  scoped), and `GET /api/env` (the repo-scope env list is filtered to the caller's set — the names
  alone reveal that a repo exists and is configured). Board reads stay open: the jobs list is the
  org's audit trail. An organization token names no person and is never scoped.
- **`otherRepoSessions` reads differently under scoping.** Sessions on repos the CALLER cannot
  reach land there, beside the sessions on repos outside the installation. That is the honest
  description of what was excluded and why — fixing it would mean per-user telemetry reads and a
  lost shared cache.
