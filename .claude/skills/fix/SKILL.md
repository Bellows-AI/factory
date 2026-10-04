---
name: fix
description: Fix a GitHub issue end-to-end in an isolated git worktree — fetch with gh, plan with the fix-planner subagent, TDD implementation, review loop with the reviewer subagent, commit, push, open PR, then wait for GitHub review and address every comment in a bounded loop. Trigger phrases: "/fix", "fix this issue", "fix the GitHub issue", "work on issue #N".
---

# Fix a GitHub issue end-to-end

Fix the GitHub issue given as the argument. Run all seven phases in order, autonomously — do not
pause for approval between phases; stop only when genuinely blocked (see the stop conditions in
each phase). Track progress with the todo tool throughout.

Everything from Phase 1 on — planning included — runs inside a dedicated git worktree, never the
main checkout.

## Phase 0 — Fetch the issue

- If no issue URL/number was given, ask for one and stop.
- Fetch the issue with full detail, comments included:
  `gh issue view <url-or-number> --json number,title,body,labels,comments,state`
- If the issue is already closed, say so and ask whether to proceed.
- Before touching any code, read this repo's AGENTS.md and the `docs/` file that covers the area
  you will change — the "Read before you touch" table maps areas to files.

## Phase 1 — Create the worktree

**Factory task exception:** if the current branch already matches `factory/<uuid>`
(`git branch --show-current`), this run is a Factory board task — the worktree and the branch
already exist and the board resumes follow-ups on that exact checkout. Skip the creation steps
below: WORKTREE is the current directory, and wherever this phase says `fix/<issue-number>-<slug>`,
read the task branch you are on. Never create or switch branches in this tree — leaving it off the
task branch strands the run: the board's resume gate refuses a follow-up whose checkout is not on
`factory/<uuid>`, and the work becomes unreachable to the thread that owns it.

1. Resolve the repo root (`git rev-parse --show-toplevel`) and the default branch
   (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`), then update the base:
   `git fetch origin <default-branch>`.
2. Create the worktree as a sibling of the repo root, with a fresh branch off the default branch:
   `git worktree add <root>/../<repo-name>-fix-<issue-number> -b fix/<issue-number>-<short-slug> origin/<default-branch>`
   The slug comes from the issue title. Never reuse an existing branch or an existing path; if
   creation fails, stop and ask.
3. Untracked files do not follow a worktree, so recreate the environment: clone dependencies from
   the main checkout when possible (`cp -cR <root>/node_modules <worktree>/node_modules` — APFS
   copy-on-write, near-instant), falling back to `npm install`. Copy any gitignored local files
   the toolchain needs too (`.env` and the like).
4. Prove the worktree can actually run the test suite (`npm test` — offline, no token, no
   database, no docker) before moving on.
5. Record the worktree path as WORKTREE. From now on every command runs with WORKTREE as its
   working directory — absolute path, never a relative `cd`.

## Phase 2 — Plan (fix-planner subagent)

- Gather context: AGENTS.md and the docs file covering the area the issue concerns, read from
  WORKTREE.
- Spawn the `fix-planner` subagent (task tool) with the issue JSON and that context, and tell it
  the repository root is WORKTREE. Trust its analysis and work with its output; do not re-plan
  unless it is demonstrably wrong, in which case say why.
- Turn its plan into your todo list, one todo per approach step, each with the test or command
  that verifies it.
- If the plan marks anything `BLOCKER` in Risks / ambiguity, STOP: present the ambiguity and the
  planner's analysis to the user. Do not pick an interpretation yourself.

## Phase 3 — Implement, TDD

The suite commands here are `npm test` (vitest, offline) and `npm run typecheck`. Single file:
`npx vitest run <path>`. Style is enforced by biome — run `npm run lint:changed` before
committing (only the files the branch touched, at low CPU priority; never the whole-repo
`npm run lint`, which CI runs), and `npm run lint:changed -- --write` (or `npm run format` for pure
format drift) to settle what it flags.

In order:

1. RED: write a test that reproduces the issue. Run it (in WORKTREE) and confirm it FAILS for the
   expected reason — a setup error is not a red.
2. GREEN: write the minimum implementation that makes it pass. No features beyond the issue, no
   speculative abstractions.
3. Run the full suite plus `npm run typecheck`. If existing tests break, fix them before
   proceeding — never delete or skip a test to get green.
4. Tests must be isolated from each other and never hardcode database ids or environment-specific
   values.

Build coupling to remember: `server` and `web` resolve `@factory-ai/core` to `core/dist` — if
type errors point into core, run `npm run build -w core` before hunting source bugs.

## Phase 4 — Review loop (max 3 rounds)

For each round, up to 3:

1. Produce the complete diff: `git diff $(git merge-base HEAD <default-branch>)...HEAD` (plus
   uncommitted changes staged first into a temp view if needed — the reviewer must see everything
   you changed).
2. Spawn the `reviewer` subagent (task tool) with: the diff, the issue title and body, and a
   one-paragraph summary of the approach.
3. Triage its findings:
   - Blockers (bugs, broken error handling, missing coverage for the change, security issues):
     fix, re-run the full suite, continue to the next round.
   - Nitpicks/style: fix only if trivial; do not loop on them.
4. A round with zero blockers ends the loop.

After 3 rounds with blockers remaining: STOP. Commit nothing, push nothing. Report the remaining
findings to the user with your analysis.

## Phase 5 — Ship

Pre-flight (all inside WORKTREE):

- `git status` must show only the files your change touched. Anything else was made during this
  run — revert it; never mix it into the PR.
- `git log --oneline -10` — match the repo's existing commit message style.
- Stage only the files your change touched. Never commit secrets, keys, or .env files.

Then:

1. You are already on the branch chosen in Phase 1 — `fix/<issue-number>-<short-slug>`, or the
   Factory task branch (`factory/<uuid>`) when this run is a board task; do not cut another.
2. Commit with a message referencing the issue.
3. Bring the branch up to date with the default branch before pushing. Up to 2 attempts; each
   attempt is fetch, merge, resolve, verify:
   - `git fetch origin <default-branch>` then `git merge origin/<default-branch>`. "Already up
     to date" is a completed attempt, not a failed one — move straight to pushing.
   - Merge, never rebase: Phase 6 keeps appending commits to a public branch, and a merge commit
     never needs the forbidden force-push.
   - On conflict, resolve each hunk to the correct combined result — never a blanket
     `--ours`/`--theirs`. In files your change did not touch, take the default branch's side;
     where it touched the same lines as the fix, combine both intents (re-read the issue and the
     planner output if the intent is unclear — that is a stop condition, not a guess).
   - After every merge — clean, fast-forward or conflict-resolved — re-run `npm test`,
     `npm run typecheck` and `npm run lint:changed`.
   - Record the pre-merge commit (`git rev-parse HEAD`) before each merge.
   - If conflict resolution fails while the merge is still in progress, run `git merge --abort`,
     fetch again (the default branch may have moved under you), and spend the second attempt.
     `git merge --abort` only aborts a merge in progress; it does not undo a completed one.
   - If the post-merge suite cannot be resolved after the merge has completed, restore the branch
     to the recorded pre-merge commit before fetching again and spending the second attempt —
     otherwise the retry reports "Already up to date" and walks straight to pushing unverified.
   - Two failed attempts: STOP — report the conflicting files and why resolution failed, and
     leave the branch unpushed.
4. Push the branch.
5. Open the PR:
   `gh pr create --title "<short title>" --body <body> --base <default-branch>`
   Body must include: a summary of the root cause and the fix, the list of changes, the tests
   added and how they were verified, and `Fixes #<N>` on its own line so the issue auto-closes on
   merge. End the body with: `🤖 Generated with [opencode](https://opencode.ai)`
6. Leave the worktree in place — it holds the branch the PR is from. Report the PR URL and the
   worktree path — the run continues into Phase 6, which owns the final summary.

Never force-push, never push directly to the default branch, never `git worktree remove` a
worktree whose PR is open.

## Phase 6 — Wait for GitHub review (max 5 rounds)

This repo has no CI — its PR checks are the automated reviewers themselves (CodeRabbit, Greptile),
and their completion is what posts the comments. Loop until no unaddressed comments remain; one
round = one wait, one fetch, one address cycle:

1. Wait for the review to land: poll `gh pr checks <PR_NUMBER>` until nothing is pending (exit 8
   means still pending; the bots can take a few minutes). Then fetch everything with full detail —
   review summaries and PR-level comments:
   `gh pr view <PR_NUMBER> --repo <owner/repo> --comments --json comments,reviews`, plus the
   line-level comments: `gh api repos/<owner>/<repo>/pulls/<PR_NUMBER>/comments`. Read the review
   summary bodies too, not just the line comments — a "Request changes" verdict is ground for
   another round even with no line comments.
2. Address the **line-level comments** by invoking the **`github-review-fix`** skill on this PR.
   It owns every mechanical step through to verifying each reply landed; the conversation keeps
   only its ambiguity gate (next step).
3. Handle what the skill hands back, and what it does not cover:
   - A comment that is ambiguous or contradicts the code, the issue, or another comment → its
     ambiguity gate: STOP and ask the user. Never invent a resolution.
   - **PR-level comments and review-summary bodies** (the skill covers line comments only): judge
     each point yourself. Fix what is real with the full Phase 3 discipline — RED test first,
     minimal fix, `npm test` + `npm run typecheck` + `npm run lint:changed` — and run one Phase 4
     reviewer round on the new diff before pushing.
4. Every addressed comment gets a reply saying what was fixed and how — never a bare
   "fixed in <sha>". github-review-fix posts its own; for the ones you handled:
   `gh pr comment <PR_NUMBER> --body "✅ Fixed in <sha> — <what changed and why>"`. Each push
   re-triggers the bots — return to step 1 for the next round.

Stop conditions — hand back to the user instead of improvising:

- **Contradiction**: two reviewers ask for mutually exclusive changes; a comment contradicts the
  issue's acceptance criteria; a comment demands scope far beyond the bug (rearchitecture, new
  feature, cross-module refactor); or following it would break a rule of this skill. Do not pick a
  side silently: quote each side, name its source, present the options with trade-offs, ask, and
  resume with the user's decision. Minor ambiguity you can resolve sensibly is not a contradiction
  — resolve it and keep going.
- **Five rounds with comments still open**: STOP. Report what remains and why.

Done means: zero unaddressed comments, the worktree still in place, and the PR unmerged — merging
is the maintainer's call. Final report: the PR URL, rounds spent, comments addressed, and anything
left unresolved with the reason.
