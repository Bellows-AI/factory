# Workflows

**Read this before touching** `server/src/db/workflow-schema.ts`, `workflow-engine.ts`,
`workflow-store.ts`, the workflow paths in `job-store.ts`, `server/src/routes/workflows.ts`, the
`workflow` field on `POST /api/jobs`, the driver's publish gate, or `027_workflows.sql`. Each
decision below looks like it could be simplified; most are guarded by a test that fails obscurely.

A workflow is the process a task walks, owned by the board instead of baked into runner prompts
(issue #94). A definition is a graph of `agent` nodes — each holding only its prompt template and
its session policy — joined by deterministic edges with optional loop bounds. The board walks the
graph: the driver claims one row, runs it, reports one verdict; the board, never the driver,
decides the next row. Checkout/sync, gates and publish stay driver machinery the graph references
by OUTCOME — they are never nodes with containers.

## The definition grammar

```jsonc
{
  "entry": "fetch-issue",                      // optional; defaults to the first declared node
  "nodes": [
    {
      "name": "review",                        // /^[a-z0-9][a-z0-9-]{0,63}$/, unique in the graph
      "kind": "agent",                         // the only kind; see below
      "session": "fresh",                      // "resume" | "fresh"
      "gates": false,                          // optional; default true — run the driver's gates
      "publish": true,                         // optional; default false — see "Publishing" below
      "prompt": "…{{fetch-issue.output}}…"     // the interpolated template; see below
    }
  ],
  "edges": [
    {
      "from": "review", "to": "fix",
      "when": { "marker": "VERDICT: BLOCKERS" }, // or "succeeded" | "failed" | "gate-failed"
      "max": 3                                  // optional loop bound; see "Loops" below
    }
  ]
}
```

The grammar is closed and the validator (`workflow-schema.ts`) refuses with NAMED errors:

- unknown keys anywhere — a pasted foreign pipeline fails loudly (`UNKNOWN_KEY`), never silently;
- unknown node references in edges or `entry`, and unknown nodes in `{{node.output}}` placeholders
  (`UNKNOWN_NODE`, `UNKNOWN_PLACEHOLDER`);
- any node kind other than `agent` — checkout, gates and publish are driver machinery, and a node
  with a container is exactly what a workflow must not grow (`BAD_NODE`);
- a definition with no `publish: true` node, or with none reachable from the entry — a graph with
  no exit dooms every thread to rest mid-flight (`NO_PUBLISH_PATH`);
- a definition over 16 KiB (`TOO_LARGE`) — the same body-limit discipline as commands.

## The edge vocabulary

An edge rule matches one of, and nothing else — no rule may depend on anything the board does not
store on its own rows:

- `"succeeded"` / `"failed"` — the verdict the worker reported.
- `"gate-failed"` — derived from the row's stored `gates` jsonb: any gate report with
  `status: "failed"`. Read off the report the driver already maintains, never parsed from prose;
  an agent-exit failure (a `failed` verdict with green gates) and a gate failure stay
  distinguishable outcomes.
- `{"marker": "…"}` — an exact match against the output tail: the final non-empty line of the
  stored output must EQUAL the marker, trimmed. Blocks that need a semantic distinction emit a
  strict final line (`VERDICT: CLEAN` / `VERDICT: BLOCKERS` — the same contract
  `driver/src/scripts/pr-summary.cjs` already relies on).

Rules evaluate in the definition's declared order, first match wins — the one deliberate
simplification; no precedence algebra. A bound-exhausted edge RESTS the thread; it does not fall
through to a later edge, because a loop that hit its limit is a stop the author declared.

**Marker absence is a first-class outcome**: a completed node whose no rule matches rests the
thread loudly, output intact — visible, follow-up-able, never silently continued, never failed.

## Loops: counted from the audit trail

A bound `max` on an edge into node X means: the thread must not already hold `max` rows for X
when the rule matches. The count is `count(*)` over the thread's rows for that node — ALL of
them, dead rows included. Attempts are retries of one row; rounds are rows; the two counters
never substitute for each other. There is no loop-counter store: a second source of thread truth
would drift from the rows, and the rows are already the audit record.

To declare "review x3", give EVERY edge into `review` the same `max: 3` — the bound lives on the
matching edge, and the count is rows for the target, so the shared bound is the loop limit.

## Session policy

- `resume` — the row carries, FROM INSERT, the thread's PRIMARY session: the session of the
  thread's first `resume`-policy run (read off the root's snapshot). Its claim resumes it. A
  resume node with no session yet to copy (an exotic `fresh` entry, say) inserts with none, mints
  its own at claim, and that session then IS the primary.
- `fresh` — the row inserts with no session, claims with none, and mints its own: fresh eyes, one
  worktree, N sessions per thread. The task view shows each turn's own session.

A user follow-up always resumes the primary session, whatever node ran last — the follow-up CTE
reads the primary off the snapshot instead of the newest row's (a fresh-eyes review is a side
branch, and a follow-up continues the thread, not the branch). Pre-workflow threads (no snapshot
on the root) chain the NEWEST session exactly as they always did — the old behavior is pinned by
the db suite and must not change.

## Transitions: the board walks, in the verdict's transaction

`complete()` lands the verdict and — in the same `sql.begin` block, under the same per-root
advisory lock the claim takes — evaluates the completed node's outgoing edges against the run's
verdict, stored gates and output tail, then either inserts the next row (an ordinary queued job:
the driver claims it through the existing lease/fence machinery, `max_attempts` governing it
individually) or rests the thread. No read ever observes a thread with the verdict landed but no
successor row inserted; the threadDone aggregate runs AFTER the insert decision, so a moving
thread correctly answers not-done.

The engine (`workflow-engine.ts`) is a pure function — thread rows + snapshot + completed run →
insert-or-rest — unit-tested exhaustively beside the store; the SQL around it only reads rows and
inserts what the engine says. The failure mode of a bug is a thread that stops, never one that
misbehaves; a rested thread is visible and hand-continuable.

The current node is the completed row's own `workflow_node`. For an off-graph row (a user
follow-up), it is the halted node — the thread's newest carried node — so the human's extra work
sits at the node and the graph continues from it.

## Halt semantics: stop, dead, and the human's way back in

- A `stopped` row fires no edge: a human ended the turn; the follow-up composer is next. The
  board's transition runs only out of `complete()`, which a stop never reaches.
- A `dead` row (attempts burned) fires no edge — but it still COUNTS toward loop bounds, being a
  row.
- A user follow-up is an ordinary row of the same thread with NO `workflow_node`; when IT
  completes, the halted node's outgoing edges are evaluated from that completion, so the loop
  continues without the user re-triggering it by hand. Without this, a stopped loop would sit
  behind a manual re-trigger for every round — the human toil #94 exists to remove.

## Publishing

The board decides, per node, whether the driver may publish after the run's succeeded gated run,
and rides the decision on the CLAIM: `publish: true` only out of a `publish: true` node, `false`
on every other workflow node. ABSENT on a workflow-less claim — the driver reads absence as
"publish", which is what keeps a no-workflow task's claim byte-identical to before 027. The gate
lives in ONE place — the loop in `driver/src/loop.ts`, shared by both executors; the docker and
kubernetes transports grew no gate of their own (pinned by their suites), because a decision in
two places drifts.

A node may also declare `gates: false` — a fresh-eyes review need not pay suite minutes, and must
not fail the thread on a gate it did not touch. The claim then carries neither gates nor a gate
error. Default is on, matching today.

## Scoping, defaults, and the snapshot

A workflow belongs to exactly one scope — the org, a member, or a repository label — the same
stack the env vars use. Org-level creation is admin-gated; a member may create user-level and
repo-level definitions. Names are unique per scope (a coalesced unique index, the
`env_var_key_uk` precedent); each scope may declare ONE default (a partial unique index).

Resolution for a task, in `POST /api/jobs`:

1. an explicit `workflow` name, within the caller's visible scopes — repo over user over org when
   the name exists in several;
2. unnamed: the repo default, then the user default, then the org default;
3. none anywhere: the task runs exactly as workflows never existed.

The resolved definition is SNAPSHOT-FROZEN onto the thread's root row at creation, beside
`workflow_id`. Follow-up rows reference the root; every transition decision reads the snapshot.
Editing or deleting a workflow mid-flight changes later tasks, never a running thread — the task
view can always show the exact graph walked. `job.workflow_id` carries no foreign key on purpose:
job is an audit record, and deleting a definition must not touch the threads that walked it.

## The blocks and the base workflow

`server/src/db/workflow-templates.ts` holds the board-owned prompt templates and the seeded
`fix-issue` workflow — the `/fix` skeleton as a graph: fetch-issue → implement → review (x3) →
gate-fix (x3) → publish. Each block carries only its agentic content plus the output contract an
edge needs; the loop limits live on the edges, enforced by the board, no longer model discipline.
The board seeds it at boot (idempotent by name, org-level, the org default); seeding populates,
never overwrites.

Templates interpolate at row-insert time, bounded: `{{nodeName.output}}` — that node's most
recent stored output tail, hard-truncated to its 4 KiB share with a visible `[…truncated by the
board]` marker — and `{{gate.name}}` / `{{gate.output}}` — the completed run's first failed gate.
An interpolated command over the 16 KiB command cap refuses the insert (`command_too_large`) and
rests the thread. The vocabulary is closed: anything else in `{{...}}` is refused at create.

## Where things live

| Thing | Place |
| --- | --- |
| Grammar, validator, interpolation | `server/src/db/workflow-schema.ts` |
| The transition engine (pure) | `server/src/db/workflow-engine.ts` |
| The store: CRUD, scope visibility, defaults, seed | `server/src/db/workflow-store.ts` |
| Templates and the base `fix-issue` workflow | `server/src/db/workflow-templates.ts` |
| Columns (027) and the freeze-at-create snapshot | `server/migrations/027_workflows.sql` |
| The transition in the verdict's transaction | `job-store.ts` `complete()` |
| The primary-session follow-up copy | `job-store.ts` `createFollowUp()` |
| The claim's `publish` flag and the gates opt-out | `job-store.ts` `claim()` |
| The driver's one publish gate | `driver/src/loop.ts` |
| CRUD routes and `POST /api/jobs` resolution | `server/src/routes/workflows.ts`, `routes/jobs.ts` |
| The composer dropdown | `web/src/panels/TaskComposer.tsx`, `web/src/api/useWorkflows.ts` |

## Tests

- Offline units: `server/test/workflow-engine.test.ts` — the edge vocabulary, first-match order,
  loop bounds, dead-row counting, halt rules, bounded interpolation, the seeded definition.
- HTTP contracts: `server/test/routes.workflows.test.ts`, the workflow-resolution block of
  `routes.jobs.test.ts`.
- Against a real database (`npm run test:db`): `server/test-db/workflow-store.test.ts` and
  `job-store.workflow.test.ts` — atomicity, the walks, session copies, publish flags, bounds.
- Driver: the publish-flag twins in `driver/test/loop.test.ts`, and the transport parity pins in
  `docker.test.ts` / `k8s.test.ts`.
- End to end: the `# workflows` phase of `scripts/test-jobs.sh` walks a stub workflow on a real
  board and driver.
