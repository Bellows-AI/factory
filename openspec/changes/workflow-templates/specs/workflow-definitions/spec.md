## Purpose

Defines the workflow graph — the building blocks a task is made of, their deterministic
transitions and loop limits — together with how definitions are validated, scoped
(org/user/repo) and frozen onto a task at creation, so the process a task follows is system-owned
rather than prompt-enforced.

## ADDED Requirements

### Requirement: The workflow definition is a validated graph of agent nodes and deterministic edges

A workflow definition SHALL be a JSON object holding named `nodes` and `edges`. Every node SHALL
carry a kind (`agent`), a session policy (`resume` or `fresh`), and a prompt template. Every edge
SHALL carry a `from` node, a transition rule, and a `to` node, and MAY carry a maximum traversal
count. The parser SHALL refuse — with a named error — unknown keys, unknown node references, an
edge whose `from` names no node, a definition with no path to a publish node, and prompt templates
referencing an unknown prior node. The accepted grammar SHALL be strict: no node kind other than
`agent` exists, because checkout, gates and publish are driver machinery the graph references by
outcome, never nodes with containers.

#### Scenario: A well-formed definition is accepted

- **WHEN** a definition is created whose nodes all resolve, whose edges reference declared nodes,
  and whose transition rules use only the accepted vocabulary
- **THEN** the workflow is stored with an id and its definition is served back verbatim

#### Scenario: An unknown edge target is refused

- **WHEN** a definition declares an edge whose `to` names a node that does not exist
- **THEN** the create is refused with a named error identifying the edge, and nothing is stored

#### Scenario: Unknown keys are refused

- **WHEN** a definition carries a key the grammar does not declare
- **THEN** the create is refused with a named error naming the key — a pasted foreign pipeline
  fails loudly instead of silently doing nothing

### Requirement: Transition rules use a deterministic edge vocabulary

An edge's rule SHALL be one of: a terminal verdict (`succeeded` or `failed`), `gate-failed`
(derivable from the run's stored gate results, never parsed from prose), or an output-tail marker
match against a fixed string the node's block is required to emit. The marker match SHALL apply to
the output tail the board already holds at verdict time. No rule MAY depend on anything the board
does not store on its own rows.

#### Scenario: A marker edge matches the output tail

- **WHEN** a review node's run completes and its output tail carries the exact marker string one
  of its outgoing edges matches
- **THEN** that edge is the one whose transition is evaluated

#### Scenario: A gate failure is recognized without parsing prose

- **WHEN** a run completes with a stored gate result whose exit code is non-zero
- **THEN** the `gate-failed` rule matches on that fact alone, and an agent-exit failure and a
  gate failure remain distinguishable outcomes

### Requirement: Loop limits are declared per edge

An edge MAY declare a maximum traversal count. The traversal count SHALL be derived from the
audit trail — the number of rows the thread already holds for the target node — and never from a
separate instance-state store. A workflow whose loops all declare bounds is valid; an edge with
no bound MAY fire unboundedly only when the workflow author says so.

#### Scenario: A bounded edge stops at its limit

- **WHEN** a thread already holds three rows for the target node of an edge bounded at three, and
  the edge's rule matches again
- **THEN** the transition does not insert a fourth row, and the thread rests at the completed node

### Requirement: Definitions are scoped to org, user, or repository

A workflow SHALL belong to exactly one scope: the organization, a member, or a repository label.
Org-level creation SHALL require an admin; a member MAY create user-level and repo-level
definitions. Resolution for a task SHALL prefer repo over user over org. Names SHALL be unique
within a scope.

#### Scenario: A member cannot create an org-level workflow

- **WHEN** a non-admin member attempts to create a workflow scoped to the organization
- **THEN** the request is refused with `403` and nothing is stored

#### Scenario: Repo scope shadows org scope

- **WHEN** a repo-level and an org-level workflow share the default slot for a repository and a
  task is created against that repository without naming a workflow
- **THEN** the repo-level one is resolved

### Requirement: The resolved definition is snapshotted onto the task at creation

When a task is created with a workflow, the resolved definition SHALL be frozen onto the thread's
root job. Editing or deleting the workflow afterwards SHALL NOT change the graph a running thread
walks — later tasks get the new definition, the running thread keeps the old one.

#### Scenario: Editing a workflow does not move a running task

- **WHEN** a thread created under definition v1 is mid-loop and an admin edits the workflow's
  review limit from three to five
- **THEN** the running thread continues to enforce three, and only tasks created after the edit
  walk the five-round graph
