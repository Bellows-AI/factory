# claude-executor

Claude Code in a container, with a fixed configuration baked in. It runs an agent against a mounted
checkout; it does not build or run this repo's application.

## Layout

| Path | Becomes |
| --- | --- |
| `Dockerfile` | the image — Node 24 (debian), git, `@anthropic-ai/claude-code`, `gh`, `acli`, the `context-mode` plugin |
| `entrypoint.sh` | `/usr/local/bin/claude-executor` — the `ENTRYPOINT` |
| `branch-reporter.cjs` | `/usr/local/bin/branch-reporter.cjs` — the branch reporter the entrypoint launches beside the CLI |
| `run.sh` | starts a Remote Control session, with the token read from `.env` — not shipped inside the image |
| `test.sh` | builds the image and exercises it against this repo — not shipped inside it |
| `claude-home/` | `/home/node/.claude` inside the image, via `CLAUDE_CONFIG_DIR` |
| `claude-home/settings.json` | telemetry configuration |
| `claude-home/CLAUDE.md` | the global instructions every session loads |
| `claude-home/skills/` | `github`, `jira`, `backend-fix` — loaded on demand, not every session |

`claude-home/` is the predefined configuration folder. Whatever you drop in it ships in the image —
add `agents/`, `commands/` or `hooks/` and they need no Dockerfile change.

Tool-specific guidance lives in `skills/`, not in `CLAUDE.md`: `CLAUDE.md` is read in full at the
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
  Jira through it rather than through the Atlassian MCP server. Unauthenticated on a fresh
  container — it reads credentials from `~/.config/acli`, so either log in once per container:

  ```bash
  docker run --rm -it -e JIRA_API_TOKEN claude-executor \
      sh -c 'echo "$JIRA_API_TOKEN" | acli jira auth login \
          --site your-site.atlassian.net --email you@example.com --token'
  ```

  or mount an existing profile read-only with `-v "$HOME/.config/acli:/home/node/.config/acli:ro"`.
  Note that `ENTRYPOINT` is `claude`, hence the explicit `sh -c` above.

## Build

```bash
docker build -t claude-executor docker/claude-executor

# Pin the CLI instead of tracking latest:
docker build --build-arg CLAUDE_CODE_VERSION=2.0.0 -t claude-executor docker/claude-executor
```

The build context is this directory, not the repo root.

## Test

```bash
docker/claude-executor/test.sh
```

Builds the image as `claude-executor-test` and runs sixteen checks against this repo as the mounted
checkout: the CLI, `gh`, `acli`, the plugin (including a real MCP stdio handshake, since installed
is not the same as working), `CLAUDE.md`, the skills, the three `$WORKDIR` behaviours, both prompt
suppressions (onboarding done, trust off unless `TRUST_WORKDIR` is set), and git reading the mount.
Prints `ok`/`FAIL` per check and exits non-zero if any fail.

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

## Two credentials, for two different things

They are not interchangeable, and the difference is not cosmetic:

| | Headless (`-p`) | Remote Control |
| --- | --- | --- |
| Credential | `CLAUDE_CODE_OAUTH_TOKEN` from `.env` | a full-scope claude.ai login |
| Comes from | `claude setup-token` | `run.sh login` |
| Lives in | the environment, per run | a named docker volume |

A `setup-token` token can **only make model requests**. It cannot establish a Remote Control
session — and the failure is quiet: `claude --remote-control` still starts a perfectly normal
interactive session, so the only symptom is that the session never appears at claude.ai/code. (The
docs are explicit: *"Remote Control requires a full-scope login token… these tokens can only make
model requests"*.) Remote Control also needs a Pro, Max, Team or Enterprise plan; API keys are not
supported at all.

So `run.sh` does **not** pass the `.env` token. `test.sh` still does, because a headless prompt is
exactly what that token is for.

## Interactive: Remote Control

```bash
docker/claude-executor/run.sh login          # once — sign in to claude.ai
docker/claude-executor/run.sh                # session named after the current directory
docker/claude-executor/run.sh my-session
TARGET=~/src/api docker/claude-executor/run.sh
```

`run.sh login` prints an OAuth URL: open it on this machine, then paste the code back at the
prompt. The container's callback server is unreachable from the host browser, which is exactly the
case the paste flow exists for.

The login lands in `.credentials.json` under `CLAUDE_CONFIG_DIR`, so it dies with `--rm` unless
that directory is a volume. `run.sh` mounts `claude-executor-auth` there (override with
`AUTH_VOLUME`). A volume mounts *empty* and hides the baked configuration behind it, so the
entrypoint seeds it from `/opt/claude-home` on first use — the image keeps a pristine copy for
exactly this. Seeding is keyed on `settings.json` being absent, so it never overwrites a later
login. After rebuilding the image, `docker volume rm claude-executor-auth` to pick up config
changes.

Without a login in the volume, `run.sh` exits `2` and points at `run.sh login` rather than starting
a session that silently is not remote-controlled.

Two more prompts stand between a cold container and a usable interactive session, and neither has
anyone to answer it:

- **First-run onboarding** (the theme picker) is settled at build time in the image's
  `.claude.json`.
- **The trust dialog** for the mounted directory is opt-in per run via `TRUST_WORKDIR=1`, which
  `run.sh` sets. **Read this before setting it by hand:** the dialog also warns when the mounted
  checkout ships a `.claude/settings.local.json`, whose pre-approved tool permissions then apply
  without asking. Mounting a directory here is already that decision; the variable just states it
  explicitly. It stays off by default so a headless run cannot silently inherit a checkout's
  permission grants.

`ENTRYPOINT` is the `claude-executor` wrapper: it changes into `$WORKDIR`, then `exec`s `claude`
with every argument given after the image name. Arguments reach the CLI unchanged — the wrapper
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

## Branch reporter

`branch-reporter.cjs` samples `session → (repo, branch)` from `$WORKDIR` while the CLI runs —
the in-container twin of the local `plugins/agent-telemetry` hook — and POSTs it to
`FACTORY_STATS_URL` (`/api/sessions/branch`). OTLP metrics carry a session id and nothing else,
so this side channel is what lets the board attribute a run's tokens to the PR its branch
became. The driver supplies everything it needs: the endpoint (`RUNNER_STATS_URL`, defaulted to
the board), the session id (`BELLOWS_SESSION_ID`, the uuid it minted) and, when the board
requires one, the ingest token (`RUNNER_INGEST_TOKEN`). Nothing is logged, nothing retries, and
every failure — a board that is down, a token that is wrong, a directory that is not a
checkout — is a silent no-op: the run is unattributed, never failed. Hand-run containers get no
session id from a driver, so the reporter stays inert; the local plugin remains the path for
sessions you start yourself.

## Telemetry

`claude-home/settings.json` points the OTLP exporter at `http://collector:4318` — the `collector`
service in this repo's `docker-compose.yml`, resolvable only from that compose network:

```bash
docker compose up -d
docker run --rm -it --network factory-ai_default \
    -e CLAUDE_CODE_OAUTH_TOKEN \
    -v "$PWD:/workspace" \
    claude-executor -p '...'
```

Off that network the exporter fails to connect; the CLI still works, the sessions just go
unrecorded. Override `OTEL_EXPORTER_OTLP_ENDPOINT` with `-e` to point elsewhere, or set
`CLAUDE_CODE_ENABLE_TELEMETRY=0` to disable it.

The three `OTEL_LOG_*` flags are `0` on purpose: they control whether prompts, responses and tool
arguments are shipped as log bodies. See [docs/security.md](../../docs/security.md).
