---
title: Run and review tasks
description: Create, monitor, continue, stop, and close Factory task threads.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/guides/run-tasks.md
---

## Before launching

1. Select an organization and add the target repository under **Settings → Repositories**.
2. Create at least one executor profile under **Settings → Executors**, and confirm that runners
   have valid credentials for that executor. The profile flagged as default is preselected on new tasks; without a flag, the
   first profile is.
3. Configure any required [runner variables or secrets](/factory/guides/runner-environment/).
4. If the repository declares gates, review `.bellows.yaml` before starting expensive work.

## Create a task

Open **New task**, choose the repository and executor profile, then enter the instruction. If a
workflow is selected, complete every declared launch parameter.

A task without a named workflow runs Factory's default workflow. Its first node sends your
instruction to the agent, then runs gates and publishes. Your saved default-workflow settings
decide which optional blocks follow. When you have never saved them, both are on: pull request
review reconciliation (up to three rounds) and merge-conflict repair. A task can therefore keep
working after its first publish.

Every run also receives a Factory-rendered master prompt as a system prompt. It tells the agent
what Factory does around the run, such as gates, publishing, and any workflow blocks. The task's
prompt is the workflow's entry prompt with your instruction substituted in.

The task view shows the current run, live output tail, runtime activity, gates, author, session,
and thread history. A queued task begins when a driver claims it.

## Continue work

Use **Follow up** once the current run reaches a terminal state. A follow-up is refused unless:

- you are the task's author, because the session resumes in the author's workspace;
- the run reported an agent session (otherwise the board answers `409 NO_SESSION`);
- the thread has not been marked done.

A follow-up reuses the task worktree and resumes the thread's primary session. In a workflow
thread that is the first run that used the `resume` session policy, not necessarily the newest
run. Workflow nodes that ask for a fresh session, such as an independent review, get their own
session and do not change which one a follow-up continues.

## Stop, finish, or remove

- **Stop** settles a queued run immediately, and also a running run whose lease has already
  expired. For a running run with a live lease it records a cancellation request that the driver
  delivers through its heartbeat, then the run lands `stopped`. A run that has already ended cannot
  be stopped.
- **Done** is the human decision that the thread needs no more follow-up work. It can trigger
  worktree reclaim after the thread is terminal.
- **Remove** deletes the whole thread and queues its worktree for reclaim. It is refused while any
  run in the thread is `running`; stop the run first.

Failed and stopped runs retain their worktree and session so a follow-up can continue from the
evidence left behind. Do not treat an executor exit as the same thing as the human decision that a
task is done.
