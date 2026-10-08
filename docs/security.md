# Security posture

What each credential grants, what each boundary actually holds, and where the controls live.

| Concern | Code | Test |
| --- | --- | --- |
| Which routes need a credential; the two postures | `server/src/auth/plugin.ts`, `server/src/config.ts` | `server/test/auth.enforcement.test.ts`, `server/test/config.auth.test.ts` |
| Bind address, CSP, `X-Content-Type-Options`, `Referrer-Policy` | `server/src/app.ts` | *(response headers are unpinned)* |
| Secret floors, App key resolution (`GITHUB_APP_PRIVATE_KEY_FILE`) | `server/src/config.ts` | `server/test/config.github.test.ts`, `server/test/config.auth.test.ts` |
| Webhook signature as the credential | `server/src/routes/webhook.ts` | `server/test/webhook.test.ts` |
| Installation token minted onto a claim | `server/src/github/app-token.ts` | `server/test/github.app-token.test.ts` |
| Runner secrets: write-only at the API, 0600 env file at the spawn; per-member mount (`subPath` / `volume-subpath`) | `server/src/routes/env.ts`, `driver/src/docker.ts`, `driver/src/k8s-podspec.ts` | `server/test/routes.env.test.ts`, `driver/test/docker.test.ts`, `driver/test/k8s.test.ts`, `scripts/test-k8s.sh --cluster` |
| Managed connections: the Jira credential stays on the board; the runner holds only the attempt pair | `server/src/routes/connector-jira.ts`, `server/src/db/connection-store.ts` | `server/test/routes.connector-jira.test.ts`, `server/test-db/connection-store.test.ts` |
| Container hardening, and the admission policy that requires it | `driver/src/k8s-podfields.ts`, `driver/src/services.ts`, `charts/factory/templates/driver-admission.yaml` | `driver/test/services.test.ts`, `driver/test/k8s-docs.test.ts`, `driver/test/k8s-admission.test.ts` |
| Run artifacts built from the runner's own stream, never a claim env value | `driver/src/artifacts.ts` | `driver/test/artifacts.test.ts`, `driver/test/docker.test.ts` |

Credentials: [auth.md](auth.md) · runner env: [env.md](env.md) · cluster: [kubernetes.md](kubernetes.md) · mount: [workspace.md](workspace.md).

## Operational facts

- **`POST /api/jobs` queues a shell command an agent runs against the org's checkouts.** Under
  `AUTH_MODE=none` the `127.0.0.1` bind is all that stands between an unauthenticated request and
  remote code execution: authenticate the port *before* moving the driver off-host.
- **The driver mounts `/var/run/docker.sock`, which is root on the host** — it can start a
  container with the host filesystem mounted, so it is uid 0, and `docker compose up` starts it
  with the stack. The socket is never given to the dashboard.
- **The App private key mints installation tokens indefinitely and cannot be revoked from a
  list.** Inline in `.env` or in a `.pem` named by `GITHUB_APP_PRIVATE_KEY_FILE`; `chmod 600`
  either, and a mode-600 host file bind-mounted into a container running as `node` is the usual
  cause of the fatal unreadable-key error. Same care for `GITHUB_OAUTH_CLIENT_SECRET`,
  `SESSION_SECRET` (rotating it signs everyone out), `INGEST_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `JOB_BOARD_TOKEN`.
- **Required App installation permissions: `Metadata: read`, `Contents: read`.** Runners that
  commit, open PRs or read CI need `Contents: write`, `Pull requests: write` and `Actions: read`
  granted there. The claim's token is narrowed to the task's repo and `RUNNER_TOKEN_PERMISSIONS`
  (`server/src/github/app-token.ts`, `server/test/github.app-token.test.ts`), which must be a
  subset of the installation's grants or the mint fails with a 422.
- **Runner env values and secrets are stored plaintext** — they must be retrieved to be injected,
  so database read access equals holding every runner credential. The API is write-only (lists
  null the value, admin included); the driver writes them to a 0600 `--env-file` around the spawn,
  never into its own environment. An agent can still `printenv` its own container.
- **Keep `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS` at `0`**
  in `.claude/settings.json`: that content arrives as the log record *body*, not an attribute.
- **A runner's telemetry config is root-owned and 0444, in a root-owned directory** — claude's
  managed settings (the one scope that outranks the agent's own) and opencode's `otel.json` (which
  holds `logUserPrompts`/`logToolDetails`). The driver renders them (`driver/src/telemetry-config.ts`):
  a uid-0 archive `docker cp`'d in before the start on docker, a read-only Secret mount on
  kubernetes; the entrypoints run as uid 1000 and never write them. Both `test.sh`,
  `driver/test/docker.test.ts`, `driver/test/k8s.test.ts`.
- **claude's auto-mode classifier rules ride the same managed settings** (`autoMode`, `$defaults`
  plus the runner's environment and the task-dependency and credential-check exceptions); only
  managed scope reaches a run. `driver/test/telemetry-shipping.test.ts`.
- **opencode's policy is baked root-owned twice**: the global copy (`~/.config/opencode`, the first
  config layer) fixes the key order every later layer merges into, and the managed copy
  (`/etc/opencode`) outranks every layer the agent can write — so no checkout or inline config drops
  the telemetry plugin, flips a baked value or reorders the fence. The entrypoint's per-run allows
  ride `OPENCODE_CONFIG_CONTENT`. A later layer can still add a narrower allow (a merge never removes
  keys, and the last match wins): the fence stays a guardrail. `docker/opencode-executor/test.sh`.
- **The collector listens on 4317/4318, bound to `127.0.0.1`**, and OTLP ingest is open unless
  `auth.ingest_token` is set — an authenticity check, not an authorization one, since
  `metric_point` has no `org_id`. `POST /api/sessions/branch` is the exception ([auth.md](auth.md)).

## Container hardening

Set by `driver/src/k8s-podfields.ts` and `driver/src/docker.ts`. On kubernetes they are
**required by admission**, not merely set (`charts/factory/templates/driver-admission.yaml`):
a pod missing one is rejected, so a driver that forgets cannot drop the control.

| Control | Kubernetes | Docker |
| --- | --- | --- |
| No capabilities | `capabilities.drop: [ALL]` unless `unhardened: true` | `--cap-drop ALL` unless `unhardened: true` |
| No escalation | `allowPrivilegeEscalation: false` | `--security-opt no-new-privileges` |
| Seccomp | `seccompProfile: RuntimeDefault` | the daemon's default profile |
| Non-root | `runAsNonRoot`, uid 1000 | `--user 1000` |

The `unhardened: true` opt-out reaches the capability set and nothing else — the
**escalation bit stays off**, seccomp stays on, the uid is unchanged. It is declared per service in
`.bellows.yaml`, and there is **no opt-out for a GATE image**. `driver/src/services.ts`,
`driver/test/services.test.ts`. A service's `user: "uid:gid"` (numeric, uid never 0) tightens
instead: `runAsNonRoot` + `runAsUser`/`runAsGroup` on kubernetes, `--user` on docker, capabilities
still dropped. `driver/src/k8s-auxspec.ts`, `driver/test/k8s.test.ts`, `driver/test/docker.test.ts`.

## What the hardening is not

- **This is not kernel isolation and it is not VM isolation.** Every runner, gate, helper and
  service shares one host kernel, and no field in `driver/src/k8s-podfields.ts` mitigates a kernel
  escalation bug. A kernel boundary means gVisor/Kata/Firecracker on a node group the chart does
  not provision.
- **The network controls are inert without an enforcing CNI** the chart cannot install
  ([kubernetes.md](kubernetes.md)), and a NetworkPolicy cannot restrict HTTP routes — every
  endpoint a runner reaches authorizes the caller itself.
- **Membership is not a sandbox**: `github` mode narrows the board to any member ([auth.md](auth.md)).
- **`unhardened: true` on a declared `.bellows.yaml` service restores the image's default
  capability set, `CAP_NET_RAW` included**, on the network that attempt's containers share; there
  is no equivalent for a gate image. `driver/src/services.ts`, `driver/test/services.test.ts`.
- **No `readOnlyRootFilesystem`** — an agent run writes its caches, `HOME` and worktree.
- **The mount is a member boundary, never a task boundary.** Same-member tasks share one subtree
  and one uid 1000; another member or org is absent from the namespace ([workspace.md](workspace.md)).
  The dashboard is the stated exception: it mounts the whole volume read-write as the
  provisioning and org-analysis plane.
