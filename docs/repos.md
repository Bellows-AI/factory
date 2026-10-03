# The repo list

Which repositories an organization sees, where that list comes from, and what it scopes.

| Concern | Code | Test |
| --- | --- | --- |
| The list itself: fetch, cache, `list()` / `snapshot()` | `server/src/github/repo-source.ts` | `server/test/repo-source.test.ts` |
| Installation listing | `server/src/github/app-client.ts` | `server/test/github.app-client.test.ts` |
| Per-org tracked-repo allowlist (`tracked_repo`, 030) | `server/src/db/tracked-repos.ts` | `server/test/repo-source.test.ts` |
| Credential-less fallback to `session_branch` | `server/src/db/stored-repos.ts` | `server/test/routes.repos.test.ts` |
| Picker route | `server/src/routes/repos.ts` | `server/test/routes.repos.test.ts` |
| Personal checkout selection and the 20-repo cap | `server/src/routes/workspace.ts` (`MAX_REPOS_PER_USER`) | `server/test/routes.workspace.test.ts` |
| Settings → Repositories page | `web/src/pages/SettingsRepositoriesPage.tsx`, `web/src/components/repository-setup.ts` | `web/test/repository-setup.test.ts`, `web/test/repository-setup.render.test.tsx` |
| Scoping of stored reads | `server/src/stats-service.ts`, `core/src/telemetry.ts` | `core/test/telemetry.stats.test.ts` |

## Invariants

- **One list, no second roster.** The installation's report intersected with the org's
  `tracked_repo` allowlist, computed inside `RepoSource` (`snapshotNames()`), is what scopes stats,
  `otherRepoSessions`, the picker, and the env and workspace repo validation. An empty allowlist
  means every reported repo, which is why the onboarding screen's all-checked confirm writes
  nothing. `server/test/repo-source.test.ts`.
- **It is a network read, so it cannot be a config field** — it changes under the running process
  on the `RepoSource` TTL. `snapshot()` never blocks, because `StatsService.current()` aggregates
  an already-fetched payload and must not become a fetch.
- **Without an App client the source is `storedRepoNames()`** — the distinct repos already in
  `session_branch`. Every stored read is scoped by the repo list, so without the fallback a seeded
  database renders empty, which is exactly `npm run seed` followed by `npm run verify:ui`.
- **Scoping is three buckets and only one is "in".** A session on a repo outside the tracked list
  lands in `otherRepoSessions`, one with telemetry but no hook report in `sessionsWithoutHook`.
  Silent drops would make a repo leaving the installation read as an idle week.
  `core/test/telemetry.stats.test.ts`.
- **`owner/name` is the one spelling**, shared by the plugin, the branch reporter and the
  installation listing: the comparison is string inclusion, there are no ids to join on. It travels
  in the `/api/stats` payload as `meta.repos`, not behind a second request.
- **Installation access is the whole boundary.** Any member sees every repo the org tracks; GitHub
  repo permissions are not projected into Factory ([organizations.md](organizations.md)). Writes
  that touch a checkout validate the name against the tracked list (`400 UNKNOWN_REPO`);
  `POST /api/jobs` validates shape only, because its `repo` is an audit label, not a fetch target.
- **`PUT /api/workspace/repos` is a whole-selection replacement**, so the page blocks the save
  until both the installation list and the workspace poll have answered, and a selected repo
  GitHub stopped reporting stays listed and deselect-only. `web/test/repository-setup.test.ts`.
