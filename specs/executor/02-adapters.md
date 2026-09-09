# 02 — Agent adapters

**Depends on:** [00-overview](00-overview.md); [01](01-schema-and-store.md) for `core/src/executor.ts`
existing.
**Blocks:** [03-controller](03-controller.md), [05-job-and-runtime](05-job-and-runtime.md).

## Scope

Make `claude-code` and `opencode` interchangeable behind one interface. Three capabilities:

1. **Prompt + non-interactive invocation** — each adapter knows its own headless CLI form, its
   exit-code semantics, and how its output is captured.
2. **Per-tool config + MCP servers** — the adapter materialises `claude-settings.json` or
   `opencode.json`, including permission mode and the MCP servers the task asked for.
3. **Structured result extraction** — a normalised result, so an `agent_task_attempt` row means the
   same thing regardless of which tool produced it.

Plus a fourth thing that falls out of the task shape: a task can name a **skill or slash command**,
not only raw prompt text, and the adapter maps that to its tool's mechanism.

## Non-goals

No spawning (that is [03](03-controller.md)'s `RunnerBackend` and [05](05-job-and-runtime.md)'s
`entrypoint.mjs`), no Kubernetes, no HTTP. Everything in this spec is **pure** and testable offline.

---

## 1. Where the types live

- **`core/src/executor.ts`** — the neutral contract, added to what [01](01-schema-and-store.md)
  already put there: `AgentRunSpec`, `AgentRunPlan`, `AgentResult`, `RunEnvelope`, `AgentAdapter`,
  `TaskErrorCode`. Re-export from `core/src/index.ts`.
- **`executor/src/adapters/claude-code.ts`, `executor/src/adapters/opencode.ts`** — the
  implementations.

**`core` must not know claude-code exists**, for the same reason it no longer knows GitHub exists:
`CanonicalPr` used to be `RawPullRequest`, and a second forge could only be added by faking GitHub's
shape. *Rejected:* putting the adapters in `core` "since they're pure" — purity is not the criterion,
provider-neutrality is.

---

## 2. The interface

```ts
export interface AgentAdapter {
    readonly tool: string;
    readonly supports: {
        readonly command: boolean;
        readonly skill: boolean;
        readonly mcp: boolean;
    };
    /** True when the tool will honour a session id we hand it (claude-code --session-id). False
     *  means the session id — and therefore the token-spend join — only exists if the result
     *  envelope carries one. */
    readonly acceptsSessionId: boolean;

    /** PURE. No fs, no spawn, no clock, no randomness. This is what npm test asserts against. */
    plan(spec: AgentRunSpec): AgentRunPlan;

    /** PURE. Never throws: a shape we cannot read degrades, it does not fail the attempt. */
    parseResult(envelope: RunEnvelope): AgentResult;
}
```

Same reasoning as `flattenMetrics` being pure and separate from the insert: the wire format is the
awkward part, and keeping it here means it can be tested exhaustively with no cluster and no CLI
installed.

Only two ~20-line files do I/O, and they are not adapters:
`executor/src/runner/materialise.ts` (write the plan's files) and `executor/src/runner/exec.ts`
(spawn).

```ts
export interface AgentRunSpec {
    readonly tool: string;
    readonly invocation: TaskInvocation;
    readonly prompt: string;
    readonly permissionMode: PermissionMode;
    readonly model: string | null;
    readonly mcpServers: readonly McpServerConfig[];   // resolved, not names
    readonly sessionId: string | null;                 // pre-assigned when acceptsSessionId
    readonly workdir: string;                          // /work
    readonly configDir: string;                        // /etc/factory  (read-only mount)
    readonly otelEndpoint: string;
    readonly binary: string;                           // EXECUTOR_CLAUDE_BIN etc.
}

export interface AgentRunPlan {
    readonly argv: readonly string[];
    readonly files: readonly {
        readonly path: string;
        readonly contents: string;
        readonly mode?: number;
        /** When true the runner MUST also append the path to .git/info/exclude. A settings file the
         *  agent commits is a diff nobody asked for — and .gitignore is itself a tracked file, so
         *  excluding it there would show up in the diff too. */
        readonly inWorktree?: boolean;
    }[];
    readonly env: Readonly<Record<string, string>>;
    /** The runner reads the prompt file and feeds it in. The plan's argv NEVER contains prompt text:
     *  a Job's args are printed by `kubectl get job -o yaml` and stored unencrypted in etcd by
     *  default, and the prompt is the one field that must not land there. */
    readonly promptSource: 'stdin';
    readonly cwd: string;
}
```

---

## 3. claude-code adapter

```
<binary> --print
         --output-format json
         --permission-mode <plan|acceptEdits|bypassPermissions>
         --session-id <uuid>
         --settings   <configDir>/claude-settings.json
         --mcp-config <configDir>/mcp.json  --strict-mcp-config    # only when mcpServers non-empty
         --model <model>                                           # only when set
    < <configDir>/prompt.txt
```

`--settings` and `--mcp-config` point **outside the worktree** so nothing config-shaped enters the
diff. `--strict-mcp-config` means the pod's MCP set is exactly what the task asked for, with no user
or global config leaking in.

`supports: { command: true, skill: true, mcp: true }`, `acceptsSessionId: true`.

### Invocation mapping

| `invocation.kind` | Mapping | Determinism |
| --- | --- | --- |
| `prompt` | the text, on stdin | — |
| `command` | `/{name}{ ' ' + args }` on stdin | **Deterministic** — a slash command resolves in print mode |
| `skill` | `Use the {name} skill.\n\n{prompt}` on stdin | **A request, not a guarantee** — there is no `--skill` flag; skills are model-invoked |

That asymmetry goes in `docs/limits.md`: *naming a skill is a request the model may decline; a slash
command is deterministic. Prefer a command when the outcome matters.* The API must not paper over it
— see [06](06-api-and-auth.md)'s `UNSUPPORTED_INVOCATION`.

### Permission mode mapping

`readOnly → plan`, `acceptEdits → acceptEdits`, `full → bypassPermissions`.

### `claude-settings.json`, materialised at `configDir`

```jsonc
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "<spec.otelEndpoint>",
    "OTEL_METRIC_EXPORT_INTERVAL": "5000",
    "OTEL_METRICS_INCLUDE_SESSION_ID": "true",   // severing this severs the task->tokens join
    "OTEL_METRICS_INCLUDE_ACCOUNT_UUID": "false",
    "OTEL_LOG_USER_PROMPTS": "0",                // all three: docs/security.md, applied where
    "OTEL_LOG_ASSISTANT_RESPONSES": "0",         // nobody is watching the terminal
    "OTEL_LOG_TOOL_DETAILS": "0"
  },
  "permissions": { "defaultMode": "acceptEdits", "deny": ["Bash(git push:*)"] }
}
```

The three `OTEL_LOG_*` zeros are enforced **here**, in a file the plan generates, rather than in a
`.claude/settings.json` the pod does not have. `OTEL_METRIC_EXPORT_INTERVAL` is shortened from the
default because of Flag F in [00](00-overview.md): a short task with a long export interval reports
zero spend and nothing errors.

The `Bash(git push:*)` deny is a default the task's permission mode can override — a task whose
command is supposed to push needs it lifted. Make that an explicit field on the spec rather than a
special case buried in the adapter.

### Exit-code semantics

Exit 0 means **the CLI ran**, not that the work succeeded. The authoritative signal is `is_error` in
the `--output-format json` result, because a non-zero exit can equally mean the binary failed to
start.

| Observed | Result |
| --- | --- |
| non-zero exit | `failed`, `AGENT_NONZERO_EXIT` |
| exit 0, `is_error: true` | `failed`, the tool's message |
| exit 0, no parseable result | `failed`, `RESULT_MISSING` — **not** `succeeded` |
| exit 0, `is_error: false` | `succeeded` |

---

## 4. opencode adapter

```
<binary> run --print-logs [--model <provider/model>] [--agent <name>]
env: OPENCODE_CONFIG=<configDir>/opencode.json, XDG_CONFIG_HOME=<configDir>
```

`OPENCODE_CONFIG` points outside the worktree for the same reason as `--settings`.

```jsonc
{ "$schema": "https://opencode.ai/config.json",
  "permission": { "edit": "allow", "bash": "allow", "webfetch": "deny" },
  "mcp": { "jira": { "type": "local", "command": ["…"], "enabled": true } } }
```

Permission mapping: `readOnly → {edit:'deny', bash:'deny', webfetch:'deny'}`,
`acceptEdits → {edit:'allow', bash:'allow', webfetch:'deny'}`, `full → all allow`.

**`ask` is never emitted.** It is unusable in `run` mode — there is nobody to ask — so it would hang
until the deadline and report as `timed_out`, which reads as a runaway agent rather than a config bug.

`acceptsSessionId: false` — `run --session <id>` *continues* an existing session rather than creating
one with a given id.

`supports.command` / `supports.skill`: **verify against the pinned version and set them honestly.**
When false, `POST /api/tasks` answers `400 UNSUPPORTED_INVOCATION` rather than degrading a command
into prose — same rule as `?range=` invalid giving `400 BAD_RANGE` rather than falling back to all
time.

**Flag D from [00](00-overview.md) is closed:** the opencode image ships `@gcornut/opencode-otel`
and `server/src/telemetry/metric-map.ts`'s `RULES` carries the `opencode.*` names, so `agentOf()`
returns `'opencode'` and the session is priced like any other. A metric newer than those rows still
accumulates as null, and `opencode.cost.usage` is refused the same way as Claude's.

---

## 5. Structured result extraction

**The key move: the facts that matter are measured by git, not parsed from the tool.**

`executor/runner/entrypoint.mjs` ([05](05-job-and-runtime.md) owns the file; this spec owns the
envelope shape) produces:

```ts
export interface RunEnvelope {
    readonly schema: 1;
    readonly tool: string;
    readonly toolVersion: string | null;
    readonly exitCode: number;
    readonly timedOut: boolean;
    readonly baseSha: string | null;
    readonly headSha: string | null;
    readonly branch: string | null;
    readonly commits: number | null;
    readonly filesChanged: number | null;
    /** The tool's own output, VERBATIM and unparsed. Everything above is measured by the runner and
     *  is therefore identical for every tool; this is the only field an adapter reads. */
    readonly tool_output: string | null;
}
```

Consequences, and they are the whole reason for this shape:

- **Commits, branch, shas, files changed, timeout, exit code are never tool-specific.** They come
  from git and from the process. A CLI that renames every flag and rewrites its JSON cannot break them.
- **Token spend is never tool-specific either.** It comes from OTEL → `metric_point` →
  `session_field_total`, joined on `session_id`.
- **Only `sessionId`, `finalMessage` and `toolVersion` are parsed per tool**, each independently
  nullable.

`parseResult` therefore:

- sets `result_parse = 'ok'` when it read `tool_output` cleanly;
- sets `'degraded'` when it could not, nulls those three fields, and **leaves the git-measured half
  populated** — the attempt still reports its real status;
- sets `'missing'` when there is no envelope at all → status `failed`, `RESULT_MISSING`.

**Never throws. Never reports 0.** Null means "not measured", the same contract `docs/telemetry.md`
states for tokens: "0 tokens would assert the PR was written without AI."

`final_message` is truncated to fit the 4096-byte Kubernetes termination-message budget, and
`final_message_truncated` records that it happened.

---

## 6. Version drift on the input side

`executor/scripts/verify-cli-flags.sh` — **not part of `npm test`.** It runs `claude --help` and
`opencode --help` inside the built agent image and diffs against
`executor/test/fixtures/claude-help.txt` / `opencode-help.txt`. It fails the **image build**, which is
the only place a flag rename is catchable before the first task runs.

`EXECUTOR_CLAUDE_VERSION_PIN` / `EXECUTOR_OPENCODE_VERSION_PIN` are recorded on the attempt as
`tool_version`. A mismatch between the pin and what the pod reports is **logged, not fatal** — a
version bump must not stall the queue.

`docs/limits.md` gets a line: *the CLI captures in `executor/test/fixtures/` are from pinned versions
X and Y; a newer CLI is untested until recaptured* — the same honesty the GitHub-capture entries
already carry.

---

## 7. Acceptance criteria — all offline, `npm test`

| File | Must assert |
| --- | --- |
| `executor/test/adapter.claude.plan.test.ts` | argv for all three invocation kinds; permission-mode mapping for all three modes; `--session-id` present and a valid uuid; `--strict-mcp-config` appears **only** alongside `--mcp-config`; every materialised file path is under `configDir` **or** carries `inWorktree: true`; **no plan's argv contains the prompt text** (assert against a distinctive sentinel prompt); the settings blob carries all three `OTEL_LOG_*` at `"0"` and `OTEL_METRICS_INCLUDE_SESSION_ID` at `"true"`. |
| `executor/test/adapter.opencode.plan.test.ts` | The same set, plus `acceptsSessionId === false`, **no `ask` permission is ever emitted** in any mode, and `OPENCODE_CONFIG` resolves outside the worktree. |
| `executor/test/adapter.result.test.ts` | Envelope v1 → `AgentResult`. A `tool_output` whose shape changed → `parse: 'degraded'`, `sessionId`/`finalMessage`/`toolVersion` null, **`commits` and `headSha` still populated**. Envelope missing entirely → `parse: 'missing'`, status `failed`, `RESULT_MISSING`, never `succeeded`. Exit 0 + `is_error: true` → `failed`. 4 KB truncation sets `finalMessageTruncated`. **Adversarial: the agent printed `##FACTORY_RESULT##` itself** — assert the termination-message path wins and the log-scan path takes the last occurrence only ([05](05-job-and-runtime.md) §Result capture). |

The settings-blob assertion is cheap and is exactly the regression `docs/security.md` fears: three
environment switches that silently put prompt text and source code into the database.

## Files

**Create:** `executor/src/adapters/claude-code.ts`, `executor/src/adapters/opencode.ts`,
`executor/src/runner/materialise.ts`, `executor/src/runner/exec.ts`,
`executor/scripts/verify-cli-flags.sh`, `executor/test/fixtures/{claude-help.txt,opencode-help.txt}`,
`executor/test/fixtures/envelope-*.json`, the three test files above.

**Modify:** `core/src/executor.ts` (add the run/plan/result/envelope types), `core/src/index.ts`
(re-export), `docs/limits.md` (skill-is-a-request; opencode tokens mapped; CLI capture versions).
