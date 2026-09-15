## Purpose

Builds on #102's landed attribution — sessions already resolve to a member through the read-side
job join, with unattributed sessions an explicit figure — by attributing sessions to their task
thread and by letting every figure on the page be scoped to the signed-in caller instead of the
whole organization.

## ADDED Requirements

### Requirement: Sessions are attributed to their task thread at read time

Every telemetry session the stats payload reports SHALL carry, where derivable, the task thread it
belongs to, resolved through the same board rows that already resolve its member: a session id
carried by any job row resolves to that job's thread root. Follow-up rows attributing the same
session resolve to the same task, and a session resolvable through no job row SHALL carry no task,
exactly as it carries no member — the landed unattributed contract, extended, not changed.

#### Scenario: Executor session attributed through the job row
- **WHEN** a headless executor run reported session id S, and the board holds a job row with
  `session_id = S` in thread T
- **THEN** session S is reported as attributed to task T, beside the member the landed join
  already resolves

#### Scenario: Follow-up chain attributes consistently
- **WHEN** session S was resumed by a follow-up job (a second job row carrying the same
  `session_id = S` in the same thread)
- **THEN** both rows resolve to the one thread root, and the session is counted once under that
  task

#### Scenario: Removed thread
- **WHEN** a task thread was removed, deleting its job rows
- **THEN** its sessions carry neither member nor task, the unattributed count includes them, and
  their tokens still count in organization totals

### Requirement: Usage figures can be scoped to the signed-in caller

The stats endpoint SHALL accept a scope selection: organization (the default) or the signed-in
caller. Caller-scoped figures SHALL be computed over only the sessions the landed join attributes
to that caller, by filtering at read time over the same fetched input the organization scope
reads — a scope switch MUST NOT require a second fetch of the underlying data. The scope is a
filter over every figure, not an additional per-user breakdown. The response SHALL name the scope
its figures were computed under and the member it resolved to.

#### Scenario: Caller scope
- **WHEN** a signed-in member requests caller-scoped figures
- **THEN** every figure covers only that member's attributed sessions, and the response names the
  caller scope and the member it resolved to

#### Scenario: Caller scope without a signed-in member
- **WHEN** the stats endpoint is asked for caller scope on a request with no signed-in member (open
  auth mode, or a worker token)
- **THEN** the endpoint rejects the request with a client error naming the reason, rather than
  silently serving organization figures under a caller heading

#### Scenario: Coverage is not narrowed by scope
- **WHEN** figures are scoped to a caller
- **THEN** the reported telemetry coverage window still describes what the store holds, not what the
  scope selected
