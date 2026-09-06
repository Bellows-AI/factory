# API

Read before: adding or changing a route, a status code, or a query parameter.

Every `/api/*` route needs a credential under `AUTH_MODE=github`, and none under `AUTH_MODE=none`.
Which one each takes is in the table in [auth.md](auth.md); the exemptions worth knowing here are
`GET /api/health` and `/api/auth/*`, and the fact that the SPA's own document is never gated. An
unauthenticated `/api/*` request is `401 UNAUTHENTICATED`.

| Route | Behaviour |
| --- | --- |
| `GET /api/auth/github` | `302` to GitHub, setting a signed, single-use state cookie. `?returnTo=` is validated as a same-origin absolute path; anything else becomes `/`. |
| `GET /api/auth/github/callback` | `302` on every outcome, never JSON — it is reached by a top-level navigation, and an error body is a dead end for the human in front of it. Failures carry `?auth_error=denied\|state\|github\|no_membership`. |
| `POST /api/auth/logout` | `204`, including for a caller who was never signed in. POST because a GET logout is CSRF-able and gets fired by link prefetchers. |
| `GET /api/auth/me` | `200 { user, role, organization, mode }` or `401 UNAUTHENTICATED`. Deliberately exempt from the wall: being what *tells* the SPA it is unauthenticated is its whole purpose. |
| `GET /api/health` | Never calls GitHub or the database. A container whose migrations are still retrying is up and answering, so probing either here would fail the compose healthcheck and restart the container that was about to succeed. |
| `GET /api/stats` | `200` with `{ stats, telemetry, meta }`; `202` with progress while a cold fetch runs (SPA polls every 2s); `503` only if the first PR fetch failed **and** nothing is persisted. A cold boot with a warm database is a 200 because the seed landed — but both other codes stay reachable and deleting either is a regression. `telemetry` is `null` when unavailable, and `meta.persistence` degrades in three states (`ok` / `migrating` / `unavailable` — there is no `off`); neither is ever a reason for a non-200. `?range=day\|week\|2w\|month\|all\|custom` (default `all`), plus `?from=&to=` for `custom`; `400 BAD_RANGE` on anything unparseable, never a silent fallback to all time. `?org=` is accepted and `400 UNKNOWN_ORG` on a mismatch — see below. |
| `POST /api/refresh` | `202`. Single-flight. Refreshes both caches. |
| `POST /api/otlp/v1/metrics` | `200 {"partialSuccess":{}}`. 1 MB limit, JSON only. Registered only when a store exists. |
| `POST /api/otlp/v1/logs` | `200`. Accepted and dropped — see M6 in the plan. |
| `POST /api/sessions/branch` | `202`. `400` on a malformed body, never 5xx. |
| `POST /api/jobs` | `201 { id, status }`. `400 BAD_COMMAND` on a missing, empty or over-16-KiB command. Optional `repo` (`owner/name`, both segments path-segment-safe, ≤100 characters each — `400 BAD_REPO`) and `executor` (path-segment-safe — `400 BAD_EXECUTOR`) are the tasks chat's grouping metadata: validated by shape only and **never** against the member's `user_repo` / `user_executor` rows, and neither changes what a worker runs — see [jobs.md](jobs.md). Records `created_by` from the authenticated caller, **never from the body** — a client-supplied author is impersonation on the audit trail of a route that runs shell commands. |
| `POST /api/jobs/claim` | `200 { id, command, attempts, leaseToken, leaseExpiresAt, userId, workspacePath, resumeSessionId }`, or **`204`** when nothing is waiting — an idle poll is the common case and must be recognisable without parsing a body. `resumeSessionId` is non-null only when the claim is picking a parked job back up, and the worker restores that session instead of starting one. `userId` is the account that queued the job, or null for one queued before accounts existed; it is still shipped ahead of its remaining consumer, the per-user Claude credential. `workspacePath` is the author's checkout directory **relative to the workspace root** (`<orgId>/<userId>`), or null when the job has no author or the board has no workspace root — the driver **fails** such a job rather than falling back, because every broader path is the parent of somebody else's tree. `400 BAD_WORKER` / `BAD_LEASE`. |
| `POST /api/jobs/:id/heartbeat` | `200 { leaseExpiresAt }`. **`409 LEASE_LOST`** once the lease has been reclaimed — the driver kills the container on this, and it is the only signal a superseded worker gets. `404` unknown, `400 BAD_ID` / `BAD_TOKEN`. |
| `POST /api/jobs/:id/session` | `200 { id, sessionId, remoteSessionId }`. Records the agent session the running attempt is using. Called **twice** per Remote Control attempt: `sessionId` (a uuid) is known at spawn, `remoteSessionId` (`cse_…`, optional, opaque, ≤256 chars) only once the bridge connects. A null `remoteSessionId` never clears one already stored. Lease-guarded: `409 LEASE_LOST`, `404`, `400 BAD_ID` / `BAD_TOKEN` / `BAD_SESSION_ID` / `BAD_REMOTE_SESSION_ID`. Separate from `complete` because the link is worth most while the job is still running. |
| `POST /api/jobs/:id/suspend` | `200 { id, status: 'standby' }`. Parks a running job: the container is gone, but it is not finished, it keeps its `sessionId`, and it hands back the attempt the claim took. `409 LEASE_LOST`, `404`, `400 BAD_ID` / `BAD_TOKEN`. |
| `POST /api/jobs/:id/resume` | `200 { id, status: 'queued' }`. **Takes no lease token** — nobody holds a parked job, which is what makes this callable by a person. `409 NOT_STANDBY` for a job that exists but is not parked, `404` unknown, `400 BAD_ID`. |
| `POST /api/jobs/:id/complete` | `200`. `409 LEASE_LOST` for a report from a worker that no longer holds the job; refused, never merged. `404` unknown; `400` on a status outside `succeeded\|failed`. `output` is truncated to 64 KiB server side. |
| `GET /api/jobs/:id` | `200` the job, `404` otherwise. `createdBy` names the account that queued it, or null. `repo` and `executor` carry the labels the task was queued with, or null for one queued before the tasks chat. `sessionId` and `remoteSessionId` are null until the driver reports them, and again from the moment the job is re-claimed for a *new* attempt — both survive a park and resume. `remoteSessionId` stays null for every headless job. |
| `GET /api/jobs` | `200 { jobs }`. `?status=&limit=&repo=` (default limit 50, cap 200). `?repo=` is an exact match under the same `BAD_REPO` rules as create; jobs queued before the column existed have `repo: null` and appear only in unfiltered lists. `output` is omitted from the list projection — it is unbounded and no list view shows it. |
| `GET /api/repos` | `200 { repos, installation, meta }` — every repository the GitHub App installation can see, for the picker. A failed refresh is **still a 200**, carrying the last good list and a named `meta.error`, for the reason `/api/stats` serves a stale cache: an empty picker and an unreachable GitHub look identical otherwise, and only one of them is somebody's fault. An empty list with no error is its own state — the App is installed nowhere — and the SPA renders a different sentence for it. |
| `GET /api/workspace` | `200 { root, repos, orphaned, executors }`. Provisions the caller's directory if it does not exist, which is idempotent and covers `AUTH_MODE=none` (whose caller never passes through the OAuth callback) and any session predating the deploy. With no workspace root configured it answers `200 { root: null, repos: [], executors: [] }` — **not** a 503: that is a configuration somebody chose, and the page says so rather than showing an error. Each repo carries `status`, `error`, and the on-disk `branch` / `lastCommit` / `sizeBytes`, all of which are `null` until measured and never `0`. `orphaned` lists deselected repositories whose checkouts are still on disk, because nothing prunes. Each executor carries `name`, `type` and `createdAt` — the pasted `config` is deliberately absent, because it may hold credentials and this route is polled. |
| `PUT /api/workspace/repos` | `202 { repos }`. The body is the **whole** selection, which is what makes it a PUT: replaying it changes nothing, so a browser's retry after a dropped connection is safe. Clones run in the background — a request that waited for one would be killed by any proxy in front of it. `400 BAD_BODY`, `BAD_REPO_NAME` (a name that cannot be a directory), `REPO_NAME_CONFLICT` (two owners, one checkout directory), `TOO_MANY_REPOS`, `UNKNOWN_REPO` (outside what the installation can see, so the clone could only 404); `409 WORKSPACE_DISABLED`. |
| `PUT /api/workspace/executors` | `200 { executors }`. The body is the **whole** executor list, the same whole-list-replace argument as the repos route — but `200`, not `202`, because nothing runs in the background; the rows are written before the response is sent. `config` is stored verbatim and validated structurally only: an object, a known `type`, unique path-segment-safe names, at most 10 per member. Field-level rules wait for a real consumer, and 012's check constraint holds the line at the row. Body limit 64 KiB. `400 BAD_BODY`, `BAD_EXECUTOR_TYPE`, `BAD_EXECUTOR_NAME`, `EXECUTOR_NAME_CONFLICT`, `TOO_MANY_EXECUTORS`; `409 WORKSPACE_DISABLED`; `503 UNAVAILABLE` when no store is configured. |

- **The job routes are registered only when `buildApp` is given a job store**, like the ingest
  routes. See [jobs.md](jobs.md) for the lease and fencing-token rules behind the `409`s.
- **The workspace routes are registered only when `buildApp` is given a `userRepos` store**, the
  same bargain. An absent workspace *root* is a different thing entirely and does not remove them:
  the routes still answer, and report that the feature is off.
- **`/api/repos` and `/api/workspace*` are walled by falling through `requirementFor`**, not by
  being listed anywhere. The default is the safe one, which is the property worth keeping — a new
  route is authenticated unless somebody deliberately opens it.


- **`meta.organization.mode` is a discriminant, never inferred from `available.length > 1`.** A
  directory user with one membership can be granted a second with no deploy; a control disabled by
  list length is right today by accident and silently wrong then.
- **`400 UNKNOWN_ORG` is checked before `parseRange` and before `ensureFresh()`.** The organization
  selects *which* data set is being ranged, so it is the more fundamental error, and a bad request
  must never be answered with a 202 the client then polls forever. Rejected rather than ignored, and
  the `BAD_RANGE` precedent understates the reason: an ignored range at least echoes in
  `meta.range` where a reader could notice, whereas an ignored `?org=` would echo
  `meta.organization.current` as the configured org and render one organization's figures under a
  heading the caller did not ask for. Once the store is partitioned, "trust the parameter" must
  never become a habit — the day auth lands, that habit is a cross-tenant read. Guarded by
  "reports the organization, not the range, when both are wrong", which is what pins the ordering.
- **`org` goes no further than the guard.** The service knows the only organization there is, and a
  parameter it ignores is worse than no parameter.
