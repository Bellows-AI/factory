# G2 · Baseline screenshot gallery (issue #271)

The **old** UI, shot before any redesign code: the "before" half of every later before/after comparison.
`RESULTS.md` beside this file is the G0 `verify:ui` run (#269); everything else here is this gallery.

## What is here

- 120 PNGs from `e2e/baseline.spec.ts`: 30 shots × {dark, light} × {1440×1000, 390×844}, full page. Each file is
  named `<route>_<state>_<theme>_<width>.png`. `state` is `default` unless the route has several states; the task
  detail page has one for each #270 fixture.
- `manifest.json` lists each shot's file, route, state, theme, viewport, fixture and timestamp, plus the `commit`
  the UI came from: `e19fce106aebd0de659c7cb02fd3952332eb2286`.

| Route family | States | Rendered from |
| --- | --- | --- |
| `dashboard`, `inbox` | default | the seeded open board |
| `composer` | default | the seed, plus the one executor from `e2e/executor.ts` |
| `task-detail` | queued, running, stopping, stopped, parked-review-wait, parked-review-wait-done, woken-continuation, follow-up-over-wait, failed-gate, agent-failed, published, done, follow-up, multi-follow-up, missing-summary, sessionless, other-author, null-author | the matching `e2e/fixtures/threads.ts` export through `routeThread` |
| `settings-overview`, `-organization`, `-workspace`, `-repos`, `-executors`, `-workflows` | default | the seeded open board |
| `signin`, `onboarding`, `account` | default | the github-mode auth board and the stub IdP (anonymous, `?reselect=1`, signed in) |

The account shots show a per-run GitHub id, the run's workspace path and sign-in times. Relative times on every
page ("26d ago") are relative to the run.

## The tree it was shot in

`e19fce1`, plus only the test-only overlay from EXECUTION-GRAPH §2. None of #273/#274/#276 is in it, and neither is
anything else that landed after `e19fce1`.

- `git show 25db9f4 -- e2e`: the #269 selector and executor fixes (`e2e/` only; `RESULTS.md` is left out).
- `e2e/fixtures/threads.ts` as of `e5e5264` (#270). #270's refactor of `task-detail.spec.ts` is left out
  because it imports `E2E_DATABASE_URL`, which only exists after #277. The spec run here does not load that file.
- `e2e/baseline.spec.ts` (this change). The run used the copy from before review. Review added two lines: the
  `BASELINE=1` opt-in, which is why the command below sets it, and a 120 s test timeout. Neither changes what
  is shot.

The task checkout may not add worktrees or move `HEAD`, so, as in G0, the tree is a `git archive` export.
Because an export has no repository to ask for its commit, `BASELINE_COMMIT` supplies it to the manifest:

```bash
P=/tmp/g2-baseline
mkdir -p $P && git archive e19fce1 | tar -x -C $P
git show 25db9f4 -- e2e | git apply --unsafe-paths --directory=$P
git show e5e5264:e2e/fixtures/threads.ts > $P/e2e/fixtures/threads.ts
cp e2e/baseline.spec.ts $P/e2e/
cd $P && npm ci
env -u GITHUB_TOKEN E2E_DB_HOST=timescale BASELINE=1 BASELINE_COMMIT=e19fce106aebd0de659c7cb02fd3952332eb2286 \
    npx playwright test e2e/baseline.spec.ts
cp artifacts/ui/baseline/* <checkout>/docs/plans/bellows-redesign-2026-09-26/baseline/
```

After the overlay, `diff -rq` against the task branch's `e2e/` differed only in `reset-db.mjs`, `stub-idp.mjs`
(#277) and `task-detail.spec.ts` (#270 + #277), which is the intended exclusion.

| | |
| --- | --- |
| Started / finished (UTC) | 2026-09-28T07:10:03Z / 2026-09-28T07:16:51Z |
| Playwright / browser | 1.62.1 / Chrome Headless Shell, one worker, `retries: 0` |
| Environment | the same as G0 (`RESULTS.md`): `GITHUB_TOKEN` unset, Chromium's libraries from bookworm `.deb`s via `LD_LIBRARY_PATH`, databases on the `timescale` service |
| **Result** | **120 passed** (6.8 min) |

## Shooting the "after" half

Run the same spec on any later checkout: `BASELINE=1 npx playwright test e2e/baseline.spec.ts`. Without `BASELINE`
it skips, so `npm run verify:ui` does not pay for 120 shots. The spec writes to `artifacts/ui/baseline/` with the
same file names, so each image pairs with its baseline by name. In a git checkout, the manifest's commit is
`git rev-parse HEAD`.

Empty `artifacts/ui/baseline/` first. The manifest lists every PNG in that directory, so after a filtered or
partial run it would stamp leftovers from an earlier run with this run's commit. Compare the account shots by
eye, not by pixel diff (see above).
