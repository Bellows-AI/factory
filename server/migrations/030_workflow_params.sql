-- Launch parameters, frozen beside the snapshot (issue #127).
--
-- A workflow may declare required parameters (definition.params — the grammar's top-level key,
-- validated by workflow-schema.ts, every declared param REQUIRED at launch). The values a member
-- submits travel on the POST /api/jobs body as `workflowParams` and are validated against the
-- resolved definition's declarations before anything queues — a parametrized workflow like
-- `fix-issue` must never launch on a prompt the model can only guess at.
--
-- ROOT ROW ONLY, BESIDE THE SNAPSHOT: the same freeze-at-create rule 027 states for the definition
-- itself. The root row carries the values the task was launched with; every later row's transition
-- (and the composer-less follow-up) reads them from the root, so editing a definition's params
-- mid-flight changes later tasks, never a running thread.
--
-- This file must contain NO `create extension` and NO `create_hypertable`, per 005's header.

alter table job add column if not exists workflow_params jsonb;
