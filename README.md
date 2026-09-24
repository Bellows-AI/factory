# factory-ai

Software Engineering factory control plane.

First surface: **Factory Stats** — a dashboard measuring AI-assisted delivery from agent
telemetry: sessions, token usage (input, output, cache reads and cache creation), lines written,
active time, and how much of it the telemetry can actually see.

Metric definitions, the API traps behind them, and the reasoning are specified in
`../factory-stats/SPEC.md`. Every definition exists to correct a specific distortion —
simplifying one silently makes the number wrong.

## Layout

| Package | Purpose |
| --- | --- |
| `core/` | Pure telemetry aggregation and shared types. No dependencies, no I/O. |
| `server/` | Fastify API: telemetry ingest and store, the GitHub App credential and repo list, and static hosting for the SPA. |
| `web/` | Vite + React SPA. |
| `driver/` | Job driver: claims jobs from the board and spawns a runner container per job. |

## Running it

A database is required: it is the only source the dashboard reads. A GitHub App is required too:
the id and the private key are the only configuration there is, and either one missing refuses to
boot — a dashboard that silently fetches nothing looks like data loss rather than like a missing
credential.

```bash
npm install
docker compose up -d timescale        # required; there is no in-memory mode

# No credential: fill a disposable database with synthetic sessions and browse that offline.
docker compose exec timescale psql -U factory -d postgres -c 'create database factory_seed'
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_seed npm run seed
npm run verify:ui                     # boots server/dist/offline.js against the seeded database

# Live, via the environment
cp .env.example .env   # set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY
npm run dev
```

**There is no repo list to configure.** Install the GitHub App on the repositories you want
measured, and that installation is both the credential and the list — so they cannot drift apart.
The list is read at runtime and cached for 10 minutes, so granting the App a new repository shows
up without a restart. With no credential at all (the offline tooling), the list falls back to the
distinct repos the database already holds sessions for.

A database whose name ends in `_test`, `_seed`, `_synthetic`, `_demo` or `_e2e` is treated as
disposable, and is refused outright in `app` mode — `npm run seed` writes synthetic agent
sessions into one and `npm run test:db` truncates one, so real history put there is either
counterfeited or destroyed.

`npm run dev` starts the API on `127.0.0.1:8080` and Vite on `5173` with `/api` proxied.

```bash
# Runs `npm run dev` inside the container against the bind-mounted working tree: API on
# 127.0.0.1:8080, Vite on 5173, edits live with no rebuild. node_modules lives in a named volume,
# so a restart takes seconds; `down -v` forces a clean reinstall.
docker compose up

# What deploys. Compose does not run this.
docker build -f docker/Dockerfile --target runtime -t factory-ai .
```

Compose reads the repo-root `.env` for the App credentials and the rest, and mounts a `workspaces`
volume at `/workspaces`, which `ORG_WORKSPACE_ROOT` defaults to. **Nothing is cloned at boot.** Each
member signs in, picks repositories from the Workspace page, and gets their own checkouts at
`/workspaces/<ORG_ID>/<user id>/<name>` — so one person's agent cannot edit another's working copy.
Set `ORG_WORKSPACE_ROOT=` in `.env` to switch that off entirely. An existing checkout is never
fetched or overwritten, and nothing is ever pruned; see [docs/workspace.md](docs/workspace.md).

## Auth

**`docker compose up` requires a GitHub sign-in.** `docker-compose.yml` pins `AUTH_MODE=github`,
and unlike almost everything else in that file `.env` cannot override it. Fill in
`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET` (32+ chars) and
`PUBLIC_URL` in `.env` — a missing one is fatal at boot and names itself, rather than falling back
to an open port. Register an **OAuth App**, not a GitHub App, with the callback at
`<PUBLIC_URL>/api/auth/github/callback`; on the default compose ports that is
`http://127.0.0.1:5173/api/auth/github/callback`.

Membership is the App's installation access: anyone who can see one of its installations signs into
that org, and nobody else does — onboarding is installing the App. See [docs/auth.md](docs/auth.md).

`npm run dev` on the host still defaults to `AUTH_MODE=none`, where every route is open and the
loopback bind is the access control — that is what `npm run seed` and `npm run verify:ui` need, and
what a clone with no OAuth app can run.

There are two GitHub registrations, deliberately. An **OAuth App** signs people in and requests zero
scopes — it reads a numeric id and a login, nothing else. A separate **GitHub App** reads
repositories: its private key signs a short-lived JWT, which buys an installation token that expires
in an hour. One credential doing both would mean every person who signs in grants repository access.

Required GitHub App installation permissions:

- `Metadata: read` — the repository list that scopes every figure.
- `Contents: read` — cloning private source onto the workspace root.

## Freshness

- The telemetry read is cached for `TELEMETRY_TTL_SECONDS` (default 30s, floor 5s — there is no
  quota to protect, only a hot loop to prevent). The retired `CACHE_TTL_SECONDS` and
  `SYNC_TTL_SECONDS` are fatal if set.
- A cold `GET /api/stats` answers **202** with progress while the first read runs; the SPA polls
  every 2s.
- A stale snapshot is still served with 200. A failed read keeps the last good render on screen
  and explains itself rather than blanking the dashboard.
- After a failed read the server waits 30s before retrying, so a dead database cannot turn into
  a request loop. There is no bypass.

## API

| Route | Behaviour |
| --- | --- |
| `GET /api/health` | Never calls GitHub, so a token-less or rate-limited container still reports healthy. |
| `GET /api/stats` | `200` with `{ telemetry, meta }`, `202` while the first read runs, `503` if telemetry is disabled or the first read failed. |

## Tests

```bash
npm test        # offline, no token, no quota
npm run typecheck
```

- `core/test/telemetry.independent.test.ts` recomputes the headline telemetry figures straight off
  the raw fixture, deliberately sharing no code with `core/src/telemetry.ts`. Aggregation is the
  one place a wrong number is invisible.
- `core/test/telemetry.stats.test.ts` asserts what a plausible-but-wrong aggregation would
  violate: ratios null on a zero denominator, weekly series seeded through empty weeks, no `NaN`,
  the four token types never summed into one figure, no monetary field. `core/test/range.test.ts`
  pins presets-as-lookback, sessions kept on overlap, and coverage untouched.
- `server/test/` drives the API in-process via `app.inject()` with a stubbed telemetry client and
  repo source: caching, single-flight, the 202 cold path, error-code mapping, and the degraded
  telemetry states.

## Things that will bite

- Figures depend on the current date (the partial-week flag). `telemetryStats()` takes an
  injectable `now` for exactly this reason — keep using it in tests.
- Charts are fixed-width; below roughly 700px the weekly axis labels become illegible.
