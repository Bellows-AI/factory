# Proposal: workflow-templates — tasks as execution graphs of building blocks

## Why

Issue #94. The engineering process is a workflow hardcoded in prose: the `/fix` and `backend-fix`
skills carry the review loop x3, the gate follow-ups and their stop conditions inside the prompt,
so loop limits survive only as model discipline — nothing counts rounds, nothing enforces a
transition, and changing the process means editing prose baked into runner images. The
deterministic skeleton (checkout → fetch issue → implement → review x3 → gates → gate-fix x3 →
open PR) should be owned by the system, as a graph of building blocks, with each node holding only
its agentic content.

## What Changes

- **Workflow graph schema** (jsonb, strict validation): `agent` nodes with prompt templates and a
  session policy; edges with deterministic rules — verdict, output-tail marker match, gate-failure —
  and per-edge max traversal counts (the loop limits).
- **`workflow` storage with org/user/repo scoping** — the same resolution stack env vars use.
  Definitions are created via API; org-level creation requires admin.
- **Board-walked transitions**: at `complete`, in the verdict's transaction, the board decides the
  next node from the graph and inserts the next row — an automated follow-up. Loop counters derive
  from the audit trail (row counts per node per thread); no instance-state table. The driver
  contract (claim/run/complete) is unchanged.
- **Deterministic marker vocabulary**: agent blocks end with strict output contracts (e.g.
  `VERDICT: CLEAN | BLOCKERS`); the board matches the output tail it was handed at `complete`.
- **Session policy per node** (`resume | fresh`): fix nodes resume the thread's primary session;
  review nodes start fresh (fresh eyes). A thread becomes one worktree, N sessions. User follow-ups
  always resume the primary session.
- **Publish becomes a board-decided flag on the claim** — true only on the transition into the
  publish node. Today every succeeded gated run publishes, which would push mid-loop. This is the
  one driver change, landed for both executors (docker and kubernetes) in the same change.
- **Building blocks as board-owned prompt templates**, interpolated at row-insert time with prior
  node outputs (bounded tails): fetch-issue, execute (the `/fix` skeleton minus its loops), review,
  fix, gate-fix. Checkout/sync, gates and publish remain driver machinery the graph references by
  outcome — they are not nodes with containers.
- **Task UI**: a workflow dropdown beside repo/executor in the task composer, fed by
  `GET /api/workflows`; the task detail page labels each turn with its node. Definitions are JSON
  via API — no graph editor.
- **Snapshot at create**: the resolved definition is frozen onto the thread's root job, so editing
  a workflow mid-flight never moves a running instance's graph.
- **No-workflow tasks behave exactly as today** — the current hardcoded pipeline is the implicit
  default, and a workflow-less claim is byte-identical to the claim of today.

**BREAKING**: none for external callers — `POST /api/jobs` gains an optional `workflow` field, and
the claim payload gains an optional `publish` flag the driver reads. No existing payload shape is
removed.

## Capabilities

### New Capabilities

- `workflow-definitions`: the workflow graph schema (nodes, session policies, deterministic edges,
  loop limits), its strict validation, org/user/repo scoping and resolution order, and the
  snapshot-frozen-at-create rule.
- `workflow-execution`: board-walked transitions atomic with the verdict, the edge vocabulary
  (verdict / gate-failure / output marker), loop limits enforced from the audit trail, per-node
  session behavior, the publish flag, and the halt semantics for stop and user follow-ups.
- `workflow-selection`: how a task names its workflow — the composer dropdown, `GET /api/workflows`,
  the `workflow` field on `POST /api/jobs`, and the default resolution (explicit > repo > user >
  org > none).

### Modified Capabilities

<!-- openspec/specs/ holds executor-transcripts only; no existing capability's requirements change. -->

## Impact

- **Migration** `server/migrations/027_workflows.sql`: a `workflow` table (org-scoped, name,
  scope fields, `definition` jsonb, `created_by`) plus `job.workflow_id`, `job.workflow_node`, and
  the definition snapshot on the root row.
- **Server**: `server/src/db/workflow-store.ts` (new), `job-store.ts` (transition hook inside
  `complete`'s transaction; session copy at insert; `publish` on the claim read), 
  `server/src/routes/workflows.ts` (new) and the `workflow` field on `POST /api/jobs`.
- **Driver**: the publish step becomes conditional on the claim's `publish` flag, in both
  `docker.ts` and `k8s.ts` paths of `driver/src/` — the only driver change; executor images and
  container scripts are untouched.
- **Web**: workflow dropdown in the task composer, node labels on task-detail turns.
- **Docs**: new `docs/workflows.md`, a row in AGENTS.md's read-before-you-touch table, and a
  pointer from docs/jobs.md.
- **Tests**: server db suite (transition atomicity, loop limits, session policies, halt rules),
  route tests (workflow CRUD + validation, create with workflow), driver tests (publish flag
  honored both executors; absent flag = today byte-for-byte), web render smoke, and a
  `scripts/test-jobs.sh` extension walking a stub workflow end-to-end offline.
