## Context

A task is a `job` row; a thread is its follow-up chain (`parent_job_id`, `root_job_id`), one
worktree per root, one session per thread today — the claim resumes the session only when the row
carries `parent_job_id`. The pipeline between "run finishes" and "PR exists" is hardcoded in the
driver loop: gates run between agent finish and verdict, and every succeeded gated run publishes.
The board is deliberately dumb ("hands jobs out and records results, never spawns anything") but
it already makes one thread-level decision in the verdict's transaction — `threadDone`
(job-store.ts, `complete`) — and it already inserts the next row of a thread by hand
(`createFollowUp`, with the author guard and the atomic insert-select). The row carries `gates`
jsonb, replaced at each gate report, so a gate failure is machine-readable on the board without
parsing the output. Env vars already implement an org < workspace < repo resolution stack
(env-var-store). Commands are capped at 16 KiB; output tails are bounded. See proposal.md — Why
for the motivation.

## Goals / Non-Goals

**Goals:**

- The deterministic skeleton of the engineering process (the `/fix` shape: implement → review x3
  → gates → gate-fix x3 → publish) owned by the board, walked deterministically, with loop limits
  the system enforces.
- Each node holds only its agentic content — a prompt template — so changing the process means
  editing a definition, never an image.
- Driver contract unchanged except one boolean; docker and kubernetes land it in the same change
  (executor parity, AGENTS.md).
- Graph position and loop counters derived from the audit trail; no second source of thread truth.

**Non-Goals:**

- Event-triggered nodes (GitHub webhook → "address reviews" node) — the fetch-review-comments
  block ships as a template only; the trigger is the next change.
- Parallel node execution — a thread's worktree has one writer by design; the graph is a state
  machine, not a dataflow.
- Gates as standalone graph nodes — they stay per-run driver machinery; "gate-failed" is edge
  vocabulary.
- A graph editor; Jira blocks beyond the existing jira skill; workflow-scoped env var changes.

## Decisions

### 1. The board walks the graph, in `complete`'s transaction

The transition engine lives in the server: `complete` lands the verdict, then — in the same
`sql.begin` block that already computes `threadDone` — evaluates the completed node's outgoing
edges against the edge vocabulary, and either inserts the next row (an automated follow-up,
subject to the same thread-exclusion guarantees the hand-made follow-up already has) or rests the
thread. The driver keeps claiming one row and reporting one verdict.

Alternatives: **driver-walked** (the claim returns the remaining graph) was rejected because one
lease would span hours of multi-node work, crash recovery becomes "which node was I on", and the
docker/kubernetes parity surface doubles for no benefit; **agent-walked** (compile the graph into
one prompt) is what `/fix` already is — the loop limits would remain model discipline, which is
exactly the defect #94 names.

### 2. Graph state is derived from the audit trail

Current node = the `workflow_node` of the thread's newest row. Loop count = `count(*)` of the
thread's rows for a node, read in the transition transaction (the same walk `threadDone` already
does, one more aggregate in the same query). No `workflow_instance` table: a second store of
thread state would drift from the rows, and the rows are already the audit record. `attempts`
(counts claims of one row — crash retries) and round counts (count rows) are different counters
and never substitute for each other; a dead review row still counts as a round.

Alternative considered: a mutable instance row holding position and counters — rejected as a
denormalisation of what the rows already say (the "attribution is a read-time join" precedent).

### 3. Node-level session policy: `resume` copies the primary session at insert

A `resume` node's row is created, at insert, carrying the thread's **primary session id** — the
session of the thread's first `resume`-policy run (which is the entry node's, copied forward row
by row, exactly how a follow-up copies its parent's session today). A `fresh` node's row carries
no session and mints its own at claim, becoming a side branch of the thread. The claim's
resume rule generalizes from "carries `parent_job_id`" to "carries a session" — the mechanics are
unchanged, only the board-side decision of which rows carry one. A user follow-up keeps resuming
the primary session: it copies the primary-session row, not the last row, whatever node was last.

Consequence, accepted: a thread holds N sessions and the task view's session link shows the row's
own. The transcript store (`.factory/transcripts/<rootJobId>/`) already keys on the root, so both
sessions' transcripts survive beside each other with no change.

### 4. The edge vocabulary is verdict, gate-failure, and output-tail markers

An edge rule matches on one of: `succeeded` / `failed` (the verdict), `gate-failed` (a stored
gate result with a non-zero exit — read off the row's `gates` jsonb the driver already maintains),
or an exact string match against the output tail (e.g. `VERDICT: BLOCKERS`). The board evaluates
rules in the definition's declared order and takes the first match. Blocks that need a semantic
distinction (review clean vs blockers) emit a strict final line — the same contract
`pr-summary.cjs` already relies on; "skills with deterministic scripting" is precisely this:
agentic content bounded by a machine-readable output contract.

Marker absence is a first-class outcome: if no rule matches a `succeeded` run, the thread rests
(never silently continues, never fails) — the same "named, visible, follow-up-able" rule an
exhausted loop follows.

### 5. Publish becomes a claim-carried flag, computed from the graph

Today the driver publishes after every succeeded gated run — which would push a mid-loop review
to the remote. The board computes, per node, whether a publish may follow, and the claim carries
`publish: true|false`; the driver's publish step becomes conditional. Workflow-less tasks resolve
the flag exactly as today (true), so their claims and runs stay byte-identical. Both executors
read the same flag from the same claim object — the kubernetes twin lands in the same change.

### 6. Gates stay per-run, with a per-node opt-out

Gates run between agent finish and verdict as they always have; the graph never starts a gate
container. A node MAY declare `gates: false` (a fresh-eyes review need not pay suite minutes —
and must not fail the thread on a gate a review did not touch). Default is on, matching today.
The `gate-failed` edge rule therefore names the run's own gate outcome whatever node it was.

### 7. The definition is snapshotted onto the root at create

At `POST /api/jobs`, the board resolves the workflow (explicit name > repo default > user default
> org default), validates it, and stores the resolved definition jsonb on the thread's root row
beside `workflow_id`. Follow-up rows reference the root; every transition decision reads the
snapshot. Editing a definition mid-flight changes later tasks, never a running thread. A
definition is bounded in size (the same body-limit discipline as commands), so the snapshot is a
column, not a table.

### 8. Stop and user follow-ups re-enter the graph at the halted node

`stopped` fires no edge (a human ended the turn; the follow-up composer is next). A user
follow-up on a workflow thread is an ordinary row — it carries no node and copies the primary
session — and when IT completes, the board evaluates the halted node's outgoing edges from that
completion: the human's extra work sits at the node, then the graph continues. The alternative —
follow-ups never advance the graph — was rejected: it strands a stopped loop behind a manual
re-trigger for every round, which is the human-toil #94 exists to remove.

### 9. Blocks are board-owned prompt templates, interpolated at insert

A node's prompt template carries `{{nodeName.output}}`, `{{gate.name}}`, `{{gate.output}}`
placeholders the board fills at row-insert time from prior rows' stored output tails (bounded —
the 16 KiB command cap still governs) and from the verdict's own data. The runner images ship no
workflow knowledge: the baked `AGENTS.md`/skills remain, but the process lives on the board, so a
definition change needs no image rebuild and reaches opencode and claude-code runners alike.

## Risks / Trade-offs

- [The board grows a brain — transition logic is server code with server tests, and a bug could
  insert wrong rows] → The engine is a pure function (thread rows + snapshot + verdict → next
  node or rest) beside the store, unit-tested exhaustively; insert is subject to the same
  thread-exclusion the follow-up path already enforces; a thread that rests is always visible and
  hand-continuable, so the failure mode is stopping, not misbehaving.
- [Marker contracts are prompt-engineered and a model may omit the marker] → Absence rests the
  thread loudly with the output intact (Decision 4); it never advances on a guess. The templates
  instruct the marker; the docs state the contract.
- [Threads run longer — 7+ rows per task is normal for the base workflow] → Every row is an
  ordinary claim through the existing lease/fence machinery; `max_attempts` governs rows
  individually; the task view already renders the chain. Wall-clock banking is per-row and already
  sums the thread.
- [Output tails interpolated into commands could exceed 16 KiB] → Interpolation bounds each
  substituted tail to a fixed share of the cap and hard-truncates with a marker; the insert
  refuses a command that still exceeds the cap (named error), resting the thread.
- [Snapshot drift vs the live definition confuses "which version ran?"] → The root row carries
  both `workflow_id` and the snapshot; the task view can always show the exact graph walked.

## Migration Plan

One migration (`027_workflows.sql`): the `workflow` table plus nullable job columns
(`workflow_id`, `workflow_node`, definition snapshot on the root). All nullable → existing rows
and in-flight tasks are untouched and behave as today. Deploy order is the ordinary single-binary
order (migration runs at boot; driver ships the flag read in the same release — a driver older
than the board ignores the flag's absence, a board older than the driver never sends it). No
backfill; no rollback beyond the migration's own down (drop the new objects).

## Open Questions

None deferred. The one deliberate simplification to revisit if a real workflow needs it: edge
rules evaluate in declared order, first match wins — no precedence algebra.
