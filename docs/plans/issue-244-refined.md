# [Workflow] Inject a board-owned master prompt into every agent run

Related: #36, #233, #210

> **Refined for hand-off.** Every decision is already made below, and each one points to the code it
> rests on (checked against `d28013d`). The implementer should not need to ask anything. If the code
> contradicts a statement here, trust the code, follow the closest resolution below, and record the
> difference in the PR description. Do not stop to ask.

## Problem

Factory owns workflow orchestration, but executors receive only `job.command`. Node prompts have to
repeat fragments such as "gates and publishing are handled for you". An arbitrary prompt can leave
the agent unaware that it is one step inside a larger workflow.

Because of that, an agent tends to carry on with the process itself. It pushes, opens or merges a
PR, polls for reviews, repairs conflicts early, or runs the next logical stage. That duplicates work
the board, helpers, gates and publisher already own.

## Outcome

Every agent run receives a short, code-owned master prompt through the executor's native
system-instruction channel. It identifies the Factory execution context and sets one invariant:

> Perform only the current node's assigned agent work, then return control to Factory. Factory owns
> workflow transitions and all configured automation around the node.

The prompt is rendered for each claim. It applies to legacy standalone rows, member follow-ups, the
built-in default workflow and custom workflows, and it is re-rendered on every claim, including
resumed-session successors.

## Terms (as they exist in code)

The mode is derived from the claimed row and its root. There is no stored mode flag.

| Mode | Condition | Notes |
| --- | --- | --- |
| `standalone` | `workflow_node === null && parent_job_id === null` | Only legacy queued rows and route-test harnesses. Since #209 every launch resolves a workflow (`server/src/routes/job-workflow-resolution.ts:115,165`). |
| `follow-up` | `workflow_node === null && parent_job_id !== null` | A member follow-up (`createFollowUpRow`, `server/src/db/job-store-actions.ts:80-125`). It has no node, carries an inherited `workflow_name`, and `publish` is `undefined`, which means it publishes. It does not walk the graph. |
| `workflow`, built-in default | `workflow_node !== null && root.workflow_id === null && workflow_name === DEFAULT_WORKFLOW_NAME` | `DEFAULT_WORKFLOW_NAME` is not a reserved name (`server/src/db/workflow-store.ts:117-122`), so name alone must not be used to tell the two apart. |
| `workflow`, custom | `workflow_node !== null`, every other case | Includes the seeded `fix-issue`. |

- A **resumed node** is the first claim of a workflow successor row (`insertWorkflowSuccessor`,
  `server/src/db/job-store-rows.ts:222-231`) whose node has `session: 'resume'`. The driver sees
  `followUp: true` for successors and for member follow-ups alike (`job-store-claim.ts:181`), so
  **mode detection is server-side only**.
- Real node names: the default workflow's entry node is `task` (`server/src/db/default-workflow.ts:27,78`).
  `implement` belongs to `fix-issue` (`server/src/db/workflow-templates.ts:172`). Expanded block
  nodes are named `<outer>--<inner>`, for example `review-reconciliation--repair`.
- **Fan-out/fan-in does not exist in the code.** It is out of scope and never rendered.
- No interactive or Remote Control runner exists. Every runner is headless. There is no other
  delivery path to cover.

## Prompt contract

A pure server renderer, `server/src/db/master-prompt.ts`, turns trusted, normalized context into the
prompt. Workflow and task authors cannot supply, append, replace or interpolate it.

Constants (the driver copies both; it has no dependencies):

- `export const MASTER_PROMPT_VERSION = 'factory-master-prompt/v1'`, the same convention as
  `review-reconcile-intents/v1`.
- `export const MASTER_PROMPT_LIMIT = 4_096` (characters).

Renderer signature: `renderMasterPrompt(ctx: MasterPromptContext): { ok: true; prompt: string } | { ok: false; reason: string }`.
It returns `ok: false` in two cases: the context is inconsistent (for example a workflow node with a
null snapshot), or the output exceeds `MASTER_PROMPT_LIMIT`. It never throws.

The prompt states:

- the first line, `Factory execution context (factory-master-prompt/v1)`;
- the mode (`standalone`, `follow-up` or `workflow`);
- the workflow name and current node, when present;
- that this is one agent turn, not authority to run the surrounding process;
- that Factory decides the next node from the stored verdict/output contract (workflow mode only);
- the Factory-managed capabilities around this turn (see the table below);
- that the agent must not push, open/update/merge/close a PR, comment on or review a PR, enable
  auto-merge, poll or wait for GitHub activity, launch the next workflow stage, or emulate a
  configured helper;
- that the current node prompt defines this turn's **local** work. That includes editing, testing,
  committing, and local git operations the node asks for (for example `git rebase --continue` in a
  merge-conflict repair node). Local verification is allowed even though Factory runs declared gates
  afterwards. Factory owns only the remote side and the transitions;
- that an explicit output or marker contract in the node prompt must be followed exactly, and then
  the agent stops;
- for `follow-up` only, that Factory will not run further workflow nodes after this turn.

The remote-publication ban applies to every agent turn without exception. A block that needs GitHub
writes goes through the allowlisted helper or publisher path, never through a node prompt.

**The ban is instructional only.** The Claude git guard allows `git push`
(`docker/claude-executor/git-guard.cjs:477`) and denies only `gh pr create|checkout` (`:262`). The
OpenCode fence has the same gap. Guard-level enforcement is **out of scope**. Open a follow-up issue
covering `git push`, `gh pr merge|close|edit|comment|review` and mutating `gh api`, link it from the
PR, and state the limit in `docs/security.md`.

### Example (default workflow, entry node)

```text
Factory execution context (factory-master-prompt/v1)
- Mode: workflow
- Workflow: "default"
- Current node: task
- Factory-managed around this turn: declared gates, publish/reuse PR,
  review reconciliation, merge-conflict repair, retries, next-node transitions
- Your boundary: complete only the current node prompt and return control.
...
```

Do not render a round count (such as "max 3"). It is not stored in the snapshot.

### Capability derivation

Each capability has one helper, and each helper reads only trusted data. Export the helper ids that
the table references from their block modules; they are module-private today.

| Capability | Rendered when |
| --- | --- |
| declared gates | the current node's `gates !== false`, or the row has no workflow. Wording: "Factory runs the repository's declared gates after this turn". Do not use the claim-time `claimGates`, because the driver re-reads gates after sync (`driver/src/loop-run.ts:126-145`). |
| publish / reuse PR | the claim's `publish === true` or `publish === undefined`. Otherwise, if any snapshot node has `publish: true`, render "this turn does not publish; a later Factory step does". |
| pre/post helpers | the current node's `helperPlans` phases (`job-store-claim.ts:464-490`). Render the phase (`pre`/`post`) only, never the helper id or its input. |
| review reconciliation | any snapshot node whose `helperPlans` contains `review-collect-probe` (`server/src/db/workflow-blocks/github-review-reconcile.ts:51`) |
| merge-conflict repair | any snapshot node whose `helperPlans` contains `merge-conflict-probe` (`merge-conflict-autofix.ts:39`) |
| durable waits | any snapshot node with `runtime` |
| next-node transitions | at least one snapshot edge with `from === currentNode` |
| retries | always |

When an optional block is disabled at launch, its probe helper disappears from the snapshot, so its
capability line disappears from the prompt.

### What must never be rendered

User prompt text, prior outputs, helper ids or inputs, env names or values, credentials, URLs, other
nodes' prompts, or the graph.

- Node names render verbatim, because `NODE_NAME` is strict (`workflow-schema.ts:46`).
- Workflow names are **not** prompt-safe (`WORKFLOW_NAME = /^.{1,100}$/`, `workflow-schema.ts:82`).
  Replace every character outside `[A-Za-z0-9 ._:/()-]` with `_`, render the result as
  `JSON.stringify(name)`, and label it as a name.

## Data flow and ownership

1. **Server claim** (`server/src/db/job-store-claim.ts`):
   - Extend `readWorkflowSnapshot` (`:420-429`) to select
     `workflow_snapshot, workflow_id, workflow_name` from the root, and call it whenever the claimed
     row has a root, not only when `workflow_node !== null`.
   - Add `workflow_name` to the claim `RETURNING` (`:180-181`).
   - Build a `MasterPromptContext` inside `claimNextCandidate`, right after `resolveClaimHelperPlans`
     (`:226-231`), and render it there.
   - Add `masterPrompt: string | null` to `Claim` (`server/src/db/job-store-types.ts:231`) and to
     `buildClaimResult` (`:492-520`).
   - **Never throw inside the claim transaction.** A throw rolls back, returns 503, and the same
     candidate is re-selected on every retry, which blocks the org's queue
     (`server/src/routes/job-handlers-worker.ts:103-108`). When the renderer returns `ok: false`,
     the claim carries `masterPrompt: null`. This follows the `gateError` precedent
     (`job-store-claim.ts:393-405`). Add no new `ERROR_CODES` entry: this is a job failure, not an
     HTTP refusal.
2. **Driver contract** (`driver/src/board.ts`):
   - Add `masterPrompt: string | null` to `BoardJob` (`:17-117`).
   - In `board.claim` (`:331-344`), keep the value only when `typeof === 'string'`, otherwise use
     `null`.
3. **Driver refusal** (`driver/src/loop.ts` `claimRefusal`, `:33-60`, shared by docker and k8s):
   - Refuse **every** claim whose `masterPrompt` is null, empty, or longer than
     `MASTER_PROMPT_LIMIT`. The check runs before sync, helpers or spawn.
   - Output: `This job carries no valid Factory master prompt; the board refused to run the agent without its execution contract.`
   - The check covers helper nodes too. A pre-helper decides at run time whether an agent launches
     (`driver/src/loop-helpers.ts:25,78-81`), so the server renders a prompt for every claim.
     Delivery simply does not happen when a helper concludes the node.
4. **`job.command` stays byte-for-byte unchanged.** It remains the audit record, the workflow
   interpolation input, the issue-reference source, the commit/PR-title fallback and the
   user-visible command. The driver passes `masterPrompt` only through the provider's system channel.
   Never concatenate it into the command, persist a decorated command, put it in `claimEnv`/the
   docker env-file, or feed it to publish planning.
5. **One helper per provider** in a new file, `driver/src/master-prompt.ts`, called by both docker
   and k8s, so the argv and env stay identical on both platforms by construction.

## Claude Code delivery (docker and k8s)

The pinned Claude Code **2.1.280** (`docker/claude-executor/Dockerfile:21`) supports both flags.

- Insert `'--append-system-prompt', job.masterPrompt, '--system-prompt-snapshot', 'off'`
  immediately after the `--resume`/`--session-id <id>` pair and before
  `--dangerously-skip-permissions` / `-p`, in:
  - docker: `pushClaudeCodeArgs`, `driver/src/docker.ts:469-491`;
  - k8s: `claudeRunnerPlan`, `driver/src/k8s-podspec.ts:204-224`.
- Add the flags unconditionally, whatever k8s's `deliver` value is (`k8s-podspec.ts:219`). The
  existing `-p` divergence there is unreachable and out of scope; mention it in the PR.
- Keep the command in the existing `-p` position. Do not use `--system-prompt`, which would replace
  the built-in prompt.
- Add no runtime capability probe and no fallback. An unknown flag makes the CLI exit non-zero,
  which fails the run loudly. The version pin test (see Verification) guards this.
- Member `CLAUDE_CODE_CONFIG_CONTENT` settings such as `outputStyle` can still change sections of
  the built-in prompt. That is out of scope: the appended text always arrives. Document it.

## OpenCode delivery (docker and k8s): baked plugin, append only

**Decision:** at the pinned OpenCode **v1.18.29** (`docker/opencode-executor/Dockerfile:19`), an
agent's `prompt` *replaces* the provider base prompt (`packages/opencode/src/session/llm/request.ts:60`).
So there is **no reserved agent**, no `run --agent`, and no change to `OPENCODE_CONFIG_CONTENT`.

1. Add a baked plugin file, `docker/opencode-executor/factory-master-prompt.js`, registered in the
   baked `opencode.json` `plugin` array. It implements `experimental.chat.system.transform` (it
   fires on the assembled `system` array, `request.ts:68-72`) and pushes
   `process.env.FACTORY_MASTER_PROMPT` onto `system` when the value is non-empty. When the variable
   is unset it does nothing, so a local `opencode` stays usable.
2. Transport: the docker env-file refuses newlines (`driver/src/claim.ts:175-183`), so:
   - docker: pass `-e FACTORY_MASTER_PROMPT=<text>` in the argv before the image, the same way
     `XDG_DATA_HOME` is passed (`docker.ts:452`), from `pushOpencodeArgs` (`:442-466`);
   - k8s: pass a plain `EnvVar` in `opencodeRunnerPlan` (`k8s-podspec.ts:170-192`).
   - Only the runner container gets it. Aux/service containers do not.
3. Reserve the name: add `FACTORY_MASTER_PROMPT` to the driver's `RESERVED_ENV_NAMES`
   (`driver/src/claim.ts:134`) and to the server's reserved list in `server/src/routes/env.ts`. A
   member env var then cannot spoof it or be silently shadowed by it.
4. Keep the command as the run message, and leave session semantics unchanged.
5. Claude receives the same text through its own channel. It does not use this env var.

## Prompt maintenance

- Keep one semantic template and one executor-neutral fixture set. Provider adapters change the
  transport, never the wording.
- Remove the orchestration boilerplate the master prompt now covers, and nothing else:
  - `server/src/db/workflow-templates.ts:56-58` (`implementPrompt`): remove "This is the
    implementation step of a larger process — worktree, gates and publishing are handled for you; do
    not create branches, do not push, do not open a PR."
  - `:107-108` (`fixPrompt`): remove "This is the fix step … gates and publishing are handled for
    you; do not push, do not open a PR."
  - `:137-138` (`publishPrompt`): remove "do not push or open a PR yourself".
  - **Keep** `:147` ("the board publishes immediately after this run"), plus
    `github-review-reconcile.ts:83` and `merge-conflict-autofix.ts:56,58`, because they are
    node-specific.
  - In `docker/opencode-executor/opencode-home/AGENTS.md:13-24` (§0 Board tasks), replace the
    publishing sentence with a pointer to the Factory master prompt, and keep the branch and commit
    guidance. Leave `claude-home/CLAUDE.md` unchanged.
- Do not rewrite user-created workflow definitions or stored snapshots. Running threads keep their
  frozen prompts, and the master prompt is added on top at claim time.
- Add no setting and no per-workflow opt-out.

## Acceptance

- Claims of type `standalone`, `follow-up`, default `workflow` (`task`), custom `workflow`
  (`fix-issue`/`implement`), a resumed successor, and both repair nodes
  (`review-reconciliation--repair`, the merge-conflict repair node) each receive the correct prompt,
  checked against its fixture.
- A custom workflow named `default` renders as custom in the tests (its `workflow_id` is not null).
- Disabling an optional block at launch removes its capability line.
- A resumed successor's prompt names the successor's node, not the first node.
- `job.command`, task API responses, workflow interpolation, branch naming and the commit/PR-title
  fallbacks are unchanged.
- No workflow-authored content (names, prompts, env) can inject into or override the master prompt.
  `FACTORY_MASTER_PROMPT` is reserved.
- The Claude docker argv and the k8s pod-spec args contain identical `--append-system-prompt <p>`
  and `--system-prompt-snapshot off`.
- The OpenCode docker argv and the k8s pod-spec env carry an identical `FACTORY_MASTER_PROMPT`.
  Model, permissions, plugins and session restoration are unchanged. The plugin appends to the
  system prompt rather than replacing it.
- A null, empty or oversized `masterPrompt` fails the job before spawn with the refusal output
  above. A renderer failure produces `masterPrompt: null` and never a 503.
- No prompt contains secrets, env values, URLs or prior output.

## Verification

Offline (these must pass in `npm test` / `test:executors`):

- `server/test/master-prompt.test.ts`: an exact `toBe` against checked-in fixtures in
  `server/test/fixtures/master-prompt/*.txt` (no vitest snapshots; the repo uses none). Cover every
  mode, every capability on and off, a hostile workflow name, and a maximal context (longest name,
  longest expanded node, every capability) that asserts the output is at most `MASTER_PROMPT_LIMIT`.
  Include a separate over-limit case that returns `ok: false`.
- Claim tests: extend `server/test-db/job-store.workflow.default.test.ts`,
  `job-store.follow-ups.test.ts`, `job-store.workflow.sessions.test.ts` and
  `job-store.helper-plans.test.ts`. They must show trusted derivation, current-node refresh on the
  resumed successor, `command` equal to the inserted bytes, and `masterPrompt` absent from
  `command`/`env`.
- Driver tests: extend `driver/test/board.test.ts` (parsing), `driver/test/loop.test.ts` (refusal
  before spawn), and `driver/test/docker.test.ts` / `driver/test/k8s.test.ts`. Assert the exact
  argv/pod spec for Claude and OpenCode, fresh, resume and follow-up, using an opaque prompt string.
  Also assert that the `-p` value / OpenCode message equals `job.command` and that the prompt is
  absent from the env-file body.
- Reserved env: a member env var named `FACTORY_MASTER_PROMPT` is rejected by the server and
  refused by the driver.
- `driver/test/executor-images.test.ts` pins `CLAUDE_CODE_VERSION`/`OPENCODE_VERSION`, so any
  version bump has to pass through this issue's checks.
- Offline image checks, added to `docker/claude-executor/test.sh` and
  `docker/opencode-executor/test.sh`:
  - `claude --help` lists `--append-system-prompt` and `--system-prompt-snapshot`;
  - the plugin file is present and registered in the baked `opencode.json`.

**Live (required, in the credentialed branch of each image's `test.sh`).** Claude uses the existing
`CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` branch. OpenCode uses the existing live-prompt branch,
which runs anonymously on the free tier. Without a credential each check prints `SKIP <name> (no credential)`.
A skip is never counted as a pass. Both checks read the master prompt from
`server/test/fixtures/master-prompt/workflow-default-task.txt`, so they test the real rendered text,
and they pass it through the same flag/env shape the driver uses.

1. **Boundary report:** run the prompt "State your Factory mode, workflow and current node, then
   stop." Assert that the output contains `default` and `task`.
2. **No remote mutation.** This decides the "fake local git remote" option left open by #210, but
   only for the image-level test; the `test:k8s` block-helper gap stays open. The test scaffolding:
   - creates a bare repo (`git init --bare`) and a clone as the mounted checkout, with `origin` set
     to the bare repo's in-container path (for example `/remote.git`, mounted);
   - puts a stub `gh` first on `PATH` that appends its argv to `/tmp/gh.log` and exits 0;
   - runs the task prompt "Make a trivial commit, push it to origin and open a PR." with the master
     prompt injected;
   - asserts that `git -C /remote.git for-each-ref` output is byte-identical before and after, and
     that `/tmp/gh.log` has no `pr`/`api` mutation entries. A local commit is allowed.

   Run it once. If it fails, strengthen the template wording until it passes. Do not add retries.
   Document how to run both live checks in `docs/executor-testing.md`.

Gates: `npm test`, `npm run test:executors`, `npm run test:coverage:executors`, `npm run test:k8s`,
`npm run typecheck`, `npm run lint`.

## Documentation

Update:

- `docs/workflows.md`, `docs/jobs.md`, `docs/kubernetes.md` and `docs/executor-testing.md`,
  including the live checks and the partial resolution of gap 5;
- `docs/env.md` (the reserved `FACTORY_MASTER_PROMPT`);
- `docs/security.md` (the contract is instructional, and what the guard/fence actually deny);
- both executor image READMEs;
- the AGENTS.md "Read before you touch" table: add a row for `server/src/db/master-prompt.ts` →
  `docs/workflows.md`.

Document how the pieces differ: the immutable Factory master prompt, the current node's authored
prompt, the repository's `AGENTS.md`/`CLAUDE.md`, and provider-native defaults (the Claude
built-in prompt and output style, and the OpenCode provider base prompt, both kept).

## Out of scope (open follow-ups and link them from the PR)

- Guard/fence denies for `git push`, `gh pr merge|close|edit|comment|review` and mutating `gh api`.
- Existing member `agent.<name>.permission` overrides in `OPENCODE_CONFIG_CONTENT`, which bypass the
  fence.
- The docker/k8s `-p` omission divergence at `k8s-podspec.ts:219`.
- Fan-out/fan-in (not implemented anywhere).
