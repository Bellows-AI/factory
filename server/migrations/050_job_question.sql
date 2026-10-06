-- Questions the agent asks during a run (issue #531, part of #226): one row per AskUserQuestion
-- tool call of one attempt, reported by the driver, answered by a member, and handed back to the
-- driver through the heartbeat.
--
-- `lease_token` pins the row to the attempt that asked: an answer lands only while that attempt
-- still holds the job (`job.lease_token = job_question.lease_token`), so a reclaim, a stop or the
-- run ending closes the question without writing to this table — `closed` is computed at read
-- time and never stored, hence the state check allows only the three stored states.
--
-- `questions` and `answers` are member content. They are never logged, never telemetry.
--
-- Retention is the job row's lifetime: `on delete cascade` from job, the `job_artifact` rule.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists job_question (
    org_id text not null,
    job_id uuid not null,
    question_id text not null,
    attempt integer not null,
    lease_token uuid not null,
    questions jsonb not null,
    state text not null default 'pending' check (state in ('pending', 'answered', 'expired')),
    answers jsonb,
    answered_by uuid references app_user (id) on delete set null,
    asked_at timestamptz not null default now(),
    answered_at timestamptz,
    primary key (org_id, job_id, question_id),
    foreign key (org_id, job_id) references job (org_id, id) on delete cascade
);
