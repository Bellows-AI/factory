# opencode-executor

opencode in a container, headless only, run by the driver when a task's executor profile has type
`opencode`. It does not build or run this repo's application.

| Concern | Code | Test |
| --- | --- | --- |
| The image — Node 24, `opencode-ai`, `@gcornut/opencode-otel`, `context-mode`, `gh`, `acli` (all pinned) | `Dockerfile` | `test.sh` |
| `ENTRYPOINT` (`/usr/local/bin/opencode-executor`): `$WORKDIR`, `XDG_DATA_HOME`, per-run allows via `OPENCODE_CONFIG_CONTENT`, a `--session` the database lacks started anew, the session that predates a fresh run named for the reporter | `entrypoint.sh` | `driver/test/executor-images.test.ts`, `test.sh` |
| Permission policy and plugin references, baked root-owned as the global and the managed (`/etc/opencode`) copy | `opencode-home/opencode.json` | `driver/test/executor-images.test.ts`, `test.sh` |
| Telemetry plugin config at `OPENCODE_OTEL_CONFIG_PATH`, root-owned; the driver renders its endpoint | `otel.json`, `driver/src/telemetry-config.ts` | `test.sh`, `driver/test/telemetry-shipping.test.ts` |
| Baked global instructions | `opencode-home/AGENTS.md` | `driver/test/executor-images.test.ts` |
| Sidecars: branch reporting to `/api/sessions/branch`, which with the attempt pair also records the live session; killing a run hung after a provider rate limit | `branch-reporter.cjs`, `rate-limit-watch.cjs` | `driver/test/executor-images.test.ts`, `driver/test/branch-reporter.test.ts`, `test.sh` |
| Cooperative Stop: the supervisor-mailbox agent and the step-boundary plugin | `ctl-agent.cjs`, `stop-plugin/index.js` | `driver/test/supervisor.test.ts`, `driver/test/run-control.test.ts` |
| Skills, shared with claude-executor | `../skills/` | `driver/test/executor-images.test.ts` |

Master-prompt delivery (the reserved `factory` agent) and run control:
[docs/jobs.md](../../docs/jobs.md). Policy layering and the telemetry scope:
[docs/security.md](../../docs/security.md). Image invariants shared with Claude Code (skills, the
guard as a guardrail): [claude-executor](../claude-executor/README.md).

## Invariants

- **Permissions are baked, not flagged** — `ask` is unusable headless. `RUNNER_SKIP_PERMISSIONS`
  applies to Claude Code only.
- opencode's **last matching rule wins**, so key order in `opencode.json` is load-bearing: catch-all
  first, deny globs next, exact-match allows last. A trailing-glob allow would bless a compound
  command containing a denied one. `test.sh`.
- opencode mints its own session ids (`ses_…`) in sqlite under `XDG_DATA_HOME`, which the driver
  points at the task's own directory (`.factory/opencode/<task>`) on the workspaces volume — the only reason a follow-up's
  `run --session <id>` works in a fresh container.
- opencode answers prompts with **no key at all** through its free tier, so `test.sh` asserts the
  absence of credential material in the image rather than a failure without a credential.
- An `mcp.context-mode` entry beside the plugin entry makes the loader register zero `ctx_*` tools.
  `test.sh`.

## Commands

```bash
# The shared skills arrive as the named `skills` build context. OPENCODE_VERSION overrides the pin.
docker build --build-context skills=docker/skills -t opencode-executor docker/opencode-executor
make runners                                       # both executor images
docker/opencode-executor/test.sh                   # builds opencode-executor-test, checks it
docker run --rm -e ANTHROPIC_API_KEY -v "$PWD:/workspace" \
    opencode-executor run 'summarise the diff on this branch'
```

Telemetry exports only to the endpoint rendered into `$OPENCODE_OTEL_CONFIG_PATH`; the plugin never
reads `OTEL_EXPORTER_OTLP_ENDPOINT`.
