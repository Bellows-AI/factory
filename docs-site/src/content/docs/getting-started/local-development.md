---
title: Local development
description: Run Factory from a source checkout with Node.js and a disposable local database.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/getting-started/local-development.md
---

## Prerequisites

- Node.js 22.12 or newer and npm.
- Docker with the Compose plugin.
- A GitHub App for live repository access, or a disposable database for the offline seeded walkthrough.

## Run with live repository access

```bash
git clone https://github.com/Bellows-AI/factory.git
cd factory
npm install
docker compose up -d timescale
cp .env.example .env
```

Set at least `GITHUB_APP_ID`, one of `GITHUB_APP_PRIVATE_KEY` or
`GITHUB_APP_PRIVATE_KEY_FILE`, and `DATABASE_URL` in `.env`. Then start the API and frontend:

```bash
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` to the API on `127.0.0.1:8080`.

`AUTH_MODE` defaults to `none` for host development. In that mode every API route is open to anyone
who can reach the bind address, including the route that queues executable tasks. Factory refuses an
unauthenticated non-loopback bind unless `AUTH_ALLOW_PUBLIC_BIND=1` explicitly asserts that another
layer provides authentication.

## Run the complete Compose development stack

```bash
docker compose up
```

Compose starts the dashboard, driver, TimescaleDB, and OTEL collector from the working tree. Source
edits are live; rebuilding an image is not required. The dashboard container binds `0.0.0.0` and
Compose pins `AUTH_MODE=github`, so set these in `.env` first:

- `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (or `GITHUB_APP_PRIVATE_KEY_FILE`).
- `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `SESSION_SECRET`.
- `PUBLIC_URL`, the origin GitHub redirects back to. It is required on a non-loopback bind.
- `JOB_BOARD_TOKEN` (`openssl rand -hex 32`). Compose refuses to start without it.

## Offline seeded walkthrough

The offline tools intentionally boot a code-only no-fetch entry rather than adding a production
configuration switch. To browse synthetic data, seed a disposable database and serve it with that
entry:

```bash
docker compose up -d timescale
docker compose exec timescale psql -U factory -d postgres -c 'create database factory_seed'
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_seed npm run seed
npm run build
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_seed WEB_ROOT=web/dist \
  node server/dist/offline.js
```

Then open `http://127.0.0.1:8080`.

To run the browser checks, `npm run verify:ui` resets and seeds its own `factory_e2e` database and
also starts a signed-in board against `factory_auth_e2e`. Create both databases and install the
browser once:

```bash
docker compose exec timescale psql -U factory -d postgres -c 'create database factory_e2e'
docker compose exec timescale psql -U factory -d postgres -c 'create database factory_auth_e2e'
npx playwright install chromium
npm run verify:ui
```

Names ending in `_test`, `_seed`, `_synthetic`, `_demo`, or `_e2e` are disposable. Live application
mode refuses to store fetched history in them.

## Build the deployable image

```bash
docker build -f docker/Dockerfile --target runtime -t factory-ai .
```

The Dockerfile compiles the source in its own build stage, so no host build is needed. The image
serves the compiled SPA and API together on port `8080`; it does not include Compose's development
watchers. It binds `0.0.0.0`, so run it with `AUTH_MODE=github` and its credentials, or set
`AUTH_ALLOW_PUBLIC_BIND=1` only when another layer authenticates requests.
