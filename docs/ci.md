# CI

Four workflows and no configured secret — the only credentials are `github.token` and the `npm` job's OIDC
token, and `core/test/ci-workflows.test.ts` pins every claim below.

| Concern | Code | Test |
| --- | --- | --- |
| Validation, the db suite (`test-db`) and the browser lane | `.github/workflows/ci.yml`, `vitest.db.config.ts` | `core/test/ci-workflows.test.ts` |
| Tag fold, buildkit mirror, image matrix, scan gate, manifest, chart publish | `.github/workflows/release-image.yml`, `.trivyignore` | `core/test/ci-workflows.test.ts` |
| CLI publish: `@bellows-ai/bellows-cli` on npmjs.org, trusted publishing, `VERSION` stamped over `0.0.0` | `.github/workflows/release-image.yml` (`npm`), `cli/package.json`, `cli/src/version.ts` | `core/test/ci-workflows.test.ts`, `cli/test/diagnostics.test.ts` |
| Release command: patch bump, version-only commit, tag, atomic push | `scripts/release.sh`, `VERSION` | `core/test/release-script.test.ts` |
| Release images; separate core/server/web compilation stages and source-only build inputs | `docker/Dockerfile`, `docker/driver.Dockerfile`, `docker/{claude,opencode}-executor/` | `driver/test/executor-images.test.ts`, `driver/test/compose.test.ts` |
| Browser-lane databases and ports | `e2e/reset-db.mjs`, `playwright.config.ts` | `core/test/e2e-config.test.ts` |
| Postgres mirror: the compose pin copied from `mirror.gcr.io` to `ghcr.io/bellows-ai/postgres:17`, weekly and on demand | `.github/workflows/mirror-images.yml` | `core/test/ci-workflows.test.ts` |
| Nightly/on-demand browser lane: `@nightly` specs and the specimen, never on the merge path | `.github/workflows/ui-nightly.yml`, `playwright.nightly.config.ts` | `core/test/ci-workflows.test.ts`, `core/test/e2e-config.test.ts` |

## Invariants

- **`npm run build` precedes `npm test`**, so a broken `core/dist` reports as a build failure; `npm run typecheck`
  follows, covering every `*/tsconfig.test.json` and `e2e/`. `core/test/typecheck-coverage.test.ts`.
- **The `test-db` job runs `npm run test:db` on every pull request**, beside `validate`, against a `postgres:17`
  service whose database ends `_test` — the only coverage the SQL and the migrations have.
  `.github/workflows/ci.yml`, `core/test/ci-workflows.test.ts`.
- **The `e2e` job runs only on a push to `main`**, with a `postgres:17` service, `factory_e2e` and
  `factory_auth_e2e` created by hand (`e2e/reset-db.mjs` truncates but never creates), and chromium.
- **A push to `main` that changes only `VERSION` skips CI; its tag still validates** through the `workflow_call`
  `release-image.yml` makes. No release commit carries `[skip ci]`.
- **Node is `24`, matching `docker/Dockerfile`'s runtime base**; there is no `.nvmrc`, so the test is the only pin.
- **Every base image pulls from `public.ecr.aws/docker/library/`** (Docker Hub rate-limits shared runner IPs).
  Buildkit comes from `public.ecr.aws/vend/moby/buildkit`, pulled once per release by the `buildkit` job into
  `<registry>/buildkit`; every build cell boots from that mirror.
- **No job service pulls from ECR Public**: a service is pulled before any step, so it can neither log in nor retry,
  and ECR Public's per-IP data limit fails it on a shared runner IP. Every `postgres` service pulls the GHCR mirror
  with `github.actor`/`github.token` credentials under `packages: read`. Only the two mirror pulls retry, and only
  on `toomanyrequests`.
- **Every `uses:` on a job holding `packages: write` is GitHub-owned**, pinned by major tag; Trivy runs as a pinned
  container and helm from a checksum-verified tarball.
- **Each build job builds to a tarball, scans it, and only then runs `docker login`**; the one earlier login, for the
  buildkit pull, is logged out before the scan. Two Trivy passes: SARIF upload (`--exit-code 0`) and the gate
  (`--exit-code 1`, `CRITICAL,HIGH`), narrowed only by `--ignore-unfixed` and `--skip-files /usr/local/bin/acli`.
- **All four images the chart renders are built, each architecture natively**, pushed as `<image>:<tag>-<arch>` and
  merged by `manifest`; `--provenance=false` keeps the merge from nesting manifest lists. The collector image is
  mirrored too, its version read from `charts/factory/values.yaml`.
- **The chart publishes after `manifest`, never beside it.** `--version` is the tag minus its `v`; `--app-version`
  is the tag exactly, which `factory.image` falls back to. Each package's first push is private
  ([eks-runbook.md](eks-runbook.md), step 3).
- **`npm` is the only job holding `id-token: write`**, and needs only `validate`. npmjs.com's trusted publisher for
  `@bellows-ai/bellows-cli` must name `Bellows-AI/factory` and `release-image.yml`, or the publish is refused; a tag that
  disagrees with `VERSION` publishes nothing.

## Stated limits

- CI cannot pull `ghcr.io/bellows-ai/postgres:17` until `mirror-images.yml` has run once; a fork pull request
  reads it only while the package grants this repository access.
- `driver/test/executor-images.test.ts` and `driver/test/review-reply-script.test.ts` spawn real processes and can
  time out on a contended runner; re-run the job.
- CI never runs `npm run test:jobs` or `npm run test:k8s`, and no lane runs a real cloud cluster
  ([eks-runbook.md](eks-runbook.md)). `test:jobs` is out because of Linux docker networking: on
  ubuntu-latest 9 checks (the compose-driver and question-round-trip phases of `scripts/test-jobs.sh`)
  need host networking to reach the loopback-only open board ([executor-testing.md](executor-testing.md)).
