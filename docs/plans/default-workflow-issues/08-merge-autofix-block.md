# [Workflow] Implement the reusable merge-conflict autofix block

Parent: #36

Depends on #202, #204, and #207.

Status: implementation is already in progress and should finish on its current design. Do not rebase its scope onto #230 or #231.

Approved additive scope: this issue may extend `workflow-schema.ts` and `job-store-claim.ts` with an optional `helperPlans` field and generic PR-identity injection, with no behavior change for existing workflows.

## Goal

Implement `builtin/merge-conflict-autofix`: reconcile an existing task PR with its current base branch, reserve substantive agent judgment for conflicts, run declared gates, and update the existing PR safely.

This block never merges or closes the PR and never enables GitHub auto-merge.

## Block contract

- Input comes from the thread's structured PR identity from #202.
- The block runs in restore mode so normal startup sync does not abort the conflict before the repair agent sees it.
- One agent repair round is supported. Further failure rests the workflow for a human follow-up.
- The no-op path may use one cheap relay turn to carry the helper result through the current runtime; it must not perform repair judgment.
- The dedicated descriptor module scaffolded by #204 becomes available and expands to the required probe/agent/gates/publish sequence.

## Deterministic preflight

Add a real driver script that:

1. validates the worktree, expected head, remote, and PR base;
2. fetches the current base using the fresh GitHub/git credential path;
3. records head/base SHAs and probes whether reconciliation is needed;
4. returns bounded versioned JSON for `up-to-date`, `rebased`, `conflicted`, or `stale/refused`.

Behavior:

- **Up to date:** perform at most one cheap relay turn; do not run repair judgment, gates, or push.
- **Clean rebase:** apply it deterministically; run declared gates and publish only if the head changed.
- **Conflict:** leave a fenced known rebase state, list bounded conflicting paths/base SHA, and launch the repair agent.
- **Moved remote head/base or lost lease:** abort safely and re-probe; never overwrite somebody else's push.

## Agent/post behavior

- Prompt the agent only with the structured conflict state and repository instructions.
- Require it to resolve the active rebase without changing the PR target or using `gh pr create`.
- Run the existing declared gates after the agent.
- Publish through the existing publisher with a fresh token, PR reuse, and `--force-with-lease`.
- On unresolved conflicts, failed gates, stopped/lost lease, or failed push, abort/clean the rebase state where safe and rest as needs-review with the exact bounded reason.

## Ownership boundary

Own: `workflow-blocks/merge-conflict-autofix.ts`, merge-specific scripts/pure helpers, fixtures/tests, block documentation, and the narrowly additive optional `helperPlans`/generic PR-identity claim plumbing required by this implementation.

Do not refactor: generic block registry/compiler (#204), helper transport (#207), PR identity/waits (#202), review reconciliation (#133), settings/UI, or generic publish behavior beyond the approved additive schema/claim fields or a narrowly proven bug.

## Acceptance

- Block catalog reports the merge block available only after this implementation.
- No-op, clean rebase, conflict repair, stale head/base, gate failure, push refusal, stop, and lease-loss paths are deterministic and bounded.
- The no-op path performs no repair judgment and uses no more than the approved cheap relay turn.
- An existing PR is reused; no duplicate PR is created.
- Force-with-lease prevents clobbering a moved remote head.
- Both executors produce identical helper/agent/gate/publish decisions through #207.
- A custom graph can reference the block independently of the default workflow.

## Verification

- Real offline Git fixtures for clean/conflicting/stale rebases and cleanup.
- Focused block/compiler tests for expansion and one-round behavior.
- Docker/Kubernetes contract tests through the shared helper seam, not new transports.
- `npm run test:executors`
- `npm run test:coverage:executors`
- `npm run typecheck`
- `npm run lint`
