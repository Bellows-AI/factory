Part **1 of 4** of Slice C — *Make task execution deliberate and auditable* (P1).

Full spec: `docs/ui-designer/ISSUE-SLICE-C-TASK-EXECUTION.md` — sections **Data-contract work
required by the UI**, **15. Workflow parameter presentation metadata**, **16. Frozen task workflow
name**, **Implementation instructions by file → Workflow schema and route / Frozen workflow name**,
and the corresponding server/database tests.

## Summary

Give the task UI two facts it cannot currently present honestly:

1. author-written, plain-language guidance for workflow parameters; and
2. the workflow name frozen onto a task when it is created.

This is the contract-first issue. It does not redesign the composer or task detail. It makes those
later UI changes consume explicit audit data instead of interpreting regexes or joining mutable
workflow records.

## Why this lands first

The current workflow parameter shape is `{ name, pattern? }`. A generic client cannot reliably turn
an arbitrary regex into repair guidance, so the composer leaks `must match <regex>`.

The current job response exposes `workflowNode` but not a workflow name. The node is a graph
position, not the reusable process the member selected. Joining `job.workflow_id` to the current
workflow row would rewrite history when a workflow is renamed and erase it when the workflow is
deleted.

Both gaps need durable contracts before presentation work starts.

## Scope

### 1. Workflow parameter presentation metadata

Extend the closed workflow grammar:

```ts
interface WorkflowParam {
    name: string;
    pattern?: string;
    description?: string;
    example?: string;
}
```

Rules:

- `description` is optional plain-language guidance, trimmed, non-empty when supplied, and at most
  160 characters.
- `example` is an optional valid example, trimmed, non-empty when supplied, and at most 120
  characters.
- Both are presentation metadata only. They do not participate in interpolation or launch
  validation.
- `name`, `pattern`, the safe-regex subset, requiredness, the 512-character value limit, and
  full-match behavior do not change.
- Unknown keys remain a loud `UNKNOWN_KEY` refusal.
- The 16 KiB definition limit remains.
- Normalized definitions retain the trimmed metadata.
- Existing workflow list/detail routes return the fields through their existing parameter
  summaries; do not add a composer-only endpoint.

Update the seeded `fix-issue` parameter without changing its accepted pattern:

- description: **Enter an issue reference such as #123 or a full GitHub issue URL.**
- example: **#123**

### 2. Frozen workflow name on jobs

Add a nullable job audit field through
`server/migrations/033_job_workflow_name.sql`, or the next free migration number:

- `job.workflow_name text`;
- non-null values constrained to the existing 1–100 character workflow-name boundary;
- best-effort backfill from workflow rows which still exist;
- propagation of a recovered root name through its existing thread where possible;
- null where historical data cannot be recovered;
- no foreign key and no read-time join.

Write rules:

- `routes/jobs.ts` passes the resolved workflow record's name into `JobStore.create`.
- The root create stamps the name.
- Workflow-generated successor rows inherit it.
- User follow-up rows inherit it.
- The client cannot supply or override it.
- Workflow-less tasks keep null.
- Renaming/deleting the source workflow does not change existing jobs.

Read rules:

- Add `workflowName: string | null` to server job responses and the web `Job` type.
- Include it in thread reads and shared job mappers.
- Keep `workflowNode` unchanged and distinct.
- Do not add an old/new payload alias.

## Implementation map

### Workflow grammar

- `server/src/db/workflow-schema.ts`
  - extend `WorkflowParam`;
  - add named guidance limits;
  - validate/normalize the two keys;
  - leave `checkWorkflowParams` behavior unchanged.
- `server/src/db/workflow-templates.ts`
  - add guidance to `ISSUE_PARAM`.
- `server/src/routes/workflows.ts` / `server/src/db/workflow-store.ts`
  - return normalized fields through existing summaries.
- `web/src/api/useWorkflows.ts`
  - type the two response fields.

### Job audit data

- `server/migrations/033_job_workflow_name.sql`
- `server/src/db/job-store.ts`
  - create input, inserts, transition/follow-up propagation, selects, mapper.
- `server/src/routes/jobs.ts`
  - trusted resolved-name write and response serialization.
- `web/src/api/useJobs.ts`
  - `workflowName` response type.

### Documentation

- `docs/workflows.md`
  - grammar/limits, base example, frozen definition + display-name semantics.
- `docs/jobs.md`
  - task audit field and inheritance.
- `docs/api.md`
  - workflow response metadata and job `workflowName`.
- `docs/persistence.md`
  - only if the migration introduces a new persistence rule worth recording.

## Invariants

- Workflow resolution remains repo > user > org.
- No workflow is auto-selected.
- Definitions and launch parameters remain frozen at task creation.
- Follow-ups remain off-graph rows which continue the same task/session.
- Guidance never substitutes for server validation.
- The server never trusts a client-authored workflow name on a job.
- A deleted workflow may make the definition unavailable for future tasks but must not change
  existing task history.
- No driver or Docker/Kubernetes behavior changes.

## Tests

### Offline server/route

- guidance accepts and normalizes valid strings;
- blank, over-limit, and unknown keys are refused;
- pattern safety and definition-size gates remain green;
- workflow list/detail returns description/example;
- job creation passes the resolved name into the store;
- client-supplied workflow-name data has no authority;
- thread serialization exposes `workflowName`;
- workflow-less tasks expose null.

### Database

In `server/test-db/job-store.workflow.test.ts`:

- root create stamps the name;
- graph successor inherits it;
- user follow-up inherits it;
- workflow rename/delete does not alter the task;
- workflow-less thread remains null;
- snapshot and parameter freeze tests stay green.

## Acceptance criteria

- [ ] Workflow definitions accept bounded `description` and `example` metadata.
- [ ] The base `fix-issue` workflow serves the specified human guidance.
- [ ] Launch validation behavior is unchanged.
- [ ] A workflow-backed task stores and returns the selected workflow's creation-time name.
- [ ] Successors and follow-ups retain that name.
- [ ] Rename/delete of a workflow cannot rewrite task history.
- [ ] No job endpoint accepts a client-authored workflow name.
- [ ] Workflow-less and unrecoverable historical jobs remain honestly null.
- [ ] API, jobs, workflows, and migration documentation matches the implementation.
- [ ] Focused unit, route, and database tests pass.

## Verification

```bash
npx vitest run server/test/routes.workflows.test.ts server/test/routes.jobs.test.ts
npm run typecheck
npm run lint
docker compose up -d timescale
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test npm run test:db
```

## Out of scope

- Composer layout or validation presentation.
- Task conversation/outcome layout.
- Task action/menu/dialog changes.
- Structured PR state/publication storage.
- Any runner change.
