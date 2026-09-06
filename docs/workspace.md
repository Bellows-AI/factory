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
  literal rather than empty-defaulted like `ORG_ID` / `ORG_NAME` for the same reason as before:
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
- **Legibility is the real cost, and it is paid with a breadcrumb rather than with a key.**
  `<userId>/.factory-workspace.json` names the login, so `ls` is not a wall of uuids. It is
  deliberately never read by any code: a breadcrumb something resolves against is a second source of
  truth for what `app_user.id` already is.
- **`workspaceDir()` asserts the uuid before it joins anything**, and `driver/src/docker.ts` asserts
  the whole `<org>/<uuid>` again before interpolating it into a `docker run`. The same posture
  `remoteSessionArgs` already takes with a session id — except here the value becomes an agent's
  working directory, and `..` in it points at the parent of every member's tree.
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
- **No token is a supported state here too.** Under `GITHUB_MODE=none` public repos clone and
  private ones report a named failure.
- **Full clone, not `--depth 1`.** Base-branch history and revert detection read history.
- **`node:24-alpine` ships no git**, so `docker/Dockerfile` installs it. Absent, the failure is an
  ENOENT per repo that appears only in the container and never in dev.

## What the page reads

`docs/workspace.md` used to say "nothing rendered on the page comes from here". That is no longer
true: the Workspace page reports each checkout's branch, newest commit and size on disk.

- **Those three are cached, and a cold read is `null` rather than awaited.** The route is polled, and
  read naively that is a `git log` plus a recursive directory walk per repo per member per tick. The
  branch and last commit refresh every 30 seconds; the size walk every five minutes, bounded at
  200,000 entries. The route serves what is cached and schedules the refresh.
- **`null` means "not measured", never zero.** A repository that is still cloning has no size, and
  `0 B` would be a claim about an empty repository. The same contract the metrics panels follow.

## Executors

The page also shows the member's configured executors, below the repositories. This is
**configuration storage only**: a row is the JSON a member pasted into the add dialog, and nothing
runs an executor yet — wiring one into the driver is future work. The known types are
`claude-code` and `opencode` (013 added the second; see [persistence.md](persistence.md) for the
constraint-rewrite move adding the next one costs). The Tasks page lets a member
stamp one of these names onto a job they queue — metadata the tasks chat displays, never checked
against this list — and still nothing runs.

- **The dialog is add-only, and validation is structural.** The contract is "raw JSON the member
  pastes"; the server checks it is an object with a known type, unique path-segment-safe names, at
  most 10 per member, and the `user_executor` check constraint restates the type list at the row.
  Field-level rules wait until a consumer exists that can be wrong about them.
- **`config` is never echoed by the poll.** It may hold credentials the member pasted, and
  `GET /api/workspace` can run every two seconds. The row's `name`, `type` and `createdAt` travel;
  the JSON stays in the table.
- **The whole list is a PUT.** Same argument as the repos selection: the body is the entire list,
  so a retried request after a dropped connection changes nothing.

## Limitations

- **Nothing prunes, and per-member checkouts multiply that by the number of members.** Deselecting a
  repository frees nothing; `docker compose down -v` is the only reclaim. The reason has not changed
  and is the reason nothing can be built here safely: this process cannot tell a stale clone from
  one holding an agent's uncommitted work.
- **What exists instead:** a per-member cap of 20 repositories, so one click cannot clone an entire
  GitHub organization onto a shared volume; a reported `sizeBytes` per checkout; and an `orphaned`
  list of deselected repositories that are still on disk, so growth is at least visible on the page
  rather than only in `df`. That list is where a prune button would attach.
- **Clones drift from their remotes**, because nothing fetches.

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
