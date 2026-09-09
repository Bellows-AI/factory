# factory-ai

Software Engineering factory control plane.

First surface: **Factory Stats** — a dashboard measuring the efficiency of an AI-heavy delivery
process for `Bellows-AI/factory`: throughput, cycle time, rework, and whether automated
code review produces actionable signal.

Metric definitions, the API traps behind them, and the reasoning are specified in
`../factory-stats/SPEC.md`. Every definition exists to correct a specific distortion —
simplifying one silently makes the number wrong.

## Layout

| Package | Purpose |
| --- | --- |
| `core/` | Pure aggregation and shared types. No dependencies, no I/O. Byte-equivalent to the verified reference implementation. |
| `server/` | Fastify API: GitHub GraphQL client, in-memory cache, and static hosting for the SPA. |
| `web/` | Vite + React SPA. |

## Running it

A database is required: it is the only source the dashboard reads. A GitHub App is required too:
the id and the private key are the only configuration there is, and either one missing refuses to
boot — a dashboard that silently fetches nothing looks like data loss rather than like a missing
credential.

```bash
npm install
docker compose up -d timescale        # required; there is no in-memory mode

# No credential: fill a disposable database with synthetic data and browse that offline.
docker compose exec timescale psql -U factory -d postgres -c 'create database factory_seed'
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_seed npm run seed
npm run verify:ui                     # boots server/dist/offline.js against the seeded database

# Live, via the environment
cp .env.example .env   # set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY
npm run dev

# The organization is identity only. There is no repo list here any more.
ORG_ID=bellows-ai
ORG_NAME="Bellows AI"
```

**There is no repo list to configure.** Install the GitHub App on the repositories you want measured,
and that installation is both the credential and the list — so they cannot drift apart, which is
what `ORG_REPOS` could not promise: a repo listed but never granted failed every sync with a 404
that read as a deleted repository. Cost is still ~243 rate-limit points per repo for a full walk, so
the sync TTL floor rises to 60s × the number of repositories the installation reports.

A database whose name ends in `_test`, `_seed`, `_synthetic`, `_demo` or `_e2e` is treated as
disposable, and is refused outright in `app` mode — `npm run seed` writes invented pull
requests into one and `npm run test:db` truncates one, so real fetched history put there is either
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
`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET` (32+ chars), `PUBLIC_URL`
and `AUTH_BOOTSTRAP_ADMIN` in `.env` — a missing one is fatal at boot and names itself, rather than
falling back to an open port. Register an **OAuth App**, not a GitHub App, with the callback at
`<PUBLIC_URL>/api/auth/github/callback`; on the default compose ports that is
`http://127.0.0.1:5173/api/auth/github/callback`.

Membership is Factory's, not GitHub's. Set `AUTH_AUTO_JOIN_GITHUB_ORG` to a GitHub organization and
its members admit themselves, as ordinary members, the first time they sign in — onboarding is "add
them to the org". Leave it empty for invite-only, where an admin names every login in advance with
`npm run invite`; either way an invite still admits somebody outside the org, and
`AUTH_BOOTSTRAP_ADMIN` covers the first admin. Auto-join asks GitHub for `read:org`, which is the
one scope this app ever requests. See [docs/auth.md](docs/auth.md).

`npm run dev` on the host still defaults to `AUTH_MODE=none`, where every route is open and the
loopback bind is the access control — that is what `npm run seed` and `npm run verify:ui` need, and
what a clone with no OAuth app can run.

There are two GitHub registrations, deliberately. An **OAuth App** signs people in and requests zero
scopes — it reads a numeric id and a login, nothing else. A separate **GitHub App** reads
repositories: its private key signs a short-lived JWT, which buys an installation token that expires
in an hour. One credential doing both would mean every person who signs in grants repository access.

Required GitHub App installation permissions:

- `Metadata: read`
- `Pull requests: read`
- `Contents: read` — **only** for the revert rate. Without it that single metric reports
  "unavailable" and everything else still works.

## Cost and freshness

A full history fetch is 9 pages, ~243 rate-limit points and ~45 seconds against a 5000/hour
budget. Consequences baked into the code:

- The server caches one snapshot in memory; `CACHE_TTL_SECONDS` is rejected below 300.
- A cold `GET /api/stats` answers **202** with progress while fetching; the SPA polls every 2s.
- A stale snapshot is still served with 200. A rate limit keeps the last good render on screen
  and explains itself rather than blanking the dashboard.
- After a failed fetch the server waits 30s before retrying, so a rejected token cannot turn
  into a request loop. `POST /api/refresh` bypasses that.

## API

| Route | Behaviour |
| --- | --- |
| `GET /api/health` | Never calls GitHub, so a token-less or rate-limited container still reports healthy. |
| `GET /api/stats` | `200` with `{ stats, meta }`, `202` while a cold fetch runs, `503` if the first fetch failed. |
| `POST /api/refresh` | `202`. Single-flight. |

## Tests

```bash
npm test        # offline, no token, no quota
npm run typecheck
```

- `core/test/metrics.independent.test.ts` recomputes every headline number straight off the raw
  payload, deliberately sharing no code with `core/src/metrics.ts`, and pins the SPEC §1 measured
  landmarks. Aggregation is the one place a wrong number is invisible.
- `core/test/metrics.invariants.test.ts` asserts what a plausible-but-wrong aggregation would
  violate: distributions sum to the PR count, `resolved <= total`, `p50 <= p90`, human rework ≤ any
  rework, no `NaN`, every ratio null or in [0,1].
- `server/test/` drives the API in-process via `app.inject()` with a stubbed GitHub client:
  caching, single-flight, the 202 cold path, error-code mapping, and the degraded revert rate.

## Things that will bite

- Metrics depend on the current date (the partial-week flag). `compute()` takes an injectable
  `now` for exactly this reason — keep using it in tests.
- `stats.meta.window` relies on the query's `CREATED_AT DESC` ordering.
- Charts are fixed-width; below roughly 700px the weekly axis labels become illegible.
- The fixture is already post-backfill, so the oversized-PR path (#149, 397 reviews) is not
  exercised by it.
