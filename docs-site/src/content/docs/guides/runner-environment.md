---
title: Configure runner environment
description: Stack organization, workspace, and repository variables and secrets for executor runs.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/guides/runner-environment.md
---

Factory resolves runner environment at claim time from three scopes:

```text
organization < workspace < repository
```

The most specific value wins. Organization and repository settings apply to all members with access;
workspace settings belong to the current member.

Variables are returned to the UI. Secrets are write-only after saving, but they are not encrypted in
the database. Restrict database access, backups, and operator access accordingly.

## Add a value

Open the Environment settings, select a scope, add a shell-compatible name, and choose variable or
secret. Names must match `[A-Za-z_][A-Za-z0-9_]*`.

Factory refuses names reserved for runner contracts, including `WORKDIR`, `TRUST_WORKDIR`,
`BELLOWS_GATE_URL`, `BELLOWS_GATE_TOKEN`, `CRED_HELPER`, `FACTORY_TRANSCRIPT_DIR`, and synthesized
telemetry or executor settings. A refused name should be renamed rather than forced through another
scope.

## Platform-provided credentials

At claim time Factory can synthesize short-lived GitHub installation access and executor-specific
configuration after scoped values are merged. Synthesized values win collisions and are not exposed as
stored user secrets.

On Docker, the driver writes resolved values to a temporary env file rather than process arguments. On
Kubernetes, it creates an attempt-scoped Secret and imports it into runner and auxiliary Jobs. Both
paths delete attempt material during cleanup.

:::caution[Network addresses inside runners]
`127.0.0.1` names the runner itself. Use the declared service name, Compose service name, Kubernetes
Service, or configured host-gateway address for dependencies outside the runner.
:::
