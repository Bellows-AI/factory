# Agent guide

Global instructions for every session in this image. Behavioural guidelines that reduce common LLM
coding mistakes; project-level `CLAUDE.md` / `AGENTS.md` files in the mounted checkout take
precedence over anything here.

**Tradeoff:** these guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the request.

## 4. Goal-driven execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant
clarification.

## 5. Tool discipline

Derived from an audit of real tool failures. No hook can fix these; they are decisions made before
the call.

**Read the file before you edit it — every time.** Roughly a third of all tool errors are edits
rejected with "File has not been read yet", and in most of those the path had never been touched in
the session. Knowing the content is not the same as having read it:

- Grep output, a subagent's report, and sandboxed script output do **not** count as a read.
- A file already in context because the harness injected it does **not** count either.
- After any command that rewrites files (`prettier`, `eslint --fix`, `lint-staged`,
  `git checkout/merge/stash`), an earlier read is stale. Read again before the next edit.

**Never use a relative `cd`.** Use absolute paths. The session's cwd may be a worktree or a
subdirectory rather than the repo root, and the resulting error does not say what the cwd was.

**Do not retry a command the permission settings deny.** Re-issuing a blocked command wastes a call
and does not prompt the user. Reach for the non-destructive equivalent — `git restore`,
`git merge --no-ff`, `trash` — or ask.

**Check auth once, before a batch, not per call.** An expired session makes every tool in a
sequence fail identically. One probe up front, then re-authenticate, before firing the rest.

## Testing

1. Apply DRY — avoid duplication, prefer shared utility packages.
2. Tests must be fully isolated from one another.
3. Do not clean up test data in integration scenarios.
4. Target mix: 25% unit, 70% integration, 5% E2E.
5. Never hardcode ids in database-connected (integration) tests.

**If you are about to take a shortcut — disabling a test, copy-pasting code, lowering an
expectation — ask first.**

## Code review checklist

1. Critical bugs (panic risks, nil dereferences)
2. Error handling patterns
3. Test coverage for the change
4. Linter clean
5. Build verification
6. Performance implications

## Tooling

GitHub and Jira are covered by the `github` and `jira` skills, which load on demand. Reach for
them rather than improvising: `gh` for pull requests, reviews and checks; `acli` for work items.
Do not use an Atlassian MCP server.

## Infrastructure access

The environment and the job network carry the infrastructure — `127.0.0.1` carries nothing. Before
connecting to a database or any other backing service:

- **Look up the injected env variables first** (`printenv`). The board resolves the author's
  scoped variables at claim time and injects them into this container; a `DATABASE_URL` names the
  host to connect to. A refused connection on `127.0.0.1` means "probed the wrong address", not
  "nothing is running" — there is no host port publishing here.
- **Declared services are DNS names.** A `services:` list in the checkout's `.bellows.yaml` starts
  one container per entry on this job's network for as long as the job runs, and the service
  `name` is the hostname — `db` resolves, `localhost` does not. Services start with no health
  wait: a refused first connect may be a service still booting, so retry briefly before declaring
  it down.
