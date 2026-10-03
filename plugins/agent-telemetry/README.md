# agent-telemetry

A Claude Code plugin that posts `session → (repo, branch)` to a Factory dashboard, so token usage
is attributed to the repo. In-container twin: `docker/claude-executor/branch-reporter.cjs`.

| Concern | Code |
| --- | --- |
| The report: payload, endpoint, credential, timeout, sampling | `scripts/session-telemetry.mjs` |
| Which events fire it (`SessionStart`, `PostToolUse` on `Bash`, `SessionEnd`) | `hooks/hooks.json` |
| The route it posts to (`/api/sessions/branch`) | `server/src/routes/ingest.ts` |

## Invariants

- OTLP metrics carry only `session.id` — no repo, no branch. This hook is the only link; without
  it a session is counted in `sessionsWithoutHook` rather than in the totals.
- **Install at user scope**, not in this repo: the sessions that matter happen in the repos you
  work in.
- `OTEL_METRICS_INCLUDE_SESSION_ID` must stay true (the default) or `sessionsWithoutHook` climbs
  without bound, indistinguishable from the plugin being broken.
- `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` and `OTEL_LOG_TOOL_DETAILS` must stay
  off — that content arrives as the log record *body*, which the server's attribute allowlist does
  not filter. See [docs/security.md](../../docs/security.md).
- `cwd` and `transcript_path` are read locally and never transmitted. No prompts, no file
  contents, no diff, no identity.
- Against `AUTH_MODE=github`, `FACTORY_STATS_TOKEN` must be a personal access token (`fat_…`,
  minted from the settings page); the organization comes from the credential, never from the repo
  the report names. Organization tokens (`oat_…`) are read-only and rejected.
- Store the token in `~/.claude/settings.json` only. A repo's `.claude/settings.json` is tracked
  and would publish it. A credentialed report is sent only over `https://` or to an explicit
  loopback host; otherwise the plugin drops it.
- Every failure is a silent no-op, exit 0: not a git repo, dashboard down, timeout (200ms,
  fire-and-forget). No retry queue, no spool file, no dependencies beyond Node builtins and `git`.

## Limits

- The branch is **sampled** once per 20s per session plus session start and end, not tracked — a
  branch held for less than one interval can be missed. Coverage starts at install. Today only
  the repo half of the report is read.

## Commands

```bash
claude plugin marketplace add /path/to/factory-ai
claude plugin install agent-telemetry@factory-ai
claude plugin validate ./plugins/agent-telemetry   # malformed hooks.json = plugin loads, hooks don't
```

`FACTORY_STATS_URL` overrides the endpoint (default `http://127.0.0.1:8080`). The token counts
come from Claude Code's own OTLP export, configured separately — `.claude/settings.json` in this
repo has a working `env` block to copy.
