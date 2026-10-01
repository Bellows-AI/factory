# [Workflow] Persist PR identity and durable workflow waits from GitHub events

Parent: #36

## Goal

Provide the durable, executor-free PR lifecycle substrate that review reconciliation needs: structured PR identity, idempotent signed webhook ingestion, and a wait/wake state tied to a workflow thread.

This issue does not collect review text, run an agent, reply to comments, or implement a workflow block.

## Work

- Stop treating `[driver] published …` output as the only record of publication. Extend the completion contract so the driver reports structured publication data already returned by `publishCheckout()`: repository, PR number/URL, head branch, and base branch/ref.
- Persist publication identity on the thread/root as audit data through `server/migrations/036_job_pr_lifecycle.sql` (reserved for this parallel slice). Validate repository/URL/branch boundaries; do not trust arbitrary completion payload values outside the leased job's repository.
- Add durable PR-wait state associated with a root and a named reason/block, including active/cancelled/completed timestamps and a bounded last-seen event cursor/state.
- Extend the existing HMAC-authenticated `/api/github/webhook` route for the required pull request, review, review-comment, and issue-comment delivery families while preserving `organization.member_removed` behavior.
- Deduplicate deliveries by GitHub delivery GUID. Unsupported actions/events acknowledge without mutating workflow state.
- Resolve a delivery to a root through structured repository/PR identity, never by parsing job output.
- Expose store operations that a later block can use to enter a wait, atomically claim/coalesce pending review activity, and finish/cancel a wait.
- Closing/merging the PR and stopping/removing the task cancel the wait idempotently.
- Add bounded read-model fields sufficient for later UI: `waitReason`, `waitingSince`, and terminal/exhausted reason. Do not add UI here.
- Document required webhook subscriptions and security boundaries.

## Ownership boundary

Own: completion publication payload, job/PR persistence migration and store, webhook routing/deduplication, wait store API, server read-model fields, focused driver-completion/server tests, jobs/API/security docs.

Do not touch: review collector scripts, block schema/registry, review prompts/replies, merge repair, or web components.

The later shared block transport should land after this issue to avoid simultaneous edits in `driver/src/loop.ts`/board completion types.

## Acceptance

- A successful existing/new PR publish records one structured identity; publish no-op/failure does not invent one.
- Duplicate or out-of-order deliveries do not enqueue duplicate work.
- Events for another org/repository/PR cannot wake the thread.
- Waiting consumes no driver claim or runner.
- PR close/merge and task stop cancel the wait.
- Existing membership webhook tests stay green.

## Verification

- Driver loop completion tests for structured publication.
- Route/store tests for signatures, event/action filtering, dedupe, mapping, coalescing, and cancellation.
- Focused DB tests for constraints and concurrent wake-up behavior.
- `npm run test:executors`
- `npm run typecheck`
- `npm run lint`
