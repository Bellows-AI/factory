# opencode-executor

opencode in a container, headless only, run by the driver when a task's executor profile has type
`opencode`. It does not build or run this repo's application.

| Concern | Code | Test |
| --- | --- | --- |
| The image — Node 24, `opencode-ai`, `@gcornut/opencode-otel`, `context-mode`, `gh`, `acli` (all pinned) | `Dockerfile` | `test.sh` |
| `ENTRYPOINT` (`/usr/local/bin/opencode-executor`): `$WORKDIR`, `XDG_DATA_HOME`, the `external_directory` and `origin/HEAD` amendments | `entrypoint.sh` | `driver/test/executor-images.test.ts`, `test.sh` |
| Permission policy and plugin references, at `OPENCODE_CONFIG` | `opencode-home/opencode.json` | `driver/test/executor-images.test.ts`, `test.sh` |
| Telemetry plugin config (endpoint, `http/json`, delta temporality) at `OPENCODE_OTEL_CONFIG_PATH`, root-owned; the driver renders its endpoint | `otel.json`, `driver/src/telemetry-config.ts` | `test.sh`, `driver/test/executor-images.test.ts`, `driver/test/telemetry-shipping.test.ts` |
| Baked global instructions, incl. context discipline | `opencode-home/AGENTS.md` | `driver/test/executor-images.test.ts` |
| Sidecars: branch reporting to `/api/sessions/branch` with live session discovery; killing a run hung after a provider rate limit | `branch-reporter.cjs`, `rate-limit-watch.cjs` | `driver/test/executor-images.test.ts`, `test.sh` |
| Skills, shared with claude-executor | `../skills/` | `driver/test/executor-images.test.ts` |

## Invariants

- **Permissions are baked, not flagged.** `ask` is unusable headless, so policy lives in
  `opencode.json`: permissionless inside the working directory, `external_directory` denied
  outside it except `/tmp`, `/home/node` and the member's own tree. `RUNNER_SKIP_PERMISSIONS`
  applies to Claude Code only.
- opencode resolves rules with the **last matching rule winning**, so key order is load-bearing:
  catch-all first, deny globs next, allows last. The allows are exact matches — a trailing-glob
  allow would bless a compound command containing a denied one. The resulting git/gh guard is
  coarser than claude-executor's parsing hook, by design; both are guardrails, not security
  boundaries, and the driver-side sync refusal is the last line of defence. A mounted
  `opencode.json` replaces the whole baked config, plugin references included.
- opencode mints its own session ids (`ses_…`) in a sqlite database under `XDG_DATA_HOME`, which
  the driver points into the member's tree on the workspaces volume — the only reason a follow-up's
  `run --session <id>` works in a fresh container. It also answers prompts with **no key at all**
  through its free tier, so `test.sh` asserts the absence of credential material in the image
  rather than a failure without a credential.
- The master prompt arrives as a reserved PRIMARY agent, `factory`, merged into
  `OPENCODE_CONFIG_CONTENT`; every run launches `--agent factory`. Unlike Claude Code's
  `--append-system-prompt` this REPLACES the provider-default prompt, so a `model` set only under
  another named agent silently stops applying ([docs/jobs.md](../../docs/jobs.md)).
- `context-mode` is Elastic License 2.0, not MIT. An `mcp.context-mode` entry beside the plugin
  entry makes the loader register zero `ctx_*` tools.

## Commands

```bash
# The context is this directory; the shared skills arrive as the named `skills` context, without
# which the build fails pulling an image called `skills`. OPENCODE_VERSION overrides the pin.
docker build --build-context skills=docker/skills -t opencode-executor docker/opencode-executor
make runners                                       # both executor images
docker/opencode-executor/test.sh                   # builds opencode-executor-test, checks it
# Headless form: run [--session <id>] <prompt>
docker run --rm -e ANTHROPIC_API_KEY -v "$PWD:/workspace" \
    opencode-executor run 'summarise the diff on this branch'
```

To export telemetry, join the compose network (`--network factory-ai_default`); any other endpoint
has to be rendered into `$OPENCODE_OTEL_CONFIG_PATH`, as the driver does — the plugin never reads
`OTEL_EXPORTER_OTLP_ENDPOINT`.
