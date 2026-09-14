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

## Context discipline

The `context-mode` plugin's `ctx_*` tools are available, and long runs die of context bloat before
anything else: an overgrown session triggers compaction, and every compaction re-reads the whole
history with no cache — minutes per cycle, once the session has grown.

- **Search order for codebase questions: `ctx_search` → `grep` → `read`.** An open-ended "where
  does X live / how does Y work" question goes to `ctx_search` first — it returns the matching
  sections without pulling whole files in. Keep `grep` for an exact symbol or string — it is
  cheaper and never stale. `read` is for a file you are about to edit — not for open-ended
  investigation, and never re-read a file you have not changed.
- **Bound what a shell search can print.** A bare `grep -rn` over the whole tree puts its full
  output into the session; when you shell out, narrow it (`--include`, a path prefix, `| head`).
- **`ctx_batch_execute` is an offload valve, not a default.** Reach for it only when raw output
  would exceed ~20KB, cap `queries` at 3, and grep narrowly rather than `cat` — it repeats every
  matched section once per query, so `cat`-ing whole files multiplies them by the query count.
- **Trim what you print.** Summarize test and gate output (the summary lines, the failing files,
  `tail`) rather than pasting a full suite run into the session.

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
