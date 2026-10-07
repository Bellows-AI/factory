# CI

Two workflows and no configured secret — the only credential either uses is `github.token`, and
`core/test/ci-workflows.test.ts` pins every claim below.

| Concern | Code | Test |
| --- | --- | --- |
| Validation and the browser lane | `.github/workflows/ci.yml` | `core/test/ci-workflows.test.ts` |
| Tag fold, image matrix, scan gate, manifest, chart publish | `.github/workflows/release-image.yml`, `.trivyignore` | `core/test/ci-workflows.test.ts` |
| Release command: patch bump, version-only commit, tag, atomic push | `scripts/release.sh`, `VERSION` | `core/test/release-script.test.ts` |
| The images a release builds | `docker/Dockerfile`, `docker/driver.Dockerfile`, `docker/{claude,opencode}-executor/` | `driver/test/executor-images.test.ts` |
| Browser-lane databases and ports | `e2e/reset-db.mjs`, `playwright.config.ts` | `core/test/e2e-config.test.ts` |

## Invariants

- **`npm run build` precedes `npm test`.** `server` and `web` resolve `@factory-ai/core` to
  `core/dist`, so a broken build must report as a broken build, not as a `pretest` failure buried in
  the test step. `npm run typecheck` follows rather than replaces it: `tsc -b` also covers
  `server/tsconfig.test.json` and `e2e/tsconfig.json`.
- **The `e2e` job runs only on a push to `main`.** It provisions what `npm run verify:ui` cannot: a
  `postgres:17` service matching the image `docker-compose.yml` pins, `factory_e2e` and
  `factory_auth_e2e` created by hand (`e2e/reset-db.mjs` truncates but never creates), and chromium.
- **A push to `main` that changes only `VERSION` skips CI; its tag still validates** — `ci.yml`'s
  `push.paths-ignore` never reaches the `workflow_call` that `release-image.yml` makes. No release
  commit carries `[skip ci]`, which would skip the tag's workflow too.
- **Node is `24`, matching `docker/Dockerfile`'s runtime base** — `engines` says `>=22` and there
  is no `.nvmrc`, so the test comparing the two is the only pin.
- **Every `uses:` on a job holding `packages: write` is GitHub-owned** — which is why Trivy runs as
  a pinned container and helm comes from a checksum-verified tarball. All are pinned by major tag.
- **Each build job builds to a tarball in `/tmp`, scans it, and only then runs `docker login`** —
  the registry credential is never on the runner while a third-party scanner is. Two Trivy passes
  over that tarball: SARIF upload (`--exit-code 0`, `if: always()`, one category per matrix cell)
  and the gate (`--exit-code 1 --scanners vuln,secret --severity CRITICAL,HIGH`) — identical flags,
  with `--ignore-unfixed` and `--skip-files /usr/local/bin/acli` the only narrowings.
- **All four images the chart renders are built, each architecture natively** (`ubuntu-latest`,
  `ubuntu-24.04-arm`); publishing three leaves an install that cannot pull. Each job pushes
  `<image>:<tag>-<arch>` and `manifest` merges the pair. `--provenance=false` is load-bearing, or
  each single-platform push becomes a manifest list and the merge nests lists. The collector image
  is mirrored too, its version read out of `charts/factory/values.yaml` — `global.imageRegistry`
  prefixes every chart reference, and an absolute repository under it fails to render.
- **The chart publishes after `manifest`, never beside it** — a chart resolving before its images
  exist installs cleanly and lands every pod in `ImagePullBackOff`. `--version` is the tag minus
  its leading `v` (SemVer has no `v`); `--app-version` keeps the tag exactly, which lets
  `factory.image` resolve an empty `tag` to `.Chart.AppVersion`. Nothing rewrites values at package
  time; the registry is the only channel (no `docker save`, no `upload-artifact`), and the first
  push creates each package private — see [eks-runbook.md](eks-runbook.md), step 3.

## Stated limits

- A red `npm test` step is not always your change: `driver/test/executor-images.test.ts` and
  `driver/test/review-reply-script.test.ts` spawn real processes and time out under a contended
  runner. Re-run the job — making them deterministic is its own change.
- CI never runs `npm run test:db`, `npm run test:jobs` or `npm run test:k8s`, and no lane runs a real
  cloud cluster — that walk is [eks-runbook.md](eks-runbook.md).
