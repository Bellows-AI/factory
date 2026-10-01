# [Workflow] Add reusable built-in block references and snapshot compiler

Parent: #36

## Goal

Let stored graph workflows reference board-owned, allowlisted blocks without copying their prompts or scripts. This is the schema/compiler foundation only; it does not implement review reconciliation, merge repair, or executor transport.

## Context

`workflow-schema.ts` currently accepts only `kind: "agent"` nodes with inline prompts. Definitions are snapshot-frozen on the root job, which must remain true after adding reusable blocks. Arbitrary executable/container nodes remain forbidden.

## Contract

Support a closed block node shape:

```jsonc
{
  "name": "review-comments",
  "kind": "block",
  "uses": "builtin/github-review-reconcile",
  "with": { "maxRounds": 3 }
}
```

Initial reserved IDs:

- `builtin/github-review-reconcile`
- `builtin/merge-conflict-autofix`

Create one dedicated descriptor module per reserved ID. They may report `available: false` until their implementation issues land; unavailable blocks must be listed by the catalog but rejected in runnable definitions with a named `BLOCK_UNAVAILABLE` refusal. This lets the two implementation issues edit separate files later.

## Work

- Extend the strict grammar with `kind: "block"`, `uses`, and bounded block-specific `with` values.
- Keep agent nodes unchanged. A node is either an inline agent node or a built-in block node; mixed/unknown keys refuse loudly.
- Add a board-owned registry under `server/src/db/workflow-blocks/` plus a small index. The registry owns IDs, descriptions, configuration schema, availability, and expansion.
- Compile block nodes into the ordinary low-level graph/runtime representation before a task is inserted. Namespace internal node names deterministically so two uses of one block cannot collide.
- Validate the expanded graph again, including reachability, publish path, placeholders, limits, and rewritten edges.
- Freeze the expanded definition—not a live block reference—on the root job. A block update changes future tasks only.
- Preserve the 16 KiB authored-definition cap and add an explicit bounded cap for expanded snapshots.
- Add `GET /api/workflow-blocks` to the existing workflow route plugin, returning catalog metadata/config schemas, never prompt/script bodies. Do not add another `app.ts` registration; #203 owns the concurrent registration change.
- Document the authored-vs-expanded distinction in `docs/workflows.md` and the catalog in `docs/api.md`.

## Ownership boundary

Own: `workflow-schema.ts`, the new registry/compiler modules, the catalog endpoint in the existing workflow route plugin, focused schema/compiler/routes tests, workflow/API docs.

Do not touch: `routes/jobs.ts`, default settings, web UI, driver/executor code, webhook code, or either block's runtime implementation.

## Acceptance

- Unknown IDs/config keys/types/bounds return named errors.
- Unavailable reserved blocks cannot launch.
- Expansion is deterministic and collision-free.
- Edges into/out of a block are rewritten to the declared entry/exit contract.
- The root snapshot contains the exact expanded graph and stays unchanged when a descriptor changes.
- Existing inline workflows and `fix-issue` remain green unchanged.

## Verification

- `npx vitest run server/test/workflow-schema.test.ts server/test/workflow-engine.test.ts server/test/routes.workflows.test.ts`
- `npm run typecheck`
- `npm run lint`
