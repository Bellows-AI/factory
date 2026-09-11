---
name: fix
description: Fix a GitHub issue end-to-end in an isolated git worktree — fetch with gh, plan with the fix-planner subagent, TDD implementation, review loop with the reviewer subagent, commit, push, open PR. Trigger phrases: "/fix", "fix this issue", "fix the GitHub issue", "work on issue #N".
---

# Fix a GitHub issue end-to-end

Fix the GitHub issue given as the argument. Run all six phases in order, autonomously — do not
pause for approval between phases; stop only when genuinely blocked (see the stop conditions in
each phase). Track progress with the todo tool throughout.

Everything from Phase 1 on runs inside a dedicated git worktree, never the main checkout — its
dirty state, stale builds and checked-out branches cannot leak into the fix, and two concurrent
fixes cannot touch each other.

## Phase 0 — Fetch the issue

- If no issue URL/number was given, ask for one and stop.
- Fetch the issue with full detail, comments included — clarifications and changed requirements
  often live there:
  `gh issue view <url-or-number> --json number,title,body,labels,comments,state`
- If the issue is already closed, say so and ask whether to proceed.
- Before touching any code, read this repo's AGENTS.md and the `docs/` file that covers the area
  you will change — the "Read before you touch" table maps areas to files. These hold conventions
  that look like cruft and are not.

## Phase 1 — Create the worktree

Everything from here on — planning included — runs inside the worktree: the planner must read the
same tree the executors will edit.

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
   database, no docker) before moving on. A worktree where tests cannot execute poisons every
   later phase.
5. Record the worktree path as WORKTREE. From now on every command runs with WORKTREE as its
   working directory — absolute path, never a relative `cd`.

## Phase 2 — Plan (fix-planner subagent)

- Gather context: AGENTS.md and the docs file covering the area the issue concerns, read from
  WORKTREE.
- Spawn the `fix-planner` subagent (task tool) with the issue JSON and that context, and tell it
  the repository root is WORKTREE. It runs on a stronger model with high reasoning effort — trust
  its analysis and work with its output; do not re-plan unless it is demonstrably wrong, in which
  case say why.
- Turn its plan into your todo list, one todo per approach step, each with the test or command
  that verifies it.
- If the plan marks anything `BLOCKER` in Risks / ambiguity, STOP: present the ambiguity and the
  planner's analysis to the user. Do not pick an interpretation yourself.

## Phase 3 — Implement, TDD

The suite commands here are `npm test` (vitest, offline) and `npm run typecheck`. Single file:
`npx vitest run <path>`. There is no linter or formatter — match existing style: 4-space indent,
single quotes, semicolons.

In order:

1. RED: write a test that reproduces the issue. Run it (in WORKTREE) and confirm it FAILS for the
   expected reason — a test that fails with a setup error proves nothing.
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
   one-paragraph summary of the approach. It has fresh context and cannot edit.
3. Triage its findings:
   - Blockers (bugs, broken error handling, missing coverage for the change, security issues):
     fix, re-run the full suite, continue to the next round.
   - Nitpicks/style: fix only if trivial; do not loop on them.
4. A round with zero blockers ends the loop.

After 3 rounds with blockers remaining: STOP. Commit nothing, push nothing. Report the remaining
findings to the user with your analysis — do not open a PR you know is dirty.

## Phase 5 — Ship

Pre-flight (all inside WORKTREE):

- `git status` must show only the files your change touched. The worktree started clean, so
  anything else was made during this run — revert it; never mix it into the PR.
- `git log --oneline -10` — match the repo's existing commit message style.
- Stage only the files your change touched. Never commit secrets, keys, or .env files.

Then:

1. You are already on the branch created in Phase 1 (`fix/<issue-number>-<short-slug>`); do not
   cut another.
2. Commit with a message referencing the issue.
3. Push the branch.
4. Open the PR:
   `gh pr create --title "<short title>" --body <body> --base <default-branch>`
   Body must include: a summary of the root cause and the fix, the list of changes, the tests
   added and how they were verified, and `Fixes #<N>` on its own line so the issue auto-closes on
   merge. End the body with: `🤖 Generated with [opencode](https://opencode.ai)`
5. Leave the worktree in place — it holds the branch the PR is from. Report the PR URL, the
   worktree path, and a two-line summary of what was done.

Never force-push, never push directly to the default branch, never `git worktree remove` a
worktree whose PR is open.
