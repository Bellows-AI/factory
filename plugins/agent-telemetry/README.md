# agent-telemetry

Reports the repository of each Claude Code session to a local Factory Stats dashboard, so AI
token usage can be attributed to the repo the work happened in.

## Why this exists

Claude Code's OpenTelemetry metrics carry no repo name, no branch name and no commit SHA —
`claude_code.commit.count` and every token counter have only the standard attributes. The only
identifier shared between a metric and anything else is `session.id`.

Hooks, by contrast, receive `session_id` and `cwd`. This plugin resolves `cwd` to its git
origin and posts `session -> (repo, branch)`; the dashboard scopes its telemetry figures to the
repos it reports on, and without this report a session is unattributable — counted in
`sessionsWithoutHook` rather than in the totals.

The branch is still recorded, because the statistics built on this feed are being revamped;
today only the repo half is read.

## Install

The dashboard reports on one repo, and the sessions that matter happen **in that repo** — not
in the dashboard's own repo. So this installs at user scope and instruments every repo you
work in:

```bash
claude plugin marketplace add /path/to/factory-ai
claude plugin install agent-telemetry@factory-ai
```

Remove it at any time with `/plugin uninstall`.

## The other half: OTEL

This plugin supplies the branch. The token counts come from Claude Code's own OTLP export,
which is configured separately. `factory-ai/.claude/settings.json` has a working `env` block
to copy; to instrument another repo, put the same block in that repo's `.claude/settings.json`
or in `~/.claude/settings.json` for all repos at once.

Two settings there are load-bearing:

- **`OTEL_METRICS_INCLUDE_SESSION_ID` must stay true** (it is the default). It is the only link
  between a metric and a session. Disabling it makes `sessionsWithoutHook` climb without bound —
  indistinguishable from this plugin being broken.
- **`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` and `OTEL_LOG_TOOL_DETAILS` must
  stay off.** Enabling any of them puts prompt text and source code into the telemetry
  database. The server's attribute allowlist does not save you: that content arrives as the log
  record *body*, not as an attribute.

## What it sends

```json
{
  "agent": "claude-code",
  "sessionId": "abc123",
  "repo": "owner/name",
  "branch": "feat/x",
  "headSha": "deadbeef",
  "at": "2026-08-21T10:05:00Z"
}
```

`cwd` and `transcript_path` are read locally and **never transmitted** — both are absolute
host paths. No prompts, no file contents, no diff, no identity.

Endpoint defaults to `http://127.0.0.1:8080`; override with `FACTORY_STATS_URL`.

## Authentication

On a dashboard running `AUTH_MODE=github`, every branch report needs a credential, and the
organization the session is attributed to comes from that credential — never from the repo the
report names. Set `FACTORY_STATS_TOKEN` to a **personal access token** (`fat_…`, minted from the
dashboard's settings page) and the plugin sends it as `authorization: Bearer`:

```bash
# in ~/.claude/settings.json — user scope ONLY, like the plugin itself
{
  "env": {
    "FACTORY_STATS_URL": "https://factory.example.com",
    "FACTORY_STATS_TOKEN": "fat_…"
  }
}
```

The token dies the moment its membership does, exactly like a session. Organization tokens
(`oat_…`) are not accepted: they are a read-only allowlist credential, and this is a write.
Unset, the reports go unauthenticated — which is all a local `AUTH_MODE=none` dashboard asks
for, and a board that requires a credential simply declines them in silence, the same as any
other report failure. The plugin never logs the token and never writes it anywhere — but the
settings file that carries it can: a repo's `.claude/settings.json` is tracked and would
publish the token to every reader of the repository, so user scope is the only storage this
README endorses. If a token leaks anyway, revoke it from the dashboard's settings page.

For the same reason a credentialed report is sent only over `https://` or to an explicit
loopback host — a token carried over remote `http://` would cross the network in cleartext,
so the plugin drops the report instead. The shipped default (`http://127.0.0.1:8080`) is
loopback and unaffected.

## Behaviour

Enabled at user scope, this runs in every repo on the machine, so it is built to be
unnoticeable:

| | |
|---|---|
| Not a git repo | exits immediately |
| Dashboard down | silent no-op |
| Any error at all | exits 0, nothing on stderr |
| Request timeout | 200ms, fire-and-forget, no retry |
| Sampling | once per 20s per session, plus every session start and end |
| Dependencies | none — Node builtins and `git` |

There is no retry queue and no spool file on purpose. The signal is a periodic sample whose
loss model is already benign, and a spool would trade that for unbounded disk growth and
stale-replay bugs.

## Hooks used

| Event | Why |
|---|---|
| `SessionStart` | opens the interval with the session's first branch |
| `PostToolUse` on `Bash` | catches a `git checkout` mid-session |
| `SessionEnd` | closes the interval |

A session that holds several branches produces several intervals, all reported; what the
dashboard does with them is its own concern, and today it counts the session once under its
repo.

## Verifying

```bash
claude plugin validate ./plugins/agent-telemetry
```

Worth running after any edit: a malformed `hooks/hooks.json` loads the plugin **without** its
hooks, and the only symptom is `sessionsWithoutHook` climbing on the dashboard.

## Limits

- Coverage starts when the plugin is installed. Sessions from before that are invisible,
  which is not the same as a week without AI.
- The branch is **sampled, not tracked**. A branch held for less than one interval can be missed.
- Token counts are what the agent wrote, not what survived.
