---
name: ui-fix
description: Fix a UI defect in the Factory dashboard end to end — reproduce it in a real browser, write the failing test first (vitest for pure logic, a Playwright spec for anything visual), fix, then verify with `npm run verify:ui`, reading the screenshots it leaves behind. Runs in an isolated worktree, reviewer-gated, ships as a PR. Trigger phrases: "/ui-fix", "fix the UI", "the dashboard looks broken", "this panel is blank", "fix this UI bug", or a GitHub issue about anything rendered.
---

# Fix a UI defect end to end

Fix the UI defect given as a GitHub issue or described in chat. The flow mirrors the [`fix`](../fix/SKILL.md)
skill — worktree, TDD, review gate, PR — with two additions: the reproduction is driven by what the
page shows, and nothing ships until Playwright has verified the fix in a real browser. `npm test`
renders the panels with `react-dom/server` and proves they do not throw; it does not prove they look
right. That gap is what this skill closes.

## Phase 0 — Intake

- An issue number → `gh issue view <url-or-number> --json number,title,body,labels,comments,state`.
  Comments included; clarifications live there.
- A symptom in chat → restate it as a checkable statement before touching anything: which page,
  which range or control, what renders now, what should render instead. If the symptom cannot be
  made checkable ("looks off"), ask and stop.
- Read AGENTS.md and the `docs/` file for the area before editing: `docs/design-system.md` for
  anything under `web/src` (tokens and primitives — `web/test/styles.test.ts` enforces both),
  `docs/date-range.md` for the range selector and charts, `docs/api.md` if a payload shape is
  involved.
- A UI symptom is not a UI root cause. Expect the fault to land in `web/src`, in `core` aggregation
  or in a server payload with roughly equal odds. Locate it before deciding anything.

## Phase 1 — Worktree and baseline

Run the `fix` skill's Phase 1 verbatim: sibling worktree off the default branch, branch
`fix/<issue-number>-<slug>`, `cp -cR node_modules`, copy gitignored local files (`.env` and the
like), and `npm test` proving the tree runs — all inside it from here on. The Factory task exception
(current branch already `factory/<uuid>` → the worktree exists, never switch branches) carries over
unchanged.

This skill needs two more things before anything else:

- A running timescale: `docker compose up -d timescale`. `verify:ui` seeds `factory_e2e` and
  `factory_auth_e2e` itself.
- Chromium: `npx playwright install chromium` (once per machine).

Record the baseline: run the existing spec covering the area (`npx playwright test -g '<name>'`).
If it is green and the defect is not visible in its screenshots, the repro will need a new
assertion, not an edit to an old one — Phase 3 decides which.

## Phase 2 — Reproduce, locate the root cause

Drive the page until the defect is on screen: `npx playwright test --headed` to watch it, or run
the walk and read the screenshot it leaves in `artifacts/ui/`. Then name the root cause with a
`file:line` before editing anything. Signs that point where:

- Numbers wrong, rendering fine → `core` aggregation or the API payload first.
- Renders wrong with right data → `web/src`, checked against `docs/design-system.md`.
- Blank panel, a literal `NaN`/`undefined`/`[object Object]` → the null-guard contract; the e2e
  forbidden-token sweep exists for exactly this class of defect.

If you cannot explain the failure, stop and ask. Do not pick an interpretation silently.

## Phase 3 — Red repro at the right layer

TDD order is non-negotiable: the failing test exists before the fix, and they never land in one
commit.

- Pure logic — a formatter, a hook's derived state, a reducer — → vitest in `web/test/`, in the
  suite's existing style.
- Anything visual, interactive or payload-shape-dependent → a spec in `e2e/`, matching
  `dashboard.spec.ts` conventions: role/aria locators, `watchConsole`, the forbidden-token sweep,
  full-page screenshots. Mind its two documented traps: `.cards` is not unique (scope it, as
  `usageCards` does), and a preset that resolves to the query already on screen never refetches —
  waiting on that response hangs until the timeout.
- The area has no e2e coverage → write the baseline spec first: the states the area can be in, one
  interaction, a screenshot per state. Get the baseline green, then add the failing assertion on
  top. A red baseline means the spec is wrong, not the app.

Run it and confirm it FAILS for the predicted reason. A setup error, a timeout or zero tests
collected is not a red. Commit the repro alone.

## Phase 4 — Fix

Minimum that turns the red green:

- Surgical. No adjacent refactors, no speculative abstractions; every changed line traces to the
  defect.
- Styling flows through the tokens (`docs/design-system.md`): no color literals outside `:root`,
  primitives before one-offs. `styles.test.ts` will hold you to it.
- No backward compatibility — this repo is under construction. Update the callers and delete the
  old path in the same change.
- `core` changed → `npm run build -w core` before trusting any typecheck: `server` and `web` resolve
  `@factory-ai/core` to `core/dist`.

Re-run the repro → green. If the repro was a throwaway issue-named file, fold its assertions into
the permanent suite under a behavior-descriptive name and delete the file. Then re-run the affected
suites.

## Phase 5 — Playwright verification

The gate that names this skill. From the worktree:

```bash
npm run verify:ui                       # all specs, chromium, headless
npx playwright show-trace artifacts/ui/trace/<name>/trace.zip   # on a failure
```

The config builds all four packages and boots fresh servers against freshly seeded databases —
a leftover server can never verify stale code. Never point Playwright at `npm run dev`; the built
SPA served by the API is the arrangement under test.

Then, in order:

1. Every spec green on `chromium` — and on `auth` too if sessions, sign-in or the workspace page
   were touched.
2. **Read every screenshot in `artifacts/ui/`** (the Read tool on the `.png` files). A passing
   assertion proves the DOM was right; the screenshot is the only thing that proves the layout was.
   A fix is not verified until its screenshot shows the fix.
3. Read the report, not just the exit code: pass counts non-zero, no `.skip`, no `.only`, and the
   console-error / failed-request assertions included in the green.

Gates after, all green: `npm test`, `npm run typecheck`, `npm run lint` (`npm run format` for pure
drift). Never delete, skip or weaken an assertion — yours or the repo's — to get there. `retries`
is 0 on purpose: a pass that needs a retry is not a fix.

## Phase 6 — Review and ship

1. Complete diff: `git diff $(git merge-base HEAD <default-branch>)...HEAD`, plus uncommitted work
   staged into a temp view — the reviewer must see everything.
2. Spawn the `reviewer` subagent (task tool) with the diff, the issue title and body, and a
   one-paragraph summary of the approach. Fix blockers (max 3 rounds; any fix that touches what
   renders re-runs Phase 5). Nitpicks only if trivial.
3. `git status` shows only files the fix touched. Stage only those. Never commit secrets, `.env`
   or `artifacts/` — the screenshots live locally; describe what they showed in the PR body.
4. Push, then `gh pr create --title "<short title>" --body <body> --base <default-branch>`. The body
   carries: the root cause, the change, the red → green story (which spec, which assertion), the
   `verify:ui` result and what the screenshots showed, and `Fixes #<N>` on its own line.
5. Report the PR URL, the worktree path, and the verification evidence in two lines.

## Hard rules

- **No fix without a red first; no done without a screenshot read.** These are the two failure
  modes this skill exists to close, and both shortcuts recreate them.
- **Never weaken a test to go green** — not the new one, not an existing one, not a timeout.
- **`retries: 0`, `workers: 1`.** Do not restore either to paper over flakiness; find the race.
- **Playwright observes, it does not set up.** Page state comes from UI actions on the seeded
  board. Never seed the database for one bug, never drive the API to arrange state the UI can
  reach, never hardcode ids.
- **Match the e2e house style** — role/aria locators, helpers at the top of the spec, assertions on
  what a reader would notice rather than on markup. No selector infrastructure (no `selectors.ts`,
  no page objects) until a third spec genuinely shares it.
