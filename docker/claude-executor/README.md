# claude-executor

Claude Code in a container, with a fixed configuration baked in. It runs an agent against a mounted
checkout; it does not build or run this repo's application.

## Layout

| Path | Becomes |
| --- | --- |
| `Dockerfile` | the image — Node 24 (debian), git, `@anthropic-ai/claude-code`, `gh`, `acli`, the `context-mode` plugin |
| `entrypoint.sh` | `/usr/local/bin/claude-executor` — the `ENTRYPOINT` |
| `branch-reporter.cjs` | `/usr/local/bin/branch-reporter.cjs` — the branch reporter the entrypoint launches beside the CLI |
| `git-guard.cjs` | `/usr/local/bin/git-guard.cjs` — the git guard wired as the `PreToolUse` hook in `settings.json` |
| `test.sh` | builds the image and exercises it against this repo — not shipped inside it |
| `claude-home/` | `/home/node/.claude` inside the image, via `CLAUDE_CONFIG_DIR` |
| `managed-settings.json` | `/etc/claude-code/managed-settings.json` — the telemetry configuration, in the one scope a checkout's `.claude/settings.json` cannot override |
| `claude-home/settings.json` | the git-guard hook wiring |
| `claude-home/CLAUDE.md` | the global instructions every session loads |
| `../skills/` | `/home/node/.claude/skills` — `github`, `jira`, `backend-fix`, `gates`, shared with opencode-executor; loaded on demand, not every session |

`claude-home/` is the predefined configuration folder. Whatever you drop in it ships in the image —
add `agents/`, `commands/` or `hooks/` and they need no Dockerfile change. Skills do not go here:
they live in `docker/skills/`, so opencode-executor bakes the same set.

Tool-specific guidance lives in skills, not in `CLAUDE.md`: `CLAUDE.md` is read in full at the
start of every session, while a skill costs only its description until something actually invokes
it. Anything that applies to a subset of tasks belongs in a skill. It is a
deliberate copy rather than a mount of the host's `~/.claude` — that directory holds
`.credentials.json`, `history.jsonl` and per-project session state, none of which belong in an image
layer or in git.

`CLAUDE.md` is deliberately vendor-neutral: this repo is public, so it carries no site names,
ticket prefixes or internal repo references. It also documents only tooling the image actually
has — instructions for an absent binary cost tokens every session and end in
`command not found`. To run with your own instead, mount over it:
`-v "$HOME/.claude/CLAUDE.md:/home/node/.claude/CLAUDE.md:ro"`.

## Preinstalled tooling

- **`context-mode` plugin**, installed at build time from `mksglu/context-mode` and enabled. Its
  MCP server is plain `node`, so nothing further is needed at run time. Because
  `claude plugin install` writes `extraKnownMarketplaces` and `enabledPlugins` into `settings.json`
  itself, those keys are deliberately absent from the committed file.
- **`acli`** (Atlassian CLI) at `/usr/local/bin/acli`, matching `CLAUDE.md`'s instruction to drive
  Jira through it rather than through the Atlassian MCP server. It reads credentials from
  `~/.config/acli`, empty on a fresh container, so the entrypoint logs it in when
  `ATLASSIAN_SITE`, `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN` are all set — on the board, as
  claim env ([docs/env.md](../../docs/env.md)); standalone, with `-e`. A failed sign-in warns and
  the run goes on.

## Build

```bash
docker build --build-context skills=docker/skills -t claude-executor docker/claude-executor

# Pin the CLI instead of tracking latest:
docker build --build-context skills=docker/skills --build-arg CLAUDE_CODE_VERSION=2.0.0 \
    -t claude-executor docker/claude-executor
```

The build context is this directory, not the repo root. The skills are the exception: they live in
`docker/skills/`, shared with the other executor image, and arrive as the named `skills` context —
leave the flag off and the build fails trying to pull an image called `skills`.

## Test

```bash
docker/claude-executor/test.sh
```

Builds the image as `claude-executor-test` and runs its checks against this repo as the mounted
checkout: the CLI, `gh`, `acli`, the plugin (including a real MCP stdio handshake, since installed
is not the same as working), `CLAUDE.md`, the skills, the three `$WORKDIR` behaviours, the onboarding
prompt suppressed at build time, the `/opt/claude-home` seed, git reading the mount,
and the git guard — the baked case table (`--selftest`), the hook wire protocol, and the
`settings.json` wiring. Prints `ok`/`FAIL` per check and exits non-zero if any fail.

It always asserts that a run without a token reaches the login prompt — that is what proves no
credential is baked into the image. It then runs one live prompt using
`CLAUDE_CODE_OAUTH_TOKEN` from the environment, falling back to `.env`, and skips that single check
if neither has one.

## Run

Credentials never enter the image; they arrive as environment at run time.

```bash
docker run --rm -it \
    -e CLAUDE_CODE_OAUTH_TOKEN \
    -v "$PWD:/workspace" \
    claude-executor -p 'summarise the diff on this branch'
```

`ANTHROPIC_API_KEY` works in place of `CLAUDE_CODE_OAUTH_TOKEN`.

First-run onboarding (the theme picker) would otherwise wait for a keypress nobody sends; it is
settled at build time in the image's `.claude.json`.

`ENTRYPOINT` is the `claude-executor` wrapper: it changes into `$WORKDIR`, then runs `claude`
with every argument given after the image name as a supervised child, capturing and re-raising its
exit status. Arguments reach the CLI unchanged — the wrapper
adds no flags and interprets none.

```bash
# Run against a subdirectory of the mount, or a second checkout, without rebuilding
docker run --rm -e WORKDIR=/workspace/server -v "$PWD:/workspace" claude-executor -p '...'
docker run --rm -e WORKDIR=/other -v "$PWD:/workspace" -v ~/src/api:/other claude-executor -p '...'
```

`WORKDIR` defaults to `/workspace` and must exist — the wrapper exits `2` with a message rather
than letting `claude` start in the wrong directory and answer about the wrong tree.

It also marks the checkout `safe.directory` when one is mounted. A bind mount keeps the host's uid,
which is rarely the container's 1000, and git otherwise refuses the repository outright with a
"dubious ownership" error that never mentions uids.

## Master prompt

Every claim carries a board-rendered `masterPrompt` (issue #244) — a short, versioned Factory
execution context (mode, workflow/node, and which capabilities Factory itself runs around this
turn) — which the driver passes with `--append-system-prompt` and `--system-prompt-snapshot off`,
right before `-p`. Four things can shape one run's behavior, and they are not the same thing:

- **The Factory master prompt** — code-owned, board-rendered, delivered fresh on every claim. Never
  authorable by a workflow or task; it is the one thing this repo's own automation cannot override.
- **The current node's prompt** — the task's own command, or a workflow node's authored template
  (docs/workflows.md). What THIS turn is asked to do.
- **This checkout's `AGENTS.md`** — read by the agent like any other file in the worktree, at its
  own discretion; not injected by the driver at all.
- **Claude Code's own built-in system prompt** — untouched. `--append-system-prompt` adds to it,
  never replaces it.

`--system-prompt-snapshot off` is what keeps a resumed conversation honest: without it, Claude Code
would record the FIRST turn's system prompt and keep re-sending it on every later `--resume`, even
though the board's own text changes (a new node, a follow-up, an updated capability list) on every
claim.

## Transcript store

When the driver starts a run it sets `FACTORY_TRANSCRIPT_DIR` to a per-task-thread
directory on the workspaces volume. The entrypoint then makes that directory `CLAUDE_CONFIG_DIR`
before anything else runs, so session transcripts land on the volume the moment the CLI writes
them and survive the container's removal — and a follow-up run, which is pointed at the same
thread directory, finds the earlier sessions for `--resume`.

The seed and both patches below the redirect read `CLAUDE_CONFIG_DIR` dynamically, so the baked
git guard and every baked setting are in force exactly as in an unredirected run: the first use
of a thread directory is seeded from `/opt/claude-home`, and the seeded copy is what later
attempts of the same thread reuse.

## Git guard

`git-guard.cjs` is wired in `settings.json` as a `PreToolUse` hook on the Bash tool (`if:
Bash(git *)` and `if: Bash(gh *)`, so every other command never pays the node boot). It denies
what would move HEAD or rewrite refs in the task worktree: `git switch`, `git checkout` of a
branch or commit (path-scoped `git checkout -- <paths>` stays allowed), `git worktree` mutations
(`list` stays allowed), `git branch` delete/rename/copy/force in short, combined and long forms,
`git reset --hard`, and `git rebase` outright — rebasing onto the default branch is
the driver sync's job, and a rebase rewrites the published task-branch commits. `git merge` is
allowed in exactly one shape: every operand is an origin remote-tracking ref (`git merge
origin/main`, flags like `--no-edit` included; `-m`'s value is not read as an operand, and
neither is a redirection — `git merge origin/main 2>&1 | tail` is the shape agents type, and the
`&` of `2>&1` is no command separator) — merging
the remote default in is the one exit from a conflicts dead-end the sync's rebase refuses (job
`3e85c499`, 2026-09-20), and a merge can neither move HEAD off the task branch nor rewrite the
published commits, so the invariant survives it. `--abort`/`--quit`/`--continue` stay allowed,
since they only unwind or complete a state a merge can have left behind. The gh arm (issue #82)
denies
`gh pr create` — the pull request belongs to the driver's publish, which writes its title and
description from a summary of the branch — and `gh pr checkout`, which would move HEAD onto a
PR's branch. Reading GitHub (`gh pr view`, `gh pr diff`, `gh api …`) and `gh pr comment` stay
allowed. Read-only git, `git add` and `git commit` are untouched.

The parser splits compound commands and lifts `$(…)`/backtick spans into segments of their own,
strips env-assignment and `env`/`sh -c` prefixes, and walks git's global options (`git -C`, `git
--git-dir …`) before reading the subcommand. A deny returns the JSON decision with a reason — the
reason is the instruction the agent sees at the moment of the block. What it does not do, on
purpose: splice partially-quoted tokens (`g"it switch"` stays unread), chase every value-taking
global option, or unroll exotic launchers (`env -S`, `xargs`) — an agent writing those after a
denied plain command is evading, and evading a guardrail is not what this defends against.

Why: the task tree standing on its `factory/<root>` branch is the driver's invariant, and the
restore-mode sync refuses a wrong checkout only *after* the damage — which strands the thread
(job `43379d3a`, 2026-09-13). This is a guardrail, not a security boundary — the agent is root in
its container, and the sync refusal stays the last line of defense. The script lives in
`/usr/local/bin` (like the branch reporter) so the transcript store's config-dir redirect cannot
move it.
The canonical case table ships inside the script: vitest runs it offline
(`driver/test/executor-images.test.ts`), and `test.sh` runs `git-guard.cjs --selftest` against
the baked copy, so the table tests the bytes that actually ship.

## Branch reporter

`branch-reporter.cjs` samples `session → (repo, branch)` from `$WORKDIR` while the CLI runs —
the in-container twin of the local `plugins/agent-telemetry` hook — and POSTs it to
`FACTORY_STATS_URL` (`/api/sessions/branch`). OTLP metrics carry a session id and nothing else,
so this side channel is what lets the board attribute a run's tokens to the PR its branch
became. The driver supplies everything it needs: the endpoint (`RUNNER_STATS_URL`, defaulted to
the board), the session id (`BELLOWS_SESSION_ID`, the uuid it minted) and the attempt it runs
for — `RUNNER_JOB_ID` + `RUNNER_LEASE_TOKEN`, sent as `x-factory-job-id` +
`x-factory-job-lease-token`, the pair the board resolves the report's organization from (never
from the report's `repo` field). Nothing is logged, nothing retries, and
every failure — a board that is down, a pair that does not resolve, a directory that is not a
checkout — is a silent no-op: the run is unattributed, never failed. Hand-run containers get no
session id from a driver, so the reporter stays inert; the local plugin remains the path for
sessions you start yourself.

## Telemetry

`managed-settings.json` points the OTLP exporter at `http://collector:4318` — the `collector`
service in this repo's `docker-compose.yml`, resolvable only from that compose network:

```bash
docker compose up -d
docker run --rm -it --network factory-ai_default \
    -e CLAUDE_CODE_OAUTH_TOKEN \
    -v "$PWD:/workspace" \
    claude-executor -p '...'
```

Off that network the exporter fails to connect; the CLI still works, the sessions just go
unrecorded. Override `OTEL_EXPORTER_OTLP_ENDPOINT` with `-e` to point elsewhere (the entrypoint
rewrites the managed value to match); to disable telemetry entirely, edit
`managed-settings.json` — the managed env block overrides `-e CLAUDE_CODE_ENABLE_TELEMETRY=0`, a
member's executor config, and the mounted checkout's own `.claude/settings.json` alike. That last
one is why it is managed: a checkout pointing `OTEL_EXPORTER_OTLP_ENDPOINT` at `127.0.0.1` (as this
repo does, for host development) used to win and silently drop every export.

The three `OTEL_LOG_*` flags are `0` on purpose: they control whether prompts, responses and tool
arguments are shipped as log bodies. See [docs/security.md](../../docs/security.md).
