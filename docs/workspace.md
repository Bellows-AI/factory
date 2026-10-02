# Workspace

Read before: touching `server/src/workspace/*`, `ORG_WORKSPACE_ROOT` / `organization.workspace_root`,
or the `git` install in `docker/Dockerfile`.

A **workspace** belongs to a person, not to the organization. Each member gets a tree at
`<root>/<orgId>/<userId>/`, created when they sign in, holding one clone per repository they chose
from the dashboard. It exists so something can be *run* against a checkout —
`docker/claude-executor` expects one — not so the dashboard can read it.

It used to be one tree per deployment: `ensureWorkspace()` cloned every repo in `ORG_REPOS` to
`<root>/<orgId>/<name>` at boot, and the driver handed every runner `WORKDIR=/workspaces/<orgId>`.
Every member's agent therefore worked in the same checkout, and the repo list was an environment
variable no user could change.

- **Unset by default, and unset means nothing is cloned.** A default path would make an upgrade
  start cloning gigabytes for an operator who changed nothing, and would turn a no-network boot into
  a network boot. Since no route, query or metric reads a checkout, there is no case where having
  one silently beats not having one. Per-member checkouts make the argument stronger, not weaker: a
  boot that cloned for every account would be N times the surprise.
- **`GET /api/workspace` answers `200 {root: null}` when there is no root**, not a 503. "Workspaces
  are off" is a configuration somebody chose, and the page renders a sentence about it rather than
  an error nobody can act on.
- **`docker-compose.yml` is the one exception: it defaults `ORG_WORKSPACE_ROOT` to `/workspaces`
  and mounts a named volume there.** The paragraph above is about defaulting a *host* path, which
  compose is not doing — `/workspaces` exists only inside the container it also provisions. It is a
  literal rather than empty-defaulted like `ORG_WORKSPACE_ROOT`'s neighbours used to be, for the
  same reason as before:
  those are host-independent identifiers, while this is a path — and a host value from `.env` is a
  path on the host that cannot exist in the container.
  **Consequence changed:** `docker compose up` no longer clones anything. Boot checks nothing out;
  a clone happens only after somebody signs in and picks repositories.
- **The volume is named, not a bind mount, and it is mounted unconditionally.** The container runs
  as `node` and usually cannot write a host directory owned by someone else — a clone dying on
  permissions is a confusing first symptom. Unconditional because a named volume is created on
  demand, and without it every clone would be discarded on the next `up`. Nothing in the code
  assumes a named volume, so a Kubernetes ReadWriteMany PVC mounted at the same path is a
  deployment change and not a code change.
- **Compose gets its secrets by `${VAR}` substitution from `.env`, never `env_file:`.** `env_file`
  would inject the whole file into the container, including variables meant only for host scripts.

## The path

- **`<root>/<orgId>/<userId>/<name>`, and the segment is the uuid, never the login.**
  `010_auth.sql` chose a uuid for `app_user.id` partly for this — "it becomes a docker volume name
  component and a workspace path segment sitting next to repo names, and a uuid can collide with
  neither". Two further reasons cost work rather than tidiness. A GitHub rename would orphan a tree
  that may hold uncommitted work belonging to an agent session, which is the one thing the
  never-touch-an-existing-checkout rule exists to protect. And GitHub lets a freed login be claimed
  by somebody else, so a login-keyed directory eventually hands a stranger the previous holder's
  checkouts and their `.git/config` — the account-takeover path `docs/auth.md` names, except the
  prize is a working tree.
- **Beside the checkouts sits `<userId>/.worktrees/<root job id>` — the driver's, not ours.**
  Each task run works in a `git worktree` of one of the member's clones, branched off the remote
  default, keyed by the task thread's root job id (`docs/jobs.md`, issue #35). The reconcile never
  creates, reads, prunes, or lists that directory — its naming rules refuse a leading dot (the
  same protection `.opencode` relies on), so the segment cannot collide with a repo name — and the
  driver is the only writer, because the worktree is attempt machinery, not provisioning.
- **Legibility is the real cost, and it is paid with a breadcrumb rather than with a key.**
  `<userId>/.factory-workspace.json` names the login, so `ls` is not a wall of uuids. It is
  deliberately never read by any code: a breadcrumb something resolves against is a second source of
  truth for what `app_user.id` already is.
- **`workspaceDir()` asserts the uuid before it joins anything**, and `driver/src/docker.ts` asserts
  the whole `<org>/<uuid>` again before interpolating it into a `docker run`: the value becomes an
  agent's working directory, and `..` in it points at the parent of every member's tree.
- **The segment and the repo name sit at different depths, so neither can shadow the other** — the
  arrangement `<orgId>/<name>` already had.
- **Repo names are constrained where a name becomes a directory, not at boot.** This was
  `checkWorkspaceNames` in `loadConfig`, refusing to *start* over an `ORG_REPOS` entry. That worked
  while an operator typed the list; it cannot now, because the list comes from a GitHub App
  installation and a name it dislikes is one nobody here can rename. The rules moved to
  `PUT /api/workspace/repos`, which refuses one repository by name with a 400, and to
  `user_repo_name_ck`, which says the same thing at the row. Two owners' same-named repos are still
  one directory; that is `user_repo_dir_uk` now.

## Provisioning and cloning

- **Signing in creates the directory and nothing else.** A `mkdir` is microseconds and a clone is
  minutes, so the two costs are split: cloning starts only when somebody `PUT`s a selection. A
  member who signs in once and never returns costs an empty directory.
- **Not inside `auth/store.ts`.** That module is SQL only, is used by the CLIs, and a `mkdirSync`
  there would make `memoryAuthStore()` lie about what signing in does. `ensureUserWorkspace` is
  called from the callback and again, idempotently, from `GET /api/workspace` — which is not
  redundancy: it covers `AUTH_MODE=none`, whose caller never passes through the callback, and every
  session that predates the deploy. A failure logs and does not block the sign-in, because a full
  disk should not become "you cannot log in".
- **Cloning is a queue driven off `user_repo` rows, not a promise queue in the route.** The row has
  to exist regardless — it is what the SPA polls — so driving off it is strictly less machinery than
  a queue that would also have to be reconciled with it, and it survives a restart.
- **`PUT` answers 202.** A clone is minutes; a request that waited for one would be killed by any
  proxy in front of it.
- **Rows stranded in `cloning` are requeued at boot.** A `cloning` row is owned by a process that no
  longer exists and the claim only takes `queued`, so without this it stays `cloning` forever while
  nothing is cloning it — a spinner that never resolves. Sound only because a `cloning` row can be
  owned solely by a live in-process runner and at boot there are none; that single-process
  assumption is written into `011`'s header, and the escape hatch named there is a
  `claimed_by`/`lease_expires_at` pair exactly like `job`'s. The claim query is already
  `for update skip locked`, so a second replica would break that one statement and nothing else.
- **Stale `.tmp-<pid>` trees are swept at boot.** The rename into place is atomic, so a `.tmp-`
  directory is never a finished clone and never anything anybody wants. Without the sweep every
  interrupted clone leaks a checkout's worth of disk permanently.
- **Two clones at a time**, and raising it makes no single clone finish sooner.
- **A fresh installation token per repository.** They last an hour and a batch of clones can outlive
  one, so taking a token once for the batch would fail the tail with a 401 that reads as a rejected
  credential.
- **A clone failure is recorded against the row, not thrown.** `cloneRepo` throws where the old
  boot-time reconcile counted a failure — it swallowed the message because boot had nowhere to put
  one, and now there is a column called `error` and a page that shows it. One member's broken
  repository must not stall everybody else's clones.

## Touching a checkout

Unchanged, and every rule is about the same thing: the tree may hold uncommitted work belonging to a
Claude Code session, and this process cannot tell.

- **An existing checkout is never touched, and nothing is ever pruned.** `.git` present means skip:
  no fetch, no reset, no branch change. Re-selecting a repository that is already `ready` does not
  re-clone it.
- **A directory that exists and is not a checkout aborts that clone.** It means the root points at
  the wrong tree, and continuing would scatter clones through somebody's home directory.
- **Cloned into `<name>.tmp-<pid>` and renamed into place.** A process killed mid-clone would
  otherwise leave a partial tree that the next attempt classifies as "exists, not a checkout" — the
  rule above then fails forever, on a directory nobody deliberately created.
- **The token reaches git through the environment, and only a credential-helper snippet reaches
  argv.** A token in the clone URL is world-readable in `/proc/<pid>/cmdline`, and git writes the URL
  permanently into `.git/config`, where every later `git remote get-url origin` prints it —
  including the one `backfill/transcripts.ts` runs. `http.extraHeader` has the same argv problem;
  `GIT_ASKPASS` needs a script on disk. The helper list is cleared with a leading empty
  `-c credential.helper=` first, or an inherited `osxkeychain`/`store` answers with a stale
  credential. `GIT_TERMINAL_PROMPT=0` is set because an unauthenticated private clone would
  otherwise block on stdin forever.
- **No token is a supported state here too.** Under the offline tooling's code-only `none` arm
  public repos clone and private ones report a named failure.
- **Full clone, not `--depth 1`.** A reused branch has to be built on in place, which needs the
  commits below it — the runner's git orchestration reuses existing branches and pushes.
- **`node:24-alpine` ships no git**, so `docker/Dockerfile` installs it. Absent, the failure is an
  ENOENT per repo that appears only in the container and never in dev.

## What the page reads

`docs/workspace.md` used to say "nothing rendered on the page comes from here". That is no longer
true: the workspace payload feeds Settings, and since #181 the checkout facts — each checkout's
branch, newest commit and size on disk — render on Settings → Repositories, beside the selection
that produced them. Settings → Workspace keeps what is personal: the root sentence, the member's
own environment scope, and the `Still on disk` list of deselected but unpruned checkouts.

- **Those three are cached, and a cold read is `null` rather than awaited.** The route is polled, and
  read naively that is a `git log` plus a recursive directory walk per repo per member per tick. The
  branch and last commit refresh every 30 seconds; the size walk every five minutes, run as `du`
  in a child process bounded at 20 seconds. The route serves what is cached and schedules the
  refresh.
- **`null` means "not measured", never zero.** A repository that is still cloning has no size, and
  `0 B` would be a claim about an empty repository. The same contract the metrics panels follow.

## Executors

Settings → Executors shows the member's configured executors (moved off the workspace page by #150 —
executors configure what a runner runs with and have nothing to do with checkouts), under the scope
sentence "Your saved agent settings for running tasks." A row is a name, an agent type and a
configuration object — `{}` when the member set nothing, which inherits the deployment's runner
configuration. The known types are `claude-code` and `opencode` (013 added the second; see
[persistence.md](persistence.md) for the constraint-rewrite move adding the next one costs). The
Tasks page lets a member stamp one of these names onto a job they queue, and the claim resolves that
label against the author's rows at run time — the name is the join key, which is why it is never
validated against the list when the task is queued (`job` is an audit record; the rows come and go
with a PUT).

- **Both `opencode` and `claude-code` config reach the run.** At claim, the job store reads the
  author's row of the stamped name (`configFor`) and hands the pasted config to the runner as a
  claim-env value each CLI's entrypoint merges over its baked configuration —
  `OPENCODE_CONFIG_CONTENT` for an opencode row (verified against the pinned runner image: baked
  plugins, instructions and permission fence survive, member `model`/`provider`/`small_model` land),
  `CLAUDE_CODE_CONFIG_CONTENT` for a claude-code row with `hooks`, `enabledPlugins` and
  `extraKnownMarketplaces` stripped (the git guard hook and the baked context-mode plugin install).
  Both strip lists are one constant, `RUNNER_MANAGED_KEYS` in `core/src/executors.ts`: the claim
  strips by it and the dialog warns by it. This is what makes the member's model and provider choice
  authoritative; without a matching row the run falls back to the image's default model.
- **`permission` is stripped board-side, never honored from a paste.** The baked fence in the
  runner image (and the entrypoint's per-member `external_directory` patch) is the only authority
  on what a run may touch: a pasted `external_directory: "*": allow` would otherwise open every
  member's tree to one run. Every other key travels verbatim.
- **The selected label drives the run.** At claim time the board resolves the label in the task
  author's executor list and sends that row's type to the driver. `claude-code` selects the Claude
  Code image and CLI; `opencode` selects OpenCode. A label matching no row — renamed, deleted or
  free text — is an unresolved selection, and the driver fails the task explicitly instead of
  guessing a runner.
- **Guided setup is the default; JSON is Advanced (issue 261).** The dialog reads Name (shown in the
  task picker), Agent (Claude Code / OpenCode), Model ("Use runner default", or a custom
  identifier), then a collapsed **Advanced configuration** holding the JSON editor and the gate
  repair rounds. A name and an agent save `{}`; the member never types it, and the note says that
  saving checks the form only — not credentials, not whether the model exists. The Model control
  is `config.model` and nothing else: it writes that one key into the configuration text, keeping
  every other key and its order, and while the text does not parse (or `model` is not a string) the
  control is disabled with a sentence pointing at the JSON — a guided value never silently
  replaces a raw draft. Each agent keeps its own configuration text for the life of the dialog, so
  switching agents neither reinterprets nor discards the other's. There is no model catalogue: the
  help names each agent's identifier shape (`claude-sonnet-4-5` or an alias; `<provider>/<model>`
  for OpenCode). The credentials sentence links to Workspace settings (the member's environment),
  forwarding the composer's return param so the draft banner survives the detour.
- **The dialog edits as well as adds, and validation is structural.** Each row carries an Edit
  action that reopens the dialog pre-filled with the row's type, name and config; a rename saves
  under the new name and is matched against the old one. The server checks the config is an object
  with a known type, unique path-segment-safe names, at most 10 per member, and the `user_executor`
  check constraint restates the type list at the row. The dialog mirrors that client-side
  (`web/src/workspace/executors.ts`): a JSON object under 32 KiB, parse errors with the engine's
  line and column where it reports one, a name that is non-blank, slash-free, not `-`/`.`-leading
  and not another row's — shown beside the field before Save — and a string `model`. Valid JSON is
  not a tested configuration, and the help says so. Settings the runner will not honor (the
  `RUNNER_MANAGED_KEYS` of the agent, plus Claude Code's `CLAUDE_CODE_ENABLE_TELEMETRY`/`OTEL_*`
  env) are listed by key path — never value — under the editor. Field-level rules beyond `model`
  wait until a consumer exists that can be wrong about them — the opencode consumer reads `model`,
  `small_model` and `provider` only by opencode's own merge semantics, not by schema.
- **Saving is predictable.** The actions read "Add executor" / "Save changes"; a disabled Save says
  why beside it, and an edit that changes nothing (formatting and key order included) stays
  disabled with "No changes to save." A failed save keeps every field for a retry; a successful one
  closes, restores focus to the trigger and is announced in the page's `role="status"` line. Adding
  never flags the new row as the default. Cancel, Escape, the backdrop or the credentials link with
  unsaved work raise the settings area's discard confirmation (`UnsavedChangesDialog`, nested
  inside the executor dialog).
- **Each row also carries the default workflow's gate-repair round limit (issue #49).** The dialog's
  Advanced `Gate repair rounds` field is a whole number 0..10 (042's check constraint restates the
  bound at the row), `3` when left blank, `0` turning automatic gate repair off. `POST /api/jobs`
  reads the row the task's executor label names at launch and freezes the value onto the thread
  (docs/workflows.md), so editing it later changes later tasks, never a running one — and the task
  view counts the thread's spent repair rounds against the frozen budget.
- **The page refuses before any dialog when there is no root.** With `root: null` the header drops
  its Add action and the page renders a sentence pointing at workspace setup — both executor
  routes would answer 409 `WORKSPACE_DISABLED` anyway, so the client refuses first instead of
  discovering it after a fetch.
- **A member may flag one executor as the default (issue 215).** Each row's `is_default` column
  (040) is a real preference, not list order: the panel's Make default action flags a row and
  clears every other, `withDefault` folds that back into the whole-list PUT the same way
  `mergeExecutors` folds a dialog save, and 040's partial unique index makes "at most one default
  per member" a database fact — the route refuses a body naming two before it ever reaches the
  row. The task composer and the settings overview both read it through `defaultExecutorName`,
  which falls back to the first row when none is flagged — the pre-215 behavior, unchanged for a
  member who has never used the action. A rename keeps the flag (matched by the row's original
  name, same as `mergeExecutors`); dropping the default row from a PUT clears it rather than
  reviving it on another row — the flag lives on the row, not on a name. "Selected first on new
  tasks" is what the fallback still says; the flagged row says "Default — selected on new tasks"
  instead.
- **The Advanced help says what each type's config does.** The claude-code help: merged into the
  runner's settings.json, with `hooks`, `enabledPlugins` and `extraKnownMarketplaces` stripped —
  everything else applies, except that the `CLAUDE_CODE_ENABLE_TELEMETRY`/`OTEL_*` env values
  live in the image's managed settings (with the driver's `OTEL_EXPORTER_OTLP_ENDPOINT` patched in)
  and always win over anything a member sets. The opencode help: merged over the baked
  configuration by the selected OpenCode runner — model and provider apply, permission rules
  ignored. Every help is tied to its field with `aria-describedby`.
- **Types are labelled for people, stored for machines.** List and dialog show "Claude Code" and
  "OpenCode"; the stored `type` stays the raw union value (`claude-code`, `opencode`).
- **`config` is never echoed by the poll — one on-demand read excepted.** It may hold credentials
  the member pasted, and `GET /api/workspace` can run every two seconds. The row's `name`, `type`,
  `createdAt` and `isDefault` travel; the JSON stays in the table (the claim-time `configFor` read
  is the one read that selects it) — except for `GET /api/workspace/executors`, which answers WITH the configs
  because the edit dialog cannot pre-fill without them. It is fetched once per dialog open, never
  on a tick, which is what keeps the credentials out of the poll without making an executor
  uneditable.
- **A rename leaves the stamped tasks alone, on purpose.** `job.executor` was an audit stamp at
  queue time; historical tasks keep showing the old name, and a follow-up continues on the
  executor that ran it (copied at insert, not looked up again). A task queued against a name that
  no longer matches a row — renamed or deleted — fails with an unresolved-executor reason.
- **The whole list is a PUT.** Same argument as the repos selection: the body is the entire list,
  so a retried request after a dropped connection changes nothing.

## The workspace boundary, stated exactly (#382)

**The mount is a MEMBER boundary. It is not a task boundary and not a repository boundary.** Both
executors mount one member's `<orgId>/<userId>` subtree and only that subtree — on Kubernetes as a
`subPath` on the workspaces claim, on Docker as `--mount volume-subpath=`. Both are bind mounts, so
the rest of the volume is not merely unreadable from inside the container, it is **absent**: no
sibling member's path resolves, `..` reaches the container's own rootfs rather than the volume
root, and a symlink has nothing in the namespace to point at. `scripts/test-k8s.sh --cluster`
proves exactly that, from inside a pod, with traversal, absolute-path and symlink probes.

What follows from it, stated rather than left to be discovered:

- **Every task belonging to the same member shares that subtree**, including concurrent ones. Two
  tasks of one member can read and write each other's checkouts, each other's `.worktrees/<root
  job id>` directories, each other's caches and each other's transcripts. The per-thread worktree
  separates them by *convention and path*, never by a kernel boundary.
- **Every repository that member selected is in the same subtree.** A task queued against one
  repository can read the checkouts of all the others.
- **A different member, or a different organization, is unreachable.** That is the boundary the
  mount actually draws, and the one the probes cover.

Narrowing this to a task would be a different mount design, not a tightened parameter: the git
metadata a worktree needs lives in the member's clone (`.git` is shared by every worktree of it),
the sync and publish steps write across both, the executor caches are per-member by construction,
and the transcripts are read back by path after the run. A task-scoped mount has to answer all
four before any of it can be written, and **this change deliberately does not touch mount code** —
the issue asks for the design first. Until then, no part of this system claims task isolation from
the workspace mount, and neither should any document describing it.

## Limitations

- **Nothing prunes automatically, and per-member checkouts multiply that by the number of members.**
  Deselecting a repository frees nothing by itself; what reclaims disk is the member's own manual
  purge (below). The reason nothing is automatic has not changed and is the reason nothing can be
  built here safely: this process cannot tell a stale clone from one holding an agent's uncommitted
  work. The driver's task worktrees only LOOK like that — a task the user closed or deleted does
  clean its tree up: when the whole thread is terminal AND the user has marked it done (or removed
  it) the driver removes the per-thread worktree and prunes its admin entry (issue #47,
  `docs/jobs.md`), keeping the surviving `factory/<root>` branch so a follow-up can recreate the
  tree when its claim restores. A thread that failed or finished without the done keeps its tree —
  the tree is what its next turn continues from. What still grows unbounded is the member CLONES,
  which hold the per-thread worktrees' branches — which is exactly what the purge asks the member
  to give up, by name, in its confirmation.
- **What exists instead:** a per-member cap of 20 repositories, so one click cannot clone an entire
  GitHub organization onto a shared volume; a reported `sizeBytes` per checkout; an `orphaned` list
  of deselected repositories that are still on disk, with sizes; a per-member checkout total; and —
  since #92 — the delete.

## The manual purge (#92)

- **One member, one orphan, deliberately.** `DELETE /api/workspace/repos/:owner/:name` removes the
  row's `<root>/<orgId>/<userId>/<repo_name>` directory and then the row. The identity comes from
  the authenticated caller and the stored row, never a client-supplied path — `workspaceDir`
  asserts the uuid as always — and the sibling `.worktrees/` directory is never traversed. `202`
  means a removal child is running; `204` means there was nothing to remove. The confirmation names
  what is lost — uncommitted work, and the local `factory/<root>` branches a follow-up would have
  reused — because this is the one deletion that can destroy agent work: a clone may hold
  exactly that, and only the member can know.
- **The refusal list is the safety list.** A selected row (whatever its clone status), a row still
  owned by a clone (`cloning`), and a row with unfinished tasks cannot be purged. Tasks are counted
  for this member by the checkout's repo NAME — the directory is keyed by name even when an old
  task's `owner/name` differs — and a task blocks when its THREAD is not over: any member
  nonterminal, or no member marked done. Command-only tasks run in no checkout and never block.
  Each refusal is decided under the row's lock, in one transaction (`stampPurge`), which is what
  makes the races unlosable: a selection that commits first makes the stamp's deselection check
  fail; a stamp that commits first blocks re-selection (`409 PURGE_IN_PROGRESS`) and both
  job-insert paths (below).
- **The stamp is released only by an observed child exit.** After `purging` commits, the route
  answers 202 and the directory comes down in a bounded child process (`rm -rf`, 60s, killed and
  reaped on timeout) OUTSIDE any database transaction. The row is deleted in a second transaction
  only if it is still deselected and still `purging` — and only once the child has exited. An
  error lands the row deselected, `failed`, with the reason: visible and retryable, the row
  outliving any partial directory. No DB compare-and-delete is trusted to protect against a
  still-running filesystem deletion, and there is no in-process watchdog: a crash orphans the
  stamp, and boot recovery finishes it.
- **Boot recovery is the single-process assumption, extended.** 011's header already said a
  `cloning` row is owned solely by a live in-process runner; 044 says the same of `purging`. At
  boot, before the clone queue starts and before the runtime is served to any route — every
  workspace mutation and task creation resolves its org through `orgs.for()`, which awaits the
  build — each interrupted `purging` row is finished (residue removed, row deleted) or marked
  `failed` with the reason.
- **A missing directory is a successful cleanup.** A stale row whose tree is already gone is
  deleted in line (204, no child spawned); the GET's orphan list simply does not show it, because
  the list is about what is on disk — one stat per row, never a walk.
- **The facts cache learns `invalidate` for exactly one caller.** For most of its life there was
  no invalidate and the header said so; the purge is the one case where a cached measurement can
  outlive its tree, and a re-selected repository reuses the path. Without it the new checkout
  would briefly report its predecessor's size and commit.
- **The driver's reclaim tolerates the purge.** A finished task's worktree reclaim may race a
  purge that deleted the parent clone. `git-worktree-remove.cjs` settles the tree from what the
  tree itself knows when REPO is absent — a task worktree's `.git` file names the clone's admin
  dir, and only such a tree is removed; anything else keeps the refusal, and there is no prune
  when there is no clone to prune into. Docker and kubernetes run the same script.
- **Clones drift from their remotes**, because nothing fetches — but a task never works on the
  drift: the driver's startup sync creates the task worktree from `origin/<default>` fresh at
  each task's starting claim, which is why the drift is survivable at all. A claim that
  continues a session (a follow-up) restores the tree without fetching —
  mid-flight is exactly when a task must not sync with main (issue #58).

## Tests

- **`workspace.reconcile.test.ts` never reaches the network.** It clones `file://` from a bare repo
  it builds itself, with `user.email`, `user.name`, `init.defaultBranch` and `commit.gpgsign` all
  pinned on the command line so the fixture does not depend on the runner having a global git
  config. Auth is covered through the injected `run` seam, which is the only way to assert the token
  is in the child environment and *not* in argv.
- **`workspace.queue.test.ts` uses the same `run` seam** to drive the whole queue — claiming,
  failure recording, restart recovery — without git running at all.
- **`e2e/workspace.spec.ts` drives real provisioning** against a root under `artifacts/`, never
  `$HOME`: that run creates directories and must not do so anywhere a developer keeps work.
