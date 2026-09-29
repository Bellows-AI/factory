# F3 · After gallery (issue #288)

The **redesigned** UI, shot once every lane and finishing issue (#286, #287) had landed and #288's
cleanup was committed: the "after" half of every before/after comparison. `../baseline/` is the
"before" half (#271).

## What is here

- 120 PNGs from `e2e/baseline.spec.ts`: 30 shots × {dark, light} × {1440×1000, 390×844}, full page. The file
  names are the baseline's, `<route>_<state>_<theme>_<width>.png`, so `after/X.png` pairs with
  `baseline/X.png` by name — `diff <(ls after) <(ls baseline)` differs only in the baseline's
  `RESULTS.md`.
- `manifest.json` has the baseline's shape — each shot's file, route, state, theme, viewport, fixture and
  timestamp — plus the `commit` the UI came from: `16afa0f4dbf1bdeb0084bff84e45cdd7e4b1a75e`, #288's cleanup
  commit, whose tree is the one shot.

| Route family | States | Rendered from |
| --- | --- | --- |
| `dashboard`, `inbox` | default | the seeded open board |
| `composer` | default | the seed, plus the one executor from `e2e/executor.ts` |
| `task-detail` | queued, running, stopping, stopped, parked-review-wait, parked-review-wait-done, woken-continuation, follow-up-over-wait, failed-gate, agent-failed, published, done, follow-up, multi-follow-up, missing-summary, sessionless, other-author, null-author | the matching `e2e/fixtures/threads.ts` export through `routeThread` |
| `settings-overview`, `-organization`, `-workspace`, `-repos`, `-executors`, `-workflows` | default | the seeded open board |
| `signin`, `onboarding`, `account` | default | the github-mode auth board and the stub IdP (anonymous, `?reselect=1`, signed in) |

The account shots show a per-run GitHub id, the run's workspace path and sign-in times, and relative times on
every page ("26d ago") are relative to the run — compare those by eye, not by pixel diff, as with the baseline.

## The tree it was shot in

The task checkout itself at `16afa0f`: no `git archive` export, no overlay and no `BASELINE_COMMIT`, so the
manifest's commit is `git rev-parse HEAD`. The spec is the one the baseline ran, unchanged.

```bash
rm -rf artifacts/ui/baseline
env -u GITHUB_TOKEN E2E_DB_HOST=timescale BASELINE=1 npx playwright test e2e/baseline.spec.ts
cp artifacts/ui/baseline/* docs/plans/bellows-redesign-2026-09-26/after/
```

| | |
| --- | --- |
| Started / finished (UTC) | 2026-09-29T04:10:16Z / 2026-09-29T04:13:51Z |
| Playwright / browser | 1.62.1 / Chrome Headless Shell 151, one worker, `retries: 0` |
| Environment | as the baseline's (`../baseline/RESULTS.md`): `GITHUB_TOKEN` unset, Chromium's libraries from bookworm `.deb`s via `LD_LIBRARY_PATH`, `factory_e2e` and `factory_auth_e2e` on the `timescale` service |
| **Result** | **120 passed** (3.5 min) |
