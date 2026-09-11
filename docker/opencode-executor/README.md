# opencode-executor

opencode in a container, with a fixed configuration baked in. It runs an agent against a mounted
checkout; it does not build or run this repo's application.

Headless only. The driver selects it with `RUNNER_CLI=opencode`, and that combination refuses
`RUNNER_REMOTE_CONTROL` and `RUNNER_SKIP_PERMISSIONS` at startup — Remote Control is claude-code's
bridge, and opencode takes its permissions from the config baked into this image, not from a CLI
flag.

## Layout

| Path | Becomes |
| --- | --- |
| `Dockerfile` | the image — Node 24 (debian), `opencode-ai` (pinned), `@gcornut/opencode-otel` (pinned), `context-mode` (pinned), `gh`, `acli` |
| `entrypoint.sh` | `/usr/local/bin/opencode-executor` — the `ENTRYPOINT` |
| `branch-reporter.cjs` | `/usr/local/bin/branch-reporter.cjs` — the branch reporter the entrypoint launches beside the CLI |
| `test.sh` | builds the image and smoke-tests it — not shipped inside it |
| `opencode-home/opencode.json` | the baked permission policy plus the plugin references (telemetry, context mode), at `OPENCODE_CONFIG` |
| `opencode-home/otel.json` | the telemetry plugin's config: the compose collector, http/json, delta temporality |
| `opencode-home/AGENTS.md` | the global instructions every run loads |

## Build

```bash
docker build -t opencode-executor docker/opencode-executor

# Pin the CLI instead of tracking latest:
docker build --build-arg OPENCODE_VERSION=1.18.29 -t opencode-executor docker/opencode-executor
```

The build context is this directory, not the repo root.

## Test

```bash
docker/opencode-executor/test.sh
```

Builds the image as `opencode-executor-test` and runs a handful of checks: the CLI answers with the
pinned version, the baked `opencode.json` parses and carries exactly the expected permission block,
the `$WORKDIR` contract holds (a missing directory exits `2`), no credential material is baked into
the image, and one real `run` through the wrapper answers — via opencode's anonymous free tier,
bounded by a timeout. It is deliberately shallower than `docker/claude-executor/test.sh`; deepen it
the first time something surprises us.

## Run

Credentials never enter the image; they arrive as environment at run time. Under the driver, that
is `RUNNER_ENV`'s job — its default already forwards `ANTHROPIC_API_KEY`, which opencode reads as a
provider key. `CLAUDE_CODE_OAUTH_TOKEN` means nothing to opencode and is forwarded harmlessly.

Measured, and worth knowing before relying on it: **opencode answers prompts with no key at all**,
through its own anonymous free tier. A credential-less run is not a failure the way it is for
claude-code — the key is what unlocks your providers and models. `test.sh` therefore asserts the
absence of credential *material* in the image (env and auth files), not a failure without one.

```bash
docker run --rm \
    -e ANTHROPIC_API_KEY \
    -v "$PWD:/workspace" \
    opencode-executor run 'summarise the diff on this branch'
```

The command is the CLI's headless form: `run [--session <id>] <prompt>`. A fresh run is
`run <prompt>` — opencode mints its own session ids (`ses_…`) and cannot adopt one minted in
advance. A FOLLOW-UP is `run --session <id> <prompt>`: it continues a session opencode itself
created on an earlier run, which is why the driver sets `XDG_DATA_HOME` (below) so that database
outlives the container.

## Permissions are baked, not flagged

`opencode-home/opencode.json` holds the permission policy, because opencode reads policy from
config and `ask` is unusable headless — a run that stops to ask hangs until its deadline, and an
unanswered ask auto-rejects. The baked policy is **permissionless inside the workspace, hard-gated
outside it**:

| Rule | Value | Why |
| --- | --- | --- |
| `*` | `allow` | Nothing inside the working directory prompts. Per-tool asks (`doom_loop`, `question`, …) resolve to this too. |
| `read` | `{"*": "allow"}` | Explicit, because opencode seeds a default `*.env.*` read deny (a secrets-file rule) that matches any filename with `.env.` in it — it once auto-rejected a read of `routes.env.test.ts` and broke a run mid-investigation. |
| `webfetch` | `deny` | A hard refusal, never a prompt: the agent sees "denied" and routes around it. |
| `external_directory` | `deny` everything, then `allow` `/tmp/*` and `/home/node/*` | The fence, enforced by config rather than agent instructions. Everything outside the working directory is refused — the rest of the shared workspaces volume (other members' trees) and system folders included — except the runner's own scratch space, so a run can still use `/tmp` for throwaway clones. |

**The one runtime amendment:** the entrypoint re-opens the member's own tree. The driver points
`XDG_DATA_HOME` at `<mount>/<org>/<user>/.opencode`, and a path of that shape makes the
entrypoint insert an `allow` for `<mount>/<org>/<user>/**` into `external_directory` before the
CLI starts — the member's checkouts, `.worktrees` and `.opencode` session data are the task's
own workspace, and a run must never lose an attempt to reaching them, which is exactly what
killed job `2011be64` (exit 125) mid-investigation. `**` rather than `*`, because the allow has
to cross `/` and the tree's leading-dot directories. Any other `XDG_DATA_HOME` shape — a
standalone run, most likely — patches nothing, and the fence stays exactly as baked; other
members' trees stay refused either way.

To run another policy, mount your own over the baked file:
`-v "$HOME/opencode.json:/home/node/.config/opencode/opencode.json:ro"` — it resolves outside
`/workspace`, so nothing config-shaped enters the checkout's diff. A mounted file replaces the
whole baked config, the plugin references included: mount an `opencode.json` that lists
`"plugin": ["/usr/local/lib/node_modules/@gcornut/opencode-otel", "/usr/local/lib/node_modules/context-mode"]`
if you still want telemetry and context mode.

## Context mode

The [`context-mode` plugin](https://github.com/mksglu/context-mode) (sandboxed `ctx_*` tools,
session memory, hook-based routing) is baked into the image and enabled from the baked
`opencode.json`, the same way the telemetry plugin is: the package installed at build time and
referenced by its absolute path `/usr/local/lib/node_modules/context-mode`, so nothing is fetched
from npm at run time and two builds of one commit carry the same plugin. Do not add an
`mcp.context-mode` entry beside the plugin entry — the loader then registers zero `ctx_*` tools
(upstream-documented). The plugin is Elastic License 2.0, not MIT like the rest of the image.

Its state rides `XDG_DATA_HOME`, like opencode's own: verified in a real run that everything it
writes lands inside the `.opencode` directory the driver already designates per member, so nothing
plugin-shaped enters the checkout's diff or bloats the workspaces volume elsewhere.

## Session ids

opencode mints its own session ids (`ses_…`) and stores them in a sqlite database under its data
directory. The driver points `XDG_DATA_HOME` at a `.opencode` directory in the member's own tree
on the workspaces volume, and the image's entrypoint creates it on first run — the database
outlives the container, which is the whole mechanism: a follow-up runs `run --session <id>` in a
fresh container, and that only works if the session is still in the database it reads. After a
run the driver reads the newest root session out of the database with one throwaway node
container (`node:sqlite`, read-only) and reports the id to the board, which is what makes the
task follow-up-able. A job run by this image still shows no session link — the link is built from
claude-code's Remote Control id, which opencode does not have. Its runs still emit OTLP through the image's baked plugin, and the server's metric map prices the `opencode.*` metrics under the `opencode` agent.

## Branch reporter

`branch-reporter.cjs` samples `session → (repo, branch)` from `$WORKDIR` while the CLI runs and
POSTs it to `FACTORY_STATS_URL` (`/api/sessions/branch`) — the side channel that lets the board
attribute a run's tokens to the PR its branch became, which OTLP metrics alone cannot (they
carry a session id and nothing else). The driver supplies the endpoint (`RUNNER_STATS_URL`,
defaulted to the board) and, when the board requires one, the ingest token
(`RUNNER_INGEST_TOKEN`). The session id is the one thing opencode will not take in advance: on a
fresh run the reporter discovers it live from the session database under `XDG_DATA_HOME` — the
newest root session, the exact query the driver's close-time readout uses — and on a follow-up
the driver hands the id over (`BELLOWS_SESSION_ID`) so both runs name the same conversation.
Nothing is logged, nothing retries, and every failure is a silent no-op: the run is
unattributed, never failed.

## Telemetry

Metrics are emitted by `@gcornut/opencode-otel` (MIT, self-contained — its OpenTelemetry SDK is
bundled), baked into the image and enabled from the baked `opencode.json`. Its config is the baked
`opencode-home/otel.json`, not the `OTEL_EXPORTER_OTLP_*` environment variables (the plugin reads
neither):

```json
{
    "endpoint": "http://collector:4318",
    "protocol": "http/json",
    "metricsTemporality": "delta"
}
```

`endpoint` plus `protocol` resolve to `http://collector:4318/v1/metrics` (and `/v1/logs`) — the
`collector` service in this repo's `docker-compose.yml`, resolvable only from that compose network.
Off that network the exporter fails to connect; the CLI still works, the runs just go unrecorded.
The entrypoint honors a driver-supplied `OTEL_EXPORTER_OTLP_ENDPOINT` (the driver's
`RUNNER_OTEL_ENDPOINT`) by rewriting `otel.json`'s `endpoint` before the CLI starts — a collector
the compose network cannot name is still used by this executor, the same override the kubernetes
runner applies in the pod spec.
The plugin emits the same eight counters as Claude Code under an `opencode.` prefix (`token.usage`
split by `type`, `tool.decision` split by `decision`, plus commit, pull-request, line, session and
active-time counts), which the server's metric map resolves to the same fields as `claude_code.*`
and the collector refuses `opencode.cost.usage` exactly as it refuses Claude's. Override the
config path with `-e OPENCODE_OTEL_CONFIG_PATH=/path/to/otel.json`.
