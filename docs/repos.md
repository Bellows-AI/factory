# The repo list

Read before: touching `repo-source.ts`, `db/stored-repos.ts`, `server/src/orgs.ts`, or
any per-repo rendering in the SPA.

The dashboard reports **every repo the GitHub App installation reports as one set of figures**.
Per-repo pages are not built yet; when they are, they filter `meta.repos` and the `repo` field on
each session rather than refetching.

- **The repo list is what the App installation reports, intersected with the org's tracked-repo
  allowlist (`repos.snapshotNames()`), and there is no separate telemetry repo setting.** The
  allowlist is `tracked_repo` (030) — the onboarding screen's per-org checkbox answer (#125) — and
  its empty state means every reported repo: the default, which is why the screen's all-checked
  confirm writes nothing. The intersection happens inside `RepoSource`, so stats scoping,
  `otherRepoSessions` and the workspace/env writes all follow one truth. A second list would be a
  second source of truth that silently drops sessions the moment it drifts. The list changes under
  the process — somebody grants the App another repository and it appears without a restart, on the
  10-minute TTL in [metrics.md](metrics.md) — which is why it is a function over a snapshot rather
  than a bound array.
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
  installation, or a plugin that stopped reporting, read as an idle week. Since #125 the same holds
  for an unselected repo — a repo the installation reports but the org's allowlist does not name
  counts in `otherRepoSessions`, never vanishes: the honest bucket is where a narrowed choice's
  remainder lives.
- **The hook stamps `owner/name` — the same form the list carries.** That is the whole reason the
  comparison is a string inclusion and not a lookup: there are no ids to join on, so the one
  spelling of a repo name is a contract between the plugin, the branch reporter and the
  installation listing.
- **`meta.repos` travels in the payload, not behind a second request.** A page that cannot name the
  repos the figures were computed over cannot be read honestly.

## The settings page (issue 181)

Settings → Repositories is the one place that answers everything about repositories:
availability, personal checkout selection, checkout status, search, and the repository-wide
environment of one repository — together, on one page.

- **Selection and status live there now, not on Workspace.** The whole-selection draft seeds from
  the shared workspace poll, saves as a full replacement (`PUT /api/workspace/repos`, `202`), and
  adopts the draft as its baseline only on success — a failure keeps both the draft and the
  last-good statuses. The old Select-repositories modal is deleted; there is no second selection
  surface to drift.
- **A selected repository GitHub stops reporting cannot be silently dropped.** It stays listed
  under "No longer reported by GitHub", deselectable but not newly selectable, and it blocks the
  whole-list save until removed — the PUT is a full replacement, so saving past it would erase the
  selection. The same whole-replacement logic is why the save also stays blocked until both the
  installation list and the workspace poll have answered: an empty draft from an unanswered poll is
  not a deselection.
- **The 20-repository ceiling is the server's `MAX_REPOS_PER_USER`, mirrored in the UI**
  (`web/src/components/repository-setup.ts`). The server remains the authority; the mirrored number
  only lets a row disable before a doomed request is built.
- **Per-repo env is member-editable.** The page's old `disabled={!isAdmin}` gate was web-only
  decoration over routes that accept any installation member (`routes/env.ts` — see
  [env.md](env.md)); it is gone. Configuration opens on the page via a row's Configure action and
  does not require personal checkout enablement.

## Per-org, not per-user

The list is per organization — one App installation's answer, cached per org by the runtime
registry (`server/src/orgs.ts`). Per-user repo scoping (#66) retired with the auto-join it was
built on: #99 settled that GitHub repo permissions are NOT projected into Factory, and installation
access is the boundary — any member of an installation sees every repo it reports. What survives of
the scoping machinery:

- **`meta.telemetry.repoFilter` is gone with it.** `otherRepoSessions` counts only sessions on
  repos outside the installation now, and `meta.repos` is the org's full list — the figures a page
  renders are interpretable exactly when the list that produced them is named.
- **`PUT /api/workspace/repos` and the per-repo env write validate against the tracked list** —
  the installation report intersected with the org's allowlist (#125) — refusing unknown names
  with `400 UNKNOWN_REPO`. The clone rides the installation's token, so a repo outside it is one
  the deployment has no business fetching; an untracked one is one the org chose not to follow.
  There is no `403 REPO_NOT_ACCESSIBLE` any more: within an installation, every member may reach
  everything the org tracks. `POST /api/jobs` validates the repo field's format only — the job's
  repo is a label its telemetry is filed under, not a fetch target.
- **`GET /api/env`'s repo scope is unfiltered** — every member of the installation may read and
  write the per-repo env config, exactly as they may the org-wide one.
