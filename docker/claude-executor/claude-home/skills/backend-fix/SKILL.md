---
name: backend-fix
description: End-to-end fix of a backend bug under strict TDD — pull the ticket, locate the module, build a test harness if the module has none, reproduce the bug with a failing test at the right layer, fix it, generalize the repro into the permanent suite, and hand off to the board's publish, which opens the pull request. Use when asked to "fix the backend bug", "work ticket ABC-1234", "take this bug end to end", or when handed a bug ticket with no further instructions. Stack-agnostic: it discovers the test runner and commands from the repo. Not for frontend/browser bugs.
---

# Backend bug fix, end to end

Runs a bug from ticket to merged-ready PR without pausing for approval at each step. It stops for
exactly two things: an infrastructure blocker it cannot fix, and a genuine contradiction (Step 7).

Everything here is stack-agnostic. **Discover the project's conventions first (Step 0) and use
them** — the commands in this skill are placeholders, not literals.

## Hard rules — read first

- **TDD order is non-negotiable.** Red repro test → fix → green. Never bundle the test and the fix
  into one commit: the red commit is what proves the bug was real, and a reviewer cannot
  reconstruct it afterwards.
- **Reproduce at the right layer.** If the fault isolates without I/O — a util, validator, pure
  function, calculation, model method — the failing **unit** test is the repro. Otherwise
  (controller→service→store flow, query scope/filter, permission gate, cross-service side effect)
  the failing **integration** test is the repro. Most backend bugs are integration-level; default
  there unless the fault is provably pure.
- **No coverage means build the harness first, then fix.** Never attempt a fix in a module with no
  test harness — you would have no way to tell a fix from a coincidence. Build the baseline
  yourself (Step 4) and continue to the fix in the same run.
- **Business correctness, not shape smoke.** Every list/filter/scope/guard test must assert
  behaviour, not `status === 200` and "an array came back". Seed **both** sides of any predicate
  and assert inclusion *and* exclusion by id. Test boundaries (`N`, `N-1`, `N+1`). Assert exact
  error codes, never "some error occurred". Cover every entry point that shares the logic.
- **Never hardcode ids in tests that touch a database.** Generate data with the project's faker or
  factory layer; take framework ids from the project's seeded constants. A hardcoded id passes
  until someone reseeds.
- **Surgical changes.** Do not refactor adjacent code while fixing. Match existing style. Touch
  only what the ticket requires. Follow the project's error-handling and logging conventions
  rather than inventing new ones.
- **No throwaway repros in the final suite.** Ticket-named repro files exist only to prove
  red→green. Once green, fold their assertions into the permanent suites under
  behaviour-descriptive names and delete the ticket-named files. The merged branch must contain
  zero files named after the ticket key.
- **Lint and tests pass locally before every push.** Not once — before *every* push, including the
  ones made while addressing review feedback. Never `--no-verify`, never skip a check.
- **Local review gate before every push.** See [Local review gate](#local-review-gate). Runs after
  lint and tests are green, before the push.
- **CI red is a blocker, not an end state.** After each push, poll the checks and fix the root
  cause until green.

---

## Step 0 — Learn the project

Before touching anything, read the repo's own instructions — `AGENTS.md`, `CLAUDE.md`,
`CONTRIBUTING.md`, the README — and the test config. Establish:

| What | How to find it |
| --- | --- |
| Test runner and commands | `package.json` scripts, `Makefile`, `justfile`, CI workflow |
| Unit vs integration split | test directory layout; whether integration needs a live database |
| How integration tests get a database | docker-compose, testcontainers, a `test:db`-style script |
| Fixture / factory layer | existing test helpers; a faker or factory-bot equivalent |
| Seeded constants | the ids and users test setup provisions |
| Lint / format commands | scripts and config files; note if formatting is enforced in CI |
| Branch and commit conventions | `git log --oneline -20`, existing branch names, PR templates |
| Base branch | default branch, or a release/hotfix branch if the ticket targets a patch |

Write nothing down as a plan file. Carry it. **If the repo documents a rule that contradicts this
skill, the repo wins** — say so and follow the repo.

---

## Step 1 — Get the ticket

Use the **jira** skill. In short: find the in-progress ticket assigned to the current user, or take
the key the user gave. One match, use it; several, list them and ask; none, ask for a key.

Read the description **and the comments** — clarifications and reversals live in comments. If it is
a subtask, read the parent too.

If the ticket is frontend-only, or targets a different service than the one checked out, stop and
say so rather than fixing the wrong thing.

---

## Step 2 — Locate the module

Map the ticket's summary, description, components and labels onto code. Trace the whole path — the
entry point (route/handler), the business logic (service/use case), and the data access
(model/repository/query) — plus the tests that cover them.

```bash
git grep -ln "<distinctive term from the ticket>" -- <source dirs>
git log --oneline -15 -- <candidate path>    # who touched this recently, and why
```

Ambiguous after grepping → ask the user to confirm the module before writing code. A module with
no tests is not ambiguity; that is Step 4.

---

## Step 3 — Assess harness coverage

For the module, check: does a test directory exist with real specs; are there setup helpers that
build state; is there a fixture/factory layer; for a unit-reproducible fault, is there a matching
unit test file.

No coverage at all → **Step 4**. Some coverage → **Step 5**.

---

## Step 4 — Build the baseline harness (no asking)

Cut the ticket branch first (Step 5.1 logic) so the harness commits land on it, then:

1. **Setup helpers** — functions that build the state a test needs, through the application's own
   model or API layer rather than raw inserts, so the tests exercise real invariants. Reuse the
   project's existing helpers; add to them rather than starting a parallel set.
2. **Fixtures** — factory *functions* that take overrides, not static objects. Static fixtures get
   mutated by one test and break the next.
3. **A baseline spec** — one authenticated request to the module's main entry point, asserting one
   business-meaningful fact (a seeded entity comes back by id), not just a status code.
4. **Verify green.** A red baseline means the harness is wrong; debug the harness, not the
   application. If the test infrastructure will not boot, that is an infra blocker — say so and
   stop; it is not a contradiction.
5. **Commit** the harness on its own: `<KEY> [test] add <module> baseline harness`.

Continue straight to Step 5 (the branch already exists). The baseline spec is where Step 5.9 later
folds the bug's permanent test.

---

## Step 5 — TDD fix

### 5.1 Branch

Derive the base from the ticket's target version: a patch release means the corresponding hotfix
branch, anything else means the project's development branch. Several candidate hotfix branches →
ask.

Work in a dedicated worktree if the project supports it (`git worktree add`, or the repo's own
script) so several tickets can be in flight at once without sharing a checkout, a database or a
port block.

### 5.2 Identify the state the bug needs

From the ticket and its comments, list the preconditions for the bug to manifest — "a record with
tag X", "an order in status Y", "a role missing permission Z". For each: an existing helper covers
it, or you add one in 5.3. No hardcoded ids.

### 5.3 Extend the harness with seed helpers

Add missing setup helpers before writing the spec, so the spec reads as intent rather than
plumbing.

### 5.4 Decide the reproduction layer

Apply the hard rule above. If unit-reproducible, write the failing unit test now and confirm it
fails **for the right reason** — a test that fails because of a typo in the setup proves nothing.
Otherwise state explicitly why the fault is not unit-reproducible and go to 5.5b.

### 5.5 Write the failing test

Check the test infrastructure is up first. A flaky or infra failure is never a valid red.

**5.5a — unit repro path.** The unit test pins the bug. Add a **happy-path** integration case for
the behaviour a user expects end to end. It may already pass before the fix; it must pass after.

**5.5b — integration repro path.** Write a ticket-named spec that seeds both sides of the
predicate, calls the affected entry point the way a client does, and asserts the buggy behaviour.

**Watch the filter mechanism.** If the project's test command filters by *test name* rather than
filename, a ticket-named file whose `describe`/`it` text omits the key matches zero tests — and
zero tests passing reports as success. Check which one your runner does before trusting a green.

Confirm it fails for the right reason.

### 5.6 First commit — the repro

Stage only the repro and the helpers it needed: `<KEY> [test] reproduce <one-line bug summary>`.

### 5.7 Fix

Minimal edit. Follow the project's error-handling and logging conventions. No adjacent refactors,
no speculative generalisation.

### 5.8 Verify green

Repro first, then the whole module suite for regressions. Both green before continuing.

### 5.9 Generalize the tests, delete the repros

1. Move the unit repro's assertion into the module's permanent unit file under a behaviour-named
   test.
2. Move the integration case into the module's permanent spec, named for the behaviour
   (`excludes archived records from the list`) — never for the ticket key.
3. Delete the ticket-named files.
4. Re-run and confirm still green.

### 5.10 Lint and test — mandatory pre-push gate

Run the project's lint (and formatter, if CI enforces it) and the affected suites. Any failure
blocks the push. Fix errors; warnings are acceptable unless CI disagrees.

### 5.11 Second commit — fix plus generalized tests

Stage the source fix, the permanent tests, and the deletion of the repro files:
`<KEY> [fix] <one-line summary>`.

**Do not amend the first commit.** Two commits is the point: the red one preserves the repro for
review history.

### 5.12 Local review gate, then push

Run the [Local review gate](#local-review-gate) on the diff about to be pushed. Fix everything
actionable, re-review until clean, then push. Gate fixes go in a new commit
(`<KEY> [fix] address local review: <summary>`) — never amend a commit already on the remote.

### 5.13 Report ready for publish — the board opens the PR

Do not create the pull request yourself. The factory board's publish flow pushes the task branch
and opens (or reuses) the pull request after the gates pass, writing the title and description
from the branch's commits — `gh pr create` is denied to you, and the deny is policy, not an
obstacle. Finish the job the publish expects: work committed on the task branch, lint and tests
green.

---

## Step 6 — Land the PR (one loop, max 5 iterations)

The PR is the board's: its publish opens (or reuses) the pull request after your run ends and the
gates pass — so on the run that fixed the ticket there is nothing to poll; finish at 5.13. On a
follow-up run, after review feedback arrives, the PR exists and this loop applies. Per iteration:

1. Poll the checks. Red → fix the **root cause** and re-push (each push repeats 5.10 and the review
   gate). Never bypass a check to make it green.
2. Read the review feedback — the **review summary** as well as the line comments. The substantive
   objection is often in the summary while the line comments are details.
3. Address each comment under the same rules that got you here: TDD red→green, surgical changes, no
   hardcoded ids, lint and tests green, review gate before the push.
4. Reply to each comment saying *what changed and how*, not just the SHA.

Exit when the checks are green and nothing is unaddressed. Hand back early on the 5-iteration cap,
a contradiction (Step 7), or a blocker outside the diff (infra, secrets, a base-branch conflict
needing a product decision).

---

## Step 7 — Contradiction: stop and ask

The only place the flow pauses. A contradiction is feedback that cannot be reconciled
automatically:

- Two reviewers, or a reviewer and the ticket, ask for mutually exclusive changes.
- A comment demands behaviour that contradicts the ticket's acceptance criteria.
- A comment asks for a rearchitecture or a new feature well beyond the bug.
- Complying would violate a hard rule above — hardcoded test ids, shape-only assertions, a
  non-surgical refactor, a swallowed error.

When one appears: do not silently pick a side. Quote each position, name its source, lay out the
options and their tradeoffs, ask, then resume Step 6 with the answer.

Minor ambiguity you can resolve sensibly is not a contradiction. Resolve it and keep going.

---

## Step 8 — Done

Do not declare done while CI is red. Confirm the final check status, then report: PR URL, CI
status, what the fix was, whether Step 4 built a harness, how many review iterations it took, and
anything left unresolved with the reason.

---

## Local review gate

A headless review of the exact diff about to be pushed, run after lint and tests are green and
before every push. It catches convention violations and correctness gaps locally, so the remote
reviewer sees a cleaner diff.

```
tries = 0
loop:
  if tries >= 5:
      Summarize what is still unresolved, ask the user how to proceed, and STOP.
      Do not push a diff the gate has not cleared.

  # The diff that will be pushed
  git diff origin/<branch>...HEAD                        # branch already on the remote
  git diff $(git merge-base origin/<base> HEAD)..HEAD    # before the first push

  Review it for correctness, error handling, security, and violations of the conventions in
  the repo's own AGENTS.md / CLAUDE.md — plus this skill's hard rules. Ask for actionable
  issues only, each with file:line and a concrete fix, and for an exact "NO ISSUES" when clean.

  if clean: break
  Fix every actionable issue. Behaviour change → test first, then fix. Re-run lint and the
  affected suites. Commit as a new commit.
  tries++
```

**Use the merge-base form before the first push.** A fixed `HEAD~N` offset silently drops the
earliest commits, and by then the branch may carry harness, repro, fix and gate commits.

Run the review as a subagent (`code-reviewer`, else `general-purpose`) with the diff, or through a
headless CLI if the environment has one. Skip pure style nitpicks the linter already owns. If the
review raises something that genuinely contradicts the ticket or a hard rule, treat it as Step 7
rather than degrading the fix to comply.
