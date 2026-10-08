# Runner environment & secrets

Environment variables and secrets for runners, held by the board in three stacked scopes — org,
workspace (a member's own), repository — and injected into the runner at claim time.

The name rules, the per-scope ceiling and the reserved-name list live in `core/src/env.ts`, which
both the route and the web editors render from. The driver keeps its own copy in
`driver/src/claim.ts`, deliberately narrower.

## Where things live

| Concern | Code | Test |
| --- | --- | --- |
| The three scopes, the scope check, `stackEnv`, the write-only secret echo | `server/src/db/env-var-store.ts`, `server/migrations/017_env_vars.sql` | `server/test-db/env-var-store.test.ts` |
| Whole-list PUT, validation codes, reserved names | `server/src/routes/env.ts`, `core/src/env.ts` | `server/test/routes.env.test.ts` |
| Claim-time resolution and the minted `GITHUB_TOKEN` base layer | `server/src/db/job-store-claim.ts`, `job-store-org-resolvers.ts` (`withMintedToken`) | `server/test/job-store.env.test.ts`, `server/test-db/job-store.test.ts` |
| `claimEnv`: the driver's filter and the synthesized executor-config names | `driver/src/claim.ts` | `driver/test/docker.test.ts`, `k8s.test.ts` |
| Docker: a 0600 `--env-file` written and removed around the run | `driver/src/docker.ts` | `driver/test/docker.test.ts` |
| Kubernetes: a per-attempt Secret, values in `stringData`, referenced by `secretKeyRef` | `driver/src/k8s-podspec.ts` | `driver/test/k8s.test.ts` |
| Jira: `ATLASSIAN_SITE`/`_EMAIL`/`_API_TOKEN` (ordinary member config, not reserved) → `JIRA_API` on the api.atlassian.com gateway; the agent's path is `docker/skills/jira/SKILL.md` | `docker/claude-executor/entrypoint.sh`, `docker/opencode-executor/entrypoint.sh` | `driver/test/executor-images.test.ts` |
| Skill connections (`github`, `jira`): the env names a selected skill needs, checked by presence in the resolved claim env, never read as values | `core/src/skills.ts`, `server/src/db/job-store-claim.ts` | `core/test/skills.test.ts`, `server/test-db/job-store.skills.test.ts` |
| The three editors, their drafts, the `.env` disclosure | `web/src/panels/EnvVarsPanel.tsx`, `env-vars-panel-parts.tsx`, `env-draft.ts`, `env-raw.ts` | `web/test/env-draft.test.ts`, `env-raw.test.ts`, `env.render.test.tsx`, `e2e/env.spec.ts` |
| Where the editors mount | `web/src/pages/SettingsOrganizationPage.tsx`, `SettingsWorkspacePage.tsx`, `SettingsRepositoriesPage.tsx` | `e2e/env.spec.ts` |
| The vertical: PUT core env → claim → runner → the probe values in the output | `scripts/test-jobs.sh` | — |

## Invariants

- **Values sit in plaintext and must, so read access to the database is equivalent to holding every
  runner credential.** They have to be retrieved to be injected; rotation is a re-PUT. The
  write-only rule buys the browser, not the database: every list read nulls a secret's value in the
  SELECT (`env-var-store.ts`, pinned by `server/test-db/env-var-store.test.ts`).
- **A secret entry carrying `value: null` on a whole-list PUT SURVIVES untouched**; an omitted name
  deletes. This is the one exception to "the body is the whole truth", and it is why a non-secret
  may never carry a null value. Same test, plus `server/test/routes.env.test.ts`.
- **Precedence is org < workspace < repo, most specific wins** — `stackEnv`, exported and pinned by
  the offline suite so the rule does not live only where a database is.
- **The minted installation `GITHUB_TOKEN` is the BASE layer**: a configured one in any scope wins
  the collision, and the mint only fills the gap (`withMintedToken`,
  `server/test/job-store.env.test.ts`). Against the driver's own `RUNNER_ENV` the collision runs the
  other way — the claim always wins.
- **The resolved env is never persisted on the job row**, which `GET /api/jobs/:id` serves to every
  member. A resolver or mint failure rolls the claim back to 503 with the attempt unburned, so a job
  is never handed out with half an environment (`server/test-db/job-store.test.ts`).
- **Claim values never pass through the driver's own process environment.** The names are
  member-controlled, so a `PATH` or `DOCKER_HOST` on the docker CLI's own argv would be host code
  execution; the env file and the k8s Secret are what keep them out of argv entirely.

## Stated limits

- An env-file line has no quoting, so a value containing a newline is refused at PUT
  (`400 BAD_ENV_VALUE`) and again at the driver.
- A driver that crashes before cleanup leaks its attempt's Secret — Secrets carry no TTL; the
  `factory.job: <id>` label is what a cleanup job would select. The chart's Role grants
  `secrets: [create, delete]` only, never `get` or `list`.
- `REPO`, `WORKTREE` and `BRANCH` belong to the startup sync's container and are deliberately NOT
  reserved board-wide: a runner never sees them.
- A failed Jira cloud-id lookup warns on stderr and does not fail the run.
