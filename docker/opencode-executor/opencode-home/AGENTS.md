# Agent guide

Global instructions for every run in this image. Behavioural guidelines that reduce common LLM
coding mistakes; project-level `AGENTS.md` / `CLAUDE.md` files in the mounted checkout take
precedence over anything here.

**Tradeoff:** these guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 0. Board tasks: how the work lands

You are running as a headless task on the factory board. Nobody is watching a terminal — never
stop to ask; unanswered questions go in the final report, where a human reads them.

- Work happens in the checkout mounted at your working directory — your run's own worktree,
  branched off the remote default, one per task, so concurrent tasks never share a tree. Never
  commit to the default branch: work on the branch your worktree is on, or create a task branch —
  `fix/<issue-number>` when the task names an issue, otherwise `task/<short-slug>`.
- Commit as you go. One logical change per commit, messages in the imperative mood, the issue
  reference (e.g. `(#12)`) in the commit that closes the task.
- Run the declared gates (below) before you finish, and never leave the tree failing.
- Finish means: the work committed on the task branch, the tree clean, the gates green. After
  your run the board deterministically runs the declared gates again, pushes the branch, and
  opens or reuses the pull request — do not push or open PRs yourself, and do not ask about it.
  Publishing is not optional and needs no confirmation.

## 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask in the final message.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.

## 2. Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what the task asked for.
- No abstractions for single-use code.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

## 3. Surgical changes

**Touch only what the task requires. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match the existing style of the file, even if you'd do it differently.
- Every changed line should trace back to the task.

## 4. Finish with a report

You run headless — nobody watches the terminal. The final message is the only thing a human reads:
state what you changed, what you verified, and anything you could not do.

## Tooling

- Reach for `gh` for GitHub (pull requests, reviews, checks) rather than raw API calls.
- Reach for `acli` for Jira work items rather than improvising HTTP against Atlassian.
- Both start unauthenticated; they read credentials from the environment or config the caller
  provides. If a credential is missing, say so instead of working around it.

## Verification gates

The repository may declare CI-style checks in `.bellows.yaml` — named commands (`test`, `lint`,
build) that run in a separate container sharing this workspace. When `BELLOWS_GATE_URL` and
`BELLOWS_GATE_TOKEN` are set, run one with `node`:

```bash
node -e 'fetch(process.env.BELLOWS_GATE_URL+"/run",{method:"POST",headers:{
"authorization":"Bearer "+process.env.BELLOWS_GATE_TOKEN,"content-type":"application/json"},
body:JSON.stringify({gate:"test"})}).then(r=>r.json()).then(j=>{console.log("exit",j.exitCode);
console.log(j.output)})'
```

`exitCode` 0 means the gate passed; otherwise read `output`, fix what it names, and run it again.
Only gates `.bellows.yaml` declares can run — the request carries a gate NAME, never a command.
If `BELLOWS_GATE_URL` is unset there are no gates here: verify with your own commands instead. Do
not finish a task while a declared gate is failing.
