## Purpose

Covers how a task names the workflow it will walk: the list the task composer offers, the
`workflow` field on job creation, and the default resolution when none is named — so selecting a
process is as ordinary as picking a repository or executor.

## ADDED Requirements

### Requirement: The workflow list is served to the task composer

`GET /api/workflows` SHALL list the workflows visible to the caller — the org's, the caller's
own, and the repository-scoped ones for the requested repository context — with name, scope and
id. The route SHALL be person-gated like the other task routes; a worker token SHALL NOT list
workflows.

#### Scenario: The composer can offer a dropdown

- **WHEN** the task composer loads for a member with one org-level, one own user-level and one
  repo-level workflow
- **THEN** the list answers all three with their scopes, and the composer renders them as the
  workflow choices beside repository and executor

#### Scenario: A worker token is refused

- **WHEN** the board's worker credential calls `GET /api/workflows`
- **THEN** the route refuses it — workflow selection is a person's decision, never a driver's

### Requirement: Job creation accepts a workflow name

`POST /api/jobs` SHALL accept an optional `workflow` field naming the workflow the task walks.
An unknown name SHALL be refused with a named error. When the field names a workflow the caller
may use but the definition snapshot at insert differs from a later edit, the task SHALL walk the
snapshot it was created with.

#### Scenario: A task is created with a named workflow

- **WHEN** a task is created naming the org-level `fix-issue` workflow
- **THEN** the created thread's root row carries that workflow's resolved definition snapshot,
  and the thread's first run is the graph's entry node

#### Scenario: An unknown workflow name is refused

- **WHEN** a task is created naming a workflow that does not exist in the caller's visible scopes
- **THEN** the create is refused with a named error and no job row is inserted

### Requirement: Default resolution prefers repo, then user, then org, then none

When a task names no workflow, the board SHALL resolve a default in the order: the repository's
default, the author's default, the organization's default, and none. `None` means the task runs
exactly as workflows never existed — the current hardcoded pipeline.

#### Scenario: No default anywhere

- **WHEN** a task names no workflow and no scope declares a default
- **THEN** the task runs the implicit pipeline — claim, run, gates, publish — identical to a
  board before this change
