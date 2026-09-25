---
title: Configure runner environment
description: Stack organization, workspace, and repository variables and secrets for executor runs.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/guides/runner-environment.md
---

Factory resolves runner environment at claim time from three scopes:

```text
organization < workspace < repository
```

The most specific value wins. Organization and repository values apply to every member's runs;
workspace values belong to the current member. Any member of the organization can edit the
organization and repository scopes. There is no admin tier, so any member can overwrite a secret
stored there.

Variables are returned to the UI. Secrets are write-only after saving, but they are not encrypted in
the database. Restrict database access, backups, and operator access accordingly.

## Add a value

Each scope has its own editor:

| Scope        | Page                        |
| ------------ | --------------------------- |
| Organization | **Settings → Organization** |
| Workspace    | **Settings → Workspace**    |
| Repository   | **Settings → Repositories** |

Each editor has **Variables** and **Secrets** tabs; the tab you add a row in decides its type.
Names must match `[A-Za-z_][A-Za-z0-9_]*`.

Limits per scope:

- at most 100 entries;
- names up to 255 characters;
- values up to 32 KiB;
- no newlines in values, because the Docker executor delivers values in a line-based env file.

Factory refuses names reserved for runner contracts: `WORKDIR`, `BELLOWS_GATE_URL`,
`BELLOWS_GATE_TOKEN`, `CRED_HELPER`, `RESTORE`, `FACTORY_TRANSCRIPT_DIR`, `FACTORY_STATS_URL`,
`RUNNER_JOB_ID`, `RUNNER_LEASE_TOKEN`, `BELLOWS_SESSION_ID`, `OPENCODE_CONFIG_CONTENT`, and
`CLAUDE_CODE_CONFIG_CONTENT`. Rename a refused variable rather than forcing it through another
scope.

## Platform-provided credentials

At claim time Factory mints a short-lived GitHub installation token and adds it as `GITHUB_TOKEN`
underneath the scoped values. A `GITHUB_TOKEN` you configure in any scope takes precedence over
the minted one. Leave it unset unless you deliberately want runs to use a different credential.

Factory also synthesizes the executor configuration (`OPENCODE_CONFIG_CONTENT` or
`CLAUDE_CODE_CONFIG_CONTENT`) from the author's executor profile. Those names are reserved, so a
stored value can never collide with them.

On Kubernetes, the driver creates one attempt-scoped Secret per object it launches (runner, sync,
publish, helper, and gate), which that pod reads through `secretKeyRef`, then deletes it when the run ends. A driver that crashes before cleanup leaves that Secret
behind, because Secrets have no expiry; it carries a `factory.job` label for cleanup. On Docker,
the driver writes resolved values to a temporary `0600` env file rather than process arguments,
and removes it when the run ends. A follow-up run that restores an existing worktree receives no
env file or Secret for that sync step.

:::caution[Network addresses inside runners]
`127.0.0.1` names the runner itself. Use the declared service name for `.bellows.yaml` services. On
Kubernetes each service is reachable through a headless Service of the same name.

With the Helm chart's default `isolation.networkPolicy: true`, runner pods can reach only DNS, this
release's dashboard, collector, and driver, other runner pods, and addresses outside
`isolation.blockedCidrs`. Private addresses, such as an internal database or Git server, are
blocked unless you add them to `isolation.allowedCidrs`. Enforcement requires a CNI that supports
NetworkPolicy.
:::
