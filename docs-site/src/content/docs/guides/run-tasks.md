---
title: Run and review tasks
description: Create, monitor, continue, stop, and close Factory task threads.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/guides/run-tasks.md
---

## Before launching

1. Select an organization and add the target repository under Workspace settings.
2. Confirm that the checkout exists and the selected executor has valid credentials.
3. Configure any required [runner variables or secrets](./runner-environment.md).
4. If the repository declares gates, review `.bellows.yaml` before starting expensive work.

## Create a task

Open **Tasks → New**, choose the repository and executor, then enter the instruction. If a workflow is
selected, complete every declared launch parameter; otherwise the instruction is the entire agent
command.

The task view shows the current run, live output tail, runtime activity, gates, author, session, and
thread history. A queued task begins when a driver claims it.

## Continue work

Use **Follow up** only after the current run reaches a terminal state. A normal follow-up resumes the
parent agent session and reuses the task worktree. Workflow transitions may instead start a fresh
session when the node definition asks for independent review.

## Stop, finish, or remove

- **Stop** settles queued or parked work immediately. For a live lease it records a cancellation request
  that the driver delivers to the executor.
- **Done** is the human decision that the thread needs no more follow-up work. It can trigger worktree
  reclaim after the thread is terminal.
- **Remove** deletes the thread only when no run is active and queues its worktree for reclaim.

Failed and stopped runs retain their worktree and session so a follow-up can continue from the evidence
left behind. Do not treat an executor exit as the same thing as the human decision that a task is done.
