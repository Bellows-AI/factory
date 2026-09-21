---
title: Workflows, gates, and publishing
description: Define multi-run task graphs, repository verification gates, and controlled branch publishing.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/guides/workflows-gates-publishing.md
---

## Workflows

A workflow is a validated graph of agent nodes. Each node chooses a fresh or resumed session, a prompt,
whether gates run, and whether successful work may publish. Edges react to `succeeded`, `failed`,
`gate-failed`, or an exact final-line marker.

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
      "session": "fresh",
      "prompt": "Implement {{param.issue}}.",
      "gates": true
    },
    {
      "name": "review",
      "kind": "agent",
      "session": "fresh",
      "prompt": "Review this result: {{node.implement.output}}",
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

Every declared parameter is required at launch. Loops must be bounded. A valid graph needs a reachable
`publish: true` node, but only that node's successful run receives publishing authority. The task stores
a frozen workflow snapshot so later edits cannot rewrite an active thread's audit.

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
service. Docker keeps a warm gate environment per checkout. Kubernetes runs each gate as a short-lived
Job against the shared workspace, with a timeout and attempt-scoped Secret.

## Publishing

After an eligible run succeeds and gates pass, the driver requests a fresh GitHub installation token,
pushes the task branch, and records the published result. Mid-workflow review or fix nodes cannot publish
unless their node explicitly sets `publish: true`.
