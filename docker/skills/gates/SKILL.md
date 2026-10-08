---
name: gates
description: Run a repository's verification gates (tests, lint, build checks declared in .bellows.yaml) in the shared environment image, and read their output. Use before finishing a task, after changes that could break CI, or whenever asked to "run the gates", "run the checks" or "verify with CI steps". Requires BELLOWS_GATE_URL and BELLOWS_GATE_TOKEN to be set.
metadata:
  requires-tools: curl
---

# Verification gates

The repository you are working in may declare CI-style checks in `.bellows.yaml` — an environment
image and named commands (test, lint, build). They run in a separate container that shares this
workspace, so anything you have written to the tree is exactly what the gates see.

## Running a gate

```bash
curl -sf -X POST "$BELLOWS_GATE_URL/run" \
    -H "authorization: Bearer $BELLOWS_GATE_TOKEN" \
    -H "content-type: application/json" \
    -d '{"gate":"test"}'
```

The answer is JSON: `{"exitCode":0,"output":"..."}`. `exitCode` `0` means the gate passed; anything
else failed, and `output` carries its tail — read it, fix what it names, run the gate again.

If the answer also carries `deadServices`, a service the repository declared (a database, a cache) has
died: the note names its exit, reason and last log lines. That is an environment fault you cannot fix
from the tree, and a gate that cannot reach the service (`ENOTFOUND`, connection refused) fails for it —
do not work around it by installing the service yourself; end with `FACTORY_BLOCKED:` and the note.

Run, read, fix, run again as often as the work needs: every answer is the gate's own result on the
tree as it is now, and you can ship a draft pull request at any point (the github skill) without
waiting for green. The declared gates also run when you finish, and a failing one fails the task —
what you ran here is a check for you, never the verdict.

If `BELLOWS_GATE_URL` is unset, this environment has no gates configured: say so and verify with
your own commands instead. Do not guess the URL.

## Rules

- Only gates the repository declares can run. The gate **name** goes in the request; you cannot
  send an arbitrary command. Read `.bellows.yaml` to see what is declared.
- Gates can write generated files to the shared workspace. The environment container stays warm —
  run one at any point to check partial progress.
- Do not mark work finished while a declared gate is failing.
