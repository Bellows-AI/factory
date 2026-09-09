# Configuration

Read before: touching `server/src/config.ts` or the `docker-compose.yml` environment blocks.

One source: environment variables (`.env` via `--env-file-if-exists`, compose, or the shell).

- **`loadConfig` does no I/O.** `loadConfig({})` has to mean the same thing on every machine; if
  the validator read the disk, the existing `describe('loadConfig')` cases would start reading
  whatever the developer happens to keep around and fail on exactly one machine. That block's
  survival is the regression test.
- **An unknown environment variable is ignored — with named exceptions.** `GITHUB_TOKEN`,
  `GITHUB_OWNER`, `ORG_REPOS`, `GITHUB_REPOS`, `DATA_SOURCE` and `CACHE_TTL_SECONDS` are fatal
  rather than ignored: every one of them *was* meaningful, so ignoring one now would change
  behaviour silently. Each message names what replaced it rather than reporting a typo.
- **`DATABASE_URL` is required, and so are the App id and key.** The database is the only source
  the dashboard reads, and the GitHub App is the only credential there is: the environment can
  produce nothing else. `app` with `GITHUB_APP_ID` or `GITHUB_APP_PRIVATE_KEY` missing is fatal
  and names the missing key. There is no mode to select, and no offline way to obtain a private
  key — so the tooling that must run without one (`npm run seed`, `npm run verify:ui`,
  `scripts/test-jobs.sh`, the route-test harness) says so in CODE, by passing the code-only
  `none` arm of `GitHubConfig` to `resolveConfig` or by booting the compiled offline entry,
  `server/dist/offline.js`. An environment variable that selects it does not exist, and a
  dashboard that silently fetches nothing presents as data loss rather than as a missing
  credential.
- **A process that fetches refuses a disposable database** (`_test`, `_seed`, `_synthetic`,
  `_demo`, `_e2e`). `npm run test:db` truncates one and `npm run seed` fills one with invented
  pull requests, so real fetched history put there is destroyed or made indistinguishable from
  synthetic. The code-only `none` arm is exempt by construction, because nothing is fetched to
  lose — which is exactly how the seeding CLI and the browser check run. The guard used to key on
  `GITHUB_TOKEN`, then on a mode; now every env-booted process fetches, so the guard is simply
  refused.
- **There is no repo list to configure.** It is whatever the GitHub App installation reports. A
  configured copy beside it would be a second roster to keep in step with the credential — and a
  repo in one but not the other used to fail every sync with a 404 that read as a deleted
  repository. `AppConfig` therefore has no `repos`, and the sync TTL's per-repo floor moved to the
  stats service, which is now the only thing that knows the count.
- **`ORG_ID` and `ORG_NAME` are empty-defaulted in `docker-compose.yml`**, unlike most of that
  block. Every other variable there is a real value, but the org id leads every stored primary key —
  a literal default would repartition the database under the operator on every start.
- **`resolveConfig` reads `GITHUB_APP_PRIVATE_KEY_FILE`, and `loadConfig` never learns a file
  exists.** The whole `describe('loadConfig')` suite depends on the validator being a pure function
  of its argument, and an App private key normally arrives as a path — so the read happens in
  `resolveConfig`, before the validator sees the record. The validator only shape-checks the PEM;
  `createPrivateKey()` runs when the token provider is constructed, so a well-shaped but unusable
  key is still fatal at boot rather than at the first fetch. An inline key wins over a `_FILE` path.
  The key may also be base64: a PEM is multi-line and neither `.env` nor compose handles that well.
- **`GITHUB_API_URL` is environment-only and undocumented on purpose**, for the same reason as the
  three OAuth endpoint overrides below: a configurable API host that ships with a deployment is
  somewhere to send a private key. `index.ts` logs loudly when it is set.
- **`AUTH_MODE` is an explicit enum, never inferred from whether a client id is set**, and
  `AUTH_MODE=github` with an incomplete set of auth variables is fatal and names the missing key.
  Both are the same instinct as `persistence.status` having no `'off'`: a mode you can fall into by
  typo is worse than one that refuses. Full reasoning in [auth.md](auth.md). `AuthConfig` is a
  discriminated union rather than a record of optionals, so "half-configured" is unrepresentable
  rather than merely rejected.
- **`GITHUB_OAUTH_AUTHORIZE_URL` / `_TOKEN_URL` / `_USER_URL` are a test seam**, not documented
  configuration — a configurable authorize URL that reached a real deployment would be a phishing
  vector, and `index.ts` logs loudly when one is in use. `AUTH_ALLOW_PUBLIC_BIND` is restricted for a
  different reason: it asserts something about the network in front of the process, which is a
  property of the host rather than of the deployment.
- **`ORG_WORKSPACE_ROOT` is unset by default, must be absolute, and expands `~` against `env.HOME`
  rather than `os.homedir()`** — that last one is what keeps `loadConfig` a pure function of its
  argument. See [workspace.md](workspace.md) for the rest, including why a relative path is rejected
  rather than resolved.
- **Never log the merged environment.** It holds the App private key. Log key names and the
  resolved values that are not secrets only.
