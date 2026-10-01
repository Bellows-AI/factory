# [Workflow] Built-in default workflow with configurable PR review and merge-conflict autofix

Refines #36. This is the parent specification for #122 and #133. It is adjacent to #131 (generic workflow CRUD/editor), but the curated default-workflow configuration here must not require users to edit graph JSON.

## Problem

An unnamed task currently resolves no workflow. The member's prompt runs verbatim and the driver publishes a successful gated result, while reusable graphs run only when a workflow is explicitly selected.

That leaves the common path without post-PR automation. A member can run an arbitrary prompt or invoke a user-defined skill, but after the PR opens Factory does not reconcile reviewer feedback or repair conflicts with the base branch.

The repository also has no reusable, allowlisted block contract for these capabilities. Implementing them only inside one seeded graph would duplicate prompts/scripts and keep them out of custom graph workflows.

## Product decisions

- An unnamed task runs the code-owned `default` workflow. An explicitly selected workflow wins and does not implicitly inherit the default workflow's optional steps.
- The first agent command is exactly `{{command}}`. Arbitrary prompts and user-defined skills remain valid entry points.
- The existing run → declared gates → publish/open-or-reuse-PR behavior is the mandatory spine.
- `Iterate on PR review comments` and `Repair merge conflicts` are enabled when no saved preference exists, including for existing users.
- Saved preferences are per member within an organization and supply the initial selection in the task composer.
- Every default-workflow task may include or exclude either optional step for that run. The launch-time selection wins over saved preferences and is frozen into the root job's compiled workflow snapshot.
- Changing saved preferences or editing a composer draft never changes an already-created task.
- Switching both optional steps off produces today's unnamed-task behavior: run the prompt/skill, run declared gates, and publish.
- “Autofix merge” means repairing branch/base conflicts and updating the PR. It does not merge the PR or enable GitHub auto-merge.
- Do not restore the arbitrary scoped `workflow.is_default` model removed by migration 032. There is one reserved, board-owned default workflow; custom workflows remain explicit choices.

## Default graph

```text
execute {{command}}
  → declared gates
  → publish/open-or-reuse PR
  → [review reconciliation, when included; max 3 repair rounds]
  → [merge-conflict autofix, when included]
  → done
```

Required short-circuits:

- no repository, no checkout, or nothing publishable: finish after `execute` without attempting GitHub-only blocks;
- publish failure: fail/rest before review or merge automation;
- PR already closed or merged: finish without modifying it;
- excluded block: omit it from the compiled snapshot instead of queueing a no-op agent run.

## Configuration and per-task UI

Add a `Workflows` settings route with a `Default workflow` panel. Show the mandatory spine as read-only and expose two saved-default switches, both on by default:

1. **Iterate on PR review comments** — wait for review activity and address at most three rounds of actionable feedback.
2. **Repair merge conflicts** — reconcile the task branch with the PR's current base branch, invoke an agent only when conflicts need judgment, run gates, and update the existing PR.

The panel needs loading, unavailable, dirty, saving, saved, and server-refusal states and participates in the shared settings unsaved-change guard. Copy must explain that saved defaults apply to new composer drafts/tasks only.

In the task composer:

- replace the no-selection label/copy with `Default workflow`;
- show the two optional steps as per-task checkboxes initialized from the saved defaults;
- allow the member to include a normally disabled step or exclude a normally enabled step;
- list the final included steps in preflight before launch;
- reset the per-task choices to saved defaults for a new draft, but do not overwrite choices in an existing dirty draft when the settings poll refreshes;
- hide these checkboxes when an explicit custom workflow is selected; custom definitions own their graph.

The launch body carries the complete final selection, for example:

```json
{
  "defaultWorkflow": {
    "reviewReconciliation": true,
    "mergeConflictAutofix": false
  }
}
```

The server accepts this field only when no explicit workflow name is supplied, requires both booleans, and returns `400 BAD_DEFAULT_WORKFLOW` for malformed, partial, or custom-workflow combinations. The server compiles exactly that selection; it must not re-read preferences after accepting the launch.

Saved-settings API:

- `GET /api/workflows/default-settings`
- `PUT /api/workflows/default-settings` with the complete boolean pair

Persist settings by `(org_id, user_id)`. A missing row means both `true`; do not backfill one row per user merely to represent defaults.

## Reusable built-in blocks

Add a closed board-owned block registry and let graph definitions reference allowlisted blocks. A block reference is not arbitrary shell:

```jsonc
{
  "name": "review-comments",
  "kind": "block",
  "uses": "builtin/github-review-reconcile",
  "with": { "maxRounds": 3 }
}
```

Initial block IDs:

- `builtin/github-review-reconcile`
- `builtin/merge-conflict-autofix`

The validator rejects unknown block IDs, unknown configuration keys, unsafe bounds, and illegal edges with named errors. A compiler expands block references into validated graph/runtime steps at task creation, namespaces internal node names, then freezes the expanded definition on the root job. New tasks receive updated block implementations; running tasks never do.

Expose the block catalog and configuration schema in the workflow API so #131's JSON editor and the later #132 graph UI can author references without copying prompts. The default workflow must be assembled from these same block definitions—no second implementation in its template.

Deterministic helpers live as real files under `driver/src/scripts/`, are passed by content, and run through shared Docker/Kubernetes transports. Agent prompts receive bounded structured output. Kubernetes parity is part of each block, not a follow-up.

## Review reconciliation semantics (#133)

Do not hold a runner while waiting for a human.

After publish, persist structured PR identity on the thread (repository, PR number/URL, head/base refs) instead of recovering it from decorated output. Use the existing signed GitHub webhook route for the required PR review/review-comment events. Delivery GUIDs and comment/thread IDs make wake-ups idempotent.

The block performs a deterministic full-state fetch—general PR conversation, submitted review bodies/states, inline review comments, and unresolved review threads—so webhook ordering or a missed delivery cannot hide feedback from the agent.

- If reviewers are requested or actionable feedback exists, park the workflow durably without a claimed runner.
- On actionable feedback, enqueue one repair round with the collected feedback and exact thread/comment IDs.
- After changes, run declared gates, commit/push through the existing publisher, reply to exact comments/threads with what changed, and resolve only threads actually addressed.
- Re-fetch after the push. New feedback becomes the next round; duplicate deliveries do not.
- Count repair agent runs, not webhook deliveries or no-op checks. A fourth required round rests the thread as needs-review with all feedback visible.
- Approval/no remaining requested review and no unresolved actionable feedback exits the block. If no reviewer is requested and no feedback exists at the initial fetch, exit immediately.
- A user stop or PR close cancels the durable wait.

If publish diagnostics continue to be appended to stored output, preserve the agent/block outcome separately so `[driver] published …` cannot break marker/outcome transitions.

## Merge-conflict autofix semantics (#122)

Run after review reconciliation, or immediately after publish when review reconciliation is excluded.

The deterministic preflight fetches the PR's current base and probes whether the head is already based on it:

- up to date / cleanly reconcilable: complete without an agent, applying and publishing the deterministic rebase only when the head changes;
- conflicts: leave a fenced, known rebase state for the agent, provide conflicting paths/base SHA, let the agent resolve, then run declared gates and update the existing PR with `--force-with-lease`;
- changed remote head/base or lost lease: abort safely and retry from a fresh probe, never overwrite somebody else's push;
- unresolved conflict, failed gates, or failed push: abort/clean the rebase state where safe and rest as needs-review with the exact reason.

Use restore mode so normal startup sync does not fail and abort the conflict before the repair agent sees it. Keep remote Git operations in the shared driver block implementation, with identical Docker and Kubernetes behavior.

One merge-repair agent round is in scope. Further attempts require a human follow-up or a later configuration option.

## Server and persistence work

- Add the member default-settings migration/store/routes.
- Add the built-in block registry, strict reference validation, compiler, and expanded-snapshot tests.
- Resolve unnamed `POST /api/jobs` requests to the compiled default workflow, using the request's per-task selection; explicit workflow names retain existing repo → user → org precedence.
- Stamp the reserved default workflow name, selected step flags, and exact expanded snapshot on the root job for audit/UI reads.
- Store structured PR identity and durable review-wait state; map signed GitHub deliveries to the owning root without parsing logs.
- Extend the webhook handler without weakening its HMAC boundary, body cap, or existing membership-event behavior.
- Update task aggregation so a durable PR-review wait is visibly `Waiting for review`, not running, queued, or falsely done.

## Driver work

- Share block script execution and credential handling between Docker and Kubernetes.
- Reuse `publishCheckout()` for initial/subsequent commits, pushes, and PR lookup; never create a duplicate PR.
- Add bounded, parseable results for review collection/replies and merge reconciliation.
- Keep secrets out of argv/log/output and request a publish-fresh installation token before every GitHub write.
- Fence helpers by job/lease and clean auxiliary Kubernetes Jobs/Secrets exactly like publish steps.

## Web work

- Add `SettingsWorkflowsPage`, navigation/wiring, API hook, accessibility, responsive layout, and unsaved-change integration.
- Add per-task include/exclude controls and preflight disclosure to the composer, seeded from but independent of saved defaults.
- Render the frozen per-task selection, durable wait, and exhausted-round outcomes in task detail/inbox without inferring them from log prose.
- Keep #131's generic workflow JSON editor separate; it consumes the block catalog but does not edit the reserved default template.

## Acceptance criteria

- An unnamed task runs an arbitrary prompt or skill through the default workflow and opens/reuses one PR after gates pass.
- Both optional steps are included for a member with no saved settings.
- Either saved default can be disabled independently.
- For one task, a member can include a saved-off step or exclude a saved-on step; the preflight and resulting snapshot agree with the submitted selection.
- A dirty composer draft keeps its explicit choices across settings refreshes.
- A task snapshot/UI do not change when defaults are edited mid-thread.
- An explicit custom workflow rejects default-workflow launch options, is not modified by preferences, and can reference either built-in block itself.
- Review feedback from conversation, review bodies, and inline threads is collected deterministically, addressed, replied to, and re-fetched for at most three repair rounds without duplicate runs.
- Waiting for review consumes no executor. Duplicate/out-of-order webhook deliveries are harmless.
- Merge repair updates the existing PR only after gates pass, uses force-with-lease, and never leaves an unowned rebase or overwrites a moved remote head.
- No-repo, no-change, closed PR, excluded block, and clean/up-to-date paths complete without unnecessary agent runs.
- Docker and Kubernetes execute identical block decisions and failure semantics.
- Existing explicit `fix-issue` behavior remains unchanged unless its graph explicitly adopts a built-in block.

## Verification

- Schema/compiler: prompt-vs-block grammar, unknown IDs/config, expansion namespacing, edge rewrites, bounds, snapshot immutability.
- Routes/store: per-org/member isolation, missing-row defaults, settings PUT validation, per-task overrides, malformed/custom-workflow refusal, unnamed default resolution, explicit precedence, both steps excluded.
- Webhook: signature, supported/ignored events, delivery dedupe, coalescing while a round runs, PR close/merge cancellation.
- Offline scripts: all review-comment surfaces, unresolved-thread selection, exact replies, clean/conflicting/stale merge probes, cleanup, bounded output, secret redaction.
- Driver Docker and Kubernetes: helper transport, fresh token, lease loss, PR reuse, gate failure, force-with-lease refusal, cleanup.
- Web render: settings states/toggles, unsaved guard, task-level include/exclude/reset/dirty behavior, preflight, waiting/exhausted task states.
- Keep `npm test`, `npm run test:executors`, `npm run test:coverage:executors`, `npm run typecheck`, `npm run lint`, and `npm run build` green. Add focused DB coverage for new tables.

## Documentation

Update `docs/workflows.md`, `docs/jobs.md`, `docs/api.md`, `docs/design-system.md`, `docs/executor-testing.md`, `docs/configuration.md`, and `docs/security.md`. Remove the “there are no default workflows” contract and stale “none/raw prompt” UI copy. Document request-level overrides, required GitHub App permissions/event subscriptions, and that merge autofix never merges a PR.

## Out of scope

- GitHub auto-merge or merging/closing PRs.
- A visual graph editor (#132).
- Making an arbitrary user workflow the implicit default; the default is reserved and code-owned.
- Repository/org policy layers for the saved defaults.
- Jira or non-GitHub review providers.
- More than one merge-conflict repair agent round.

