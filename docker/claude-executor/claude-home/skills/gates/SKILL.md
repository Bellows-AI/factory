---
name: gates
description: Run a repository's verification gates (tests, lint, build checks declared in .bellows.yaml) in the shared environment image, and read their output. Use before finishing a task, after changes that could break CI, or whenever asked to "run the gates", "run the checks" or "verify with CI steps". Requires BELLOWS_GATE_URL and BELLOWS_GATE_TOKEN to be set.
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

If `BELLOWS_GATE_URL` is unset, this environment has no gates configured: say so and verify with
your own commands instead. Do not guess the URL.

## Rules

- Only gates the repository declares can run. The gate **name** goes in the request; you cannot
  send an arbitrary command. Read `.bellows.yaml` to see what is declared.
- Running a gate writes nothing. It is safe to run one at any point to check partial progress —
  the environment container stays warm, so repeated runs are cheap.
- A gate that fails is information, not a verdict on you: read its output, fix the cause, re-run.
  Do not mark work finished while a declared gate is failing.
