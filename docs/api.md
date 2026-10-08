# API

Every HTTP surface the board serves under `/api/*`. The route files are the contract — status
codes, query parameters and error codes are read there, never restated here.

| Surface | Code | Test |
| --- | --- | --- |
| Sign-in, session, org switch | `server/src/routes/auth.ts` | `server/test/auth.oauth.sign-in.test.ts` |
| Onboarding (parked sign-in, installation pick) | `server/src/routes/auth-onboarding.ts` | `server/test/auth.completion.test.ts` |
| Personal and org access tokens | `server/src/routes/tokens.ts` | `server/test/auth.tokens.test.ts` |
| Liveness and readiness probes | `server/src/routes/health.ts` | `server/test/routes.health.test.ts` |
| Packaged release version (`/api/version`, open) | `server/src/routes/version.ts`, `server/src/version.ts` | `server/test/routes.version.test.ts`, `server/test/auth.enforcement.test.ts` |
| Skill discovery (`GET /api/skills`): name, description, declared requirements with env names, never the instructions | `server/src/routes/skills.ts`, `server/src/skills.ts` | `server/test/skills.test.ts` |
| Dashboard payload (`/api/stats`) | `server/src/routes/stats.ts` | `server/test/routes.stats.get.test.ts` |
| OTLP ingest, `/api/sessions/branch` | `server/src/routes/ingest.ts` | `server/test/routes.ingest.test.ts` |
| Jobs: create, claim, worker reports, actions, reclaims | `server/src/routes/jobs.ts` and `job-*.ts` | `server/test/routes.jobs.test.ts` |
| Agent questions: `POST /api/jobs/:id/question`, `question-expire` (worker), `questions/:questionId/answer` (member); heartbeat `answeredQuestions` | `server/src/routes/job-handlers-questions.ts`, `job-handlers-worker.ts` | `server/test/routes.jobs.test.ts`, `server/test/auth.enforcement.test.ts` |
| Named reviewers: `POST /api/jobs/:id/review`, `review-read` (worker, lease-fenced; `409 UNKNOWN_REVIEWER`, `409 REVIEW_UNSUPPORTED`, `400 INVALID_REVIEW`, `404 REVIEW_NOT_FOUND`) | `server/src/routes/job-handlers-reviews.ts` | `server/test/routes.jobs.test.ts`, `server/test/auth.enforcement.test.ts` |
| Task read model (`/api/tasks`) | `server/src/routes/tasks.ts` | `server/test/routes.tasks.test.ts` |
| Managed connections: `GET/POST /api/connections`, `DELETE /api/connections/:id`, and the runner's `ANY /api/jobs/:id/connectors/jira/*` proxy | `server/src/routes/connections.ts`, `connector-jira.ts` | `server/test/routes.connections.test.ts`, `server/test/routes.connector-jira.test.ts` |
| Repo picker (`/api/repos`) | `server/src/routes/repos.ts` | `server/test/routes.repos.test.ts` |
| Runner env in three scopes | `server/src/routes/env.ts` | `server/test/routes.env.test.ts` |
| Workspace, checkouts, personal executors (incl. `DELETE /executors/:id`, `POST /executors/:id/suspension`) | `server/src/routes/workspace.ts`, `workspace-purge.ts` | `server/test/routes.workspace.test.ts`, `server/test/routes.executor-lifecycle.test.ts` |
| Organization executor profiles | `server/src/routes/org-executors.ts` | `server/test/routes.org-executors.test.ts` |
| Member roster and roles | `server/src/routes/org-members.ts` | `server/test/routes.org-members.test.ts` |
| Workflow definitions and the block catalog | `server/src/routes/workflows.ts` | `server/test/routes.workflows.test.ts` |
| GitHub webhook deliveries | `server/src/routes/webhook.ts` | `server/test/webhook.test.ts` |
| Which credential a path needs | `server/src/auth/plugin.ts` (`requirementFor`) | `server/test/auth.enforcement.test.ts` |

Error codes have one home, `core/src/error-codes.ts`, pinned by `core/test/error-codes.test.ts`
and by the `lint/no-shared-literals.grit` plugin.

## Invariants

- A route is authenticated unless `requirementFor` (`server/src/auth/plugin.ts`) deliberately
  exempts it — new paths fall through to the walled default. `server/test/auth.enforcement.test.ts`.
- `GET /api/auth/me` answers `200 { authenticated: false }` anonymously, never `401`: it is what
  tells the SPA it is signed out. `server/test/auth.oauth.me.test.ts`.
- The job routes register only when `buildApp` is given a job store, the workspace routes only with
  a `userRepos` store; an absent workspace *root* removes neither. `server/src/app.ts`.
- The organization is the credential's, never a request field — `?org=` only selects among the
  caller's memberships, refused before the range is parsed
  (`server/test/routes.stats.organization.test.ts`). See [organizations.md](organizations.md).
- A stale read is still a `200` carrying its staleness (`/api/stats`, `/api/repos`): an empty
  payload and an unreachable GitHub must not look alike.
- Lease-guarded worker routes answer `409 LEASE_LOST`; only `heartbeat`'s is a kill order
  ([jobs.md](jobs.md)).
