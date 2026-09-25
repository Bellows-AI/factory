---
title: Workflows, gates, and publishing
description: Define multi-run task graphs, repository verification gates, and controlled branch publishing.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/guides/workflows-gates-publishing.md
---

## Workflows

A workflow is a validated graph of nodes. An `agent` node chooses a fresh or resumed session, a
prompt, whether gates run, and whether successful work may publish. Edges react to `succeeded`,
`failed`, `gate-failed`, or an exact final-line marker. Edges are evaluated in declared order and
the first match wins; a completed node that no edge matches rests the thread.

```json
{
  "entry": "implement",
  "params": [
    {
      "name": "issue",
      "pattern": "#\\d+",
      "description": "GitHub issue number",
      "example": "#123"
    }
  ],
  "nodes": [
    {
      "name": "implement",
      "kind": "agent",
      "session": "resume",
      "prompt": "Implement {{param.issue}}.",
      "gates": true
    },
    {
      "name": "review",
      "kind": "agent",
      "session": "fresh",
      "prompt": "Review this result: {{implement.output}}\nEnd with exactly one final line: VERDICT: CLEAN or VERDICT: BLOCKERS.",
      "gates": false
    },
    {
      "name": "publish",
      "kind": "agent",
      "session": "resume",
      "prompt": "Prepare the reviewed work for publishing.",
      "gates": true,
      "publish": true
    }
  ],
  "edges": [
    { "from": "implement", "to": "review", "when": "succeeded" },
    { "from": "review", "to": "publish", "when": { "marker": "VERDICT: CLEAN" } },
    { "from": "review", "to": "implement", "when": { "marker": "VERDICT: BLOCKERS" }, "max": 3 }
  ]
}
```

Every declared parameter is required at launch. A valid graph needs a reachable `publish: true`
node, but only that node's successful run receives publishing authority. The task stores a frozen
workflow snapshot so later edits cannot rewrite an active thread's audit.

### Sessions

All runs in a thread share one worktree. A `resume` node continues the thread's primary session,
which is the session of the thread's first `resume` run. In the example, `implement` starts that
session and `publish` continues it. A `fresh` node, like `review`, always starts a new session.

### Prompt placeholders

Prompts can use a closed set of placeholders. Anything else is refused when the workflow is saved.

- `{{command}}` — on the entry node, the instruction the member typed when launching the task; on
  every later node, the interpolated entry prompt.
- `{{param.NAME}}` — a declared launch parameter. Because of this, `param` is a reserved node name.
- `{{<node name>.output}}` — the most recent output tail of that node, for example
  `{{implement.output}}`.
- `{{gate.name}}` and `{{gate.output}}` — the first failed gate of the completed run.

Substituted values are bounded, except `{{command}}`.

### Loop bounds

`max` on an edge is optional. When present, it must be an integer from 1 to 1000, and the edge fires only
while the thread holds fewer than `max` runs of the target node. When absent, the edge may fire
without limit, and nothing detects cycles, so give every edge that closes a loop a `max`. An
exhausted bound rests the thread rather than falling through to a later edge.

### Built-in blocks

A `block` node references a Factory-owned process instead of spelling out its prompts:

```json
{
  "name": "review-comments",
  "kind": "block",
  "uses": "builtin/github-review-reconcile",
  "with": { "maxRounds": 3 }
}
```

The available blocks are `builtin/github-review-reconcile` and `builtin/merge-conflict-autofix`. A
block node cannot carry `prompt`, `session`, `gates`, or `publish`. Blocks are expanded into
ordinary agent nodes when the workflow is saved, so reading the workflow back returns the expanded
graph.

Tasks launched without a named workflow run a built-in default workflow: one node whose prompt is
`{{command}}`, with gates and publishing, followed by whichever of these two blocks the member has
enabled.

## Repository gates

Repositories declare named verification commands in `.bellows.yaml`:

```yaml
environment:
  image: node:24-alpine
  gates:
    - name: test
      command: npm test
    - name: lint
      command: npm run lint
```

The agent can request only a declared gate name; it cannot send an arbitrary command to the gate
service.

The file is read with a strict subset of YAML: one `environment:` block with `image:` and a list of
`name`/`command` pairs, plus an optional top-level `services:` block. Tabs, unknown keys, more than
16 gates, and an image that looks like a command-line flag are refused. A file that fails to parse
fails the task before anything runs. Gates run as the runner's user (uid 1000, `HOME=/tmp`), not as
the image's default user.

On Kubernetes, each gate runs as a short-lived Job against the task worktree, with a timeout and the
attempt-scoped Secret. On Docker, the driver keeps one gate environment container per task
worktree and keeps it warm for `GATE_COOLDOWN_MS` (ten minutes by default) after a run, so a
follow-up reuses it.

## Publishing

After an eligible run succeeds and gates pass, the driver publishes the work:

1. It requests a fresh GitHub installation token from the board. If none comes back, it publishes
   with the token issued at claim time.
2. It creates the task branch, or reuses an existing one.
3. It commits, then pushes with `--force-with-lease`. The commit message is the task command's
   first line.
4. It opens a pull request, or reuses an existing one. The title and body are summarized from the
   branch's commits and diff when that succeeds; otherwise the title falls back to the command's
   first line. An issue reference in the command adds `Closes #N` to the body.

A publish failure fails the run: work that exists only in the local worktree is not a success.
Nothing is published after a failed gate or a failed, timed-out, or stopped run. The agent itself
is not allowed to open pull requests with `gh pr create`; publishing is Factory's job.

Mid-workflow review or fix nodes cannot publish unless their node explicitly sets `publish: true`.
