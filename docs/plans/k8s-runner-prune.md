# Plan: simplify / prune the kubernetes runner

Status: **done, except #11 and #13** (low value / very low risk, left for a future pass if
wanted). Step 0 and #1–#10, #12 landed as 9 commits on `main`, each with typecheck/lint/full test
suite/`test:k8s` green; #7 and #8 (gate error codes, aux-read patience) were confirmed with the
user before landing.

Written 2026-09-23 after the architecture-simplification pass that landed on
`main` at `1df03b6` (re-export shims removed, executor-neutral `runner.ts` / `claim.ts` /
`close-read.ts` / `container-scripts.ts`, job-store regrouped, zero import cycles,
`noUnusedImports`/`noUnusedVariables` enabled).

## Why

A fresh graphify run flagged the "k8s-runner" community with cohesion 0.066. That community is not
one incoherent file: it is the whole kubernetes runner — 112 symbols across the 7 `driver/src/k8s-*.ts`
files — so the low score is mostly size. The file split is fine. Inside it, though, there is
copy-paste: ~500–550 of ~3,600 lines in `k8s-*.ts` can go without changing any pinned behavior.

## Step 0 — fix first: gate harness-failure code (verified bug)

`driver/src/k8s-gates.ts` `readGateJobStatus` (~line 127): a **transport failure** that exhausts the
retries is thrown raw (`retryOrThrow(failures, () => e as Error)`, ~line 131), while the **429/5xx**
arm wraps it in `gateHarness(...)` (~lines 137–143), which sets `code: CONTAINER_GONE`.
`readGateVerdict` (~line 351) never sets the code on either arm.

Effect: `driver/src/gates.ts:337` — the ad-hoc gate endpoint — maps `CONTAINER_GONE` to **409 "gate
environment is gone"**; anything else is **500**. So under `EXECUTOR=kubernetes` an API-server outage
during a gate read answers 500, where docker answers 409 for the same harness failure. The loop's
harness-vs-verdict path keys on the same code.

Fix: wrap both exhausted-retry arms (and `readGateVerdict`'s throws, or its replacement after #1) in
`gateHarness`. Test first in `driver/test/k8s.test.ts` ("the kubernetes gate manager" describe):
a request fake that throws on every GET of the gate Job → the run rejects with `code === CONTAINER_GONE`.

## Execution order

Commit after each step. After each step run:

```bash
npx vitest run driver/test/k8s.test.ts driver/test/docker.test.ts driver/test/loop.test.ts
```

At the end: `npm run typecheck && npm run lint && npm test && npm run test:executors && npm run test:coverage:executors`,
plus `npm run test:k8s` (helm lint/template) once the spec builders (#3) change.

1. **Step 0** — gate harness code bug (test first).
2. **Zero-risk batch**: #1, #5, #6, #9, #10, #12 (see table). Mechanical, no behavior change.
3. **#2** merge sync/reclaim pollers, then **#4** opencode close-read logic → `close-read.ts`.
4. **#3** one aux-Job skeleton builder (run `test:k8s` after).
5. **#7 / #8** — STOP and confirm with the user first: they touch gate error codes and aux-read patience.

| # | Candidate | Lines | Risk |
|---|---|---|---|
| 1 | Delete `readGateVerdict` (`k8s-gates.ts:351`) — same behavior as `readVerdict` in `k8s-poll.ts:50` (loop vs recursion; verified) | ~25 | none |
| 5 | Pod-lookup helpers `jobPodsPath` / `livePod` / `podLogPath` (lookup written out ~10×) | ~30 | none |
| 6 | One fire-and-forget delete helper (~12 copies) | ~40 | none |
| 9 | Move `parseLastJsonLine` (`docker-runner-support.ts`) + the "answered nothing readable" reasons to a neutral file; k8s re-implements it | ~10 | none |
| 10 | One home for copied regexes (`UUID`/`JOB_ID`, `WORKSPACE_PATH` ×4, `GATE_KEY`/`GATE_IMAGE` ×2) and HTTP/MS constants | ~15 | none |
| 12 | Un-export symbols used only inside their own file | 0 | none |
| 2 | Merge `pollSyncJobToTerminal`/`pollReclaimJobToTerminal`, `readSyncJobLog`/`readReclaimJobLog`, `runSyncJob`/`runReclaimJob` (`k8s-poll.ts:291-500`) into `pollJobToTerminal` with a nullable `failed` message; keep "sync/reclaim pollers never throw" and the script-reason passthrough (`k8s.test.ts:845`) | ~110 | low |
| 4 | Opencode close-read retry loop + outcome merge duplicated in both runners → `close-read.ts`; delete dead `OPENCODE_SESSION_SCRAPE_RETRIES/DELAY_MS` in `k8s-transport.ts:74-75` (verified: `k8s-runner.ts:174-175` redefines its own) | ~50 | low |
| 3 | One aux-Job skeleton for 7 builders (`syncJobSpec`, `reclaimJobSpec`, `publishStepJobSpec`, `gateJobSpec`, `bellowsJobSpec`, `claudeTurnsJobSpec`, `opencodeReadoutJobSpec`); `runnerJobSpec` stays separate | ~140 | low |
| 7 | One job-status poll core under runner, aux and gate polls (after #2) | ~70 | medium |
| 8 | Merge `readAuxVerdictOutput` and `readRunnerVerdict` (aux pod list becomes more patient) | ~25 | low |
| 11 | Name/path builder table (`attemptName(prefix, job)`); hardcoded secrets path in `k8s-gates.ts` | ~15 | none (low value) |
| 13 | Claude close-read gating via `readsAgentTurns`; fix misnamed deadline constant | 0 | very low |

**Keep (looks duplicated, is not):** sync vs reclaim claim handling (different acquire/release
contracts); docker's label sweep vs the k8s claim fence (documented deliberate in docs/kubernetes.md);
publish failure wording (transport-specific); runtime sampling (already shared via
`composeRuntimeSample`); runner log read without retry (intentional); `runnerJobSpec` separate from
`AuxJobSpec`; gate exit default `1` vs aux `null`.

**Unverified — check before acting:** the runner's per-attempt Secret is labelled `factory.job`
only, while the sync, publish and gate Secrets also carry `factory.lease`. Possible drift.

## Known state outside this plan

- `server/test-db/workflow-store.test.ts` "compiles a block node before storage…" fails on `main`
  (expects `BLOCK_UNAVAILABLE`, gets `NO_PUBLISH_PATH`) — pre-existing, in the area of the user's
  stashed WIP (`stash@{0}` "pre-merge wip workflow-store"). Not part of this plan.
- Run `npm run build -w core` before local typecheck/dev (core/dist must include `core/src/env.ts`).
- AGENTS.md rule: every k8s change keeps docker/kubernetes parity; a `k8s-*.ts` import of a
  `docker*.ts` file is a parity smell.

---

# Appendix: full analysis report (line ranges, evidence, pinning tests)

The line numbers below were taken against `main` at `1df03b6`; re-check them before editing.

# Kubernetes runner: prune / simplify candidates

Read-only analysis of `driver/src/k8s-*.ts` against the docker twin and the neutral files. All
"unused" claims were checked with `grep -w` across `driver/src` and `driver/test`. None of the poller
names (`pollJobToTerminal`, `pollSyncJobToTerminal`, `pollReclaimJobToTerminal`, `auxVerdict`,
`readVerdict`, `readGateVerdict`, `runSyncJob`, `runReclaimJob`, `parseLastJsonLine`) appear in
`docs/` or `driver/test/`. Tests pin these functions only through `createKubernetesRunner` and
`createKubernetesGateManager`, so they can be restructured internally as long as the request
sequences and the few pinned strings stay the same.

## Ranked summary

| # | Candidate | Est. lines removed | Risk | Value |
|---|---|---|---|---|
| 1 | Delete `readGateVerdict`, a verbatim copy of `readVerdict` | ~25 | none | high |
| 2 | Merge the sync and reclaim pollers and log reads into `pollJobToTerminal` plus one log read | ~110 | low | high |
| 3 | One aux Job skeleton builder for 7 spec builders | ~140 | low | high |
| 4 | Opencode close-read decision logic: move it to `close-read.ts` and use it from both runners; delete dead k8s constants | ~50 | low | high |
| 5 | Pod discovery helpers (`jobPodsPath`, `livePod`, `podLogPath`) | ~30 | none | medium |
| 6 | Fire-and-forget delete helper | ~40 | none | medium |
| 7 | One job-status poll core under the runner, aux and gate polls | ~70 | medium (gate error codes) | medium |
| 8 | Merge `readAuxVerdictOutput` and `readRunnerVerdict` | ~25 | low (aux pod list becomes more patient) | medium |
| 9 | Move `parseLastJsonLine` and the "answered nothing readable" reasons to a neutral file | ~10 | none | medium (parity) |
| 10 | Copied regexes (`UUID`/`JOB_ID`, `WORKSPACE_PATH` x4, `GATE_KEY`/`GATE_IMAGE` x2) and HTTP/MS constants | ~15 | none | medium |
| 11 | Name/path builder table (`attemptName(prefix, job)`), `jobsSelectorPath` becomes `byJob`, hardcoded secrets path in `k8s-gates.ts` | ~15 | none | low |
| 12 | Un-export symbols used only inside their own file | 0 | none | low |
| 13 | Claude close-read gating: use `readsAgentTurns`; fix the misnamed deadline constant | 0 | very low | low (parity) |
| K | Keep list: real platform or contract differences | – | – | – |

Total if all are done: roughly 500 to 550 lines out of about 3,600 in `k8s-*.ts`.

---

## 1. Delete `readGateVerdict` (zero risk)

- `driver/src/k8s-gates.ts:346-370` `readGateVerdict(deps, path, what)` is `readVerdict` (`k8s-poll.ts:50-67`)
  rewritten as a `for(;;)` loop. The semantics match exactly: `++failures > POLL_MAX_CONSECUTIVE_FAILURES`
  is equivalent to `failures + 1 > …` starting from 0. On transport exhaustion both rethrow the raw
  error, and on 429/5xx exhaustion both throw the same message:
  `` `${what} answered ${response.status} ${POLL_MAX_CONSECUTIVE_FAILURES} times in a row` ``.
- Change: in `readGateJobResult`, import `readVerdict` from `k8s-poll.js` and delete the copy.
  `k8s-fence.ts` and `k8s-services.ts` already import it.
- Pinned by: the gate describe block in `k8s.test.ts` (~4798-4930).

## 2. Merge the sync and reclaim pollers (k8s-poll.ts:291-500)

What is duplicated (verified line by line):
- `pollSyncJobToTerminal` (318-345) and `pollReclaimJobToTerminal` (430-457) are character-identical
  apart from the job name and the word "sync"/"reclaim". Both are the `readVerdict` retry loop hand-inlined
  through `pollAgainOrGiveUp` (298-309), which exists only to serve them.
- `readSyncJobLog` (352-367) and `readReclaimJobLog` (460-475) are identical apart from the name.
- `runSyncJob` (416-422) and `runReclaimJob` (493-499) repeat the last-JSON-line parse that
  `docker-runner-support.ts:106 parseLastJsonLine` already implements.

The one real difference from `pollJobToTerminal` (96-110): sync and reclaim treat a failed Job as
terminal and still read the log, because the script prints `{ok:false,reason}` and the test at
`k8s.test.ts:845` expects the script's reason to come through. `pollJobToTerminal` instead answers
`messages.failed`.

Proposed change:
- Make `PollToTerminalMessages.failed` a `string | null`. `null` means "a failed Job is still a verdict
  to read".
- Sync and reclaim call `pollJobToTerminal(deps, syncJobName(job), { what: 'reading the worktree sync job', …, failed: null })`.
- Replace the two log reads with one `readJobLog(deps, jobName)`.
- Replace the two parse tails with `parseLastJsonLine` (see #9).
- Delete `pollAgainOrGiveUp`, `pollSyncJobToTerminal`, `pollReclaimJobToTerminal`, `readSyncJobLog`
  and `readReclaimJobLog`.

Invariants preserved:
- "Sync/reclaim pollers NEVER throw": `pollJobToTerminal` never throws, because `readJobOrGiveUp`
  catches `readVerdict`'s throw.
- Consecutive-failure counting: `readVerdict`'s counter is per call, and each pending round starts a
  new call. That matches the old `pollSyncJobToTerminal(deps, job, 0)` reset.

Message drift:
- The transport-exhaustion reason loses its prefix. It was `"the worktree sync job could not be read: <e>"`
  and becomes the raw `<e>`. No test pins it; `readJobOrGiveUp` can prepend the prefix if wanted.
- A non-404 4xx loses the body preview unless `errorStatus` gets the body.
- The tests pin only `toContain('500')` (`k8s.test.ts:860-864`, `1171-1176`). That still holds: the reason becomes
  `"reading the worktree sync job answered 500 15 times in a row"`.

Estimate: about 110 lines removed. Pinned by: `describe('the worktree sync')` (`k8s.test.ts:678-1092`)
and `describe('the worktree reclaim')` (`1094-1215`), including the Foreground-before-release ordering
tests (999, 1027, 1171), which this change does not affect.

## 3. One aux Job skeleton (k8s-auxspec.ts and k8s-podspec.ts)

Seven builders re-spell the same roughly 25-line skeleton:
- `syncJobSpec` (auxspec 46-114)
- `reclaimJobSpec` (130-181)
- `publishStepJobSpec` (215-265)
- `gateJobSpec` (podspec 491-553)
- `bellowsJobSpec` (615-664)
- `claudeTurnsJobSpec` (698-752)
- `opencodeReadoutJobSpec` (754-811)

Each repeats the same shared shape:
- `apiVersion/kind`
- `labels = {'factory.job','factory.lease'}`, used twice
- `backoffLimit: 0, completions: 1, parallelism: 1`
- `ttlSecondsAfterFinished: TTL_SECONDS`
- `restartPolicy: 'Never', automountServiceAccountToken: false`
- `imagePullPolicy: config.imagePullPolicy`
- the `workspaces` volumeMount with `subPath: workspaceSubPathOf(job)`
- `volumes: [{ name:'workspaces', persistentVolumeClaim:{ claimName: config.workspaceVolume } }]`

Evidence: `grep -c "persistentVolumeClaim: { claimName: config.workspaceVolume }"` gives 3 in auxspec
and 5 in podspec (the 5 include the runner). `'factory.lease': job.leaseToken` appears 6 times in each file.

Proposed change: add `auxJobSpec(config, job, { name, deadlineSeconds, container, securityContext? })`
and `workspaceMount(config, job, { readOnly?, subPath? })`, both in `k8s-podspec.ts` next to `AuxJobSpec`.
- Each builder keeps its own validation and its container body: command, env, envFrom, workingDir.
  Those are the parts that actually differ and that the spec tests read.
- The pins that every aux pod shares (no SA token, `backoffLimit: 0`, subPath-scoped mount) then live
  in one place.
- `runnerJobSpec` stays separate. `k8s-podspec.ts:371-377` states why the runner has its own
  interface, and its shape is pinned field by field.

Estimate: about 140 lines removed. Risk is low because the output is byte-identical and the spec
tests compare fields of the produced object. Pinned by the spec tests at `k8s.test.ts`: 678-790 (sync),
1094-1122 (reclaim), 1217+ (publish), 4940+ (bellows), 5278-5360 (opencode/claude-turns), plus the gate spec tests.

Optional: the `JOB_ID.test(job.id) || JOB_ID.test(job.leaseToken)` refusal is repeated 4 times with a
different verb each time. It could move into the helper as a `verb` parameter, but leave it alone
unless the messages are unpinned.

## 4. Opencode close-read decision logic, duplicated across executors

This is decision logic, not transport:
- The retry loop:
  - docker: `docker-close-read.ts:106-138` `readOpencodeSessionWithRetries`, with `OPENCODE_SESSION_READOUT_RETRIES = 3` and `…_RETRY_DELAY_MS = 500`
  - k8s: `k8s-runner.ts:169-198` `scrapeOpencodeSessionWithRetries`, with `OPENCODE_SESSION_SCRAPE_RETRIES = 3` and `…_DELAY_MS = 500`
  - The two loops are the same: `for (attempt…; attempt < 3 && !scraped.sessionId; …)`, sleep 500ms after the first try, and `reason = scraped.error ?? reason`.
- The merge onto the outcome: docker `applyOpencodeCloseRead` (149-172) and k8s `mergeOpencodeOutcome`
  (200-213) are line-for-line identical, including the fallback `'the readout answered nothing (no session in the database)'`.
- The all-null `OpencodeRunOutcome` literal is spelled out 4 times: `k8s-runner.ts:75-83`, `182-190`,
  and `docker-close-read.ts:113-121`, `128-136`.

Dead code found here: `k8s-transport.ts:74-75` exports `OPENCODE_SESSION_SCRAPE_RETRIES` and
`OPENCODE_SESSION_SCRAPE_DELAY_MS`, but `k8s-runner.ts:174-175` redefines them locally and never
imports them. No other file imports them.

Proposed change, in `close-read.ts` (neutral):
- `opencodeReadFailed(error)`, the null outcome
- `readOpencodeWithRetries(readOnce: () => Promise<OpencodeRunOutcome>, sleep)`, with the constants
- `mergeOpencodeOutcome(outcome, scraped, reason)`

Docker passes a setTimeout sleep and k8s passes `deps.sleep`. Delete the k8s-transport constants.

Estimate: about 50 lines removed. Pinned by `loop.test.ts:484, 1129, 1150` ("the session readout came up
empty"), `k8s.test.ts:5467-5561` (including "retries the scrape while the database is mid-checkpoint"
and `readoutError` containing 'the session readout job failed'), and the docker opencode readout tests
in `docker.test.ts`.

## 5. Pod discovery helpers (zero risk)

- The label-selector string ``${podsPath(ns)}?labelSelector=${encodeURIComponent(`job-name=${X}`)}``
  appears 10 times: `k8s-poll.ts` 120, 181, 260, 356, 464; `k8s-runner.ts` 110, 240; `k8s-gates.ts` 84, 194;
  `k8s-services.ts` 51.
- `.items?.find((item) => !item.metadata?.deletionTimestamp)`, the "skip terminating pods" rule, appears
  8 times across poll, runner, gates and services.
- The pod log path ``${podsPath(ns)}/${pod}/log?tailLines=${LOG_TAIL_LINES}`` appears 5 times.

Proposed change: `jobPodsPath(ns, jobName)` and `podLogPath(ns, pod, tail?)` in k8s-auxspec, next to
`podsPath`, and `livePod(body)` in k8s-transport, next to `K8sPodList`. That gives one home for the
documented "skip terminating pods" rule.

Estimate: about 30 lines removed. Tests match exact paths, and the output strings are unchanged.

## 6. Fire-and-forget delete helper (zero risk)

- The pattern ``void deps.request('DELETE', `${jobPath(ns, name)}?propagationPolicy=Background`).then(() => undefined, () => undefined)``
  appears at `k8s-runner.ts` 129, 162, 384-389, 448-453, 500-505; `k8s-services.ts` 68; `k8s-gates.ts` 245.
- Secret deletes use the same shape: `k8s-runner.ts` 62-65 (`forgetSecret`), 394-397, 455-458; `k8s-gates.ts` 333.
- Foreground and awaited variants: `k8s-runner.ts` 419-426 (`takeSyncJobDown`), 480-487 (`takeReclaimJobDown`).

Proposed change: `deleteJob(deps, name, 'Background' | 'Foreground'): Promise<void>` (swallowing) and
`deleteSecret(deps, name)`. The fire-and-forget callers write `void deleteJob(...)`. `takeSyncJobDown`
and `takeReclaimJobDown` become `await deleteJob(deps, syncJobName(job), 'Foreground')`.
- Keep `deleteOwnJob` (`k8s-fence.ts:62`) separate. It returns a boolean the fence branches on
  (404 counts as success).

Estimate: about 40 lines removed. The tests assert exact DELETE paths and ordering (`k8s.test.ts` 927-1075, 1123, 1171), and the paths stay identical.

## 7. One job-status poll core (medium; do after #2)

After #2 there are still four status loops over `GET jobs/<name>`:
- `pollJobToTerminal` (k8s-poll 96-110): returns a string, never throws
- `auxVerdict` (147-163): throws on 404 and on other errors
- `pollRunnerJobUntilTerminal` (213-245): throws, adds a per-round output tail and `timedOut`
- the gate trio `readGateJobStatus`, `retryOrThrow`, `gateJobTerminal` and `pollGateJobToTerminal`
  (k8s-gates 102-185, about 85 lines): throws `gateHarness`, adds a per-round image-pull check and `timedOut`

`auxVerdict` and `pollRunnerJobUntilTerminal` have the same 404 and error arms, differing only in the wording.

Proposed change: one `pollJobStatus(deps, jobName, what, onPending?) → Promise<{ status: K8sJobStatus } | { error: string, gone: boolean }>`,
built on `readVerdict`. Each caller then maps the result: return a string, throw, throw `gateHarness`,
compute `timedOut` from `conditions`. `onPending` carries the runner's `tailRunnerOutput` and the
gate's `checkGateImagePullable`. Export a single `timedOutOf(status)`; it currently exists twice
(poll 237-239, gates 116-118).

Behavior note (possible latent bug, verify before choosing): in the gate poll, transport-failure
exhaustion throws the raw error with no `CONTAINER_GONE` code (`k8s-gates.ts:133`,
`retryOrThrow(failures, () => e as Error)`), while 429/5xx exhaustion throws `gateHarness(...)` with the
code. The docker manager always codes harness failures (`gates.ts:107-118`), and the ad-hoc endpoint
keys on the code (`gates.ts:337`). A unified poller whose errors the gate caller wraps in `gateHarness`
would make these consistent. That is a behavior change: decide it, and pin it with a test.

Estimate: about 70 lines removed. Risk is medium because four callers depend on it. Pinned by
`k8s.test.ts` 4238 ("keeps polling through transient API failures"), 4326 ("recounts after a good read"),
4435 ("abandons the run when the job object is gone"), 4442 (DeadlineExceeded), and the gate tests
4841 (exit 124), 4856, 4863 (unpullable image).

## 8. Merge `readAuxVerdictOutput` and `readRunnerVerdict`

- `k8s-poll.ts:113-138` and `253-289` have the same shape: list pods by `job-name`, take the live pod,
  `exitCode ?? (succeeded ? 0 : null)`, tail-log read with no retry that swallows errors.
- The differences:
  - The runner lists pods through `readVerdict` (patient); aux uses a bare `request`.
  - The runner wraps the log in `reportTail`; aux returns it raw.
- Proposed change: one `readJobPodVerdict(deps, jobName, succeeded)` that always uses `readVerdict` for
  the list. The runner applies `reportTail` itself.
- The change is that the aux pod list becomes retry-bounded. This is the direction `auxVerdict`'s own
  doc comment claims ("the same discovery … the runner's own verdict read applies"). Keep the log
  read's "no retries at all" (poll 275-276), which is deliberate.
- `readGateJobResult` (k8s-gates 187-217) is the same read again, with an exit default of `1` (the gate
  needs a number) and trimming. It can call the merged helper and map `null` to 1.
- Estimate: about 25 lines, or about 45 with the gate. Pinned by `k8s.test.ts` 4388, 4396, 4410, 4456, 4510, 1357 (publish steps), 1581.

## 9. `parseLastJsonLine` and sync/reclaim fallbacks in a neutral home (parity)

- `docker-runner-support.ts:106-113` `parseLastJsonLine` is re-inlined in `k8s-poll.ts:417-422` and `494-499`.
- The fallback reasons `'the worktree sync answered nothing readable'` and `'the worktree reclaim answered nothing readable'`
  are spelled out in both runners (`docker-runner.ts:256-259` and `298-302`; `k8s-poll.ts:421` and `498`).
- `docs/kubernetes.md` calls a k8s file importing from `docker-*` a parity smell. So move
  `parseLastJsonLine` next to `SyncResult`/`ReclaimResult` in `publish.ts`, and export
  `syncUnreadable` / `reclaimUnreadable` from there. Both runners then share the decision of what an
  unparseable verdict means.
- Pinned by `k8s.test.ts:867-870` (`toEqual` on the exact sync string) and the docker sync tests.

## 10. Copied constants

- UUID regex: `claim.ts:12` (exported), `publish.ts:179`, and `k8s-transport.ts:17` `JOB_ID`.
- `WORKSPACE_PATH` in 4 places: `claim.ts:36`, `publish.ts:187`, `services.ts:78`, `k8s-podspec.ts:671`.
  The last carries the comment "COPIED from services.ts (which copied it from docker.ts)".
- `GATE_KEY` and `GATE_IMAGE` in 2 places: `docker.ts:197-201` and `k8s-podspec.ts:425-427`, commented
  "COPIED from docker.ts".
- `HTTP_NOT_FOUND` and `HTTP_CONFLICT` are redefined at `board.ts:270-271` and `gates.ts:18-20`, while
  `k8s-transport.ts:65-66` exports them.
- `MS_PER_SECOND` in 3 places: `close-read.ts:154`, `loop-attempt.ts:24`, `k8s-transport.ts:23`.

The copies were made to avoid k8s importing docker, and a neutral file answers that. Proposed change:
export each once from `claim.ts` (UUID, WORKSPACE_PATH, GATE_KEY, GATE_IMAGE), and import them. This
does not conflict with the "driver depends on nothing" rule, which is about `core`, not about files
inside driver. `JOB_ID` becomes `UUID`, or an alias. Leave the HTTP and MS constants unless you are
already in those files.

Estimate: about 15 lines of code plus 3 "COPIED" comment blocks. Zero risk.

## 11. Name and path builder families (low value; keep the names readable)

- Ten builders are `` `factory-<prefix>-${hash16(`${job.id}|${job.leaseToken}`)}` `` plus an optional suffix:
  - `k8s-auxspec.ts`: sync 34, sync-env 44, reclaim 128, publish-env 201, pub-step 205
  - `k8s-podspec.ts`: gate-env 460, bellows 587, runner 601, ocread 684, cturns 696
- A one-line `attemptName(prefix, job, suffix = '')` would put every prefix in one visible list. The
  docs care about that list: `runnerJobName` must not collide with `bellowsJobName` (podspec 596-598).
- `syncEnvSecretName` becomes `${syncJobName(job)}-env`.
- Keep the named exports. The tests pin names through them (`runnerJobName`, `opencodeReadoutJobName`,
  `claudeTurnsJobName`, `syncJobName`, `reclaimJobName`).
- `jobsSelectorPath` (auxspec 401-402) is `byJob(jobsPath(namespace), job)` spelled out. Define it that
  way, as its pods and services siblings (388, 390) already are.
- `k8s-gates.ts:56` and `333` hardcode `` `/api/v1/namespaces/${ns}/secrets` `` instead of using `secretsPath`.
- Path builders are split between `jobsPath` (podspec 340) and everything else (auxspec 373-432), so
  `k8s-auxspec.ts` imports `jobsPath` back from podspec. Moving them all to one file is cosmetic.
- `runnerName` (podspec 608-613) is `runnerJobName` plus a uuid assert. Folding the assert into
  `runnerJobName` removes one name. Tests use `runnerJobName`; source uses `runnerName`.
- Estimate: about 15 lines. Zero risk.

## 12. Exported but only used in their own file (verified by grep)

These are exported but referenced only inside their own file, with no test use. Un-exporting them
removes no lines but shrinks the surface:
- `k8s-fence.ts`: `deleteOwnJob` (62), `sweepClaimedFleets` (296)
- `k8s-auxspec.ts`: `servicePodName` (277), `PublishStepJobSpecInput` (208)
- `k8s-podspec.ts`: `bellowsJobName` (587), `GateJobSpecInput` (481)
- `k8s-poll.ts`: `PollToTerminalMessages` (83), `pollSyncJobToTerminal` (318), `pollReclaimJobToTerminal` (430). These disappear with #2.
- `k8s-transport.ts`: `InClusterRequestDeps` (129)

Used only by tests, so keep: `runnerJobName`, `opencodeReadoutJobName`, `claudeTurnsJobName`, `K8sMethod`.

Dead: `k8s-transport.ts:74-75` `OPENCODE_SESSION_SCRAPE_*` (#4).

## 13. Unreachable config branches and parity nits

- Config-unreachable paths: `config.ts:322-345` refuses Remote Control and cache watch under kubernetes,
  and the k8s files already contain no Remote Control, idle or cache-watch code (grep is clean).
  Nothing to prune.
  - Keep `remoteSessionId() { return null }` (k8s-runner 523-525). The `Runner` interface requires it,
    and the loop calls it only under Remote Control (`loop-attempt.ts:213`).
  - Making it optional on `Runner` would save 3 lines, which is not worth an interface change.
  - Keep the `idled: false` literals.
- Claude close-read gating:
  - `k8s-runner.ts:307` gates with `job.executorType === 'claude-code' && session`. Docker uses
    `readsAgentTurns(config, job, session)` (`close-read.ts:108`, `docker-close-read.ts:180`).
  - Use the neutral predicate for parity.
  - The observable difference is tiny. With a non-uuid session id, k8s today sets `agentTurns = null`
    (because `claudeTurnsJobSpec` throws), while docker leaves it undefined.
- `claudeTurnsJobSpec` uses `OPENCODE_READOUT_DEADLINE_SECONDS` (podspec 717). Rename it to
  `CLOSE_READ_DEADLINE_SECONDS`, since it is shared by design (podspec 692-694).
- `publishGit`'s `if (!repo) throw` (k8s-runner 361-364) is documented as unreachable. The docker twin
  guards with `if (publish.inRepo && repo)` instead. Harmless; keep or drop.
- Secret bodies: there are 4 hand-built Secret objects:
  - runner `secretBody` (podspec 363-369)
  - sync (poll 385-394)
  - publish (runner 343-349)
  - gate (gates 56-65)
  - An `attemptSecretBody(name, job, data)` helper would remove about 20 lines.
  - Caution: the runner's `secretBody` labels only `factory.job`, while the other three add
    `factory.lease`. That looks like drift rather than a decision, but it is a behavior change. Check
    the Secret label tests before unifying.

## K. Looks duplicated, but keep

- `syncCheckout` vs `reclaimWorktree` control flow (k8s-runner 409-508). The contracts really differ:
  - Sync: acquire throws (stand-down), the claim is held on success, and it is released only on failure,
    after a Foreground delete.
  - Reclaim: an acquire failure turns into `ok:false` (skip), and the claim is always released in `finally`.
  - Share only the delete helper (#6).
- Docker `dockerReclaimFence` sweep vs the k8s `acquireClaim` fence. Documented as deliberate
  (`docs/kubernetes.md` "The docker runner's fence … keeps the old shape, deliberately").
- Publish step failure text:
  - docker: `dockerErrorDetail(e)` strips the echoed argv, which is transport-specific
  - k8s: `verdict.output.trim() || 'the step exited N'`
  - The decisions already live in `publishCheckout`.
- `sampleRuntime` vs `dockerSampleRuntime`. Both already delegate to `composeRuntimeSample`, and what
  remains is pure transport.
- Bellows readout throws, while the opencode readout never throws. These are caller-level contracts:
  infrastructure failure vs best-effort. After #7 they share the poller and keep separate mappings.
- `readRunnerVerdict`'s log read has no retry on purpose (poll 275-276). Keep it that way through #8.
- `runnerJobSpec` / `RunnerJobSpec` stay separate from `AuxJobSpec` (podspec 371-377).
- `k8s-gates.ts` exit default `1` vs aux `null`. The gate verdict needs a number.

## Suggested order

Start with #1, #5, #6, #9, #10 and #12. They are mechanical and have zero behavior change. Then do #2
and #4, then #3, and #7/#8 last. Run `npx vitest run driver/test/k8s.test.ts driver/test/docker.test.ts driver/test/loop.test.ts`
after each step, plus `npm run test:executors` and `npm run test:coverage:executors` at the end, and
`npm run test:k8s` (helm) if the spec builders change.
