# CI

Two workflows and no configured secret: the only credential either uses is `github.token`, the
installation token the run already carries. `core/test/ci-workflows.test.ts` pins everything below
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

- a `postgres:17` service — the same image `docker-compose.yml` pins, and a test asserts the two
  stay equal. Plain postgres since #371: the schema names no extension. The service is still
  called `postgres`, because that name is what the scripts and `playwright.config.ts` reach for.
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
major tag keeps security patches flowing, and there is no Dependabot here to bump a pin. The
registry push did not change that, because it uses no action: `docker login`, `docker buildx` and
`docker buildx imagetools` are `run` steps, so no third party ever sees a job holding
`packages: write`. A test asserts both halves — every `uses:` carries a major tag, and every
`uses:` on the release path is GitHub-owned.

## `.github/workflows/release-image.yml`

Triggers on `v*` tags. `validate` calls `ci.yml`; because a called workflow sees the caller's event,
`e2e`'s `if` correctly skips on a tag push. The git tag is folded into a docker tag first — a docker
tag admits only `[A-Za-z0-9_.-]`, so `v1.0.0+build.1` is a legal git tag that `docker build` would
refuse; everything outside that set becomes a dash. Folding is lossy — `v1.0.0+build.1` and
`v1.0.0-build.1` collapse to one string — so when it changes anything, a 7-character sha1 of the
original ref is appended. A docker tag also stops at 128 characters where a git tag does not, so an
over-long ref is truncated to 120 and carries the same digest. A clean `v1.2.3` is therefore tagged
`v1.2.3` and nothing else — the suffix appears only where the raw ref could not be used. The stated
limit: a tag deliberately named to equal another tag's truncated-plus-digest form would land on the
same image tag. Nothing accidental reaches that case, and always-suffixing to close it would put a
digest on every ordinary release. Every image reference uses that folded value; the raw ref stays
on the run and on the tag itself.

The fold is a job of its own, `tag`, and it also lowercases `github.repository_owner` into
`ghcr.io/<owner>` — GHCR rejects a mixed-case path rather than folding it. Both travel as job
outputs, so there is one fold and one registry string rather than one per job that could drift.

`build` is a matrix of **four images × two architectures**, eight jobs:

| image | built from |
| --- | --- |
| `factory-ai` | `docker/Dockerfile`, `--target runtime` — the dashboard |
| `factory-driver` | `docker/driver.Dockerfile` |
| `claude-executor` | `docker/claude-executor`, `--build-context skills=docker/skills` |
| `opencode-executor` | `docker/opencode-executor`, same shared context |

Those four are what the chart renders; publishing three of them leaves an install that cannot
pull. The flags live in the matrix, not in the script, so a test can read them — it asserts the
set of four by name and each one's build flags.

**Each architecture builds natively**, `ubuntu-latest` for amd64 and `ubuntu-24.04-arm` for
arm64, which are free to public repositories. QEMU would need one job instead of two, but every
executor image runs a full `npm install` plus a `gh`/`acli` download, and under emulation that is
tens of minutes per arch. Both executor Dockerfiles already read `TARGETARCH` for those
downloads, so nothing in them changed.

Each build job pushes `<image>:<tag>-<arch>`; `manifest` then merges each pair into the real tag
with `docker buildx imagetools create`. The alternative — pushing by digest and carrying eight
digests between jobs as artifacts — buys only the absence of those two extra tags in the
registry. `--provenance=false` is load-bearing: an attestation would make each single-platform
push a manifest list of its own, and the merge would nest lists and carry `unknown/unknown`
entries.

### The scan gate

Each build job builds to a **tarball** first (`--output type=docker,dest=/tmp/image.tar`) rather
than pushing: Trivy then reads the exact bytes that would ship, and nothing has left the runner
if it fails. The push step rebuilds with the same flags, which is a cache hit on the same
builder. The tar lands in `/tmp`, never the workspace — for the two images whose context is `.`
it would otherwise be swept into the push build's context.

Two passes over that one tarball. The first writes SARIF with `--exit-code 0` and
`github/codeql-action/upload-sarif@v3` publishes it under a category per matrix cell (one
category holds one result set; eight uploads sharing a name would leave only whichever finished
last). The upload is `if: always()`, because a gate on the SARIF pass would skip the upload on
exactly the runs whose findings matter. The second pass is the gate: `--exit-code 1` on
**`--scanners vuln,secret --severity CRITICAL,HIGH`**.

Two narrowings, both measured rather than assumed, and both applied to the SARIF pass as well so
the Security tab shows what the gate enforces:

- **`--ignore-unfixed`.** 99 of the executors' findings are `bookworm-slim` base packages
  (`perl`, `bsdutils`, `curl`, `libblkid1`) with no upstream patch. Blocking on them does not
  produce a fixed image, it produces a release nobody can cut.
- **`--skip-files /usr/local/bin/acli`.** Atlassian publishes the CLI as a single `latest`
  binary — there is no versioned URL — so its 26 Go stdlib findings have a fix in Go and no
  build to take it from. Scoped to the one path, so the same CVEs still block anywhere else:
  `gh` carried several of them until 2.102.0 and would be caught again. Issue #384 mirrors that
  binary into our own registry, which is what retires the flag.

A test pins both, pins that they are the *only* narrowings (no `--skip-dirs`, no second
`--skip-files`, no `--vuln-type`), pins that the two passes carry identical flags, and pins that
the skip names an issue that retires it.

`docker login` comes *after* the gate. The registry credential is not on the runner while a
third-party scanner container runs, and nothing reaches GHCR the gate has not passed.

Trivy runs as a **pinned container**, not `aquasecurity/trivy-action`: a job holding
`packages: write` should not execute a third-party action, and a scanner that moves under you
turns a release into a bisect. A test pins the version shape and that every `uses:` on this path
is `actions/*` or `github/*`.

The gate is strict on purpose and `.trivyignore` at the repo root is the only valve. An entry
there is a decision with a reason and a revisit date, not a mute button — a growing file means
the base image needs bumping.

**Measured.** `v0.0.0` — the last release before the gate existed — scanned 24 HIGH on the
dashboard, 1 CRITICAL + 28 HIGH on the driver and 33 CRITICAL + 514 HIGH on each executor. Zero
secrets everywhere. What the findings were, and what each cost:

| source | fix |
| --- | --- |
| `fastify` 5.12.1, `@fastify/static` 8.3.0, `fast-uri` | bumped to 5.12.5 / 10.1.5; `npm audit --omit=dev` is clean |
| npm/yarn/corepack bundled in the runtime images (`tar`, `brace-expansion`, `ip-address`, `undici`) | removed from both — nothing at run time shells out to a package manager |
| Go `stdlib` in the vendored docker client | `docker:27-cli` → `docker:29-cli` |
| `node:24-bookworm`'s unused toolchain and media stack (~497 unfixed `linux-libc-dev`) | both executors moved to `-slim` + `apt-get install git curl ca-certificates` |
| `gh` 2.98.0 | 2.102.0 |

One more followed from the numbers: the executors keep npm (the CLI's plugin path uses it), so
npm's own vendored tree ships, and the version `node:24` pins was the last fixable source left.
`ARG NPM_VERSION=11.21.0` — the newest on the 11 line. **Not 12**: npm 12.2.0 fixes the rest and
breaks the build, because `@anthropic-ai/claude-code`'s postinstall does not place its native
binary under it and `claude plugin install` then fails with *"claude native binary not
installed"*. That is why the pin looks a minor behind and must stay there.

**Where that lands: every image passes the gate.** Dashboard and driver report nothing at all.
Each executor reports three findings, all inside npm's own bundle and none reachable from
anything a runner invokes — two `brace-expansion` and one `undici` — and those three ids are the
entire contents of `.trivyignore`, each with the reason above and a revisit condition.

### Two smaller things

Two smaller things the jobs do on purpose. `docker buildx create --use --driver docker-container`
runs first because the default builder uses the `docker` driver, which cannot `--push` at all.
And `manifest` mirrors the collector — `global.imageRegistry` prefixes *every* reference the
chart renders, the collector included, and an absolute repository under a set prefix is refused
at render, so an unmirrored collector is an install that will not come up. Its version is read
out of `charts/factory/values.yaml` rather than pinned in the workflow: two pins drift, one
cannot, and the step fails loudly if the chart stops spelling it there.

No tarball. The registry is the distribution channel, and a `docker save` artifact beside it
would be a second copy with its own lifetime, ageing separately from the tag the chart's values
name. A test asserts there is no `docker save` and no `upload-artifact` on this path.

**The first push creates a private package.** Make each of the five public — GitHub → the org →
Packages → the package → Package settings → Change visibility — and nodes pull with no
`imagePullSecrets` and no node-role change. Private works too; the chart's `imagePullSecrets`
reach every chart pod and every pod the driver specs.

### The chart is published too

`chart` packages `charts/factory` and pushes it to `oci://ghcr.io/<owner>/charts`, after
`manifest` and never beside it: a chart that resolves before its images exist installs cleanly and
then lands every pod in `ImagePullBackOff`. Without this step the only way to install a release is
to clone the repository at the right tag, which no GitOps controller does — ArgoCD resolves a
chart from a registry by version, and a deployment repository holds values, not a vendored copy of
these templates.

Two versions, deliberately different. `--version` is the tag with its leading `v` stripped,
because a `Chart.yaml` version must be SemVer and SemVer has no `v`. `--app-version` keeps the tag
exactly as spelled, and that one is load-bearing rather than decorative: `factory.image` resolves
an empty `tag` to `.Chart.AppVersion`, so a packaged chart names the dashboard, driver and
collector images of *its own release* with no value set anywhere. The two executor references are
the exception — bare repository strings with no tag field — so a deployment pins those itself
(docs/eks-runbook.md, step 3).

Nothing rewrites values at package time. A chart whose committed defaults differ from what CI
renders is a chart nobody can reproduce locally.

helm is installed from the official tarball and checksum-verified rather than through
`azure/setup-helm`, for the same reason the Trivy scan is a container and not an action: every
`uses:` on a job holding `packages: write` stays GitHub-owned. A test pins that rule, so a
third-party action added here fails the suite rather than the release.

Deployment and release notes are still out of scope.

## A red `npm test` step is not always your change

`driver/test/executor-images.test.ts` and `driver/test/review-reply-script.test.ts` spawn real
processes and time them out; under a contended runner they fail intermittently, a different case
each run, and pass when run alone. Re-run the job before hunting a bug in your diff — and if you
can make them deterministic, that is its own change, not a `continue-on-error` on this job.

## What CI does NOT run

A green pull request has not exercised these; run them locally before trusting a change to them:

- `npm run test:db` — needs a `*_test` PostgreSQL 17.
- `npm run test:jobs` — needs a docker daemon, four stub runner images and a free port 8129.
- `npm run test:k8s` — needs helm, and kind for `--cluster`. The offline phase also renders an
  EKS-shaped value set (#364), which needs nothing but helm; no lane runs a real cloud cluster —
  that is the open decision the issue records, walked by hand per `docs/eks-runbook.md`.
