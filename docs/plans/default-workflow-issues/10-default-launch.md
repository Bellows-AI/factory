# [Workflow] Enable the built-in default workflow at task launch

Parent: #36

Depends on #122, #133, #203, #204, and #208. (#122/#133 already depend on the PR/runtime foundations.)

## Goal

Make the code-owned default workflow the path for every task that does not explicitly name a custom workflow. Compile the saved/per-task optional-step selection into the root snapshot while preserving arbitrary prompts and user-defined skill invocations.

## Launch contract

`POST /api/jobs` keeps `workflow` optional:

- explicit `workflow`: resolve the existing repo → user → org stack; reject any `defaultWorkflow` field;
- no `workflow`, `defaultWorkflow` absent: load the caller's saved settings from #203 (missing row means both on);
- no `workflow`, `defaultWorkflow` present: require exactly the complete boolean pair and use it as this task's override.

Malformed, partial, unknown-key, or explicit-workflow combinations return `400 BAD_DEFAULT_WORKFLOW` before any row is inserted.

## Compiled default

The mandatory spine is:

1. an agent entry whose interpolated command is exactly `{{command}}`;
2. existing declared gates;
3. existing publish/open-or-reuse-PR machinery.

Then include, in order, only selected optional blocks:

- `builtin/github-review-reconcile` with `maxRounds: 3`;
- `builtin/merge-conflict-autofix`.

Use #204's block compiler. Do not copy either block's prompt/script into `workflow-templates.ts`.

## Persistence and behavior

- Add `server/migrations/037_default_workflow_snapshot.sql` for any new audit columns required by this slice. Stamp `workflowName: "default"`, the chosen boolean pair, and the exact expanded snapshot on the root job. The reserved code-owned default does not participate in custom workflow name/scope precedence and is not editable/deletable through generic CRUD.
- A settings change after launch cannot affect the thread.
- No repository/checkout or nothing publishable short-circuits GitHub-only blocks cleanly.
- Publish failure stops before optional blocks.
- PR closed/merged exits optional automation without mutation.
- With both blocks excluded, behavior matches today's unnamed path: prompt/skill → gates → publish.
- Remove the runtime/doc invariant from migration 032 that “unnamed means no workflow”; do not resurrect `workflow.is_default` or permit an arbitrary custom default.
- Ensure follow-ups continue the frozen default snapshot exactly like other workflows.

## Ownership boundary

Own: `routes/jobs.ts` launch validation/resolution, job-create/store fields needed for the selected pair/name/snapshot, code-owned default assembler, route/store/engine tests, job/workflow/API docs.

Do not touch: block internals, generic block transport/compiler beyond a proven integration bug, saved-settings UI, waiting-state UI, generic workflow CRUD/editor, or webhook helpers.

## Acceptance

- An unnamed arbitrary prompt and an unnamed skill invocation both run unchanged as the entry command.
- Missing settings and no override include both blocks.
- Saved settings choose defaults; a complete request override can invert either/both for one task.
- Preflight request, stored selected pair, and expanded snapshot agree.
- Explicit custom workflows reject default options and remain unchanged.
- Both excluded yields no optional block nodes and no no-op agent runs.
- Root snapshot/name/options stay frozen through settings/block updates and follow-ups.
- Existing `fix-issue` behavior stays unchanged.

## Verification

- Focused route tests for the full body matrix and all refusal/no-row guarantees.
- DB/store tests for frozen name/options/snapshot and follow-up inheritance.
- Engine tests for zero/one/two optional block graph shapes.
- Existing workflow/task composer request tests updated to the new unnamed semantics.
- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
