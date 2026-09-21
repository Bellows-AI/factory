---
title: Factory documentation
description: Install, configure, operate, and use the Factory software engineering control plane.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/index.md
template: splash
hero:
  tagline: Run AI-assisted software delivery with observable tasks, controlled executors, and repository-aware workflows.
  actions:
    - text: Choose a deployment
      link: /factory/getting-started/deployment-options/
      icon: right-arrow
      variant: primary
    - text: Explore capabilities
      link: /factory/capabilities/
      icon: open-book
---

## One control plane, two responsibilities

Factory combines a telemetry dashboard with a task board. It receives agent telemetry, attributes
sessions to repositories and branches, and reports usage and delivery activity. It also queues tasks,
leases them to a driver, runs them through isolated executor containers or Kubernetes Jobs, evaluates
gates, and records the result.

Start with [What is Factory?](./overview.md) for the system model or go directly to
[deployment options](./getting-started/deployment-options.md).

:::caution[Initial construction]
Factory is under active development. Treat the documentation for the current `main` branch as the
supported contract; there are no compatibility shims for retired configuration or payloads.
:::
