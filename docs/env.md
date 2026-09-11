# Runner environment & secrets

Read before: touching `env_var`, `server/src/routes/env.ts`, `server/src/db/env-var-store.ts`, the
claim's `env`, the driver's env forwarding, or the Environment page in `web/`.

The board stores environment variables and secrets for runners in three stacked scopes — the GitHub
Actions model, one level coarser — configured in the UI and injected into runners at claim time.
Issue #17 called the org scope "Core secrets" and asked that everything "stack upon each other".

## The scopes

| Scope | Row shape | Who writes it | Reaches |
| --- | --- | --- | --- |
| Core (organization) | `user_id` and repo columns null | an admin | every runner in the deployment |
| Workspace | `user_id` set | the member, their own rows | their runners |
| Repository | `repo_owner`/`repo_name` set | an admin | every member's runners in that repository |

One table, `env_var`, three sibling scopes, enforced by `env_var_scope_ck`: exactly one of the three
is set per row. A table per scope would put the stacking rule in three places and a union; here the
claim reads one scope disjunction and the merge lives in one function (`stackEnv`). The nullable
scope columns cannot sit in a primary key (a PK column must be NOT NULL), so uniqueness comes from
`env_var_key_uk`, a unique index over coalesced stand-ins the scope check guarantees collide with no
real value.

- **"Org level" is a database scope, not server configuration.** The issue asked for UI editing,
  which a `ORG_*` environment variable cannot offer; and this deployment has exactly one
  organization (`ORG_ID`, the `organization` table), so rows with null `user_id` and null repo ARE
  the org scope without a third identifier.
- **Repository scope is org-wide, not per member.** One configuration per repository, applied to
  every member's runs in it — the Actions precedent, and the reading of the issue's listing of
  org/workspace/repo as siblings. Admin-gated for the same reason: an admin's repo var influences
  other members' runs, which is acceptable under "membership is not a sandbox"
  ([jobs.md](jobs.md)) but is not a decision a member should make for somebody else.
- **Precedence is org < workspace < repo, most specific wins.** The issue's own listed order, and
  the Actions rule. `stackEnv` is `{...org, ...workspace, ...repo}` — exported and pinned by the
  offline suite, because a rule this load-bearing must not live only where a database is.
- **A name is checked three times**: the route (`400 BAD_ENV_NAME`, `^[A-Za-z_][A-Za-z0-9_]*$`),
  the row (`env_var_name_ck`, the same regex), and the driver (`claimEnv` drops what it cannot
  stand). `WORKDIR` and `TRUST_WORKDIR` are refused outright (`400 RESERVED_ENV_NAME`) — those are
  the driver's own contract with the runner, and a claim env carrying them would be two different
  paths to one working directory. `BELLOWS_GATE_URL` and `BELLOWS_GATE_TOKEN` are reserved the
  same way: they are the ad-hoc gate credentials the DRIVER mints per attempt (see
  [jobs.md](jobs.md)), and a member-configured value for either would be a claim telling the
  runner to send its gate calls somewhere else. `CRED_HELPER` is reserved for a sharper reason:
  it names the credential-helper CODE the startup sync's fetch executes (`-c credential.helper=`
  hands the value to git as a program), so a member value there would be member-controlled code
  running in the sync container — reserving the name is what makes the driver's own helper the
  only possible one.
- **`REPO`, `WORKTREE` and `BRANCH` are driver-owned inside the startup sync's container only**
  (issue #35): the sync's literal env names the clone, the task worktree and its branch, and the
  driver's literals win a collision on both platforms — docker's last `--env-file`/`-e` order and
  kubernetes's `env`-over-`envFrom` precedence. They are deliberately NOT in
  `RESERVED_ENV_NAMES`: a runner never sees them, so reserving them board-wide would refuse
  member names nothing ever conflicted with outside one throwaway container.

## Secrets are write-only, not encrypted

**Values sit in plaintext, deliberately.** These values must be RETRIEVED to be injected into a
runner, so hashing is impossible; encrypting them with a key that lives in the same `.env` (like
the App private key already does) is theatre with extra steps. The honest statement is: **read
access to the database is equivalent to holding every runner credential.** Rotation is a re-PUT.

What "write-only" buys is the browser, not the database: every list read — `GET /api/env`, for
admins too — nulls a secret's value IN THE SELECT. The row still travels (name, `updatedAt`, the
fact that it is a secret), so the page renders "set" without holding the value.

**The `null`-value keep rule.** A whole-list PUT must not force the client to re-send secret values
it can never read. So a secret whose incoming entry carries `value: null` SURVIVES the delete
untouched, and is not re-inserted; an omitted name deletes. This is the one exception to "the body
is the whole truth", and it is why a non-secret can never have a null value (`400 BAD_VALUE` — its
value is readable, so a client editing the scope always has it).

## How it reaches a runner

**Resolution happens on the board, at claim time** — `JobStore.claim()` calls the env store's
`resolveFor({ userId: row.created_by, repo: row.repo })`, because the board is where the org is
bound and the author and repo label are in hand. The driver stays an HTTP client that never touches
the database; a board built without an env resolver simply omits `env` from the claim, and the
driver reads that as "no environment" (`?? {}`).

- **The values cross the board→driver hop inside the claim JSON.** That hop already carries the
  worker token's authority, supports https (`JOB_BOARD_URL` checks the scheme), and under
  `AUTH_MODE=none` the whole board is open anyway — the bind address is the access control
  ([security.md](security.md)). Env on the claim is not a new class of exposure; it is the same
  hop carrying more of what it is for.
- **The resolved env is never persisted on the job row.** `GET /api/jobs/:id` serves output and
  metadata to every member; storing the merged values there would publish the very secrets this
  feature exists to hold. A resolver failure propagates as a 503 on the claim — the driver retries,
  and a job is never handed out with half an environment.
- **Docker: a `--env-file` written and removed around the run.** Claim values NEVER pass through
  the driver's own environment: `-e NAME` would read them from there, and the names are
  member-controlled — a member's `PATH`, `DOCKER_HOST` or `HOME` steering the docker CLI the
  driver executes on the host is host code execution, not a runner environment. Instead the runner
  writes a 0600 file in the OS temp directory (`factory-env-<job id>-<lease token>.env`), spawns
  `docker run
  --env-file <path>`, and removes it when the run ends — verdict, throw, or kill. Values are never
  in an argv either. The one structural cost: an env file is line-structured with no quoting, so a
  value containing a newline is refused at PUT (`400 BAD_ENV_VALUE`) and again at the driver.
  The driver's own `RUNNER_ENV` names keep the `-e NAME` form (operator-controlled values only),
  minus any name the claim also carries — docker gives `-e` precedence over `--env-file`, and the
  claim must win a collision.
- **Remote Control runners get no claim env, exactly as they get no `RUNNER_ENV`.** A forwarded
  credential does not fail there — `--remote-control` starts a perfectly ordinary local session and
  the only symptom is that it never appears at claude.ai/code. The volume is the only credential a
  Remote Control runner gets. Revisit with an allowlist if that ever needs to change.
- **Kubernetes: a per-attempt Secret.** `claimEnv`'s keys go into the pod spec as `secretKeyRef` against
  `factory-job-<id>-<lease token>-env` — the lease token is in the name because a reclaimed job's
  superseded worker must not be able to delete the replacement attempt's Secret — created (values in
  `stringData`) BEFORE the Job (a pod referencing a Secret that is not there yet is a
  `CreateContainerConfigError` and a burned attempt, so the keys are referenced non-optionally) and
  reaped by the run's own exit — once the verdict and log have been read, on a throw, or on the
  kill-induced Job 404 — and never by `kill()` itself, which can interleave the run's create()
  between the Secret POST and the Job POST; the re-claim fence deletes only the leftover Job. A
  driver that crashes before cleanup leaks its attempt's
  Secret, since Secrets carry no TTL; the `factory.job: <id>` label is what a cleanup job would
  select. No value ever lands in the pod spec. The chart's Role grows `secrets: [create, delete]` —
  no `get`, no `list`; the driver writes values it was handed and never reads one back.

## "Core secrets" and GitHub authentication

The org scope IS the "Core secrets" of the issue, and `GITHUB_TOKEN` is the first one to configure:
`gh` reads it natively, and `git` picks it up through a credential helper the agent can bootstrap.

Since #28 an app-mode board ALSO mints the App's installation token onto every claim, under the
name `GITHUB_TOKEN`. This section used to call that "deliberately not built" and name three costs —
read-only tokens, a GitHub call on the claim hot path, impossibility without a credential — and
each is answered in place:

- **The mint is the base layer, below every configured scope** (`withMintedToken` in job-store.ts,
  pinned by the offline suite like `stackEnv` is). A `GITHUB_TOKEN` configured in org, workspace or
  repo WINS the collision: it is a credential an operator deliberately chose, and silently
  replacing one token with another is a failure nobody notices. The mint fills only the gap. The
  rule does NOT reach the driver's own forwarded names, where the collision already runs the other
  way by design: under an app-mode board the claim always carries `GITHUB_TOKEN`, and the claim
  wins over `RUNNER_ENV`'s `-e NAME` and the k8s credentials Secret — so a `GITHUB_TOKEN` delivered
  that way is shadowed from now on, and such a credential must move to the org scope to stay
  authoritative.
- **Each claim mints FRESH rather than reading the provider's cache.** The token the repo-read path
  uses is cached and refreshed five minutes before expiry, so a claim served from it could hand a
  runner a credential with minutes of life left — and a runner's env is written once, its run
  capped at thirty minutes, with no refresh path. So the claim calls the provider's `fresh()`: at
  most one GitHub call per claim — concurrent claims join the same single-flight mint (never per
  poll: an idle board mints nothing) — a full hour of life every
  time, and GitHub does not invalidate the token the mint replaced. The request itself is bounded
  (`MINT_TIMEOUT_MS`): the mint runs inside the claim's transaction, so a GitHub that answers
  slowly must abort rather than pin the job-row lock and a pool connection indefinitely. A mint
  failure throws inside
  the claim transaction, and the same rollback that guards the env resolver leaves the job queued
  with its attempt unburned — the claim answers 503 and the driver retries, so a job is never
  handed out with half an environment.
- **Without a provider there is no mint** — the offline tooling's code-only `none` arm only, by
  construction, like every other fetch. The claim env is exactly what it was.
- **The token's permissions are the installation's defaults.** The create-installation-token API
  can only narrow, and code cannot grant what the installation does not have: orchestration —
  commits and PRs (`contents:write`, `pull_requests:write`) and reading CI (`actions:read`) — is
  granted in the App's installation settings on GitHub, or the runner's token stays read-only.
- **Remote Control runners get none of it**, exactly as they get no configured env: a forwarded
  credential there does not fail, it degrades the session in silence. The login volume is the only
  credential that mode gets.

## The page

`/env` on the SPA: three editors (Core, My workspace, Per repository) fed by one `GET /api/env` on
mount and after each save — **no polling**, because the list only changes when somebody edits it,
and a poll would race the editors' draft state. Whole-list PUTs, the repos/executors idiom. A
secret row renders its input blank with placeholder "set — leave blank to keep"; a member sees the
org and repo editors read-only with a sentence saying why (the `root: null` posture).

## Tests

- **`server/test-db/env-var-store.test.ts`** — the SQL: whole-scope replace, the keep-a-null-secret
  rule, the write-only echo vs `resolveFor`, the stacking order, and the check constraints at the
  row. Needs a `*_test` database.
- **`server/test/routes.env.test.ts`** — offline, against the in-memory double: sessions, the
  admin/member split, validation codes, `UNKNOWN_REPO`, the 503 path.
- **`server/test/job-store.env.test.ts`** — offline, the base-layer merge rule (`withMintedToken`):
  a configured `GITHUB_TOKEN` wins in any scope, the mint fills the gap, and no mint changes
  nothing.
- **`server/test-db/job-store.test.ts`** — the claim carries the stacked env, the minted
  installation token under it as the base layer, a fresh mint per claim, and no env when built
  without a resolver; a resolver or mint failure leaves the job claimable without burning an
  attempt.
- **`driver/test/`** — names only on the docker argv, values in the child environment, reserved
  names dropped, RC exclusion, the k8s Secret lifecycle, and the loop never logging what it was
  handed.
- **`scripts/test-jobs.sh`** — the vertical: PUT core env → claim → runner → the probe values in
  the job's output; the stub image prints two env probes before echoing its argv.
