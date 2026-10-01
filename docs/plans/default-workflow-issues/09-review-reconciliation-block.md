# [Workflow] Implement the reusable remote review reconciliation block

Parent: #36

Depends on #201, #202, #204, #207, #230, and #231.

May run in parallel with #122 after those dependencies land. This issue owns only review-specific descriptor/orchestration/tests and must reuse the completed helper, wait-data, transport, helper-control, and wait/wake-runtime seams.

## Goal

Implement `builtin/github-review-reconcile`: after a PR opens, wait without occupying an executor, collect every supported review surface deterministically, address and publish at most three repair rounds, and reply to the exact feedback addressed.

## Block contract

- `with.maxRounds` is a bounded positive integer; the default workflow uses `3`.
- Input comes from structured PR identity, never parsed driver output.
- The dedicated descriptor module scaffolded by #204 becomes available and expands to wait → collect → repair → gates → publish → reply/re-fetch, with the audit trail enforcing the round bound.
- A repair round means an agent run that addresses actionable feedback; webhook deliveries/no-op fetches do not consume the bound.

## Orchestration

1. Perform a full deterministic fetch with #201 after initial publish.
2. If no reviewer is requested and no actionable feedback exists, exit the block immediately.
3. Otherwise enter #202's durable wait; no runner may remain claimed.
4. Coalesce signed webhook activity, atomically wake once, and re-fetch full state before launching an agent.
5. Supply normalized comments/reviews/threads and exact IDs to the repair agent. New activity arriving during the run remains pending for the next fetch.
6. Run declared gates. Only after green gates, commit/push through the existing publisher with a fresh token and existing-PR reuse.
7. Use #201 to reply with bounded “what changed” text and resolve only explicitly addressed threads.
8. Re-fetch: approval/no requested reviewer/no unresolved actionable feedback exits; new feedback starts the next wait/round.
9. A fourth required repair round rests as needs-review with feedback visible. Stop or PR close/merge cancels cleanly.

Preserve the block outcome separately from decorated driver output so a final `[driver] published …` line cannot corrupt transition matching.

## Ownership boundary

Own: `workflow-blocks/github-review-reconcile.ts`, review-specific orchestration/store glue built on existing wait APIs, prompt/outcome contract, focused tests/docs.

Do not refactor: helper scripts (#201), PR identity/webhook/wait substrate (#202), generic registry/compiler (#204), generic executor transport/control (#207 and #230), generic wait/wake dispatch (#231), merge block (#122), settings/composer, or task waiting UI.

## Acceptance

- Conversation comments, review bodies/states, inline comments, and unresolved threads reach the agent once with stable IDs.
- Duplicate/out-of-order webhook deliveries do not create duplicate rounds or replies.
- Waiting uses no executor.
- Replies/resolutions happen only after a successful push and target exactly addressed feedback.
- Max three agent repair rounds; exhaustion rests visibly for a human.
- PR close/merge and user stop cancel pending automation.
- A custom graph can reference the block independently of the default workflow.

## Verification

- Pure orchestration tests for initial no-op, wait/wake, coalescing, three rounds, exhaustion, approval, close/merge, stop, and failure recovery.
- Route/store integration tests using signed offline webhook fixtures.
- Driver tests through #207's shared helper seam.
- `npm test`
- `npm run test:executors`
- `npm run typecheck`
- `npm run lint`
