# Managed connections

Which external services a task may use and as whom: an authorized connection the board owns and spends on the runner's behalf, selected per task.

| Concern | Code | Test |
| --- | --- | --- |
| The table, the proxy's per-call SQL check, `job.jira_connection_id` | `server/migrations/054_connections.sql`, `server/src/db/connection-store.ts` | `server/test-db/connection-store.test.ts` |
| Create, list, delete; who may own an org-wide one; site and credential shape | `server/src/routes/connections.ts` | `server/test/routes.connections.test.ts` |
| Task selection: `jiraConnection` on `POST /api/jobs`, checked against its author | `server/src/routes/connections.ts` (`resolveJiraConnection`), `server/src/db/job-store-actions.ts` | `server/test/routes.connections.test.ts` |
| The Jira proxy: lease pair → live connection → Atlassian with Basic auth added | `server/src/routes/connector-jira.ts` | `server/test/routes.connector-jira.test.ts` |
| The credential class: the attempt pair in every `AUTH_MODE`, nothing else | `server/src/auth/plugin.ts` (`CONNECTOR_ROUTES`) | `server/test/auth.enforcement.test.ts` |
| Runner side: `JIRA_API` derived from the board URL and the attempt's own job id | `docker/claude-executor/entrypoint.sh`, `docker/opencode-executor/entrypoint.sh` | `driver/test/executor-images.test.ts` |
| The agent's path; the skill holds no credential | `docker/skills/jira/SKILL.md` | `driver/test/executor-images.test.ts` |
| Docker and Kubernetes carry no Jira credential, only the pair and the board URL | `driver/src/claim.ts`, `driver/src/k8s-podspec.ts` | `driver/test/docker.test.ts`, `driver/test/k8s.test.ts` |
| `ATLASSIAN_*` are reserved env names | `core/src/env.ts`, `driver/src/claim.ts` | `server/test/routes.env.test.ts` |

## Invariants

- **The credential never leaves the board.** The runner holds the attempt pair; the proxy adds the
  connection's Basic auth. There is nothing to renew, and revocation is a `DELETE` that the next call
  sees. `server/src/routes/connector-jira.ts`, `server/test/routes.connector-jira.test.ts`.
- **Every call re-checks the live attempt**, with no tail grace (unlike `createOrgOfLease`): the job is
  unfinished, its lease unexpired and no stop requested. A reclaim or retry rotates the lease token, so
  a superseded attempt's pair resolves nothing. `server/test-db/connection-store.test.ts`.
- **Selection is the task's, and only the root's.** A follow-up, retry or workflow node reads its
  root's `jira_connection_id`; loading a skill adds nothing. A personal connection also needs its owner
  to be the root's author and still a member. `server/src/db/connection-store.ts`.
- **Org-wide connections are admin-created; personal ones are the owner's.** `read` forwards GET and
  HEAD only. `server/src/routes/connections.ts`, `server/test/routes.connections.test.ts`.
- **Refusals name the fix** (`CONNECTION_NOT_AUTHORIZED`), and the token is in no response, log line
  or error text. `server/test/routes.connector-jira.test.ts`.
- **The proxy reaches `rest/api/3/*` on the connection's cloud id and nothing else**, and `site` must
  be `*.atlassian.net`, since creating one makes the board fetch it.
  `server/test/routes.connector-jira.test.ts`, `server/test/routes.connections.test.ts`.

## Stated limits

- The token is plaintext at rest, the `env_var` rule ([env.md](env.md)): database read access is
  every connection's credential.
- Jira only, scoped API-token auth: the gateway refuses a classic token, which is stored without
  being tried and then answers 401 on every call. GitHub keeps the installation token minted at claim
  ([configuration.md](configuration.md)), and a member-configured `GITHUB_TOKEN` still wins the
  collision (`server/test/job-store.env.test.ts`).
- A revoked or suspended GitHub installation still surfaces as a claim-time `503`, not a refusal.
- No web UI: connections are managed through `/api/connections`.
