# G0 · Baseline `verify:ui` run (issue #269)

The browser suite as it stood **before** any redesign code, measured, not assumed.

## The run

| | |
| --- | --- |
| Commit | `e19fce1` — *Report FailureTarget deadlines as timeouts; make the gate timeout configurable* |
| Tree | `git archive e19fce1`, exported into a clean directory: the task checkout may not add worktrees, and an export carries exactly that commit's files |
| Command | `env -u GITHUB_TOKEN E2E_DB_HOST=timescale npx playwright test` (`npm run verify:ui` is `playwright test`) |
| Started / finished (UTC) | 2026-09-27T08:22:13Z / 2026-09-27T08:28:32Z |
| Playwright / browser | 1.62.1 / Chrome Headless Shell 151.0.7922.34, one worker, `retries: 0` |
| Databases | `factory_e2e`, `factory_auth_e2e` on the job's `timescale` service (created empty; the run resets and seeds them) |
| **Result** | **96 passed, 13 failed** (109 tests, 6.3 min) |

Issue #269 quotes a historical capture of 78 passed / 13 failed. The failure count reproduces; the pass count
does not, and this run is the number to use. Nothing was retried (`retries: 0`).

`main` at `bdac15e` (this branch's base, which includes #266 and #291 on top of `e19fce1`) fails the **same 13**:
96 passed / 13 failed, 6.5 min. No `e2e/` file differs between the two commits.

### Environment, not the app

Three things had to be set up around the run before it measured anything. None is a test or an app change:

- **`GITHUB_TOKEN` in the environment** refuses the seed at boot (`GITHUB_TOKEN is no longer supported`, from
  `assertNoRetiredEnvVars`), so no web server starts and every test "fails". The board container injects the
  variable; the run unsets it.
- **Chromium's shared libraries** (`libnspr4.so` first) are absent from the `node:24` image and there is no root to
  `playwright install-deps`. They were unpacked from Debian bookworm `.deb`s into a local prefix and reached through
  `LD_LIBRARY_PATH`, with a local `FONTCONFIG_FILE`. Without them all 109 tests fail at `browserType.launch` in a
  few milliseconds each.
- The database host is the declared service (`E2E_DB_HOST=timescale`); `127.0.0.1` carries nothing in the job.

## Classification

**All 13 failures are stale tests. No real defect was found, so no defect issue was filed.** Each fix is test-only
and applies unchanged on `e19fce1` (`git apply --check` there), so the G2 gallery can cherry-pick it onto that
base as EXECUTION-GRAPH §2 requires.

| Run # | Test | Cause | Class | Fix |
| ---: | --- | --- | --- | --- |
| 1 | `composer.spec.ts:40` parameters asked in words | Start is blocked by "Configure an executor in Settings to continue." before the workflow blocker it asserts | stale fixture | `withExecutor` |
| 4 | `composer.spec.ts:166` unchosen workflow / empty prompt | Same: the blocker is `missing-executor`, not `empty-prompt` | stale fixture | `withExecutor` |
| 5 | `composer.spec.ts:189` keyboard path never queues | Same: Ctrl+Enter cannot queue without an executor, the URL stays `/tasks/new` | stale fixture | `withExecutor` |
| 77 | `task-detail.spec.ts:76` Stop run spans states | `queueTask` clicks a Start that stays disabled for the same reason | stale fixture | `withExecutor` in the describe's `beforeEach` |
| 8 | `dashboard.spec.ts:109` custom picker commits once | Reopening after a committed custom window: the selected option's accessible name is `Custom ✓` (the `.popover-option[data-selected]::after` checkmark), so `{ name: 'Custom', exact: true }` never matches | stale selector | anchored `/^Custom( ✓)?$/` |
| 34 | `navigation.spec.ts:122` three options, switches without reload | Reads `<option>`s of a native `<select>`; the control is a Headless UI Listbox (`select-trigger` + `listbox`/`option` roles, issue 224) | stale selector | `expectAppearanceOptions` |
| 35 | `navigation.spec.ts:146` System removes the stored key | `selectOption` on a `<button>`: "Element is not a `<select>` element" | stale selector | `chooseAppearance` |
| 36 | `navigation.spec.ts:158` a second tab follows | Same, plus `toHaveValue` on a button | stale selector | `chooseAppearance`, trigger text |
| 37 | `navigation.spec.ts:176` narrow-screen target | Measures `.theme-select`, a class the Listbox no longer renders | stale selector | measure the labelled trigger |
| 38 | `navigation.spec.ts:188` paired screenshots at 1440 | `selectOption` on the Listbox trigger | stale selector | `chooseAppearance` |
| 89 | `auth.spec.ts:65` anonymous visitor gets the gate | Reads `<option>`s under the Appearance label | stale selector | `expectAppearanceOptions` |
| 94 | `auth.spec.ts:206` a choice of nothing refuses Continue | `Continue` is `aria-disabled` on purpose so the attempt is receivable; Playwright's actionability reads `aria-disabled` as disabled and waits out the 30 s timeout | stale test | `click({ force: true })` |
| 100 | `auth.spec.ts:319` signing out returns to the gate | `selectOption` on the Listbox trigger | stale selector | `chooseAppearance` |

Why the executor ones are the tests and not the app: since `f3aea62` (*Fix task-scoped executor routing*) a task
must name an executor, because the executor's type chooses the runner (`docs/workspace.md`). The open board
deliberately has no `ORG_WORKSPACE_ROOT`, which keeps a picker out of the visual check (`playwright.config.ts`), so
its `/api/workspace` always answers `executors: []`. The specs were written when "no executor" still meant "the
deployment default". `e2e/executor.ts` now fulfills that one read with the real answer plus one executor. The board
checks the label's shape only, so the queued task is real.

The re-run confirmed the behavior these fixes rely on. Picking the already-selected **Custom** still opens the range
dialog, and the Appearance trigger still clears 44 px at 360 px wide. Both would have been real defects otherwise.

One side effect of the fixture: the composer spec's `beforeEach` also covers its two tests that already passed (the
layout check and the dark-theme screenshots). Their screenshots now show a chosen executor, not the "Add an executor
in Settings" empty state. The browser suite no longer renders that empty state. The offline web suite still pins it
(`web/test/task-composer.render.test.tsx`, `web/test/task-composer-logic.test.ts`).

## After the fixes

| | |
| --- | --- |
| Commit | this branch (`bdac15e` + the selector-fix commit) |
| Command | `env -u GITHUB_TOKEN E2E_DB_HOST=timescale npm run verify:ui` |
| Started / finished (UTC) | 2026-09-27T08:51:03Z / 2026-09-27T08:54:20Z |
| **Result** | **109 passed, 0 failed** (3.3 min) |

## Per-test results at `e19fce1`

| Run # | Project | Spec | Test | Result | Time |
| ---: | --- | --- | --- | --- | ---: |
| 1 | chromium | `e2e/composer.spec.ts:40:5` | the guided task composer › a workflow that declares parameters asks for them in words before Start | **FAIL** | 6.1s |
| 2 | chromium | `e2e/composer.spec.ts:93:5` | the guided task composer › the compact context row stays content-sized, and the optional steps sit behind a closed disclosure | pass | 1.2s |
| 3 | chromium | `e2e/composer.spec.ts:141:5` | the guided task composer › renders correctly in dark theme at desktop and mobile widths | pass | 845ms |
| 4 | chromium | `e2e/composer.spec.ts:166:5` | the guided task composer › an unchosen workflow runs the raw prompt, and an empty prompt explains the dark Start | **FAIL** | 5.5s |
| 5 | chromium | `e2e/composer.spec.ts:189:5` | the guided task composer › the keyboard path shares the button validation: marks, focuses, and never queues | **FAIL** | 6.0s |
| 6 | chromium | `e2e/dashboard.spec.ts:71:5` | date range selector › every preset re-renders the whole dashboard cleanly | pass | 2.8s |
| 7 | chromium | `e2e/dashboard.spec.ts:96:5` | date range selector › a narrowed range changes the numbers | pass | 769ms |
| 8 | chromium | `e2e/dashboard.spec.ts:109:5` | date range selector › the custom picker commits once through Apply, and a draft never requests | **FAIL** | 30.1s |
| 9 | chromium | `e2e/dashboard.spec.ts:172:5` | date range selector › the custom range dialog stays inside the viewport and restores focus to the trigger on a narrow phone | pass | 957ms |
| 10 | chromium | `e2e/dashboard.spec.ts:195:5` | date range selector › the chart tooltip stays inside the viewport when a bucket is focused | pass | 550ms |
| 11 | chromium | `e2e/dashboard.spec.ts:211:5` | date range selector › a range with almost no data renders empty or ready, never broken | pass | 969ms |
| 12 | chromium | `e2e/dashboard.spec.ts:230:5` | date range selector › the page carries no pull-request vocabulary | pass | 463ms |
| 13 | chromium | `e2e/dashboard.spec.ts:238:5` | date range selector › month buckets daily, all-time falls back to weeks, and the per-task figures render | pass | 1.5s |
| 14 | chromium | `e2e/dashboard.spec.ts:270:5` | the supporting tables and the task board › a supporting table sorts from the keyboard and announces the active column | pass | 656ms |
| 15 | chromium | `e2e/dashboard.spec.ts:283:5` | the supporting tables and the task board › a recent task title opens the task page | pass | 573ms |
| 16 | chromium | `e2e/dashboard.spec.ts:294:5` | the supporting tables and the task board › View all tasks opens the task list | pass | 580ms |
| 17 | chromium | `e2e/dashboard.spec.ts:301:5` | the supporting tables and the task board › a board read failure keeps the last good rows while the telemetry stays | pass | 30.8s |
| 18 | chromium | `e2e/dashboard.spec.ts:320:5` | the supporting tables and the task board › a cold board failure shows the error in place | pass | 503ms |
| 19 | chromium | `e2e/dashboard.spec.ts:331:5` | the supporting tables and the task board › the page never overflows horizontally at the target widths | pass | 1.4s |
| 20 | chromium | `e2e/dashboard.spec.ts:342:5` | the supporting tables and the task board › the primary content begins in the first viewport | pass | 717ms |
| 21 | chromium | `e2e/dashboard.spec.ts:364:5` | the organization selector › names the organization and is inert | pass | 628ms |
| 22 | chromium | `e2e/dashboard.spec.ts:384:5` | the user menu › offers the way to the account page but no sign out where there is no session to end | pass | 792ms |
| 23 | chromium | `e2e/env.spec.ts:61:5` | environment editors › renders each scope editor on its own settings section, cleanly | pass | 956ms |
| 24 | chromium | `e2e/env.spec.ts:92:5` | environment editors › a variable can be added by row, edited, and saved | pass | 1.0s |
| 25 | chromium | `e2e/env.spec.ts:116:5` | environment editors › the draft spans tab switches without losing a keystroke | pass | 992ms |
| 26 | chromium | `e2e/env.spec.ts:136:5` | environment editors › removal is pending with Undo, and only the save deletes | pass | 1.2s |
| 27 | chromium | `e2e/env.spec.ts:165:5` | environment editors › the advanced .env editor applies valid text, and invalid text changes nothing | pass | 1.1s |
| 28 | chromium | `e2e/env.spec.ts:195:5` | environment editors › secrets show Set, and a typed replacement is the only path to a change | pass | 1.2s |
| 29 | chromium | `e2e/env.spec.ts:220:5` | environment editors › a dirty editor guards in-app navigation with the one dialog | pass | 1.2s |
| 30 | chromium | `e2e/env.spec.ts:249:5` | environment editors › the repositories page offers no checkout without a workspace root, though rows stay readable | pass | 695ms |
| 31 | chromium | `e2e/env.spec.ts:279:5` | environment editors › the browser tab guard arms only while dirty | pass | 5.9s |
| 32 | chromium | `e2e/env.spec.ts:308:5` | environment editors › a failed save retains the draft and its pending removals, then a retry succeeds | pass | 1.1s |
| 33 | chromium | `e2e/env.spec.ts:357:5` | environment editors › the editor stays usable and overflow-free at a narrow phone width | pass | 779ms |
| 34 | chromium | `e2e/navigation.spec.ts:122:5` | appearance › the control carries the three options and switches immediately without a reload | **FAIL** | 637ms |
| 35 | chromium | `e2e/navigation.spec.ts:146:5` | appearance › System removes the stored key and resolves the live OS palette | **FAIL** | 761ms |
| 36 | chromium | `e2e/navigation.spec.ts:158:5` | appearance › a second tab follows the first | **FAIL** | 1.1s |
| 37 | chromium | `e2e/navigation.spec.ts:176:5` | appearance › the selector clears its narrow-screen target and the bar holds | **FAIL** | 30.1s |
| 38 | chromium | `e2e/navigation.spec.ts:188:5` | appearance › paired dark and light screenshots at 1440 | **FAIL** | 824ms |
| 39 | chromium | `e2e/navigation.spec.ts:202:5` | the desktop shell › the seeded board holds at least a hundred tasks | pass | 178ms |
| 40 | chromium | `e2e/navigation.spec.ts:212:5` | the desktop shell › every routed page answers with one main region and at most one h1 | pass | 5.4s |
| 41 | chromium | `e2e/navigation.spec.ts:228:5` | the desktop shell › the persistent nav holds 240px and the app bar sticks without an h1 | pass | 949ms |
| 42 | chromium | `e2e/navigation.spec.ts:246:5` | the desktop shell › dashboard telemetry lives only on the dashboard | pass | 880ms |
| 43 | chromium | `e2e/navigation.spec.ts:258:5` | the desktop shell › the sidenav preview never exceeds five rows per section | pass | 522ms |
| 44 | chromium | `e2e/navigation.spec.ts:285:9` | the responsive shell › no page-level horizontal overflow at 320px | pass | 2.3s |
| 45 | chromium | `e2e/navigation.spec.ts:285:9` | the responsive shell › no page-level horizontal overflow at 360px | pass | 2.3s |
| 46 | chromium | `e2e/navigation.spec.ts:285:9` | the responsive shell › no page-level horizontal overflow at 768px | pass | 2.2s |
| 47 | chromium | `e2e/navigation.spec.ts:285:9` | the responsive shell › no page-level horizontal overflow at 1024px | pass | 2.2s |
| 48 | chromium | `e2e/navigation.spec.ts:285:9` | the responsive shell › no page-level horizontal overflow at 1440px | pass | 2.3s |
| 49 | chromium | `e2e/navigation.spec.ts:306:5` | the responsive shell › the skip link is the first stop and never steals focus | pass | 807ms |
| 50 | chromium | `e2e/navigation.spec.ts:333:5` | the responsive shell › keyboard focus paints the accent ring on navigation and controls, in both themes | pass | 773ms |
| 51 | chromium | `e2e/navigation.spec.ts:366:9` | the responsive shell › the drawer manages focus at 768px | pass | 1.4s |
| 52 | chromium | `e2e/navigation.spec.ts:366:9` | the responsive shell › the drawer manages focus at 390px | pass | 1.6s |
| 53 | chromium | `e2e/navigation.spec.ts:366:9` | the responsive shell › the drawer manages focus at 360px | pass | 2.9s |
| 54 | chromium | `e2e/navigation.spec.ts:443:9` | the responsive shell › toolbar groups wrap and every action stays reachable at 360px | pass | 2.1s |
| 55 | chromium | `e2e/navigation.spec.ts:443:9` | the responsive shell › toolbar groups wrap and every action stays reachable at 390px | pass | 1.8s |
| 56 | chromium | `e2e/navigation.spec.ts:464:5` | the responsive shell › horizontal scrolling lives only in named regions on a narrow phone | pass | 4.5s |
| 57 | chromium | `e2e/navigation.spec.ts:484:5` | the responsive shell › 200% zoom keeps every primary route free of page-level overflow | pass | 6.9s |
| 58 | chromium | `e2e/navigation.spec.ts:511:5` | the responsive shell › the account menu opens inside the viewport and restores its trigger on a narrow phone | pass | 1.7s |
| 59 | chromium | `e2e/navigation.spec.ts:548:13` | the visual regression matrix › captures every primary route — dark at 1440 | pass | 8.1s |
| 60 | chromium | `e2e/navigation.spec.ts:548:13` | the visual regression matrix › captures every primary route — light at 1440 | pass | 8.7s |
| 61 | chromium | `e2e/navigation.spec.ts:548:13` | the visual regression matrix › captures every primary route — dark at 768 | pass | 4.3s |
| 62 | chromium | `e2e/navigation.spec.ts:548:13` | the visual regression matrix › captures every primary route — light at 768 | pass | 4.2s |
| 63 | chromium | `e2e/navigation.spec.ts:548:13` | the visual regression matrix › captures every primary route — dark at 390 | pass | 3.9s |
| 64 | chromium | `e2e/navigation.spec.ts:548:13` | the visual regression matrix › captures every primary route — light at 390 | pass | 3.2s |
| 65 | chromium | `e2e/navigation.spec.ts:548:13` | the visual regression matrix › captures every primary route — dark at 320 | pass | 3.3s |
| 66 | chromium | `e2e/navigation.spec.ts:548:13` | the visual regression matrix › captures every primary route — light at 320 | pass | 3.0s |
| 67 | chromium | `e2e/navigation.spec.ts:565:5` | the visual regression matrix › captures the drawer open on a narrow phone | pass | 787ms |
| 68 | chromium | `e2e/navigation.spec.ts:578:5` | the visual regression matrix › captures the account menu and the range dialog open | pass | 1.1s |
| 69 | chromium | `e2e/navigation.spec.ts:599:5` | the visual regression matrix › captures the remove dialog open on a narrow phone | pass | 758ms |
| 70 | chromium | `e2e/polish.spec.ts:127:9` | polish (issue 189) › the contrast matrix meets WCAG AA in the dark theme | pass | 656ms |
| 71 | chromium | `e2e/polish.spec.ts:145:9` | polish (issue 189) › focus rings stay visible on every control kind in the dark theme | pass | 1.1s |
| 72 | chromium | `e2e/polish.spec.ts:127:9` | polish (issue 189) › the contrast matrix meets WCAG AA in the light theme | pass | 807ms |
| 73 | chromium | `e2e/polish.spec.ts:145:9` | polish (issue 189) › focus rings stay visible on every control kind in the light theme | pass | 996ms |
| 74 | chromium | `e2e/polish.spec.ts:158:5` | polish (issue 189) › reduced motion stills the lamp and keeps the state text | pass | 800ms |
| 75 | chromium | `e2e/polish.spec.ts:170:5` | polish (issue 189) › controls clear 44px at 390px | pass | 746ms |
| 76 | chromium | `e2e/polish.spec.ts:188:5` | polish (issue 189) › forced colors keep keyboard focus visible | pass | 868ms |
| 77 | chromium | `e2e/task-detail.spec.ts:76:5` | the task detail actions › Stop run spans queued, running and stopping; Mark done waits behind them | **FAIL** | 30.5s |
| 78 | chromium | `e2e/task-detail.spec.ts:114:5` | the task detail actions › Mark done closes a task, and the closure reads as attribution, not a disabled control | pass | 2.6s |
| 79 | chromium | `e2e/task-detail.spec.ts:133:5` | the task detail actions › the remove dialog: keyboard path, initial focus, focus restoration, refusal, and the route out | pass | 4.0s |
| 80 | chromium | `e2e/task-detail.spec.ts:252:5` | the task detail actions › the remove dialog contains itself and restores its trigger at a narrow phone width | pass | 876ms |
| 81 | chromium | `e2e/task-detail.spec.ts:281:5` | the task detail actions › no page-level horizontal overflow at any target width | pass | 3.0s |
| 82 | chromium | `e2e/task-detail.spec.ts:359:5` | the task detail page › a finished thread reads request, response, checks, published work, metadata | pass | 923ms |
| 83 | chromium | `e2e/task-detail.spec.ts:418:5` | the task detail page › a follow-up thread labels its runs and attaches work to each | pass | 684ms |
| 84 | chromium | `e2e/task-detail.spec.ts:457:5` | the task detail page › a finished task without a captured response says so, and offers the composer | pass | 449ms |
| 85 | chromium | `e2e/task-detail.spec.ts:473:5` | the task detail page › a sessionless terminal run links to a new task, and a closed one renders no composer | pass | 735ms |
| 86 | chromium | `e2e/task-detail.spec.ts:505:5` | the task detail page › a failed send preserves the draft | pass | 564ms |
| 87 | chromium | `e2e/task-detail.spec.ts:525:5` | the task detail page › a running run shows its activity and a bounded live output | pass | 618ms |
| 88 | chromium | `e2e/task-detail.spec.ts:585:5` | the task detail page › the detail renders at every target width without overflow | pass | 1.7s |
| 89 | auth | `e2e/auth.spec.ts:65:1` | an anonymous visitor gets the gate and no dashboard | **FAIL** | 5.7s |
| 90 | auth | `e2e/auth.spec.ts:82:1` | the gate holds a narrow phone inside the viewport, in both palettes (issue 190) | pass | 715ms |
| 91 | auth | `e2e/auth.spec.ts:105:1` | the document itself is served without authentication | pass | 400ms |
| 92 | auth | `e2e/auth.spec.ts:112:1` | the selection screen tracks only the chosen organizations (issue 125) | pass | 4.2s |
| 93 | auth | `e2e/auth.spec.ts:169:1` | the screen explains itself, its identity, and the default choice (issue 187) | pass | 1.6s |
| 94 | auth | `e2e/auth.spec.ts:206:1` | a choice of nothing refuses Continue and says what is missing (issue 187) | **FAIL** | 30.1s |
| 95 | auth | `e2e/auth.spec.ts:229:1` | an unavailable repository listing says so and keeps the choice completable (issue 187) | pass | 1.0s |
| 96 | auth | `e2e/auth.spec.ts:255:1` | the next sign-in reuses the stored choice without the screen (issue 125) | pass | 1.0s |
| 97 | auth | `e2e/auth.spec.ts:270:1` | signing in lands on the dashboard | pass | 595ms |
| 98 | auth | `e2e/auth.spec.ts:275:1` | sign-in materializes the chosen installation as the member's organization | pass | 819ms |
| 99 | auth | `e2e/auth.spec.ts:294:1` | POST /api/auth/org switches the session, refusing what is unknown or anonymous | pass | 820ms |
| 100 | auth | `e2e/auth.spec.ts:319:1` | signing out returns to the gate | **FAIL** | 1.0s |
| 101 | auth | `e2e/auth.spec.ts:346:1` | the returnTo path survives the round trip | pass | 749ms |
| 102 | auth | `e2e/auth.spec.ts:355:1` | the scope dropdown scopes the figures to the signed-in member | pass | 1.1s |
| 103 | auth | `e2e/workspace.spec.ts:34:1` | the left nav is there and moves between sections | pass | 1.0s |
| 104 | auth | `e2e/workspace.spec.ts:58:1` | reloading /settings/workspace directly serves the app rather than a 404 | pass | 812ms |
| 105 | auth | `e2e/workspace.spec.ts:78:1` | a signed-out visitor deep-linking to the settings tree gets the gate, not a 404 | pass | 378ms |
| 106 | auth | `e2e/workspace.spec.ts:86:1` | the workspace page links to the repositories page for checkout management | pass | 1.1s |
| 107 | auth | `e2e/workspace.spec.ts:105:1` | the repositories page carries the selection surface, and its draft meets the guard | pass | 1.7s |
| 108 | auth | `e2e/workspace.spec.ts:155:1` | an executor is added through the dialog, with bad JSON refused in place | pass | 2.0s |
| 109 | auth | `e2e/workspace.spec.ts:249:1` | the workspace section renders nothing malformed | pass | 928ms |

## Output tail per failure at `e19fce1`

Headings carry the run # from the tables above.

#### Run #1 · [chromium] › e2e/composer.spec.ts:40:5 › the guided task composer › a workflow that declares parameters asks for them in words before Start

```text
    Error: expect(locator).toBeVisible() failed

    Locator: locator('.composer').getByText('Complete the required workflow details to continue.')
    Expected: visible
    Timeout: 5000ms
    Error: element(s) not found

    Call log:
      - Expect "toBeVisible" with timeout 5000ms
      - waiting for locator('.composer').getByText('Complete the required workflow details to continue.')

      75 |         const start = page.getByRole('button', { name: 'Start task' });
      76 |         await expect(start).toBeDisabled();
    > 77 |         await expect(composer.getByText('Complete the required workflow details to continue.')).toBeVisible();
         |                                                                                                 ^
      78 |
      79 |         // A value the declaration accepts lights Start and the preflight speaks the actual choices.
      80 |         await issue.fill('#12');
        at e2e/composer.spec.ts:77:97
```

#### Run #4 · [chromium] › e2e/composer.spec.ts:166:5 › the guided task composer › an unchosen workflow runs the raw prompt, and an empty prompt explains the dark Start

```text
    Error: expect(locator).toBeVisible() failed

    Locator: locator('.composer').getByText('Describe the task to continue.')
    Expected: visible
    Timeout: 5000ms
    Error: element(s) not found

    Call log:
      - Expect "toBeVisible" with timeout 5000ms
      - waiting for locator('.composer').getByText('Describe the task to continue.')

      175 |         const start = page.getByRole('button', { name: 'Start task' });
      176 |         await expect(start).toBeDisabled();
    > 177 |         await expect(composer.getByText('Describe the task to continue.')).toBeVisible();
          |                                                                            ^
      178 |         await expect(composer.locator('.composer-param-error')).toHaveCount(0);
      179 |
      180 |         // The prompt is the only requirement: no process chosen, the member's words are the
        at e2e/composer.spec.ts:177:76
```

#### Run #5 · [chromium] › e2e/composer.spec.ts:189:5 › the guided task composer › the keyboard path shares the button validation: marks, focuses, and never queues

```text
    Error: expect(page).toHaveURL(expected) failed

    Expected pattern: /\/tasks\/[0-9a-f-]{36}/
    Received string:  "http://127.0.0.1:8123/tasks/new"
    Timeout: 5000ms

    Call log:
      - Expect "toHaveURL" with timeout 5000ms
        14 × locator resolved to <html lang="en" data-theme="light">…</html>
           - unexpected value "http://127.0.0.1:8123/tasks/new"

      211 |         await issue.fill('#12');
      212 |         await issue.press('ControlOrMeta+Enter');
    > 213 |         await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}/);
          |                            ^
      214 |         expect(problems.join('\n')).toBe('');
      215 |
      216 |         // Leave no claimable task behind: the task-detail spec claims against the same seeded
        at e2e/composer.spec.ts:213:28
```

#### Run #8 · [chromium] › e2e/dashboard.spec.ts:109:5 › date range selector › the custom picker commits once through Apply, and a draft never requests

```text
    Test timeout of 30000ms exceeded.

    Error: locator.click: Test timeout of 30000ms exceeded.
    Call log:
      - waiting for getByRole('option', { name: 'Custom', exact: true })

      118 |         const openCustom = async () => {
      119 |             await page.locator('#range-select').click();
    > 120 |             await page.getByRole('option', { name: 'Custom', exact: true }).click();
          |                                                                             ^
      121 |         };
      122 |
      123 |         // Custom opens the dialog; opening it is not a selection and issues no request.
        at openCustom (e2e/dashboard.spec.ts:120:77)
        at e2e/dashboard.spec.ts:160:9
```

#### Run #34 · [chromium] › e2e/navigation.spec.ts:122:5 › appearance › the control carries the three options and switches immediately without a reload

```text
    Error: expect(received).toEqual(expected) // deep equality

    - Expected  - 5
    + Received  + 1

    - Array [
    -   "System",
    -   "Light",
    -   "Dark",
    - ]
    + Array []

      125 |         await select.waitFor({ state: 'attached' });
      126 |
    > 127 |         expect(await select.locator('option').allInnerTexts()).toEqual(['System', 'Light', 'Dark']);
          |                                                                ^
      128 |         // The factory state is System with no stored key, resolved to the live OS palette.
      129 |         expect(await stored(page)).toBeNull();
      130 |         expect(await page.locator('html').getAttribute('data-theme')).toBe(await systemTheme(page));
        at e2e/navigation.spec.ts:127:64
```

#### Run #35 · [chromium] › e2e/navigation.spec.ts:146:5 › appearance › System removes the stored key and resolves the live OS palette

```text
    Error: locator.selectOption: Error: Element is not a <select> element
    Call log:
      - waiting for getByLabel('Appearance')
        - locator resolved to <button type="button" id="theme-select" aria-expanded="false" class="select-trigger" aria-haspopup="listbox" data-headlessui-state="" aria-labelledby="headlessui-label-_r_3_ theme-select">System</button>
      - attempting select option action
        - waiting for element to be visible and enabled

      148 |         const select = page.getByLabel('Appearance');
      149 |         await select.waitFor({ state: 'attached' });
    > 150 |         await select.selectOption('light');
          |                      ^
      151 |         await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      152 |         await select.selectOption('system');
      153 |         expect(await stored(page)).toBeNull();
        at e2e/navigation.spec.ts:150:22
```

#### Run #36 · [chromium] › e2e/navigation.spec.ts:158:5 › appearance › a second tab follows the first

```text
    Error: locator.selectOption: Error: Element is not a <select> element
    Call log:
      - waiting for getByLabel('Appearance')
        - locator resolved to <button type="button" id="theme-select" aria-expanded="false" class="select-trigger" aria-haspopup="listbox" data-headlessui-state="" aria-labelledby="headlessui-label-_r_3_ theme-select">System</button>
      - attempting select option action
        - waiting for element to be visible and enabled

      164 |         await other.getByLabel('Appearance').waitFor({ state: 'attached' });
      165 |
    > 166 |         await select.selectOption('light');
          |                      ^
      167 |         await expect(other.locator('html')).toHaveAttribute('data-theme', 'light');
      168 |         await expect(other.getByLabel('Appearance')).toHaveValue('light');
      169 |
        at e2e/navigation.spec.ts:166:22
```

#### Run #37 · [chromium] › e2e/navigation.spec.ts:176:5 › appearance › the selector clears its narrow-screen target and the bar holds

```text
    Test timeout of 30000ms exceeded.

    Error: locator.boundingBox: Test timeout of 30000ms exceeded.
    Call log:
      - waiting for locator('.theme-select')

      178 |         await page.goto('/');
      179 |         await page.getByLabel('Appearance').waitFor({ state: 'attached' });
    > 180 |         expect((await page.locator('.theme-select').boundingBox())?.height).toBeGreaterThanOrEqual(44);
          |                                                     ^
      181 |         await expect
      182 |             .poll(() =>
      183 |                 page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        at e2e/navigation.spec.ts:180:53
```

#### Run #38 · [chromium] › e2e/navigation.spec.ts:188:5 › appearance › paired dark and light screenshots at 1440

```text
    Error: locator.selectOption: Error: Element is not a <select> element
    Call log:
      - waiting for getByLabel('Appearance')
        - locator resolved to <button type="button" id="theme-select" aria-expanded="false" class="select-trigger" aria-haspopup="listbox" data-headlessui-state="" aria-labelledby="headlessui-label-_r_3_ theme-select">System</button>
      - attempting select option action
        - waiting for element to be visible and enabled

      190 |         const select = page.getByLabel('Appearance');
      191 |         await select.waitFor({ state: 'attached' });
    > 192 |         await select.selectOption('light');
          |                      ^
      193 |         await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      194 |         await page.screenshot({ path: `${SHOTS}/appearance-light-1440.png`, fullPage: true });
      195 |         await select.selectOption('dark');
        at e2e/navigation.spec.ts:192:22
```

#### Run #77 · [chromium] › e2e/task-detail.spec.ts:76:5 › the task detail actions › Stop run spans queued, running and stopping; Mark done waits behind them

```text
    Test timeout of 30000ms exceeded.

    Error: locator.click: Test timeout of 30000ms exceeded.
    Call log:
      - waiting for getByRole('button', { name: 'Start task' })
        - locator resolved to <button disabled type="button" class="primary">Start task</button>
      - attempting click action
        2 × waiting for element to be visible, enabled and stable
          - element is not enabled
        - retrying click action
        - waiting 20ms
        2 × waiting for element to be visible, enabled and stable
          - element is not enabled
        - retrying click action
          - waiting 100ms
        58 × waiting for element to be visible, enabled and stable
           - element is not enabled
         - retrying click action
           - waiting 500ms

      25 |     // The guided composer (#176): the prompt is a labelled field, the action is Start task.
      26 |     await page.getByLabel('What should the agent do?').fill(command);
    > 27 |     await page.getByRole('button', { name: 'Start task' }).click();
         |                                                            ^
      28 |     await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
      29 |     return /\/tasks\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
      30 | }
        at queueTask (e2e/task-detail.spec.ts:27:60)
        at e2e/task-detail.spec.ts:80:9
```

#### Run #89 · [auth] › e2e/auth.spec.ts:65:1 › an anonymous visitor gets the gate and no dashboard

```text
    Error: expect(locator).toHaveText(expected) failed

    Locator: getByLabel('Appearance').locator('option')
    Timeout: 5000ms
    - Expected  - 5
    + Received  + 1

    - Array [
    -   "System",
    -   "Light",
    -   "Dark",
    - ]
    + Array []

    Call log:
      - Expect "toHaveText" with timeout 5000ms
      - waiting for getByLabel('Appearance').locator('option')
        14 × locator resolved to 0 elements

      77 |     const appearance = page.getByLabel('Appearance');
      78 |     await expect(appearance).toBeVisible();
    > 79 |     await expect(appearance.locator('option')).toHaveText(['System', 'Light', 'Dark']);
         |                                                ^
      80 | });
      81 |
      82 | test('the gate holds a narrow phone inside the viewport, in both palettes (issue 190)', async ({ page }) => {
        at e2e/auth.spec.ts:79:48
```

#### Run #94 · [auth] › e2e/auth.spec.ts:206:1 › a choice of nothing refuses Continue and says what is missing (issue 187)

```text
    Test timeout of 30000ms exceeded.

    Error: locator.click: Test timeout of 30000ms exceeded.
    Call log:
      - waiting for getByRole('button', { name: 'Continue' })
        - locator resolved to <button type="button" class="primary" aria-disabled="true">Continue</button>
      - attempting click action
        2 × waiting for element to be visible, enabled and stable
          - element is not enabled
        - retrying click action
        - waiting 20ms
        2 × waiting for element to be visible, enabled and stable
          - element is not enabled
        - retrying click action
          - waiting 100ms
        55 × waiting for element to be visible, enabled and stable
           - element is not enabled
         - retrying click action
           - waiting 500ms

      217 |     await expect(page.getByText('Choose at least one organization to continue.')).toBeVisible();
      218 |     // The attempted action is receivable — it cannot post, and the screen stands.
    > 219 |     await cont.click();
          |                ^
      220 |     await expect(screen(page)).toBeVisible();
      221 |
      222 |     // Choosing one organization re-enables the action and completes.
        at e2e/auth.spec.ts:219:16
```

#### Run #100 · [auth] › e2e/auth.spec.ts:319:1 › signing out returns to the gate

```text
    Error: locator.selectOption: Error: Element is not a <select> element
    Call log:
      - waiting for getByLabel('Appearance')
        - locator resolved to <button type="button" id="theme-select" aria-expanded="false" class="select-trigger" aria-haspopup="listbox" data-headlessui-state="" aria-labelledby="headlessui-label-_r_19_ theme-select">System</button>
      - attempting select option action
        - waiting for element to be visible and enabled

      333 |     // The appearance preference (issue 188) is local, not session state: the choice outlives the
      334 |     // sign-out, on the gate as anywhere.
    > 335 |     await page.getByLabel('Appearance').selectOption('dark');
          |                                         ^
      336 |     await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      337 |     await page.reload();
      338 |     await expect(gate(page)).toBeVisible();
        at e2e/auth.spec.ts:335:41
```
