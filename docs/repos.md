# The repo list

Read before: touching `repo-source.ts`, `db/stored-repos.ts`, `server/src/orgs.ts`, or
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
  repos the figures were computed over cannot be read honestly.

## Per-org, not per-user

The list is per organization — one App installation's answer, cached per org by the runtime
registry (`server/src/orgs.ts`). Per-user repo scoping (#66) retired with the auto-join it was
built on: #99 settled that GitHub repo permissions are NOT projected into Factory, and installation
access is the boundary — any member of an installation sees every repo it reports. What survives of
the scoping machinery:

- **`meta.telemetry.repoFilter` is gone with it.** `otherRepoSessions` counts only sessions on
  repos outside the installation now, and `meta.repos` is the org's full list — the figures a page
  renders are interpretable exactly when the list that produced them is named.
- **`POST /api/jobs` and `PUT /api/workspace/repos` validate against the installation list** (the
  clone rides the installation's token, so a repo outside it is one the deployment has no business
  fetching), and refuse unknown names with `400 UNKNOWN_REPO`. There is no `403
  REPO_NOT_ACCESSIBLE` any more: within an installation, every member may reach everything.
- **`GET /api/env`'s repo scope is unfiltered** — every member of the installation may read and
  write the per-repo env config, exactly as they may the org-wide one.
