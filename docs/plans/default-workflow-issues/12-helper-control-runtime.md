# [Workflow] Add pre-helper conclude control and composite helper programs

Parent: #36

Depends on #207. Sequence after the already in-progress #122 to avoid changing its helper/runtime contract mid-implementation; this is a merge-order constraint, not a semantic dependency.

May run in parallel with the durable wait/wake runtime issue. This issue owns only the driver-side generic helper execution contract and its Docker/Kubernetes parity.

## Goal

Close the two generic helper-transport gaps required by review reconciliation and future reusable graph blocks:

1. a successful pre-helper can conclude a job without launching an agent, gates, post-helpers, or publish; and
2. an allowlisted host-side helper program can sequence existing script helpers with pure TypeScript planning between them.

The result must be reusable by any graph-based built-in block. It must not encode merge-conflict or review-specific policy. #122 is explicitly allowed to ship with one cheap no-op relay turn and must not be reworked to adopt this issue.

## Runtime contract

- Extend successful helper results with an explicit control outcome: `continue` by default or `conclude`.
- `conclude` is valid only for a successful pre-helper. It completes the claimed job once through the normal board completion path and preserves bounded structured output for workflow transition/audit.
- A concluded job skips the agent, gates, post-helper phase, and publish. Failure, stop, lease loss, and stale-fence behavior remain unchanged.
- Add an allowlisted composite/helper-program descriptor whose host-side coordinator can invoke registered script helpers in sequence and run pure planning logic between invocations.
- Composite programs cannot execute arbitrary shell, select arbitrary images, bypass the registry, mint credentials, or interpolate untrusted input into script source.
- Every child invocation uses the existing runner helper API, bounded I/O, fencing, stop handling, and fresh write-token rules.
- Docker and Kubernetes must execute the same child-helper plan and produce the same control outcome.

## Work

- Update the generic helper/result types and pre-helper loop handling.
- Add a registry shape for script helpers and composite helper programs with exhaustive validation.
- Add one neutral fixture composite used only to prove sequencing, intermediate planning, output propagation, and conclude behavior.
- Thread the final structured output into the existing completion request without adding block-specific branches.
- Document the generic contract and limits in the executor/workflow docs.

## Ownership boundary

Owns `driver/src/helpers.ts`, `driver/src/loop-helpers.ts`, narrowly required loop/completion wiring, driver scripts/fixtures, and driver tests.

Do not modify the server wait store/claim transition machinery, block compiler/catalog, PR lifecycle schema, or either built-in block's orchestration.

## Acceptance

- A pre-helper returning `continue` preserves current behavior.
- A pre-helper returning `conclude` completes successfully exactly once and no agent/gate/post-helper/publish call occurs.
- Invalid conclude usage and malformed composite plans fail closed before execution.
- A composite program invokes only registered child helpers and can transform one bounded child result into the next child input.
- Stop, lease loss, timeout, oversized output, read-token, and write-token cases remain covered.
- Docker and Kubernetes parity tests cover continue, conclude, composite success, child failure, and cancellation.

## Verification

- `npm run test:executors`
- `npm run test:coverage:executors`
- `npm run test:k8s`
- `npm run typecheck`
- `npm run lint`
