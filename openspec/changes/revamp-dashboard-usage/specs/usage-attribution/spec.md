## Purpose

Attributes agent sessions to a member and a task at read time, so usage figures can be scoped to
the whole organization or to the signed-in caller. Bridges existing history through the job board's
own records and defers to ingest-time attribution (issue #67) where it exists.

## ADDED Requirements

### Requirement: Sessions are attributed to a member and a task at read time

Every telemetry session the stats payload reports SHALL carry, where derivable, the member who
triggered it and the task thread it belongs to. Attribution SHALL be resolved from two sources,
with a defined precedence:

1. Ingest-time attribution stored on the session's branch record (issue #67), when present.
2. Otherwise, the job board's own rows: a session id carried by any job row resolves to that job's
author and to the thread root the row belongs to, so follow-up rows attributing the same session
resolve to the same member and task.

A session resolvable through neither source SHALL be reported with no attribution rather than a
synthetic owner.

#### Scenario: Executor session attributed through the job row
- **WHEN** a headless executor run reported session id S, and the job board holds a job row with
  `session_id = S` created by member M in thread T
- **THEN** session S is reported as attributed to member M and task T

#### Scenario: Follow-up chain attributes consistently
- **WHEN** session S was resumed by a follow-up job (a second job row carrying the same `session_id = S`
  in the same thread)
- **THEN** both resolutions agree: session S is attributed to the original author and the one thread
  root, and the session is counted once

#### Scenario: Ingest-time attribution wins when both sources exist
- **WHEN** a session has ingest-time attribution (issue #67) on its branch record and would also
  resolve through a job row
- **THEN** the ingest-time attribution is used

#### Scenario: Removed thread
- **WHEN** a task thread was removed, deleting its job rows, and its sessions carry no ingest-time
  attribution
- **THEN** those sessions are reported with no attribution, and their tokens still count in
  organization totals

### Requirement: Unattributed sessions are an explicit figure, never a silent owner

Sessions with no attribution SHALL be included in organization-scoped figures and excluded from
caller-scoped figures. The payload SHALL report the count of unattributed sessions in scope so a
reader can distinguish "little attributed usage" from "attribution is missing".

#### Scenario: Hook-only laptop session
- **WHEN** a member's local session reported telemetry and a repo but no session identity attributes
  exist and no job row carries its session id
- **THEN** the session's usage counts in the organization scope, and the unattributed count includes it

#### Scenario: Caller scope excludes unattributed sessions
- **WHEN** figures are scoped to the signed-in caller
- **THEN** unattributed sessions contribute to no figure and no per-task statistic in that scope

### Requirement: Usage figures can be scoped to the signed-in caller

The stats endpoint SHALL accept a scope selection: organization (the default) or the signed-in
caller. Caller-scoped figures SHALL be computed over only the sessions attributed to that caller,
by filtering at read time over the same fetched input the organization scope reads — a scope switch
MUST NOT require a second fetch of the underlying data. The response SHALL name the scope its
figures were computed under.

#### Scenario: Caller scope
- **WHEN** a signed-in member requests caller-scoped figures
- **THEN** every figure covers only sessions attributed to that member, and the response names the
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
