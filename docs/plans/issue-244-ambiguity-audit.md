# Issue #244 ambiguity audit: board-owned master prompt

I checked the issue text against the code at `d28013d` (main). Each item below gives the
ambiguity, the evidence, and a proposed resolution. Items marked **DECISION** need the issue owner
to confirm before hand-off, because they change what gets built. Every other item has a resolution
an executor can apply without asking.

Verified externally:
- Claude Code **2.1.280** (pinned in `docker/claude-executor/Dockerfile:21`, and the same version
  is installed locally). `claude --help` lists `--append-system-prompt <prompt>` and
  `--system-prompt-snapshot <on|off>`. The help text for the second flag says: "off: never
  record; the prompt is rendered fresh every request … No effect where system-prompt recording is
  not yet enabled."
- OpenCode source at tag **v1.18.29** (pinned in `docker/opencode-executor/Dockerfile:19`).
  `opencode run --help` lists `--agent`.
  - `packages/opencode/src/session/llm/request.ts:60` builds the system prompt as
    `input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)`, followed by
    instructions and `user.system`.
  - `packages/opencode/src/agent/agent.ts:268-288` handles `cfg.agent` entries. An unknown key
    creates a new agent with `mode: "all"`, and each field of the agent is overridden from config.
  - The `experimental.chat.system.transform` plugin hook fires on that same assembled `system`
    array (request.ts:68-72).

---

## 1. The claim path: where the trusted fields come from

1. **The claim cannot currently see the workflow name, the workflow id, or whether the row is a member follow-up.**
   Evidence: the claim `RETURNING` clause returns only `id, command, …, workflow_node, follow_up`
   (`server/src/db/job-store-claim.ts:180-181`). `readWorkflowSnapshot` selects only
   `workflow_snapshot` from the root (`:420-429`), and it runs only when `workflow_node !== null`
   (`:224`). `buildClaimResult` (`:492-520`) has no workflow-name input.
   Resolution: extend `readWorkflowSnapshot` to
   `select workflow_snapshot, workflow_id, workflow_name from job where id = rootJobId`. Always
   return `parent_job_id` (it is already there), and add `workflow_name` from the claimed row to
   the claim update's `RETURNING`. Pass a normalized `MasterPromptContext` to the renderer from
   inside `claimNextCandidate`, right after `resolveClaimHelperPlans` (`:226-231`). Add
   `masterPrompt` to `Claim` (`server/src/db/job-store-types.ts:231`) and to `buildClaimResult`.

2. **"Standalone", "default" and "custom" have no explicit flag. Derive them as follows.**
   Evidence: since #209, every unnamed launch resolves to the code-owned default workflow
   (`server/src/routes/job-workflow-resolution.ts:115,165`) with `{ id: null, name: 'default' }`.
   `DEFAULT_WORKFLOW_NAME = 'default'` (`server/src/db/default-workflow.ts:24`) is **not** a
   reserved name. Only `fix-issue` is reserved (`server/src/db/workflow-store.ts:117-122`), so a
   member can create a custom workflow called `default`. A `workflow: null` launch is only
   reachable in a route-test harness with no workflows store (`job-workflow-resolution.ts:158-161`).
   Resolution, applied to the claimed row plus the root:
   - `workflow_node === null && parent_job_id === null` → `standalone`. This covers only legacy
     queued rows and test harnesses.
   - `workflow_node === null && parent_job_id !== null` → `follow-up` (a member follow-up, see
     item 3).
   - `workflow_node !== null && root.workflow_id === null && workflow_name === DEFAULT_WORKFLOW_NAME`
     → `workflow`, **default**.
   - `workflow_node !== null` in every other case → `workflow`, **custom**.

   Do not tell default and custom apart by name alone. The rendered prompt does not need to show
   "default" versus "custom" except as the workflow name. The distinction only matters for tests.

3. **The issue does not define "member follow-up" or say what prompt it should get.**
   Evidence: `createFollowUpRow` (`server/src/db/job-store-actions.ts:80-125`) inserts a row with
   no `workflow_node` and no `workflow_id`, but copies `workflow_name` and the primary session. At
   claim time, `workflow_node === null`, so there is no snapshot read, `publish` is `undefined`,
   and the driver reads that as "publish" (`job-store-claim.ts:445`, `driver/src/board.ts:101-107`).
   A follow-up does not walk the graph.
   Resolution: render `Mode: follow-up`. Include `Workflow: <name>` when `workflow_name` is
   non-null (it is inherited context only). Capabilities are declared gates plus publish/reuse PR
   only. Add a boundary line saying Factory will not run further workflow nodes after this turn.

4. **"Resumed into another node" needs pinning down. It is a workflow successor claim, not a special flag.**
   Evidence: `insertWorkflowSuccessor` (`server/src/db/job-store-rows.ts:222-231`) sets
   `parent_job_id`, so the claim's
   `follow_up = parent_job_id is not null and command_delivered_at is null`
   (`job-store-claim.ts:181`) is **true** for the first claim of every successor, not just for
   member follow-ups. `session: 'resume'` nodes carry the primary session id
   (`workflow-schema.ts:110-115`), so the driver gets `resumeSessionId + followUp=true`, and Claude
   runs `--resume <id> -p <command>`.
   Resolution: the "resumed-node" test case is a successor row of a `session: 'resume'` node. Its
   rendered prompt must name the successor's node, not the first node's. The driver cannot tell a
   member follow-up from a successor (both have `followUp: true`), which is why mode detection has
   to be server-side (item 2).

## 2. Driver contract and argv

5. **`BoardJob` and claim parsing: say how the required field is represented, and where the driver refuses.**
   Evidence: `BoardJob` is at `driver/src/board.ts:17-117`. The claim is parsed defensively at
   `board.ts:331-344`. Pre-spawn refusals go through `claimRefusal` (`driver/src/loop.ts:33-60`,
   called at `:253`), which is shared by docker and k8s and reports
   `{status:'failed', exitCode:null, output}`.
   Resolution: add `masterPrompt: string | null` to `BoardJob`. In `board.claim`, keep the value
   only when `typeof === 'string'`, otherwise use `null`. Add a check to `claimRefusal`: if
   `masterPrompt` is null, empty, or longer than `MASTER_PROMPT_LIMIT`, fail with the output
   `"This job carries no valid Factory master prompt; the board refused to run the agent without its execution contract."`.
   This runs for **every** claim, before any sync or helper. See item 21 for why the check is not
   limited to agent launches.

6. **The argv call sites to change.**
   Claude:
   - docker: `pushClaudeCodeArgs`, `driver/src/docker.ts:469-491` (`-p` is at `:490`).
   - k8s: `claudeRunnerPlan`, `driver/src/k8s-podspec.ts:204-224` (`-p` is at `:222`).

   OpenCode:
   - docker: `pushOpencodeArgs`, `docker.ts:442-466` (`run` at `:462`, message at `:464`).
   - k8s: `opencodeRunnerPlan`, `k8s-podspec.ts:170-192`.

   Resolution: put one pure helper in `driver/src/claim.ts` (or a new `driver/src/master-prompt.ts`)
   that returns the provider-specific CLI tail fragment. Both platforms call it, so the flags stay
   byte-identical by construction. For Claude, insert
   `'--append-system-prompt', job.masterPrompt, '--system-prompt-snapshot', 'off'` immediately
   after the `--resume/--session-id <id>` pair and before `--dangerously-skip-permissions`/`-p`.

7. **The k8s Claude path already omits `-p` in one case where docker does not. The system-prompt flags must not follow that omission.**
   Evidence: `k8s-podspec.ts:219` has `deliver = !session.resume || job.followUp`. Docker always
   pushes `-p` (`docker.ts:490`). The case `resume && !followUp` needs
   `parent_job_id != null && command_delivered_at != null`, and those rows settle `stopped` and are
   never re-claimed (`job-store-claim.ts:174-178`), so the case is effectively unreachable.
   Resolution: add the system-prompt flags unconditionally, whatever the `deliver` value is. Leave
   the existing `-p` divergence alone (out of scope), and note it in the PR.

8. **The Claude flags are both supported, but `--system-prompt-snapshot off` only takes effect where recording is enabled.**
   Evidence: the help text quoted in the header.
   Resolution: pass the flag anyway. Do not probe for it and do not build a fallback. An unknown
   option makes the CLI exit non-zero, which fails the run loudly with no silent fallback. That
   already satisfies "fail before spawn if the image cannot honor them", so **drop the runtime
   image-capability probe**. The driver has no way to introspect an operator-configured image
   (`config.executorImages`). Add a pin test instead (item 17).

9. **DECISION: OpenCode's agent `prompt` replaces the provider base prompt. It does not append to it.**
   Evidence: `request.ts:60` at v1.18.29, quoted in the header. A reserved `agent.factory.prompt`
   would drop OpenCode's model-specific base instructions (`SystemPrompt.provider`) for every run.
   That is the opposite of the Claude requirement "do not replace the built-in system prompt".
   Options:
   - (A) Do what the issue says: use a reserved agent, and accept that its prompt replaces the base
     prompt. Document the divergence and reword the acceptance criteria.
   - (B) **Recommended.** Add a baked plugin file, `docker/opencode-executor/factory-master-prompt.js`,
     registered in the baked `opencode.json` `plugin` array. It implements
     `experimental.chat.system.transform` and pushes the value of a reserved env var
     (`FACTORY_MASTER_PROMPT`) onto `system`. That is a true append, needs no reserved agent, and
     never touches `OPENCODE_CONFIG_CONTENT`. The cost is that the hook is experimental, but the
     version is pinned and the image test in item 17 guards it.

   If (A) is chosen, items 10-12 apply. If (B), apply item 13 instead.

10. **(A only) Who merges `OPENCODE_CONFIG_CONTENT`?**
    Evidence: the server currently synthesizes the value only when the member has an executor
    config, dropping top-level `permission` (`job-store-claim.ts:325-338`). With no member config,
    the env var is absent. The driver passes it through untouched (`driver/src/claim.ts:120-148`).
    Resolution: the **driver** merges it (provider delivery belongs to the driver, per the issue).
    Add a pure `opencodeConfigWithFactoryAgent(job)`:
    - parse `claimEnv(job).OPENCODE_CONFIG_CONTENT` if present;
    - refuse the launch (via `claimRefusal`) if it is not a JSON object;
    - otherwise start from `{}`;
    - set `agent.factory = { mode: 'primary', prompt: masterPrompt }`, replacing the whole object;
    - serialize the result.

    Apply it only to the runner's env: `docker-runner.ts:523` (`envFileBody(job, config)`) and
    `k8s-podspec.ts:129` (`secretEnv`). Aux containers keep plain `claimEnv`. Select the agent with
    `run --agent factory`, placed before `--session` on both platforms.

11. **(A only) Hostile member config: model, permission and prompt precedence.**
    Evidence: `agent.ts:283-288`. Every agent field comes from config, including `permission`, and
    an agent without `model` uses the global `model`. The server strips only the **top-level**
    `permission` (`job-store-claim.ts:337`).
    Resolution: replace `agent.factory` wholesale. Never deep-merge the member's value in, so no
    member `permission`, `model`, `prompt` or `disable` survives on the reserved agent. Keep the
    member's top-level `model`, `default_agent` and other agents as they are (`--agent` overrides
    `default_agent`). Tests must cover a member config setting `agent.factory.{prompt,permission,disable}`
    and `default_agent: 'build'`. Existing member `agent.<other>.permission` fence bypasses are
    pre-existing. Note them in the PR as a follow-up; do not fix them here.

12. **(A only) OpenCode config substitution.**
    Evidence: OpenCode applies `{env:…}`/`{file:…}` substitution to config text.
    `WORKFLOW_NAME = /^.{1,100}$/` (`server/src/db/workflow-schema.ts:82`) allows `{`, `}` and
    arbitrary prose.
    Resolution: see item 18. Workflow names are rendered through a safe-charset filter, so no `{`
    ever reaches the config.

13. **(B only) The env var transport.**
    Evidence: the docker env-file refuses newlines (`claim.ts:175-183` `envLine`). The master
    prompt is multi-line.
    Resolution: pass `-e FACTORY_MASTER_PROMPT=<text>` in the docker argv, before the image, as
    `XDG_DATA_HOME` already is (`docker.ts:452`). For k8s, use a plain `EnvVar` in
    `opencodeRunnerPlan`. Add `FACTORY_MASTER_PROMPT` to the driver `RESERVED_ENV_NAMES`
    (`claim.ts:134`) and to the server list in `server/src/routes/env.ts`, so a member env var can
    neither spoof it nor be silently shadowed.

## 3. Prompt content and derivation

14. **The example uses node `implement` for workflow `default`. The default workflow has no such node.**
    Evidence: the default entry node is `task` (`default-workflow.ts:27,78`). `implement` belongs to
    the seeded `fix-issue` (`server/src/db/workflow-templates.ts:172`). Expanded block nodes are
    named `<outer>--<inner>` (`workflow-blocks/types.ts:22`, `index.ts:168-173`), for example
    `review-reconciliation--repair`.
    Resolution: fixture expectations use real names: `default`/`task`, `default`/`review-reconciliation--repair`,
    `fix-issue`/`implement`.

15. **Most "managed capabilities" have no named field. Here are the exact derivations.**
    The compiled snapshot keeps no block id on a node, apart from `runtime.block` on durable-wait
    nodes (`workflow-schema.ts:159-164`). `maxRounds` is not stored. It exists only as edge `max`
    values (`github-review-reconcile.ts:150-160`). Resolution, one helper per capability, each
    reading only trusted data:

    | Capability | Source |
    | --- | --- |
    | declared gates | the current node's `gates !== false`, or a workflow-less row. Not "the checkout currently declares gates": the driver re-reads gates after sync (`driver/src/loop-run.ts:126-145`), so the claim-time `claimGates` can be stale. Wording: "Factory runs the repository's declared gates after this turn". |
    | publish / reuse PR | the claim's `publish === true`, or `publish === undefined` (a workflow-less row or follow-up). Otherwise say "this turn does not publish; a later Factory step does" when any snapshot node has `publish: true`. |
    | pre/post helpers | the current node's `helperPlans` phases (`job-store-claim.ts:464-490`). Render the phase only (`pre`/`post`), never the helper id or input. |
    | review reconciliation | any snapshot node whose `helperPlans` contains `review-collect-probe` (`github-review-reconcile.ts:51`) |
    | merge-conflict repair | any snapshot node whose `helperPlans` contains `merge-conflict-probe` (`merge-conflict-autofix.ts:39`) |
    | durable waits | any snapshot node with `runtime` |
    | board-managed successors | at least one snapshot edge with `from === currentNode` |
    | retries | always true: lease `max_attempts` (`server/migrations/006_jobs.sql:32`) plus `failed` edges |
    | fan-out/fan-in | **does not exist in the code** (no match in `server/src`, `driver/src` or `docs`). Remove it from the prompt contract. |

    Drop "(max 3)" from the example. Deriving it would mean parsing `collect→repair` edge bounds,
    which is fragile, and the prompt does not need the number. Helper ids must be exported
    constants that the renderer imports (they are module-private now).

16. **"Factory runs merge-conflict repair / review reconciliation" contradicts the nodes where the agent is the repairer.**
    Evidence: `merge-conflict-autofix` `repair` tells the agent to resolve conflicts and run
    `git rebase --continue` (`merge-conflict-autofix.ts:49-65`). `github-review-reconcile` `repair`
    tells the agent to fix review feedback (`github-review-reconcile.ts:79-89`).
    Resolution: phrase capabilities as "around this turn". The template states that the current
    node prompt defines this turn's local work, including local git operations such as
    `git rebase --continue`, and that Factory owns only the remote side and the transitions.
    Include a fixture for each of the two repair nodes.

17. **Fixture location and form.**
    Evidence: no suite uses vitest snapshots (no `toMatchSnapshot` in `core/test`, `server/test` or
    `driver/test`). DB-backed claim tests live in `server/test-db/job-store*.test.ts` (for example
    `job-store.workflow.default.test.ts`, `job-store.follow-ups.test.ts`,
    `job-store.workflow.sessions.test.ts`, `job-store.helper-plans.test.ts`).
    Resolution:
    - Renderer tests: `server/test/master-prompt.test.ts`, checked with exact `toBe` against
      checked-in `.txt` fixtures in `server/test/fixtures/master-prompt/`.
    - Claim tests: extend the four `test-db` suites above.
    - Driver tests: extend `driver/test/docker.test.ts`, `driver/test/k8s.test.ts`,
      `driver/test/loop.test.ts` and `driver/test/board.test.ts`, using an opaque prompt string.
      The driver never interprets the prompt, so it does not need the server fixtures.

18. **Workflow names are not "already validated" in any sense that makes them prompt-safe.**
    Evidence: `WORKFLOW_NAME = /^.{1,100}$/` (`workflow-schema.ts:82`). `NODE_NAME` is strict
    (`:46`).
    Resolution: node names render verbatim. Workflow names render as `JSON.stringify(name)` after
    replacing every character outside `[A-Za-z0-9 ._:/()-]` with `_`. They are labelled as a name
    and never read as an instruction.

19. **Size cap and version constant.**
    Resolution:
    - `export const MASTER_PROMPT_LIMIT = 4_096` (characters) in `server/src/db/master-prompt.ts`,
      copied into the driver (the driver has no dependencies).
    - `export const MASTER_PROMPT_VERSION = 'factory-master-prompt/v1'`, following the
      `review-reconcile-intents/v1` convention (`github-review-reconcile.ts:86`). It is rendered as
      the first line: `Factory execution context (factory-master-prompt/v1)`.
    - The renderer throws if the output is over the limit. A test renders the maximal context
      (longest workflow name, longest expanded node name, every capability) and asserts it is under
      the limit.
    - The claim payload carries no separate version field.

20. **Code-owned node prompts: exact removal list.**
    `server/src/db/workflow-templates.ts`:
    - `:56-58` `implementPrompt`: remove "This is the implementation step of a larger process —
      worktree, gates and publishing are handled for you; do not create branches, do not push, do
      not open a PR."
    - `:107-108` `fixPrompt`: remove "This is the fix step … gates and publishing are handled for
      you; do not push, do not open a PR."
    - `:137-138` `publishPrompt`: remove "do not push or open a PR yourself".

    Keep the `:147` "the board publishes immediately after this run". It tells the agent what the
    output is for, which is node-specific.

    `github-review-reconcile.ts:83` and `merge-conflict-autofix.ts:56,58`: **keep**. They are
    node-specific constraints (a reply race, no new rebase) and are not the generic boundary.

    `fix-issue` reaches new launches through `seedBase` (`workflow-store.ts:296-305`). Running
    threads keep their frozen snapshots, and the issue already says to leave those alone.

    Out of the issue's list, but duplicating it: the baked `docker/opencode-executor/opencode-home/AGENTS.md:13-24`
    ("§0 Board tasks … do not push or open PRs yourself"). Resolution: trim §0's publishing
    sentence to point at the master prompt, and keep the branch and commit guidance. The Claude
    image's `claude-home/CLAUDE.md` has no equivalent block. Leave it unchanged.

## 4. Enforcement, errors, tests

21. **"Helper-only nodes need no prompt delivery" conflicts with "required `masterPrompt: string`".**
    Evidence: a pre-helper decides at run time whether to conclude without an agent
    (`driver/src/loop-helpers.ts:25,78-81`). The server cannot know this at claim time.
    `HELPER_ONLY_PROMPT` nodes (`github-review-reconcile.ts:75-77`) do launch an agent when the
    helper is missing.
    Resolution: the server renders a prompt for **every** claim, helper nodes included, and the
    driver validates it for every claim (item 5). Delivery simply does not happen when a helper
    concludes. Reword data-flow point 6 to match.

22. **Server "fail closed": do not throw inside the claim transaction.**
    Evidence: a throw in `claimNextCandidate` rolls back and returns 503 through `guard`
    (`server/src/routes/job-handlers-worker.ts:103-108`). The driver then retries, and the same
    candidate is selected again, which blocks the org's claim queue. The precedent for this is
    `gateError`, which travels on the claim so the driver can fail the job (`job-store-claim.ts:393-405`).
    Resolution: the renderer returns `{ ok: true, prompt } | { ok: false, reason }`. On `ok: false`,
    for example a workflow node with a null snapshot (`job-store-claim.ts:446-450`, "cannot happen"),
    the claim carries `masterPrompt: null`. The driver's `claimRefusal` then fails the job with a
    visible output. The server adds no new `ERROR_CODES` entry: this is a job failure, not an HTTP
    refusal. The driver side needs no code either. Its refusals are plain `output` text (`loop.ts:253-260`).

23. **"The prohibition on remote publication is absolute" is enforced only by the prompt.**
    Evidence: the Claude git guard explicitly allows `git push` (the selftest case
    `docker/claude-executor/git-guard.cjs:477`) and denies only `gh pr create|checkout`
    (`:262`). The OpenCode fence denies `gh pr create|checkout` but not `git push`, `gh pr merge`
    or `gh api`. See `docker/opencode-executor/opencode-home/opencode.json`.
    Resolution: keep enforcement out of scope. State in the issue and in the docs that the boundary
    is instructional and that the guard and fence cover only the listed verbs. Open a follow-up for
    guard-level denies of `git push`, `gh pr merge|close|edit|comment|review` and mutating `gh api`.
    Helpers and the publisher run outside the agent's tool hooks, so the follow-up would not break
    them.

24. **Verification items that cannot run offline (docs/executor-testing.md, "no Claude, no credential").**
    - "Executor image smoke tests … confirm the agent can report its boundary": needs a real model.
      Reword it as offline checks in `docker/claude-executor/test.sh` and
      `docker/opencode-executor/test.sh` (both offline by default, with an optional credentialed
      branch: `claude-executor/test.sh:6-7`):
      - `claude --help` contains `--append-system-prompt` and `--system-prompt-snapshot`;
      - `opencode run --help` contains `--agent`;
      - for option B, the plugin file is present and registered in the baked `opencode.json`;
      - for option A, `opencode debug config`, run with a sample `OPENCODE_CONFIG_CONTENT`, shows
        `agent.factory.prompt`.

      The boundary-report prompt moves into the existing optional credentialed branch.
      `driver/test/executor-images.test.ts` pins the Dockerfile `CLAUDE_CODE_VERSION`/`OPENCODE_VERSION`
      args, so a version bump has to pass through this issue's checks.
    - "Behavioral fixture … verify no remote mutation": this requires a live model plus a remote,
      and #210 already left fake-GitHub harness design open (`docs/executor-testing.md`, gap 5).
      **Drop it** from the acceptance criteria and replace it with:
      - (a) the renderer asserts the prohibition text;
      - (b) an argv/spec test proving the command bytes and the system channel are separate.

      Record the live behavioral check as a credentialed manual step.

25. **"Unchanged `job.command`" is already true. Name the assertion.**
    Evidence: `buildClaimResult` returns `row.command` verbatim (`job-store-claim.ts:505`), and
    publish planning reads `job.command`.
    Resolution: assert that the claim's `command` equals the inserted row bytes, that
    `masterPrompt` never appears inside `command`, `env` or the docker env-file body, and that the
    `-p` value and the OpenCode message value equal `job.command`.

26. **Remote Control, interactive and non-headless runners.**
    Evidence: comments still mention Remote Control (`job-store-claim.ts:209-214`), but no
    `driver/src` file implements it. Every runner is headless.
    Resolution: none needed. Say explicitly that no other runner mode exists.

27. **Claude member config could alter the system prompt through settings.**
    Evidence: `CLAUDE_CODE_CONFIG_CONTENT` strips only `hooks`, `enabledPlugins` and
    `extraKnownMarketplaces` (`job-store-claim.ts:340-345`), and it is merged into `settings.json`
    (`docker/claude-executor/entrypoint.sh:47-72`). Settings such as `outputStyle` change
    system-prompt sections.
    Resolution: out of scope. `--append-system-prompt` appends after any output style, so the
    board text still arrives. Mention this in the docs.

28. **Docs to update**, in addition to the issue's list:
    - `docs/env.md`: the new reserved env name (option B);
    - `docs/security.md`: the prompt contract is instructional;
    - the AGENTS.md "Read before you touch" table: a row for `server/src/db/master-prompt.ts` →
      `docs/workflows.md`.
