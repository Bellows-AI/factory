# CI

Two workflows, no secrets, no registry. `core/test/ci-workflows.test.ts` pins everything below
that a change could silently break — edit the workflow and the test tells you which promise moved.

## `.github/workflows/ci.yml`

Triggers: pull requests targeting `main`, pushes to `main`, and `workflow_call` — the release
workflow calls it so a tag runs the same gates by reference instead of a copy that drifts.

`validate` runs, in this order: `npm ci`, `npm run lint`, `npm run build`, `npm run typecheck`,
`npm test`. Every step is named after the command it runs, so a red job names the gate that broke
without opening the log.

**`npm run build` precedes `npm test` on purpose.** `server` and `web` resolve `@factory-ai/core`
to `core/dist`, not `core/src`; `package.json`'s `pretest` builds core so the suite stands alone,
but only `npm run build` also builds server, web and driver. Running it first means a broken build
reports as a broken build, rather than as a `pretest` failure buried in the test step.

`npm run typecheck` follows the build rather than replacing it: the build fails on a type error in
`src`, and `tsc -b` additionally covers `server/tsconfig.test.json`, so the db-test harness cannot
drift out of type without CI noticing.

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
only pin there is (`engines` says `>=22` and there is no `.nvmrc`). Pull requests share a per-ref
concurrency group, so a new push supersedes the old run; every other event gets a group of its own,
because only one run may sit pending per group and a shared group would let a third merge to `main`
cancel the second's validation outright.

Actions are referenced by major tag (`@v4`), not by commit sha — all three are GitHub-owned, the
major tag keeps security patches flowing, and there is no Dependabot here to bump a pin. Revisit
that if the release path ever gains a registry push.

## `.github/workflows/release-image.yml`

Triggers on `v*` tags. `validate` calls `ci.yml`; because a called workflow sees the caller's event,
`e2e`'s `if` correctly skips on a tag push. The git tag is folded into a docker tag first — a docker
tag admits only `[A-Za-z0-9_.-]`, so `v1.0.0+build.1` is a legal git tag that `docker build` would
refuse; everything outside that set becomes a dash. Folding is lossy — `v1.0.0+build.1` and
`v1.0.0-build.1` collapse to one string — so when it changes anything, a 7-character sha1 of the
original ref is appended. The image tag, the tarball name and the artifact name all use that folded
value; the raw ref stays on the run and on the tag itself. Nothing downstream carries the raw ref,
because a git ref may legally contain a pipe and an artifact name may not. Then `image` builds
`docker build -f docker/Dockerfile --target runtime -t factory-ai:<tag> .`, `docker save`s it and
uploads the tarball for 7 days. No build arg, no credential, no registry — publishing, deployment
and release notes are out of scope until a target registry exists.

## A red `npm test` step is not always your change

`driver/test/executor-images.test.ts` and `driver/test/review-reply-script.test.ts` spawn real
processes and time them out; under a contended runner they fail intermittently, a different case
each run, and pass when run alone. Re-run the job before hunting a bug in your diff — and if you
can make them deterministic, that is its own change, not a `continue-on-error` on this job.

## What CI does NOT run

A green pull request has not exercised these; run them locally before trusting a change to them:

- `npm run test:db` — needs a `*_test` TimescaleDB.
- `npm run test:jobs` — needs a docker daemon, four stub runner images and a free port 8129.
- `npm run test:k8s` — needs helm, and kind for `--cluster`.
