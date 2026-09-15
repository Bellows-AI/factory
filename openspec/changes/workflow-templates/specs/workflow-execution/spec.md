## Purpose

Governs how a task walks its workflow graph: the board decides the next node in the same
transaction as the verdict, loop limits are counted from the audit trail, each node's session
policy decides what the claim resumes, publishing happens only where the graph says so, and a
human can stop or follow up a workflow task without stranding it.

## ADDED Requirements

### Requirement: The transition is decided atomically with the verdict

When a workflow task's run completes, the board SHALL evaluate the completed node's outgoing
edges and insert the next node's row — or rest the thread — in the same transaction that lands
the verdict. The driver contract SHALL NOT change: the worker claims one row, runs it, and
reports one verdict; the board, never the driver, walks the graph.

#### Scenario: A completed review node inserts the next row before any other claim can see it

- **WHEN** a review node's verdict lands and its matching edge leads to a fix node
- **THEN** the fix node's row exists (queued) in the same transaction as the verdict, and no
  read ever observes the thread with the verdict landed but no successor row

#### Scenario: A workflow task's claim is an ordinary claim

- **WHEN** a driver claims a row that belongs to a workflow thread
- **THEN** the claim response is the ordinary shape for the node's run — a command, a worktree
  path, a session when the node resumes one — with no graph, node list or executor-side walk
  instructions

### Requirement: Loop limits are enforced from the audit trail

Before inserting a bounded edge's target node, the board SHALL count the thread's existing rows
for that node and refuse to exceed the edge's bound. The count SHALL be derived from the rows
themselves; the board SHALL NOT keep a separate loop-counter state.

#### Scenario: The fourth review round never runs

- **WHEN** a review/fix loop bounded at three has already produced three review rows and the
  review edge matches a fourth time
- **THEN** no fourth row is inserted and the thread rests with its verdicts intact

#### Scenario: The count survives a crashed attempt

- **WHEN** one of the three review rows burned its attempts on lease expiry re-claims and died
- **THEN** the dead row still counts toward the bound — attempts are retries, rounds are rows,
  and the two counters never substitute for each other

### Requirement: Session policy decides what a claim resumes

A node with policy `resume` SHALL carry, from insert, the thread's primary session — the session
of the thread's first `resume`-policy run — and its claim SHALL resume it. A node with policy
`fresh` SHALL claim with no session and mint its own. A user follow-up on a workflow thread SHALL
always resume the primary session, whatever node was last.

#### Scenario: A review node starts with fresh eyes

- **WHEN** a review node with policy `fresh` is claimed after an implement run in the same thread
- **THEN** the claim carries no session id and the review run starts a new conversation in the
  same worktree

#### Scenario: A fix node continues the implementation conversation

- **WHEN** a fix node with policy `resume` is claimed after a review found blockers
- **THEN** the claim carries the thread's primary session id and the run resumes that session

### Requirement: Publishing happens only where the graph says so

The board SHALL decide, per node, whether the driver publishes after a succeeded gated run, and
SHALL carry that decision on the claim. A publish node's run SHALL publish; every other node's
run SHALL NOT — a mid-loop review success never pushes. A task with no workflow SHALL carry the
same effective decision as today: publish after the succeeded gated run.

#### Scenario: A review success does not push

- **WHEN** a review node's run completes successfully with green gates
- **THEN** the driver publishes nothing — the work stays on the task branch in the worktree

#### Scenario: A no-workflow task is byte-identical to today

- **WHEN** a task with no workflow is claimed and completes successfully
- **THEN** the claim, the run and the publish behave exactly as they do without this change

### Requirement: A stopped or unmatchable thread rests, and a human re-enters it

A `stopped` verdict SHALL fire no edge — the thread rests where the run ended. A completed node
whose no edge matches (an exhausted loop, a `dead` row, a verdict no rule names) SHALL also rest
the thread. A user follow-up on a resting workflow thread SHALL be an ordinary row of the same
thread, and when it completes, the completed node's position SHALL be treated as the halted
node's: its outgoing edges SHALL be evaluated, so the graph continues after the human's extra
work.

#### Scenario: Stop ends the turn and the graph

- **WHEN** a user stops a workflow task mid-loop
- **THEN** the row lands `stopped`, no successor row is inserted, and the follow-up composer is
  what the member sees

#### Scenario: A user follow-up re-enters the graph

- **WHEN** a user follows up a thread halted at the gate-fix node, and the follow-up's run
  completes successfully
- **THEN** the gate-fix node's outgoing edges are evaluated from that completion — the loop can
  continue without the user re-triggering it by hand

#### Scenario: An exhausted loop rests rather than dead-ends silently

- **WHEN** a review loop exhausts its bound with blockers still named
- **THEN** the thread rests at the last review with its verdict and output intact — visible,
  follow-up-able, and never marked succeeded
