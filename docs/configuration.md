# Configuration

One source of configuration: environment variables (`.env` via `--env-file-if-exists`, compose, or
the shell). `.env.example` is the list; `server/src/config.ts` is the contract.

| Concern | Code | Test |
| --- | --- | --- |
| `loadConfig` purity, auth variables, the `AuthConfig` union | `server/src/config.ts` | `server/test/config.auth.test.ts` |
| App id, key, `_FILE`/base64, API host, webhook secret | `server/src/config.ts`, `server/src/github/app-token.ts` | `server/test/config.github.test.ts` |
| Retired variables that are fatal | `server/src/config.ts` | `server/test/config.persistence.test.ts`, `server/test/config.org.test.ts` |
| `DATABASE_URL`, disposable-database refusal | `server/src/config.ts` | `server/test/config.persistence.test.ts` |
| `ORG_WORKSPACE_ROOT` | `server/src/config.ts` | `server/test/config.workspace.test.ts` |
| The credential-free entry point | `server/src/offline.ts` | `server/test/routes.repos.test.ts` |

## Invariants

- **`loadConfig` does no I/O** — it must mean the same thing on every machine, so a key given as
  `GITHUB_APP_PRIVATE_KEY_FILE` is read in `resolveConfig`, before the validator sees the record,
  and `~` expands against `env.HOME` rather than `os.homedir()`. The validator shape-checks the
  PEM; `createPrivateKey()` runs at provider construction, so an unusable key is fatal at boot.
- **An unknown environment variable is ignored — with named exceptions that are fatal.** Every one
  of them was once meaningful, so ignoring it would change behaviour silently; each message names
  the replacement. `server/test/config.persistence.test.ts`.
- **`DATABASE_URL`, `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are required, and there is no
  environment variable that turns fetching off.** Tooling that must run without a credential says
  so in CODE — `server/dist/offline.js`, or the `none` arm of `GitHubConfig` passed to
  `resolveConfig` — because a dashboard that silently fetches nothing presents as data loss.
- **A fetching process refuses a disposable database** (`_test`, `_seed`, `_synthetic`, `_demo`,
  `_e2e`): `npm run test:db` truncates one and `npm run seed` fills one with synthetic sessions.
  The `none` arm is exempt by construction, which is how seed and `verify:ui` run.
- **There is no repo list to configure** — `AppConfig` has no `repos` ([repos.md](repos.md)).
- **`AUTH_MODE` is an explicit enum, never inferred from whether a client id is set**, and
  `AuthConfig` is a discriminated union so "half-configured" is unrepresentable. Same instinct as
  `TELEMETRY_SOURCE`. Reasoning in [auth.md](auth.md).
- **A secret shorter than 32 characters refuses to boot** (`SESSION_SECRET`,
  `GITHUB_WEBHOOK_SECRET`) — the webhook HMAC decides whose memberships get deleted. Unset,
  `GITHUB_WEBHOOK_SECRET` simply does not register the route.
- **`GITHUB_API_URL` and `GITHUB_OAUTH_*_URL` are test seams, undocumented on purpose** — a
  configurable API host in a shipped deployment is somewhere to send a private key, and a
  configurable authorize URL is a phishing vector. `main.ts` logs loudly when one is set.
- **Never log the merged environment.** It holds the App private key: key names and non-secret
  resolved values only.
