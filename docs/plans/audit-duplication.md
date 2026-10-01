# Duplication audit

Every finding below was verified by reading the cited code. Line numbers are as of the audit.
Ranked by payoff (drift risk × sites × cost to fix).

Method: normalized sliding-window (4–6 line) hashing across `core/src`, `server/src`, `web/src`,
`driver/src`, followed by manual read of each hit. `server/src/db` produced **zero** cross-file
duplicates — that layer is clean and is not discussed further.

---

## 1. `EXECUTOR PARITY BUG` — docker and k8s disagree on prompt delivery and on the opencode session guard

Files: `driver/src/docker.ts:479-501` (`pushClaudeCodeArgs`, `pushOpencodeArgs`) vs
`driver/src/k8s-podspec.ts:170-224` (`opencodeRunnerPlan`, `claudeRunnerPlan`).

These two pairs are near-identical copies that compose the same argv/env for the same executor
images. Two places where the copies have **already drifted into different behavior**:

**a) claude-code prompt delivery.** docker delivers the prompt unconditionally:

```ts
// docker.ts:500
args.push('-p', job.command);
```

k8s suppresses it on a resume that is not a follow-up:

```ts
// k8s-podspec.ts:219-221
const deliver = !session.resume || job.followUp;
...
if (deliver) args.push('-p', job.command);
```

So a resumed (non-follow-up) claim re-delivers the command under `EXECUTOR=docker` and does not
under `EXECUTOR=kubernetes`. One of the two is wrong; the surrounding comments in both files each
claim to be "the identical twin" of the other.

**b) opencode session guard predicate.** docker refuses on `session && !session.resume`
(`docker.ts:449`); k8s refuses on `session && !job.followUp` (`k8s-podspec.ts:176`). Different
predicates, different messages ("cannot adopt a minted session" vs "restores a session only for a
follow-up").

**Fix:** extract one platform-neutral planner that answers `{ envPairs, cliArgs }` from
`(config, job, session)`, and let each transport render it — docker as `-e NAME=value` + argv,
k8s as `EnvVar[]` + `args`. The refusals and the `deliver` decision then exist once. This is the
highest-payoff item: it is the only finding that is also a live behavioral bug, and it sits
exactly on the parity boundary AGENTS.md calls primary.

Smaller duplicates in the same pair, folded into the same refactor:

- The worktree-resolution guard and its exact refusal string: `docker.ts:361-366` ==
  `k8s-podspec.ts:260-265`.
- The `SESSION_ID.test(session.id)` assertion and its refusal string: `docker.ts:460-463` ==
  `k8s-podspec.ts:181-184`.
- `FACTORY_TRANSCRIPT_DIR` / `BELLOWS_SESSION_ID` / `XDG_DATA_HOME` name+value construction,
  duplicated verbatim in both.

---

## 2. 24 hand-rolled copies of the same k8s HTTP status check

Files: `driver/src/k8s-runner.ts` (10), `k8s-fence.ts` (14 refs), `k8s-poll.ts` (9),
`k8s-services.ts` (6), `k8s-gates.ts` (3), `k8s-helper-runner.ts` (3).

Every k8s call site repeats:

```ts
if (X.status >= HTTP_ERROR_STATUS) {
    throw new Error(`<what> answered ${X.status}: ${X.body.slice(0, ERROR_PREVIEW_CHARS)}`);
}
```

24 literal occurrences of the `.body.slice(0, ERROR_PREVIEW_CHARS)` message tail (full list:
`k8s-poll.ts` 162/193/219/289/365/378/404; `k8s-gates.ts` 59/111/233; `k8s-fence.ts`
79/106/128/278/359/385; `k8s-helper-runner.ts` 53/66; `k8s-runner.ts` 96/298/319;
`k8s-services.ts` 41/119/133).

Only the `what` string and the failure *channel* differ (throw / `publishFailed(...)` /
`{ ok: false, reason }` / `gateHarness(...)`). `k8s-gates.ts:57` additionally tolerates
`HTTP_CONFLICT`.

**Fix:** one helper in `k8s-transport.ts`, e.g.
`function refusal(res: K8sResponse, what: string): string | null` returning the formatted message
or `null`, plus `expectOk(res, what)` that throws it. Each site becomes one line and keeps its own
channel. Low risk, mechanical, removes ~100 lines.

---

## 3. Five copies of the attempt-scoped Secret body — one of which already has a helper

`driver/src/k8s-podspec.ts:368` already exports:

```ts
export const secretBody = (job: BoardJob, env: Record<string, string>) => ({ ... });
```

It is used by exactly **one** caller (`k8s-fence.ts:356`). Four other sites hand-build the same
`{ apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name, labels: { [JOB_LABEL]:
job.id, [LEASE_LABEL]: job.leaseToken } }, stringData }` object:

- `k8s-runner.ts:289` (publish secret)
- `k8s-helper-runner.ts:42` (helper secret)
- `k8s-poll.ts:352` (sync secret)
- `k8s-gates.ts:47` (gate env secret)

`secretBody` takes a fixed name (`secretName(job)`); these need a caller-supplied name, so the
fix is to widen it to `secretBody(job, name, env)` and route all five through it.

**Adjacent drift already present:** `k8s-gates.ts:47` writes the path by hand as
`` `/api/v1/namespaces/${deps.config.k8sNamespace}/secrets` `` while every other site calls
`secretsPath()` from `k8s-auxspec.ts:365`. Same string today; a namespace-path change would miss it.

---

## 4. `workspacePath()` reimplemented three times inside the driver

`driver/src/claim.ts:97` is the canonical:

```ts
export function workspacePath(job: BoardJob): string {
    const path = workspacePathOf(job);
    if (!path) throw new Error(`refusing to run job ${job.id}: the board reported no usable workspace path (${job.workspacePath ?? 'null'})`);
    return path;
}
```

Byte-identical bodies at:
- `driver/src/k8s-podspec.ts:85` — exported as `workspaceSubPathOf`, a rename with no behavior change.
- `driver/src/k8s-podspec.ts:245` — inlined a third time inside `runnerJobSpec`.

And the `.bellows.yaml` variant is duplicated twice:
- `driver/src/services.ts:595` `assertedWorkspacePath(job)`
- `driver/src/k8s-podspec.ts:650` — same check, same two-line refusal string, inlined in
  `bellowsJobSpec`.

**Fix:** delete `workspaceSubPathOf`, import `workspacePath`; export `assertedWorkspacePath` from
one home and import it in `bellowsJobSpec`. Pure deletion, no behavior change.

---

## 5. Web: 22 copies of the same failed-response parse, and a helper that already exists but is private

Files: `web/src/api/*.ts` — `useTasks.ts` (5), `useWorkspace.ts` (4), `useAccessTokens.ts` (3),
`useDefaultWorkflowSettings.ts` (3), `useEnv.ts` (2), and one each in `useStats.ts`, `useJobs.ts`,
`useRepos.ts`, `useCompletedJobs.ts`, `useWorkflows.ts`.

Every one is:

```ts
const body = (await response.json().catch(() => ({}))) as { error?: string };
<something>(body.error ?? `<verb-specific message> (${response.status})`);
```

`web/src/api/useWorkflows.ts:128` already implements precisely this as `refusalOf(response)` —
and is the only one that also preserves `body.code`. The other 21 sites silently drop the API's
error code, which `core/src/error-codes.ts` exists to make meaningful.

**Fix:** move `refusalOf` to a shared `web/src/api/refusal.ts`, taking an optional fallback verb
(`refusalOf(response, 'Could not save')`). One import per hook; also recovers `code` everywhere.

**Outlier worth a look while in there:** `useSession.ts:101` does *not* read the body at all
(`setError(\`Could not check the session (${response.status})\`)`), so a server-supplied message is
always discarded there.

---

## 6. Web: five hooks each reimplement the same abortable polling loop

- `useStats.ts:65,86,131`
- `useJobs.ts:192-193,262-268,283`
- `useCompletedJobs.ts:6-26,82,93`
- `useWorkspace.ts:71-108,196-228`
- `useTasks.ts:298-309,489,514-528`

Each holds `controller: useRef<AbortController|null>` + `timer: useRef<number|null>`, and
re-derives the same skeleton: abort the previous controller, mint a new one, `void poll(signal)`,
`window.setTimeout(() => void poll(signal), delay)`, `window.clearTimeout` on stop and on unmount.
Confirmed near-identical `start`/`refresh` bodies at `useJobs.ts:266` and `useWorkspace.ts:216`;
identical `refresh` bodies at `useEnv.ts:92`, `useAccessTokens.ts:69`, `useWorkflows.ts:177`.

The *delay policy* genuinely differs per hook (visible/hidden pairs, `useWorkspace`'s elapsed-time
backoff, `useTasks`'s moving/idle matrix) and should stay per hook.

**Fix:** one `usePoll({ poll, nextDelay })` owning the controller/timer refs and the unmount
cleanup; each hook supplies only `nextDelay`. Medium effort, removes the class of bug these refs
exist to prevent (the `useWorkspace.ts:210` comment documents one such race already hit).

---

## 7. Server: a 4-line route preamble repeated 15 times

`server/src/routes/job-handlers-worker.ts` (7) and `job-handlers-actions.ts` (8):

```ts
const store = await storeFor(orgs, request);
if (!store) return noBoard(reply);
const id = (request.params as { id: string }).id;
if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');
```

A second variant appears 5 times in `workflows.ts` (192, 205, 236) and `tokens.ts` (100, 157):

```ts
const caller = callerOf(request);
if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
const { id } = request.params as { id: string };
if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');
```

And `boardsFor + noBoard + validateClaimBody` repeats identically at
`job-handlers-worker.ts:96` and `job-handlers-actions.ts:152`.

**Fix:** `server/src/routes/helpers.ts` already hosts `bad`/`body`/`guard`; add
`resolveJobRoute(orgs, request, reply)` returning `{ store, id } | null` and
`resolveCallerRoute(request, reply)`. 15 call sites lose 3 lines each and the `BAD_ID` message
stops being 15 independent string literals.

---

## 8. Server: `checkRepoVisible` is `checkReposVisible` with a one-element list

- `server/src/routes/workspace.ts:219` `checkReposVisible(repos, selection: Repo[])`
- `server/src/routes/env.ts:130` `checkRepoVisible(repos, repo: Repo)`

Same return type, same `new Set((await repos.list()).map(fullName))`, same `lastError()`
unavailable branch, same `UNKNOWN_REPO` message string verbatim. The only difference is the
`UNAVAILABLE` message wording ("Cannot check the selection…" vs "Cannot check the repository…").

**Fix:** one exported `checkReposVisible(repos, selection, { subject })`; `env.ts` calls it with
`[repo]`.

---

## 9. Web: the inbox query string is built twice

- `web/src/api/useTasks.ts:107` `export function inboxQueryString(filters)` — already exported.
- `web/src/pages/TaskInboxPage.tsx:35` `filtersUrl(filters)` — re-implements the same five
  `params.set` lines, then wraps the result in `/tasks?`.

**Fix:** `TaskInboxPage`'s `filtersUrl` becomes two lines over `inboxQueryString`. Trivial, and
today a new filter key must be added in both or a shared link silently loses it.

Related constant duplication, same feature: `QUERY_MAX = 200` exists three times —
`server/src/routes/tasks.ts:29`, `web/src/api/useTasks.ts:78`, and
`web/src/pages/TaskInboxPage.tsx:47` (as `SEARCH_QUERY_MAX`, whose comment literally says
"mirrors `QUERY_MAX` in `useTasks.ts`"). The server/web pair belongs in `core`; the web/web pair
is a plain import away.

---

## 10. Web: `SideNav` and `MobileNavDialog` render the same nav list

`web/src/components/SideNav.tsx:100-150` vs `web/src/components/MobileNavDialog.tsx:61-112`.

Both map `NAV_ITEMS` into `NavLink`s with the same `sidenav-link` / `is-active` class expression,
the same `end`, the same `ariaCurrentFor(item, pathname)`, then conditionally map
`SETTINGS_SECTIONS` into `sidenav-sublink` rows, then render the `sidenav-newtask` link with the
same class expression. ~35 lines of JSX repeated with only the surrounding chrome differing.

**Fix:** one `<NavItems pathname onSettings onNavigate />` component used by both. The counts
block legitimately differs (`CountLine` vs three `mobile-nav-count` paragraphs) and should stay.

---

## Noted, not recommended for change

- **`commandIssue` in `driver/src/publish.ts:52` == `web/src/task-outcome.ts:20`** (identical regex
  array, identical boundary check). This crosses the driver boundary that AGENTS.md deliberately
  keeps un-shared, so it is an accepted copy — but the copies are *byte*-identical including the
  three-pattern array, and nothing pins them to each other. If the issue-reference syntax ever
  changes, one will drift. A test in each package asserting the same table would cost little.
- **`server/src/stats-service.ts:24` == `web/src/api/useStats.ts:12`** (the status/reason/source/
  stale payload shape). This is the server↔web wire contract; it belongs in `core` and both should
  import it, unlike the driver case there is no boundary argument against it.
- **`server/src/routes/auth-shared.ts:59`, `workspace.ts:309`, `workspace.ts:377`** repeat the same
  four-field caller projection (`orgId`/`userId`/`login`/`githubUserId`). Small; a
  `callerIdentity(caller)` helper if one of these is touched anyway.

---

## Suggested order

1. **#1** — it is a bug, not just duplication, and it is on the parity boundary.
2. **#4**, **#9**, **#8** — pure deletions, no behavior change, no design decision.
3. **#2**, **#3** — mechanical, large line savings, contained to the k8s transport.
4. **#5**, **#7** — one new helper each, many call sites; #5 also recovers dropped error codes.
5. **#6**, **#10** — real but the largest design surface; do last.
