# Managed connections

Which external services a task may use and as whom: an authorized connection the board owns and spends on
the runner's behalf, selected per task — and GitHub, whose token the board mints for each attempt from the App.

| Concern | Code | Test |
| --- | --- | --- |
| The table, the proxy's per-call SQL check, `job.jira_connection_id` | `server/migrations/054_connections.sql`, `server/src/db/connection-store.ts` | `server/test-db/connection-store.test.ts` |
| Create, list, delete; who may own an org-wide one; site and credential shape | `server/src/routes/connections.ts` | `server/test/routes.connections.test.ts` |
| Task selection: `jiraConnection` on `POST /api/jobs`, checked against its author; unnamed injects the author's newest own, else the org's newest | `server/src/routes/connections.ts` (`resolveJiraConnection`), `server/src/db/connection-store.ts` (`defaultFor`), `server/src/db/job-store-actions.ts` | `server/test/routes.connections.test.ts`, `server/test-db/connection-store.test.ts` |
| The settings panels: org-wide on Organization (admin writes, members read), personal on Workspace; added through a dialog, the token is write-only | `web/src/panels/JiraConnectionsPanel.tsx`, `JiraConnectionsSection.tsx`, `web/src/components/JiraConnectionDialog.tsx`, `web/src/api/connections.ts` | `web/test/jira-connections-panel.render.test.tsx`, `web/test/jira-connections.dom.test.tsx`, `e2e/jira-connections.spec.ts` |
| The CLI lists selectable connections (`bellows connection list`) and selects one with `job create --jira-connection <id>`; a connection that is not the author's is the board's `CONNECTION_NOT_AUTHORIZED`; `job preflight` checks it advisorily | `cli/src/run.ts`, `cli/src/selection.ts`, `cli/src/diagnostics.ts`, `cli/src/board.ts` | `cli/test/discovery.test.ts`, `cli/test/diagnostics.test.ts` |
| The Jira proxy: lease pair → live connection → Atlassian with Basic auth added | `server/src/routes/connector-jira.ts` | `server/test/routes.connector-jira.test.ts` |
| The credential class: the attempt pair in every `AUTH_MODE`, nothing else | `server/src/auth/plugin.ts` (`CONNECTOR_ROUTES`) | `server/test/auth.enforcement.test.ts` |
| Runner side: `JIRA_API` derived from the board URL and the attempt's own job id | `docker/claude-executor/entrypoint.sh`, `docker/opencode-executor/entrypoint.sh` | `driver/test/executor-images.test.ts` |
| The agent's path; the skill holds no credential | `docker/skills/jira/SKILL.md` | `driver/test/executor-images.test.ts` |
| Docker and Kubernetes carry no Jira credential, only the pair and the board URL | `driver/src/claim.ts`, `driver/src/k8s-podspec.ts` | `driver/test/docker.test.ts`, `driver/test/k8s.test.ts` |
| `ATLASSIAN_*` are reserved env names | `core/src/env.ts`, `driver/src/claim.ts` | `server/test/routes.env.test.ts` |
| GitHub: `POST /api/jobs/:id/credentials/github` takes the attempt pair only, checks the live attempt before the mint and after it, answers `{ token, expiresAt }` with `Cache-Control: no-store`, `409 GITHUB_UNAVAILABLE` without an App installation, and `403` to a task with no repository (its mint would be installation-wide) | `server/src/routes/github-credential.ts`, `server/src/db/github-credential.ts` | `server/test/routes.github-credential.test.ts`, `server/test-db/github-credential.test.ts` |
| GitHub: one mint per ask, narrowed to the task's repo and `RUNNER_TOKEN_PERMISSIONS`, carrying GitHub's `expires_at`; no ask shares another's | `server/src/github/app-token.ts` (`fresh`) | `server/test/github.app-token.test.ts` |
| GitHub, runner side: the image helper behind git's `credential.helper` and the `gh` wrapper (the real `gh` in `/usr/local/libexec`), renewing 5 minutes before expiry with 3 bounded tries and refusal guidance on stderr; byte-identical in both images | `docker/claude-executor/github-credential.cjs`, `gh-wrapper.sh`, `entrypoint.sh`, `docker/opencode-executor/entrypoint.sh` | `driver/test/github-credential.test.ts`, `driver/test/executor-images.test.ts` |
| GitHub, the helper's cache: memory only and the agent container's alone — docker `--tmpfs`, kubernetes `emptyDir: {medium: Memory}` at `GITHUB_CACHE_DIR` | `driver/src/claim.ts`, `driver/src/docker.ts`, `driver/src/k8s-podspec.ts` | `driver/test/github-credential.test.ts` |
| GitHub, driver side: asked (3 bounded tries) before the sync's fetch, each publish, each github-writing helper and each gate run's start, and laid into that step's env alone | `driver/src/github-credential-call.ts`, `loop-github.ts`, `loop-gates.ts`, `gates.ts`, `k8s-gates.ts`, `supervised-steps.ts` | `driver/test/board.test.ts`, `driver/test/loop.test.ts`, `driver/test/gates.test.ts`, `driver/test/k8s.test.ts` |
| `GITHUB_TOKEN` and `GH_TOKEN` are reserved env names, refused in `RUNNER_ENV` and unset by the agent's entrypoint; migration 072 deleted the stored rows | `core/src/env.ts`, `driver/src/claim.ts`, `driver/src/config.ts`, `server/migrations/072_github_env_reserved.sql` | `server/test/routes.env.test.ts`, `driver/test/config.test.ts`, `driver/test/executor-images.test.ts` |
| GitHub, the lanes: renewal across a forced expiry against the stand-in mint entry (docker), the App-less refusal and the Memory cache inside a runner pod (kubernetes) | `server/src/offline-mint.ts`, `scripts/test-jobs.sh`, `scripts/test-k8s.sh`, `scripts/k8s-stub.sh` | `server/test/test-jobs.harness.test.ts`, `driver/test/lane-stubs.test.ts` |

## Invariants

- **The credential never leaves the board.** The runner holds the attempt pair; the proxy adds the
  connection's Basic auth. There is nothing to renew, and revocation is a `DELETE` that the next call
  sees. `server/src/routes/connector-jira.ts`, `server/test/routes.connector-jira.test.ts`.
- **Every call re-checks the live attempt**, with no tail grace (unlike `createOrgOfLease`): the job is
  unfinished, its lease unexpired and no stop requested. A reclaim or retry rotates the lease token, so
  a superseded attempt's pair resolves nothing. `server/test-db/connection-store.test.ts`.
- **Selection is the task's, and only the root's, stamped at create.** A follow-up, retry or workflow
  node reads its root's `jira_connection_id`; loading a skill adds nothing, and a connection added
  later never reaches a task already created. A personal connection also needs its owner
  to be the root's author and still a member. `server/src/db/connection-store.ts`.
- **Org-wide connections are admin-created; personal ones are the owner's.** `read` forwards GET and
  HEAD only. `server/src/routes/connections.ts`, `server/test/routes.connections.test.ts`.
- **Refusals name the fix** (`CONNECTION_NOT_AUTHORIZED`), and the token is in no response, log line
  or error text. `server/test/routes.connector-jira.test.ts`.
- **GitHub's token is the attempt's, never the claim's.** No GitHub value rides the claim, the runner's
  env or the runner's Secret; a reviewer row and a superseded, cancelled or finished attempt get none, so a lost
  runner's next claim renews under its own pair. `server/test-db/github-credential.test.ts`,
  `driver/test/github-credential.test.ts`.
- **The proxy reaches `rest/api/3/*` on the connection's cloud id and nothing else**, and `site` must
  be `*.atlassian.net`, since creating one makes the board fetch it.
  `server/test/routes.connector-jira.test.ts`, `server/test/routes.connections.test.ts`.

## Stated limits

- The token is plaintext at rest, the `env_var` rule ([env.md](env.md)): database read access is
  every connection's credential.
- Jira is scoped API-token auth: the gateway refuses a classic token, which is stored without being
  tried and then answers 401 on every call.
- GitHub is the App's alone: no member token and no PAT, so an org without an installation has no
  GitHub credential at all. A revoked or suspended installation surfaces as the route's `502`.
- A gate run's GitHub token is asked at its start and never renewed during it: one gate running past
  its hour runs on an expired token. It rides the env file each `docker exec` reads, or the gate env
  Secret replaced for the run (`driver/src/k8s-gates.ts`).
- A runner whose driver was lost keeps its old pair: once the lease expires or a reclaim rotates it,
  the helper is refused for the rest of that run, and the next claim's runner gets its own.
- The helper answers `https://github.com` only: an Enterprise `GITHUB_API_URL` deployment's agent
  runs git and gh without a credential.
- A supervised step's token rides its step request, which crosses the mailbox volume, not memory.
- No in-place edit and no per-task picker in the UI: delete and re-add; the injected default covers selection.
