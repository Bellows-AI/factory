# claude-executor

Claude Code in a container, run by the driver against a mounted checkout. It does not build or run
this repo's application.

| Concern | Code | Test |
| --- | --- | --- |
| The image — Node 24, `@anthropic-ai/claude-code`, `gh`, `acli`, the `context-mode` plugin | `Dockerfile` | `test.sh` |
| `ENTRYPOINT` (`/usr/local/bin/claude-executor`): `$WORKDIR`, `safe.directory`, `JIRA_API` export, transcript redirect | `entrypoint.sh` | `driver/test/executor-images.test.ts`, `test.sh` |
| Git/gh guard, wired as the `PreToolUse` hook | `git-guard.cjs`, `claude-home/settings.json` | `driver/test/executor-images.test.ts`, `git-guard.cjs --selftest` |
| Sidecars: branch reporting (`session → repo, branch`) to `/api/sessions/branch`; progress over the CLI's `stream-json` | `branch-reporter.cjs`, `claude-progress.cjs` | `driver/test/executor-images.test.ts`, `test.sh` |
| Baked global instructions and config dir (`CLAUDE_CONFIG_DIR`) | `claude-home/` | `driver/test/executor-images.test.ts` |
| OTLP exporter config, root-owned, unoverridable by a checkout or the agent; the driver renders its endpoint | `managed-settings.json`, `driver/src/managed-settings.ts` | `test.sh`, `driver/test/telemetry-shipping.test.ts` |
| Skills, shared with opencode-executor | `../skills/` | `driver/test/executor-images.test.ts` |

## Invariants

- Whatever is dropped in `claude-home/` ships at `/home/node/.claude` with no Dockerfile change.
  Skills are the exception: they live in `docker/skills/` so both executor images bake the same set.
- Guidance that applies to a subset of tasks belongs in a skill, not in `CLAUDE.md` — `CLAUDE.md`
  is read in full every session, is vendor-neutral, and names only tooling the image has.
- No credential is baked in. `test.sh` asserts that a tokenless run reaches the login prompt.
  `WORKDIR` defaults to `/workspace` and must exist — the wrapper exits `2` rather than letting
  `claude` answer about the wrong tree.
- The driver sets `FACTORY_TRANSCRIPT_DIR` to a per-thread directory on the workspaces volume; the
  entrypoint makes it `CLAUDE_CONFIG_DIR`, seeded from `/opt/claude-home`, so `--resume` finds the
  earlier sessions. `/usr/local/bin` scripts are outside that redirect.
- The git guard is a guardrail, not a security boundary — the driver-side sync refusal is the last
  line of defence.
- The managed OTLP scope beats `-e`, a member's executor config and a checkout's
  `.claude/settings.json`; `OTEL_LOG_*` is `0` ([docs/security.md](../../docs/security.md)).
- The master prompt is board-rendered and passed with `--append-system-prompt` and
  `--system-prompt-snapshot off` — [docs/jobs.md](../../docs/jobs.md).

## Commands

```bash
# The context is this directory; the shared skills arrive as the named `skills` context, without
# which the build fails pulling an image called `skills`. CLAUDE_CODE_VERSION pins the CLI.
docker build --build-context skills=docker/skills -t claude-executor docker/claude-executor
make runners                                      # both executor images
docker/claude-executor/test.sh                    # builds claude-executor-test, checks it

docker run --rm -it -e CLAUDE_CODE_OAUTH_TOKEN -v "$PWD:/workspace" \
    claude-executor -p 'summarise the diff on this branch'
docker run --rm -e WORKDIR=/workspace/server -v "$PWD:/workspace" claude-executor -p '...'
```

`ANTHROPIC_API_KEY` works in place of `CLAUDE_CODE_OAUTH_TOKEN`. To export telemetry, join the
compose network (`--network factory-ai_default`); any other endpoint has to be rendered into
`/etc/claude-code/managed-settings.json`, as the driver does — `-e OTEL_EXPORTER_OTLP_ENDPOINT` loses to it.
