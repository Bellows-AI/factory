# Workspace

A per-member tree at `<root>/<orgId>/<userId>/`, one clone per repository that member selected,
so something can be *run* against a checkout.

| Concern | Code | Test |
| --- | --- | --- |
| `ORG_WORKSPACE_ROOT`, its default and refusals | `server/src/config.ts` | `server/test/config.workspace.test.ts` |
| Creating a member's tree at sign-in | `server/src/workspace/provision.ts` | `server/test/workspace.provision.test.ts` |
| Path construction (`workspaceDir`), cloning, git argv and credentials | `server/src/workspace/reconcile.ts` | `server/test/workspace.reconcile.test.ts` |
| The clone queue, claim, restart recovery | `server/src/workspace/queue.ts` | `server/test/workspace.queue.test.ts` |
| Branch / commit / size facts and their cache | `server/src/workspace/facts.ts` | `server/test/workspace.facts.test.ts` |
| Manual purge of one orphaned checkout | `server/src/workspace/purge.ts`, `server/src/routes/workspace-purge.ts` | `server/test/workspace.purge.test.ts`, `server/test-db/purge-races.test.ts` |
| Routes and the payload the page polls | `server/src/routes/workspace.ts` | `server/test/routes.workspace.test.ts` |
| Repo selection rows and their constraints | `server/src/db/user-repo-store.ts`, `server/migrations/011_user_workspace.sql`, `044_user_repo_purge.sql` | `server/test-db/user-repo-store.test.ts` |
| Executor profiles (user and org scope) | `server/src/db/user-executor-store.ts`, `server/src/routes/org-executors.ts`, `server/migrations/047_executor_profile_scope.sql` | `server/test-db/user-executor-store.test.ts`, `server/test/routes.org-executors.test.ts` |
| The executor dialog's client-side validation | `web/src/workspace/executors.ts`, `web/src/panels/WorkspaceExecutorsPanel.tsx` | `web/test/executors.test.ts`, `e2e/org-executors.spec.ts` |
| Real provisioning in a browser | `e2e/workspace.spec.ts` | the `chromium` Playwright project |

Mount shape and its boundary: [security.md](security.md). Task worktrees: [jobs.md](jobs.md).

## Invariants

- **The subtree is a member boundary, not a task boundary.** Every task of the
  same member shares that subtree and one uid 1000; narrowing it per task is a different design,
  and the
  per-member `subPath` deliberately does not touch mount code beyond that segment.
  `driver/src/k8s-podspec.ts`, `driver/test/k8s.test.ts`.

- **The path segment is `app_user.id`, never the login** — a freed GitHub login would hand a
  stranger a working tree. `workspaceDir` asserts the uuid before joining and
  `driver/src/docker.ts` re-asserts `<org>/<uuid>` before interpolating it into an argv.
- **An existing checkout is never touched and nothing is pruned automatically.** `.git` present
  means skip: the tree may hold an agent session's uncommitted work and nothing here can tell.
- **The clone token reaches git through the child environment, never through argv or
  `.git/config`** — a URL-embedded token is world-readable in `/proc/<pid>/cmdline` and persists
  into every later `git remote get-url`. The helper list is cleared with a leading empty
  `-c credential.helper=` first. Asserted through the injected `run` seam in
  `server/test/workspace.reconcile.test.ts`.
  Clones therefore go to `<name>.tmp-<pid>` and are renamed in; stale `.tmp-` trees are swept at
  boot, or a partial one classifies forever as "exists, not a checkout".
- **A `cloning` or `purging` row is owned by a live in-process runner**, so boot requeues or
  finishes the interrupted ones before the queue starts and before any route is served — the
  single-process assumption `011_user_workspace.sql` states (`server/test/workspace.queue.test.ts`).
- **Every purge refusal is decided under the row's lock in one transaction** (`stampPurge`) and
  the stamp is released only by an observed child exit. `server/test-db/purge-races.test.ts`.
- **`null` size means "not measured", never zero**, and only the purge invalidates the facts
  cache, since a re-selected repository reuses the path. `server/src/workspace/facts.ts`.
- **A pasted executor config reaches the runner stripped of `RUNNER_MANAGED_KEYS`**
  (`core/src/executors.ts`) and of `permission`, by the same constant the dialog warns by.
  `server/src/db/job-store-claim.ts`, `server/test-db/job-store.attribution.test.ts`.
- **`config` never rides the poll** — it may hold credentials; only the edit dialog's
  `GET /api/workspace/executors` and the claim-time `configFor` select it.
  `server/src/routes/workspace.ts`, `server/test/routes.workspace.test.ts`.
- **An executor label is resolved at claim time in the stamped scope**, never validated at queue
  time, so a renamed or deleted profile fails the task explicitly rather than guessing a runner.
  `server/test-db/job-store.executor-scope.test.ts`.
- **`node:24-alpine` ships no git**, so `docker/Dockerfile` installs it; absent, every clone is an
  ENOENT that appears only in the container.

## Stated limits

- Unset `ORG_WORKSPACE_ROOT` clones nothing and `GET /api/workspace` answers `{root: null}`.
- Nothing fetches, so clones drift; a task works from a worktree cut off `origin/<default>` at its
  starting claim ([jobs.md](jobs.md)).
- Caps: 20 repositories and 10 executor profiles per member; two clones at a time.
