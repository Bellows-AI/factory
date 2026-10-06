---
name: task-control
description: Drive a Factory task through its whole lifecycle from a local session — discover repos, executors and workflows, start a task, wait for it to settle, follow up, stop it, mark it done, remove it. Use when the user says "start a task", "run this on the board", "queue it on Factory", "wait for the task", "follow up on task X", "stop task X", "mark it done", or "remove the task". The read-only investigate-task skill stays the analysis half; this one is the half that writes.
---

# Drive a task from a local session

A task is a thread of runs on a board. This skill is the write half of the lifecycle; when the
question is "what went wrong", stop here and use `investigate-task` instead.

Two surfaces, same board. The CLI (`cli/`, issue #21) covers every verb below and is invoked as
`npm run dev -w cli -- job <verb> …` from the repo root — ONE npm layer, because a second one
swallows `--timeout`, `--json` and `--yes` as its own configuration before the CLI sees them.
There is no `factory` on PATH either. Plain `curl` is the fallback anywhere else.

The CLI's exit codes: `0` ok, `1` the board refused or was unreachable, `2` usage, `3` the wait
ended with no terminal row — `3` is not a failure, it means the task is still going.

## 1. Configure

```bash
export FACTORY_URL=http://127.0.0.1:8080        # the board's base URL — no default, ever
export FACTORY_TOKEN=fat_...                    # a personal access token from the settings page
```

`FACTORY_URL` is required. `FACTORY_TOKEN` is a personal access token, sent as
`Authorization: Bearer <token>`; it acts as its user, so the task the board records has a real
author. Against an open board (`AUTH_MODE=none`) leave it unset — the header is then omitted
rather than sent empty. An `oat_` organization token authenticates only the stats, repo and job
READS — the executor and workflow discovery below, and every write, answer `403`. Never offer or
accept the driver's worker credential for this: it is the fleet's secret, not a person's.

The `investigate-task` skill reads its own board from `FACTORY_BOARD`; this one uses the CLI's
`FACTORY_URL`. Running the pair against one board means setting both.

Ask the user for the board URL rather than guessing one — a guessed host queues real work
somewhere nobody asked for.

## 2. Discover before you create

An executor name the workspace does not define fails the task **at claim**, not at create — the
create answers `201` and the task dies minutes later with nothing useful in it. So read the three
lists first and pick from them:

```bash
curl -s -H "authorization: Bearer $FACTORY_TOKEN" "$FACTORY_URL/api/repos"                 # GET /api/repos
curl -s -H "authorization: Bearer $FACTORY_TOKEN" "$FACTORY_URL/api/workspace/executors"   # GET /api/workspace/executors
curl -s -H "authorization: Bearer $FACTORY_TOKEN" "$FACTORY_URL/api/workflows?repo=owner/name"  # GET /api/workflows
```

- `GET /api/repos` → `{ repos: [{ owner, name, ... }] }` — the installation's repos. `repo` on a
  create is `owner/name`; the create validates its SHAPE only, so a repo that is not on this list
  is another failure that lands at claim rather than at create.
- `GET /api/workspace/executors` → `{ executors: [{ name, type, isDefault, ... }] }`. Pass a
  `name` from this list, or omit `executor` entirely and let the default stand. `409` means the
  workspace feature is off on that board and `503` that its store is unreachable — omit
  `executor` either way; `401` means no credential arrived at all.
- `GET /api/workflows?repo=owner/name` → `{ workflows }`. A create names a workflow by its
  **name**, not by an id, and parameters ride beside it as `workflowParams`.

Confirm the repo and the command with the user before the create. A task spends real money.

## 3. Start

```bash
npm run dev -w cli -- job create --repo owner/name --executor my-claude -- fix the flaky login test
```

`POST /api/jobs` with `{ command, repo?, executor?, workflow?, workflowParams? }` → `201 { id,
status: "queued" }`. Refusals worth reading rather than retrying: `400 BAD_COMMAND`, `BAD_REPO`,
`BAD_EXECUTOR`, `BAD_WORKFLOW_PARAMS`, `404 UNKNOWN_WORKFLOW`, `409 PURGE_IN_PROGRESS`.

Keep the returned `id`. Every verb below takes it.

## 4. Wait

```bash
npm run dev -w cli -- job wait <id> --timeout 600
```

The CLI's `--timeout` is the TOTAL budget it keeps waiting for; the board's own per-hold cap is
separate and much shorter. The board holds the read itself:

```bash
curl -s -H "authorization: Bearer $FACTORY_TOKEN" \
  "$FACTORY_URL/api/jobs/<id>?waitFor=terminal&timeout=60"     # GET /api/jobs/<id>
```

That `timeout` is one hold, in whole seconds `1..60`; more is clamped, `0` is refused. **A hold
that runs out answers `200` with the ordinary row and no marker of its own**, so the row is the
only thing that tells a timeout from a settle. Terminal statuses: `succeeded`, `failed`, `dead`,
`stopped`. A non-terminal row means re-issue the same request — that re-issue is the wait; never
sleep between reads.

With one exception: **the board also settles the hold on an open PR or review wait**, and that
answer comes back immediately with a `queued` or `running` row. Re-issuing on it is a
request storm, not a wait. If the answer arrives far sooner than the hold asked for and the row is not
terminal, the thread is parked on a workflow wait — stop waiting and say so (the CLI's `job wait`
does this itself, and exits `3`). Nothing the wait can do moves a parked thread.

Two more details that bite:

- The wait parameters belong to the job read only. `GET /api/jobs/<id>/thread` takes none, and
  adding them there does nothing at all.
- The hold settles on the thread's chain head but answers with the row you named. Wait on the id
  the create or follow-up just returned — waiting on a root id whose newest turn is still running
  hands back a long-terminal root.

Read the settled task with `npm run dev -w cli -- job investigate <id>`, which is
`GET /api/jobs/<id>` plus `GET /api/jobs/<id>/thread`. For what the fields mean, use the
`investigate-task` skill.

## 5. Follow up

```bash
npm run dev -w cli -- job follow-up <id> -- now add a test for the null branch
```

`POST /api/jobs/<id>/follow-up` with `{ command }` alone → `201 { id, status: "queued" }`. The
repo, the executor and the agent session are copied from the parent; sending them is a second
opinion the board does not take. With no session to resume, the turn starts a fresh one and the
board prefixes a recap of the earlier turns. The new id is a new turn — wait on that one, not the
parent.

Refusals: `409 NOT_FINISHED` (the turn is still going — wait, or stop it), `409 TASK_DONE` (the
thread was closed; start a new task), `409 PURGE_IN_PROGRESS` (the org is being purged; nothing queues),
`403 FORBIDDEN` (a follow-up is the author's).

## 6. Stop, done, remove

These three change or destroy someone's work. **Confirm each one with the user first, quoting the
task's command and id back to them**, and never chain them off your own inference that a task
"looks stuck".

```bash
npm run dev -w cli -- job stop <id>          # POST /api/jobs/<id>/stop
npm run dev -w cli -- job done <id>          # POST /api/jobs/<id>/done
npm run dev -w cli -- job remove <id> --yes  # POST /api/jobs/<id>/remove
```

**Stop** ends the current turn, keeping the thread and the session, so a follow-up is still the
natural next move. Two answers: `200 { status: "stopped" }` when the row was queued or its lease
had already expired, and `202 { status: "running", cancelRequestedAt }` when a worker still holds
it — then the stop has only been *stamped*, and the worker settles it at its next heartbeat. Do
not report a `202` as stopped; wait for the settle. `409 NOT_STOPPABLE` means it had already
finished.

**Done** is the person's verdict that the task is finished, which no run can make for itself. It
is orthogonal to how the run ended — a `failed` run can be marked done, and `done` is not a
status. `200 { id, status, doneAt }`, idempotent. `409 NOT_FINISHED` while a turn is still
running. A done thread takes no more follow-ups.

**Remove** deletes the whole thread — every run, every output, the audit rows — and queues the
worktree for reclaim. It **cannot be undone**, which is why the CLI demands `--yes` on top of
the user's confirmation. `200 { id, removed: true }`. `409 TASK_RUNNING` means a turn is live:
stop it first, wait for the settle, then remove.

## Reporting back

Name the id, the status the board actually answered with, and the next step. A `202` is "stop
requested", a wait that exits `3` is "still running after N seconds" — never round either of
those up to a verdict the board did not give.
