---
name: investigate-task
description: Investigate a Factory task (a job on the board) — retrieve the whole thread, analyze the run logs and vitals, and report a grounded conclusion about what happened and why. Use when the user asks to "investigate task", "why did task X fail", "what happened with <id/repo/task>", "check the task logs", or "/investigate". Read-only: never stops, resumes, removes or re-queues anything.
---

# Investigate a task

A task is a thread of runs on the job board. The investigation has three moves: retrieve the
whole thread, read the evidence the rows carry, and answer with a conclusion that cites those
rows. Everything below is read-only — an investigation never POSTs.

## 1. Retrieve the task

```bash
BOARD=${FACTORY_BOARD:-http://127.0.0.1:8080}
# With an id (uuid, or any member of the thread — the route resolves the whole conversation):
curl -s "$BOARD/api/jobs/<id>/thread" | jq .
# Without an id, find candidates newest first (filter by repo or status):
curl -s "$BOARD/api/jobs?limit=50" | jq '.jobs[] | {id, command, status, repo, createdAt}'
```

The default board is the dev API on 127.0.0.1:8080 (`npm run dev`) — the same port the compose
dashboard serves. A board running `AUTH_MODE=github` answers `401`; investigate through the
database instead, read-only:

```bash
docker exec factory-ai-timescale-1 psql -U factory -d factory_dev -x -c \
  "select id, command, status, attempts, parent_job_id, root_job_id, exit_code,
          left(output, 4000) as output, started_at, finished_at
   from job where root_job_id = (select root_job_id from job where id = '<id>')
   order by created_at"
```

Both routes serve the same rows. The API truncates `output` at 64 KiB; psql does not.

## 2. Analyze

**Read the chain as one conversation, oldest first.** Each run is one row; the newest run is the
conversation's present tense (`rootJobId` groups them, `followUpTo` names what each turn
continued). A follow-up's command is often the best clue about what went wrong in the run before
it — "again, but tighter" is a bug report.

**Per run, the fields that carry the story:**

| Field | How to read it |
| --- | --- |
| `status` | `dead` is the BOARD's verdict — attempts exhausted on lease expiries, meaning the worker kept dying before any verdict: driver down, daemon refusing. `failed` is a run's own verdict. `standby` is parked, not broken. |
| `attempts` / `maxAttempts` | `attempts > 1` means reclaim happened: the worker vanished or its lease expired mid-run. `startedAt` is the LAST attempt's start, so `finishedAt - startedAt` is the final attempt only. |
| `exitCode` | 125 with `docker: ` in the output is a daemon refusal (bad image/mount). 124 is the gate/watch timeout. A clean 0 beside `failed` is opencode exiting 0 on a context-limit cut — the close-time readout turns that into the failure it is. |
| `output` | A ROLLING TAIL the final report overwrote — the end of the run, never the whole transcript. Do not narrate from absence: what is not in the tail was never stored. |
| `gates` | Current/last report per declared check: `exitCode`, plus the gate's own tail. A gate stuck `running` means the worker died mid-gate. A parse refusal travels as terminal `failed` with the reason in `output` or the claim's `gateError`. |
| `runtime` | `cpuPercent`/`memUsedMb` — was it doing anything. `activity` — the agent's last line, usually the current tool call. `sampledAt` — staleness: a `running` row whose sample is minutes old has probably lost its worker. `contextTokens`/`contextCostUsd` — how much window the run burned (opencode). |
| `cancelRequestedAt` | Set: a person stopped it. A `failed` row is still the run's verdict, but a stop explains a run that "gave up". |
| `doneAt` | The user closed the task by hand — orthogonal to success, never infer quality from it. |
| `sessionId` / `remoteSessionId` | The conversation's session. Only `remoteSessionId` builds a claude.ai link; the local one joins telemetry. |

**Recurring shapes worth naming in the conclusion** (all from docs/jobs.md):

- Timeout kill — `failed`, note about `DRIVER_JOB_TIMEOUT_MS` in the output, long `finishedAt - startedAt`.
- Provider death — `failed` with a rate-limit/provider error in the output and high `contextTokens`.
- Cache collapse (opencode, watch armed) — `failed` with the observed no-cache turn numbers in the output.
- Reclaim loop — `dead`, `attempts == maxAttempts`, no verdict ever landed: look at the driver, not the command.
- Never started — `attempts` grew while output stayed empty: daemon refused, driver told nobody.
- Stopped, not failed — `standby` or `cancelRequestedAt` set.

## 3. Conclude

Answer in this shape, citing rows by turn number and field — never from general knowledge:

```
Verdict: <one line — what happened, and whether the task itself is healthy>
Evidence:
  - turn 2 (failed, exit 1): "<decisive output line>"
  - turn 3 attempts=3 dead: reclaimed three times, no verdict — worker-side, not command-side
Root cause: <the single thing that went wrong, or "not determinable from the stored evidence", and what WOULD decide it>
Next: <the one action that follows — fix the yaml, raise the timeout, check the driver — or "none">
```

Rules: quote the rows; distinguish the last attempt from the whole run; say "tail" when quoting
`output`; if the evidence does not decide between two causes, say so and name the observation
that would. No speculation about code the rows do not mention.
