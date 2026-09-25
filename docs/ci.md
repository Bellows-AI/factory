# CI

Two workflows, no secrets, no registry. `core/test/ci-workflows.test.ts` pins everything below
that a change could silently break — edit the workflow and the test tells you which promise moved.

## `.github/workflows/ci.yml`

Triggers: pull requests targeting `main`, pushes to `main`, and `workflow_call` — the release
workflow calls it so a tag runs the same gates by reference instead of a copy that drifts.

`validate` runs, in this order: `npm ci`, `npm run lint`, `npm run build`, `npm test`. Every step
is named after the command it runs, so a red job names the gate that broke without opening the log.

**`npm run build` precedes `npm test` because it has to.** `server` and `web` resolve
`@factory-ai/core` to `core/dist`, not `core/src`, so a fresh checkout cannot run the suite until
core is built — 74 suites fail to collect with "Failed to resolve entry for package
@factory-ai/core", which reads like a source bug and is not one. `npm run build` starts with
`-w core`, so the build gate and the test's prerequisite are the same step.

`npm run typecheck` is deliberately not a step. `npm run build` fails on a type error in `src`;
`typecheck` additionally covers `server/tsconfig.test.json`, which the build does not — that gap is
known and out of scope here.

`e2e` runs only on a push to `main` (`needs: validate`): it boots two servers, builds the tree
twice and drives a real chromium, which is too slow to gate every pull request. It provisions what
`npm run verify:ui` cannot provision for itself:

- a `timescale/timescaledb:latest-pg17` service — the same image `docker-compose.yml` pins, and a
  test asserts the two stay equal. `001_init.sql` creates the timescaledb extension and a
  hypertable, so plain postgres does not work.
- `factory_e2e` and `factory_auth_e2e`, created by hand: `e2e/reset-db.mjs` truncates but never
  creates, and `docker/init-databases.sh` only makes `factory_test`. Migrations run inside
  `npm run seed`, so empty databases are enough.
- `npx playwright install --with-deps chromium`.

It reads no repository secret: every credential the auth project uses is a literal stub inside
`playwright.config.ts`. `artifacts/ui/` uploads on success and on failure — a passing assertion says
the DOM was right, only the screenshot says the layout was.

Node is `24`, matching `docker/Dockerfile`'s runtime base; a test compares the two, which is the
only pin there is (`engines` says `>=22` and there is no `.nvmrc`). Concurrency cancels superseded
pull-request runs and never cancels a run on `main`.

## `.github/workflows/release-image.yml`

Triggers on `v*` tags. `validate` calls `ci.yml`; because a called workflow sees the caller's event,
`e2e`'s `if` correctly skips on a tag push. Then `image` builds
`docker build -f docker/Dockerfile --target runtime -t factory-ai:<tag> .`, `docker save`s it and
uploads the tarball for 7 days. No build arg, no credential, no registry — publishing, deployment
and release notes are out of scope until a target registry exists.

## What CI does NOT run

A green pull request has not exercised these; run them locally before trusting a change to them:

- `npm run test:db` — needs a `*_test` TimescaleDB.
- `npm run test:jobs` — needs a docker daemon, four stub runner images and a free port 8129.
- `npm run test:k8s` — needs helm, and kind for `--cluster`.
