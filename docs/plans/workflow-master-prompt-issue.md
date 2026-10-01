# [Workflow] Inject a board-owned master prompt into every agent run

Related: #36, #233

## Problem

Factory owns workflow orchestration, but executors currently receive only `job.command`. The node prompt has to repeat fragments such as “gates and publishing are handled for you,” and an arbitrary prompt can leave the agent unaware that it is one step inside a larger workflow.

That ambiguity makes an agent likely to continue the process itself: push, open or merge a PR, poll for reviews, repair conflicts early, run the next logical stage, or otherwise duplicate work that the board, helpers, gates, and publisher already own.

## Outcome

Every agent run receives a concise, code-owned master prompt through the executor's native system-instruction channel. It identifies the Factory execution context and establishes one invariant:

> Perform only the current node's assigned agent work, then return control to Factory. Factory owns workflow transitions and all configured automation around the node.

The master prompt is dynamic per claim, applies to standalone/default/custom-workflow tasks, and is refreshed when a session resumes into another node or a member follow-up.

## Prompt contract

The board renders a bounded `masterPrompt` from trusted job/workflow metadata. Workflow authors and task authors cannot supply, append, replace, or interpolate this field.

The prompt states:

- execution mode: standalone task or named Factory workflow;
- workflow name and current node when present;
- this is one agent turn, not authority to execute the surrounding process;
- Factory decides the next node from the stored verdict/output contract;
- Factory runs configured pre/post helpers, declared gates, publish/open-or-reuse-PR, durable waits, review reconciliation, merge-conflict repair, retries, and fan-out/fan-in when those capabilities are present;
- the agent must not push, open/update/merge/close a PR, enable auto-merge, poll/wait for GitHub activity, launch the next workflow stage, or emulate a configured helper;
- the agent may edit, test, and commit only as the current node prompt requires; local verification is allowed even though Factory will run declared gates afterward;
- an explicit output/marker contract in the current node prompt must be followed exactly, then the agent stops.

The prohibition on remote publication is absolute for agent turns. A block that needs GitHub writes uses the allowlisted helper/publisher path, not a conflicting node prompt.

## Dynamic workflow awareness

Render only bounded facts, never full workflow definitions or other nodes' prompts:

```text
Factory execution context
- Mode: workflow
- Workflow: default
- Current node: implement
- Factory-managed capabilities: declared gates, publish/reuse PR,
  review reconciliation (max 3), merge-conflict repair
- Your boundary: complete only the current node prompt and return control.
```

For custom workflows, derive capabilities from the frozen root snapshot and current claim: gate policy, publish policy, registered helper phases/runtime, and board-managed successors. For standalone tasks, say `Mode: standalone` and retain the same gates/publish boundary.

Do not include user prompt text, prior outputs, helper inputs, environment values, credentials, URLs containing tokens, or the full graph. Node/workflow names are already validated and may be included. Cap the rendered prompt and fail closed if trusted metadata cannot produce a valid prompt.

## Data flow and ownership

1. Add a pure server-side renderer (for example `server/src/db/master-prompt.ts`) that accepts trusted normalized context and returns the canonical versioned prompt.
2. The claim path reads the root's frozen workflow snapshot plus the current row's node, gates, publish, helper/runtime metadata, and workflow name.
3. Add required `masterPrompt: string` to the worker claim response and the driver's copied `BoardJob` contract.
4. Keep `job.command` byte-for-byte unchanged. It remains the audit record, workflow interpolation input, issue-reference source, commit/PR-title fallback, and user-visible command.
5. The driver passes `masterPrompt` separately to the executor-native system channel. It must never concatenate it into `job.command`, persist a decorated command, or feed it to publish planning.
6. Helper-only/concluded nodes that launch no agent need no prompt delivery; every actual agent launch requires a valid master prompt.

The server owns prompt meaning because it owns workflow state. The driver owns provider-specific delivery only. Docker and Kubernetes must share the same prompt and make the same provider-specific argv/config decision.

## Claude Code delivery

For both Docker and Kubernetes Claude runners:

- pass the board text with `--append-system-prompt`;
- pass `--system-prompt-snapshot off` so a resumed conversation rebuilds dynamic workflow/node context for the current claim rather than retaining the first node's snapshot;
- keep the ordinary command in the existing `-p` position;
- do not replace Claude Code's built-in system prompt.

Pin the executor image/CLI version that supports these flags and fail before spawn if the configured image contract cannot honor them. Do not silently fall back to a user-message prefix.

Reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference#system-prompt-flags

## OpenCode delivery

For both Docker and Kubernetes OpenCode runners:

- reserve a board-owned primary agent name such as `factory`;
- merge that agent's dynamic `prompt` into the already supported `OPENCODE_CONFIG_CONTENT` claim config without dropping the member's selected model or the baked permission/plugin policy;
- select it with `opencode run --agent factory ...` on fresh and resumed runs;
- prevent member executor config from overriding the reserved agent prompt/name;
- preserve the ordinary command as the run message and the existing session semantics.

OpenCode supports primary-agent system prompts and `run --agent`; use those native surfaces rather than prepending prose to the task message.

References: https://opencode.ai/docs/agents/ and https://opencode.ai/docs/cli/#run-1

## Prompt maintenance

- Keep one semantic template and executor-neutral fixture set. Provider adapters may change transport syntax, not wording or policy.
- Version the template in code so tests and later migrations can name the behavior they expect.
- Remove duplicated orchestration boilerplate from code-owned workflow node prompts only where the master prompt now makes it redundant. Keep node-specific role, work, and output-marker instructions.
- Do not rewrite user-created workflow definitions or stored snapshots; their node prompts remain frozen. The master prompt overlays orchestration awareness at claim time.
- No settings or per-workflow opt-out: this is part of Factory's execution contract, not a prompt customization feature.

## Acceptance

- Standalone, default-workflow, custom-workflow, resumed-node, and member-follow-up claims receive the correct bounded master prompt.
- The default workflow prompt names enabled review/merge automation; disabling an optional block removes that capability from the prompt.
- The current workflow/node context changes on the next claim even when the agent session resumes.
- Agents are told not to perform remote publication or surrounding workflow steps, while current-node editing/testing/committing remains allowed.
- `job.command`, task API responses, workflow interpolation, branch naming, commit-title fallback, and PR-title fallback remain unchanged.
- Workflow-authored content cannot inject or override the master prompt or reserved OpenCode agent.
- Claude Docker/Kubernetes argv contain identical `--append-system-prompt` and snapshot behavior.
- OpenCode Docker/Kubernetes config/argv contain the same reserved agent and dynamic prompt without losing model, permissions, plugins, or session restoration.
- Missing, oversized, or malformed master-prompt context refuses the agent launch explicitly; it never runs without the contract.
- No prompt content contains secrets or unbounded prior output.

## Verification

- Pure renderer snapshots for standalone/default/custom workflow contexts and every managed-capability combination.
- Server claim tests proving trusted derivation, bounds, current-node refresh, and unchanged command bytes.
- Driver contract tests proving a missing prompt refuses before spawn.
- Exact Docker argv and Kubernetes pod-spec tests for Claude fresh/resume/follow-up claims.
- Exact OpenCode merged-config and argv tests for fresh/resume/follow-up claims, including hostile member config targeting the reserved agent.
- Executor image smoke tests that run each CLI with the injected system prompt and confirm the agent can report its workflow/node boundary.
- A behavioral fixture whose task prompt asks the agent to push/open a PR while the master prompt forbids it; verify no remote mutation occurs and the normal publisher remains the only writer.
- `npm test`
- `npm run test:executors`
- `npm run test:coverage:executors`
- `npm run test:k8s`
- `npm run typecheck`
- `npm run lint`

## Documentation

Update `docs/workflows.md`, `docs/jobs.md`, `docs/kubernetes.md`, `docs/executor-testing.md`, and the executor image READMEs. Document the distinction between the immutable Factory master prompt, the current node's authored prompt, repository `AGENTS.md`, and provider-native defaults.
