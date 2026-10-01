# [Workflow] Add deterministic GitHub review collection and reply helpers

Parent: #36

## Goal

Build and test the deterministic scripts that make remote review reconciliation complete and idempotent. The agent must receive every supported feedback surface with stable IDs, and replies/resolutions must target exactly what was addressed.

This issue supplies helpers only. It does not add webhook waits, executor transport, graph blocks, or orchestration.

## Inputs and outputs

Helpers take repository/PR identity and credentials through validated argv/env values. They emit bounded versioned JSON; no raw HTTP response or token reaches stdout.

Collection covers:

- general PR conversation comments;
- submitted review bodies and states;
- inline review comments with path/line/diff context;
- unresolved review threads and their stable node/comment IDs;
- requested reviewers/teams and current approval/change-request state.

Mutation covers:

- reply to the exact general or inline comment/thread with a bounded “what changed” body;
- resolve only explicitly supplied thread IDs;
- return per-target success/refusal so orchestration can retry safely without duplicating successful work.

## Work

- Add real `.cjs`/POSIX script files under `driver/src/scripts/`; no inline script strings and no mounted host paths.
- Add a pure parser/planner module beside them for validation, normalization, dedupe, ordering, output caps, and mutation plans.
- Use `gh`/GitHub GraphQL where REST does not expose unresolved-thread state. Run subprocesses with direct argv, never a shell-interpolated command.
- Stable-sort and deduplicate by GitHub IDs so the same state produces byte-stable output.
- Bound bodies, diff hunks, collection count, total output, and error text. Mark truncation visibly.
- Treat not-found/deleted comments and already-resolved threads as idempotent no-ops; permission/rate/auth failures remain actionable failures.
- Ensure the driver build copies every new script into `dist`.

## Ownership boundary

Own: new review helper scripts/module and their focused tests, script-copy manifest if required, narrow helper documentation.

Do not touch: `driver/src/loop.ts`, Docker/Kubernetes transports, server/webhook/store code, workflow schema/registry, or any web file.

## Acceptance

- Fixtures containing all feedback surfaces produce one normalized bounded result with stable IDs.
- Duplicate comments/threads are emitted once.
- Reply plans cannot target IDs absent from the collected state.
- A partial retry does not duplicate already successful replies or fail on already-resolved threads.
- Tokens never appear in argv snapshots, logs, errors, or output.
- Script bytes and direct spawn shapes are pinned by tests.

## Verification

- Focused pure/helper and `driver/test/scripts.test.ts` suites using offline fixtures/stub `gh`.
- `npm run test:executors`
- `npm run typecheck`
- `npm run lint`

