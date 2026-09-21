# Runner environment & secrets

Read before: touching `env_var`, `server/src/routes/env.ts`, `server/src/db/env-var-store.ts`, the
claim's `env`, the driver's env forwarding, or the Environment page in `web/`.

The board stores environment variables and secrets for runners in three stacked scopes — the GitHub
Actions model, one level coarser — configured in the UI and injected into runners at claim time.
Issue #17 called the org scope "Core secrets" and asked that everything "stack upon each other".

## The scopes

| Scope | Row shape | Who writes it | Reaches |
| --- | --- | --- | --- |
| Core (organization) | `user_id` and repo columns null | any member | every runner in the organization |
| Workspace | `user_id` set | the member, their own rows | their runners |
| Repository | `repo_owner`/`repo_name` set | any member | every member's runners in that repository |

One table, `env_var`, three sibling scopes, enforced by `env_var_scope_ck`: exactly one of the three
is set per row. A table per scope would put the stacking rule in three places and a union; here the
claim reads one scope disjunction and the merge lives in one function (`stackEnv`). The nullable
scope columns cannot sit in a primary key (a PK column must be NOT NULL), so uniqueness comes from
`env_var_key_uk`, a unique index over coalesced stand-ins the scope check guarantees collide with no
real value.

- **"Org level" is a database scope, not server configuration.** The issue asked for UI editing,
  which an environment variable cannot offer; `org_id` names the partition — the App's
  installation a member signed into (#99) — so rows with null `user_id` and null repo ARE the org
  scope without a third identifier.
- **Repository scope is org-wide, not per member.** One configuration per repository, applied to
  every member's runs in it — the Actions precedent, and the reading of the issue's listing of
  org/workspace/repo as siblings. Any member writes it: installation access is membership (#99),
  one trust level with no admin tier, and "membership is not a sandbox" ([jobs.md](jobs.md))
  already accepts that a member's runners share the organization's ground.
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
  only possible one. `FACTORY_TRANSCRIPT_DIR` is reserved because the driver composes it
  (`transcriptDir` in driver/src/docker.ts): it is where the headless transcript store lives, and
  the runner entrypoint redirects `CLAUDE_CONFIG_DIR` onto it — a member value would steer
  transcripts, and with them the CLI's whole configuration directory, somewhere else
   ([jobs.md](jobs.md)). `FACTORY_STATS_URL`, `RUNNER_JOB_ID`, `RUNNER_LEASE_TOKEN` and
   `BELLOWS_SESSION_ID` are reserved for the branch reporter (see [jobs.md](jobs.md)): a member
   value in the first tells the runner's attribution reports to post somewhere else, the middle
   two forge the attempt credential the board resolves those reports' organization from, and the
   last claims the report is somebody else's session — a cross-tenant write into the telemetry
   store, refused the same way. `OPENCODE_CONFIG_CONTENT` is the one name the board
  reserves that the driver does not: the claim SYNTHESIZES it from the author's own executor row
  when the task was stamped with an `opencode` executor ([workspace.md](workspace.md)), applied
  after the resolved scopes so the synthesized value wins any collision, and a member var of the
  same name could only ever be silently shadowed — the PUT says so instead. The driver's
  `claimEnv` deliberately does not filter it, because the synthesized value must flow to reach
  the runner (docker's env-file, kubernetes's per-attempt Secret — both carry it with no
  platform-specific code).
- **`REPO`, `WORKTREE` and `BRANCH` are driver-owned inside the startup sync's container only**
  (issue #35): the sync's literal env names the clone, the task worktree and its branch, and the
  driver's literals win a collision on both platforms — docker's last `--env-file`/`-e` order and
  kubernetes's `env`-over-`envFrom` precedence. They are deliberately NOT in
  `RESERVED_ENV_NAMES`: a runner never sees them, so reserving them board-wide would refuse
  member names nothing ever conflicted with outside one throwaway container. `CRED_HELPER` and
  `RESTORE` belong to the same container and are reserved for what a member value would do there:
  `CRED_HELPER` is member-controlled helper code the sync's git executes, and `RESTORE` is the
  sync's restore-mode switch (issue #58) — a member value would flip starting claims into
  restore mode, silently skipping the fetch and rebase a fresh task needs.

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
  board secret's authority, supports https (`JOB_BOARD_URL` checks the scheme), and under
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
  capped at two hours, with no refresh path. So the claim calls the provider's `fresh()`: at
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

The three editors (Core, My workspace, Per repository) live in the settings tree (#150): Core at
Settings → Organization, My workspace at Settings → Workspace, and Per repository at Settings →
Repositories, each fed by `GET /api/env`
on mount. **No polling**, because the list only changes when somebody edits it, and a poll would
race the editors' draft state. Whole-list PUTs, the repos/executors idiom. Every role edits every
scope: `PUT /api/env/org` and `PUT /api/env/repo` accept any member of the installation —
membership is the one trust level (#99), and there is no admin tier — and `PUT /api/env/workspace`
writes the caller's own rows, so the browser gates nothing the server does not. Issue #180 removed
the earlier client-only `disabled` controls (a disabled browser control is not authorization, and
these ones denied writes the server accepts) and had each editor state its scope truth first: what
the scope applies to, who may edit it, and the organization < workspace < repository precedence
(`ConfigurationScope`, echoed by the `/settings` overview's readiness items). If product policy
ever narrows who writes, the server grows a tested `403` first, and only then does a page render a
readable read-only view.

Each editor is a draft over its scope (issue 182): one baseline, one local draft, and a canonical
dirty comparison that looks only at the API payload shape — never React row ids, never row order
(every read comes back `order by name asc`, so order is not a fact the store keeps). Variables and
Secrets are real tabs with live counts; the tab a row is added in decides its type, and no control
changes a row's type afterwards. Secrets are masked and write-only as above: a stored secret
renders **Set** with a blank input ("Leave blank to keep the current secret" — a blank saves
`null`, the keep marker), a typed value shows **Will replace when saved**, and a new row with
nothing typed is **Not set** and cannot save until it is valid or removed. No stored value, length
or clue is ever rendered, and secrets never appear in `.env` text.

Removal is pending, not immediate: the row stays visible as "{name} will be removed when you save."
with an Undo, is excluded from the counts and from the save payload (an omitted name is how the
whole-list PUT deletes), and is deleted only when the save succeeds — a failed save keeps the
pending state and the Undo. An untouched blank new row may still vanish without ceremony.

Advanced editing replaces the old raw toggle: an **Edit variables as .env** disclosure inside the
Variables tab. Opening seeds a textarea from the active variable rows and changes nothing; **Apply
.env draft** parses the text with the same strict rules the server enforces (env-raw.ts mirrors
`parseVars`, copied constants included) and — on success — replaces the variable draft only
(secret rows, and their pending states, pass around untouched); on failure the text, the errors
and the disclosure stay open and the table draft is untouched. **Cancel .env changes** closes and
reseeds the textarea. Save changes stays disabled while the editor is clean, invalid, saving, or
holding unapplied `.env` text.

Save is the only write path, and its lifecycle keeps the draft honest: on success the editor
adopts the stored rows its PUT echoes back (`{ vars }`) as its new baseline **without remounting**,
which is what blanks a typed secret and shows the stored truth — and keeps the "Changes saved."
confirmation alive (a `key` bump there was once the bug that ate it). On failure the draft is
retained, the error renders as an alert that takes focus, and the inputs are untouched. The
after-save GET keeps the configured repository editor's rows tracking the store; the editors that
did not save keep their drafts, so a concurrent write to another scope appears only on reload or
repository switch — and that scope's next whole-list PUT clobbers it, the standing trade of draft
survival.

While an editor is dirty, the settings layout guards it (#182): a `beforeunload` warning for the
browser, a React Router blocker for in-app navigation (which is why `main.tsx` mounts a data
router — `useBlocker` refuses anything else), and the guarded repository switch on the repos page
— choosing Configure on another repository while the detail editor holds unsaved edits (#181).
All three run one contract with one dialog owner, so nested blockers cannot duplicate dialogs:
**Discard unsaved changes?** / "Your changes to {scope} have not been saved.", with **Continue
editing** the safe, initially focused answer and Escape/backdrop agreeing with it, and **Discard
changes** resetting the drafts and resuming what was asked. `window.confirm` is never used.

Offline tests pin the pure decisions (env-draft.ts: dirty comparison, validation, secret states,
tab and focus arithmetic), the reachable markup, and the guard's copy and listener lifetime;
blocker interception, dialog focus, and the save/removal/apply interactions themselves are the
browser suite's (`npm run verify:ui`), which is the same boundary every dialog in the app draws.

## Tests

- **`server/test-db/env-var-store.test.ts`** — the SQL: whole-scope replace, the keep-a-null-secret
  rule, the write-only echo vs `resolveFor`, the stacking order, and the check constraints at the
  row. Needs a `*_test` database.
- **`server/test/routes.env.test.ts`** — offline, against the in-memory double: sessions,
  member-writable scopes, validation codes, `UNKNOWN_REPO`, the 503 path.
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
