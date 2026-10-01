# [Workflow] Wire durable block waits into workflow transition and claim dispatch

Parent: #36

Depends on #122, #202, #204, and #207.

May run in parallel with #230 after #122 merges. This issue owns only generic server-side block runtime dispatch and durable park/wake behavior.

## Goal

Turn #202's PR lifecycle data primitives into an executable workflow-block wait/wake seam: a workflow can park after publish with no executor held, coalesce matching webhook deliveries, and later make exactly one continuation claimable.

The result must be reusable by review reconciliation and future graph-based blocks. It must not encode review-repair or merge-conflict policy.

## Runtime contract

- Add a private, server-authored block runtime descriptor carried by the frozen expanded workflow snapshot. Authored workflow JSON cannot inject or override it, and the public block catalog does not expose prompt/script bodies or privileged metadata.
- Compile registered block expansion metadata far enough for a claim to receive its validated helper plans and for completion transition code to identify a durable wait boundary.
- Add a generic dispatcher under `server/src/db/workflow-blocks/runtime.ts`; dispatch is by allowlisted block/runtime id, never by user-provided module or script name.
- A wait-boundary transition atomically records/enters the wait instead of enqueueing an immediately runnable executor job.
- The worker claim preamble atomically claims pending wake work, coalesces repeated deliveries, and creates or exposes exactly one continuation job for the applicable workflow node.
- Waiting consumes no runner/executor lease. Claim polling may sweep durable state, but it must not create a permanently sleeping worker job.
- PR-close/thread-stop cancellation wins over wake. Replayed deliveries, concurrent claimers, crashes, and lease retries cannot duplicate a round.
- Preserve bounded audit data linking root job, PR identity, delivery count, workflow node, and round.

## Work

- Add the generic workflow-block runtime dispatcher and validated runtime metadata types.
- Reuse #122's optional `helperPlans` field and generic PR-identity claim injection; extend compiler snapshot/claim plumbing only for the remaining private runtime metadata.
- Add the completion/transition hook in `job-store-worker.ts` for entering a wait transactionally.
- Add the claim-preamble wake sweep in `job-store-claim.ts` with the existing locking/fencing conventions.
- Reuse #202's `enterWait`, `recordDelivery`, `claimReview`, cancellation, and structured PR identity primitives rather than replacing them.
- Document transaction, retry, coalescing, and cancellation semantics.

## Ownership boundary

Owns the generic server runtime module, narrowly required compiler snapshot/claim plumbing, job transition/claim integration, and server/database tests.

Do not change driver helper execution semantics, deterministic GitHub helper scripts, settings/UI, or either block's repair policy/orchestration.

## Acceptance

- A workflow transition can enter a durable wait without inserting a runnable executor job.
- Zero pending deliveries produces no continuation job; one or many pending deliveries produce exactly one claimable continuation with a deterministic coalesced count.
- Two concurrent claimers cannot wake the same wait twice.
- Delivery replay, crash/retry, PR close, thread stop, and stale lease behavior are deterministic and tested.
- The continuation claim contains only registry-produced, validated runtime/helper metadata.
- Existing ordinary workflow nodes and non-block jobs are behaviorally unchanged.

## Verification

- `npm test`
- disposable database integration tests for transition/wake races and cancellation
- `npm run test:executors`
- `npm run typecheck`
- `npm run lint`
