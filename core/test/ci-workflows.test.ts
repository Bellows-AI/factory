import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
    name?: string;
    run?: string;
    uses?: string;
    if?: string;
    with?: Record<string, string>;
    env?: Record<string, string>;
}

interface Job {
    uses?: string;
    // A single dependency is written as a scalar, several as a sequence.
    needs?: string | string[];
    if?: string;
    permissions?: unknown;
    steps?: Step[];
    env?: Record<string, string>;
    services?: Record<string, { image: string }>;
    strategy?: { matrix?: { image?: { name: string; context: string; args: string }[]; arch?: string[] } };
}

interface Workflow {
    on: Record<string, { branches?: string[]; tags?: string[]; paths?: string[]; 'paths-ignore'?: string[] } | null>;
    permissions?: unknown;
    concurrency?: { group: string; 'cancel-in-progress': unknown };
    jobs: Record<string, Job>;
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const load = <T>(path: string) => parse(read(path)) as T;
const workflow = (path: string) => load<Workflow>(path);

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release-image.yml';
const UI_RUNNER = '.github/workflows/ui-runner-image.yml';
const UI_DOCKERFILE = 'docker/ui-runner.Dockerfile';

// yaml parses with the 1.2 core schema, so the `on:` key stays the string 'on' rather than
// folding to the boolean true the way a 1.1 parser would.
const triggers = (doc: Workflow) => doc.on;
const needs = (job: Job) => [job.needs ?? []].flat();
// A job that reuses another workflow (`uses:`) carries no steps at all.
const runSteps = (job: Job) =>
    (job.steps ?? []).filter((step): step is Step & { run: string } => step.run !== undefined);
const runs = (job: Job) => runSteps(job).map((step) => step.run.trim());

describe('ci workflows', () => {
    it('validates every pull request to main and every push to main', () => {
        const on = triggers(workflow(CI));
        expect(on.pull_request!.branches).toContain('main');
        expect(on.push!.branches).toContain('main');
    });

    // `npm run release` pushes one commit touching only VERSION alongside its tag; the tag's
    // release workflow validates that exact commit, so the branch push need not run it twice.
    it('skips main-branch CI for a VERSION-only push, and nothing else', () => {
        const on = triggers(workflow(CI));
        expect(on.push!['paths-ignore']).toEqual(['VERSION']);
        expect(on.push!.paths).toBeUndefined();
        expect(on.pull_request!['paths-ignore']).toBeUndefined();
        expect(on.pull_request!.paths).toBeUndefined();
        expect('workflow_call' in on).toBe(true);
    });

    // Path filters never reach a `workflow_call`, but `[skip ci]` on the tagged commit would skip
    // the tag's push workflow outright.
    it('still validates the release tag through the called workflow', () => {
        const doc = workflow(RELEASE);
        const push = triggers(doc).push!;
        expect(push.tags).toContain('v*');
        expect(push.paths).toBeUndefined();
        expect(push['paths-ignore']).toBeUndefined();
        expect(push.branches).toBeUndefined();
        const called = Object.entries(doc.jobs).find(([, job]) => job.uses === './.github/workflows/ci.yml');
        expect(needs(doc.jobs.build!)).toContain(called![0]);
        for (const path of [CI, RELEASE, 'scripts/release.sh']) {
            expect(read(path)).not.toMatch(/\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i);
        }
    });

    it('installs dependencies from the lockfile, never loosely', () => {
        const commands = runs(workflow(CI).jobs.validate!);
        expect(commands[0]).toBe('npm ci');
        expect(commands.some((command) => /npm install/.test(command))).toBe(false);
    });

    it('runs the three validation commands', () => {
        const commands = runs(workflow(CI).jobs.validate!);
        expect(commands).toContain('npm run lint');
        expect(commands).toContain('npm run build');
        expect(commands).toContain('npm test');
        // Not redundant with the build: tsc -b also covers server/tsconfig.test.json.
        expect(commands).toContain('npm run typecheck');
    });

    it('builds core before the suite that resolves @factory-ai/core to core/dist', () => {
        const commands = runs(workflow(CI).jobs.validate!);
        expect(commands.indexOf('npm run build')).toBeLessThan(commands.indexOf('npm test'));
    });

    // A failing job reports its step name, so an unnamed step hides the gate that broke; the
    // validation steps carry their command verbatim as the name.
    it('names every step after the command it runs', () => {
        for (const path of [CI, RELEASE, UI_RUNNER]) {
            for (const job of Object.values(workflow(path).jobs)) {
                for (const step of runSteps(job)) {
                    expect(step.name, `${path}: unnamed step running: ${step.run}`).toBeTruthy();
                }
            }
        }
        for (const step of runSteps(workflow(CI).jobs.validate!)) {
            expect(step.run.trim(), `${step.name} does not run its own name`).toBe(step.name);
        }
    });

    it('runs on the node major the runtime image ships', () => {
        const imageMajor = /FROM public\.ecr\.aws\/docker\/library\/node:(\d+)-alpine AS runtime/.exec(
            read('docker/Dockerfile')
        )?.[1];
        expect(imageMajor).toBeTruthy();
        const setups = Object.values(workflow(CI).jobs).flatMap((job) =>
            (job.steps ?? []).filter((step) => step.uses?.startsWith('actions/setup-node@'))
        );
        expect(setups.length).toBeGreaterThan(0);
        for (const step of setups) {
            expect(String(step.with!['node-version']).split('.')[0]).toBe(imageMajor);
        }
    });

    // GitHub-hosted runners share egress IPs, and Docker Hub rate-limits anonymous pulls per IP:
    // a release whose every build answers 429 cannot be cut. ECR Public mirrors the same official
    // images with no such limit and no credential.
    it('pulls every base image and the CI postgres from the ECR Public mirror, never Docker Hub', () => {
        const dockerfiles = [
            'docker/Dockerfile',
            'docker/driver.Dockerfile',
            UI_DOCKERFILE,
            'docker/claude-executor/Dockerfile',
            'docker/opencode-executor/Dockerfile',
        ];
        for (const path of dockerfiles) {
            // A stage or a named build context (`--from=skills`) is a bare word; an image carries a
            // tag or a path.
            const refs = [...read(path).matchAll(/^FROM (\S+)|--from=(\S+)/gm)]
                .map((match) => match[1] ?? match[2]!)
                .filter((ref) => /[:/]/.test(ref));
            expect(refs.length, path).toBeGreaterThan(0);
            for (const ref of refs) expect(ref, path).toMatch(/^public\.ecr\.aws\/docker\/library\//);
        }
        expect(workflow(CI).jobs.e2e!.services!.postgres!.image).toMatch(/^public\.ecr\.aws\/docker\/library\//);
        // The docker-container builder runs buildkit as an image of its own, Docker Hub's by default.
        for (const path of [RELEASE, UI_RUNNER]) {
            const create = runs(workflow(path).jobs.build!).find((run) => run.startsWith('docker buildx create'));
            expect(create, path).toContain('--driver-opt image=public.ecr.aws/vend/moby/buildkit:');
        }
    });

    it('runs the browser suite only on merges to main', () => {
        const e2e = workflow(CI).jobs.e2e!;
        expect(needs(e2e)).toContain('validate');
        expect(e2e.if).toContain('refs/heads/main');
        expect(e2e.if).toContain('push');
    });

    it('gives the browser suite a postgres service and the two databases it names', () => {
        const e2e = workflow(CI).jobs.e2e!;
        const compose = load<{ services: Record<string, { image: string }> }>('docker-compose.yml');
        expect(e2e.services!.postgres!.image).toBe(compose.services.postgres!.image);
        // Plain PostgreSQL since #371 dropped the extension: no TimescaleDB image anywhere.
        expect(e2e.services!.postgres!.image).not.toMatch(/timescale/i);
        const commands = runs(e2e).join('\n');
        expect(commands).toContain('create database factory_e2e');
        expect(commands).toContain('create database factory_auth_e2e');
        expect(commands).toContain('playwright install');
        expect(commands).toContain('npm run verify:ui');
    });

    it('builds every image the chart renders, on a v* tag', () => {
        const doc = workflow(RELEASE);
        expect(triggers(doc).push!.tags).toContain('v*');
        const called = Object.entries(doc.jobs).find(([, job]) => job.uses === './.github/workflows/ci.yml');
        expect(called, 'the release workflow does not reuse the validation workflow').toBeTruthy();
        const build = doc.jobs.build!;
        expect(needs(build)).toContain(called![0]);
        // The four the chart names. Publishing three of them leaves an install that cannot pull.
        const matrix = build.strategy!.matrix!.image!;
        expect(matrix.map((entry) => entry.name).sort()).toEqual([
            'claude-executor',
            'factory-ai',
            'factory-driver',
            'opencode-executor',
        ]);
        const byName = new Map(matrix.map((entry) => [entry.name, entry]));
        expect(byName.get('factory-ai')!.args).toContain('-f docker/Dockerfile');
        // The dashboard is the runtime stage, never the builder.
        expect(byName.get('factory-ai')!.args).toContain('--target runtime');
        expect(byName.get('factory-driver')!.args).toContain('-f docker/driver.Dockerfile');
        // The executors read a shared context; without the flag the build fails inside the image.
        for (const name of ['claude-executor', 'opencode-executor']) {
            expect(byName.get(name)!.args).toContain('--build-context skills=docker/skills');
            expect(byName.get(name)!.context).toBe(`docker/${name}`);
        }
    });

    // `v1.0.0+build.1` is a legal git tag and an illegal docker tag; without normalization the
    // push dies at `docker buildx build` and the release ships nothing.
    it('folds a git tag into a tag docker accepts', () => {
        const doc = workflow(RELEASE);
        const normalize = Object.values(doc.jobs)
            .flatMap(runSteps)
            .find((step) => step.run.includes('IMAGE_TAG='));
        expect(normalize, 'the git tag reaches docker unnormalized').toBeTruthy();
        // Bound as an env value, because a ref name may contain a backtick or a $.
        expect(normalize!.env!.TAG).toMatch(/^\$\{\{ github\.ref_name \}\}$/);
        expect(normalize!.run).toMatch(/tr -c 'A-Za-z0-9_\.-'/);
        // Folding is lossy, so a digest of the original keeps two refs that fold alike apart.
        expect(normalize!.run).toMatch(/sha1sum/);
        // A docker tag is 128 characters at most; a git tag is not, so the fold truncates to
        // leave room for the digest (120 + '-' + 7).
        expect(normalize!.run).toMatch(/cut -c1-120/);
        expect(normalize!.run).toMatch(/\$\{#TAG\} -gt 128/);
        // One job folds; everything downstream reads that output, so the fold cannot be done
        // twice and differently.
        expect(normalize!.run).toContain('$GITHUB_OUTPUT');
        for (const name of ['build', 'manifest']) {
            const job = doc.jobs[name]!;
            expect(needs(job), `${name} does not read the folded tag`).toContain('tag');
            const values = (job.steps ?? []).flatMap((step) => Object.values(step.env ?? {}));
            expect(values.some((value) => /\$\{\{ needs\.tag\.outputs\.image-tag \}\}/.test(value))).toBe(true);
        }
    });

    // The bare defaults resolve to docker.io/library/* on any remote cluster, so a release that
    // does not publish is a release nobody outside a kind node can install.
    it('publishes to GHCR under the repository owner', () => {
        const doc = workflow(RELEASE);
        const commands = Object.values(doc.jobs).flatMap(runs).join('\n');
        expect(commands).toContain('docker login ghcr.io');
        // GHCR rejects a mixed-case path rather than folding it, and an org login may be mixed.
        const fold = Object.values(doc.jobs)
            .flatMap(runSteps)
            .find((step) => step.run.includes('registry=ghcr.io'))!;
        expect(fold.run).toMatch(/tr 'A-Z' 'a-z'/);
        expect(fold.env!.OWNER).toMatch(/^\$\{\{ github\.repository_owner \}\}$/);
        // Every reference pushed is built from that registry value, never a literal.
        expect(commands).not.toMatch(/-t "ghcr\.io\//);
    });

    // Every executor image runs a full npm install; under QEMU that is tens of minutes per arch.
    it('builds each architecture natively and merges the pair into one tag', () => {
        const build = workflow(RELEASE).jobs.build!;
        expect(build.strategy!.matrix!.arch).toEqual(['amd64', 'arm64']);
        const commands = runs(build).join('\n');
        // The default builder uses the `docker` driver, which cannot push at all.
        expect(commands).toContain('docker buildx create');
        expect(commands).toContain('--platform "linux/$ARCH"');
        expect(commands).toContain('--push');
        // An attestation would make each single-platform push a manifest list of its own, and the
        // merge below would then nest lists and carry unknown/unknown entries.
        expect(commands).toContain('--provenance=false');
        const merge = runs(workflow(RELEASE).jobs.manifest!).join('\n');
        expect(merge).toContain('docker buildx imagetools create');
        expect(merge).toContain('$IMAGE_TAG-amd64');
        expect(merge).toContain('$IMAGE_TAG-arm64');
    });

    // global.imageRegistry prefixes every reference the chart renders, the collector included,
    // and an absolute repository under a set prefix is refused at render — so an unmirrored
    // collector is an install that cannot come up, not a convenience.
    it('mirrors the collector image the chart pins, reading the pin from the chart', () => {
        const manifest = workflow(RELEASE).jobs.manifest!;
        const mirror = runSteps(manifest).find((step) => step.run.includes('opentelemetry-collector-contrib'));
        expect(mirror, 'the collector is never mirrored under the registry prefix').toBeTruthy();
        // Read from the chart rather than pinned here: two pins drift, one cannot.
        expect(mirror!.run).toContain('charts/factory/values.yaml');
        expect(mirror!.run).not.toMatch(/collector-contrib:[\d.]+/);
    });

    // A release nobody can resolve by version is a release only this repository can install. The
    // chart goes to the same registry as the images, under `<owner>/charts` so it does not collide
    // with the `factory-ai` image package in the same namespace.
    it('publishes the chart as an OCI artifact beside the images it names', () => {
        const chart = workflow(RELEASE).jobs.chart!;
        expect(chart, 'the chart is not published at all').toBeTruthy();
        const commands = runs(chart).join('\n');
        expect(commands).toContain('helm package charts/factory');
        expect(commands).toMatch(/helm push .* "oci:\/\/\$REGISTRY\/charts"/);
    });

    // The images must exist before anything can resolve the chart that names them: a chart
    // published first is one that installs and then lands every pod in ImagePullBackOff.
    it('publishes the chart only after the images it names are pushed', () => {
        expect(needs(workflow(RELEASE).jobs.chart!)).toContain('manifest');
    });

    // `factory.image` resolves an empty `tag` to .Chart.AppVersion, so --app-version is what makes
    // a packaged chart name its own release without any value being set. A SemVer `version` has no
    // leading `v`; the app version keeps the tag as it is spelled, because that IS the image tag.
    it('packages the chart at the release version and carries the tag as the app version', () => {
        const commands = runs(workflow(RELEASE).jobs.chart!).join('\n');
        // A regex rather than a literal: the shell expansion reads as a template placeholder to
        // noTemplateCurlyInString, and the rule is right about every case but this one.
        expect(commands).toMatch(/VERSION="\$\{IMAGE_TAG#v}"/);
        expect(commands).toContain('--version "$VERSION"');
        expect(commands).toContain('--app-version "$IMAGE_TAG"');
    });

    it('never interpolates a ref name into shell text', () => {
        for (const path of [RELEASE, UI_RUNNER]) {
            for (const job of Object.values(workflow(path).jobs)) {
                for (const step of runSteps(job)) {
                    expect(step.run, `${path}: ${step.name} interpolates an expression into its script`).not.toMatch(
                        /\$\{\{/
                    );
                }
            }
        }
    });

    // The registry is the distribution channel; a tarball beside it would be a second artifact
    // with its own tag, aging separately from the one the chart's values name.
    it('ships the release through the registry and not as a tarball', () => {
        const doc = workflow(RELEASE);
        const commands = Object.values(doc.jobs).flatMap(runs).join('\n');
        expect(commands).not.toContain('docker save');
        for (const job of Object.values(doc.jobs)) {
            for (const step of job.steps ?? []) {
                expect(step.uses ?? '', 'the release image is still uploaded as an artifact').not.toMatch(
                    /^actions\/upload-artifact@/
                );
            }
        }
    });

    // `github.token` is the installation token the run already carries. Nothing on either path is
    // a credential somebody has to mint, store and rotate.
    it('needs no configured secret on the validation or publish path', () => {
        for (const path of [CI, RELEASE, UI_RUNNER]) {
            expect(read(path), `${path} reads a repository secret`).not.toMatch(/secrets\./);
        }
        expect(read(RELEASE)).toMatch(/\$\{\{ github\.token \}\}/);
        expect(read(UI_RUNNER)).toMatch(/\$\{\{ github\.token \}\}/);
    });

    it('grants each workflow only the access its job needs', () => {
        expect(workflow(CI).permissions, CI).toEqual({ contents: 'read' });
        // Packages for the push, security-events for the scan's SARIF, and no contents: write —
        // so a release can never move a ref.
        expect(workflow(RELEASE).permissions, RELEASE).toEqual({
            contents: 'read',
            packages: 'write',
            'security-events': 'write',
        });
        // The ui runner's tag job only reads the lockfile, so the write scopes sit on the jobs that
        // publish; a job-level block replaces the workflow default, hence build's own contents: read.
        const ui = workflow(UI_RUNNER);
        expect(ui.permissions, UI_RUNNER).toEqual({ contents: 'read' });
        expect(ui.jobs.tag!.permissions, `${UI_RUNNER}: tag`).toBeUndefined();
        expect(ui.jobs.build!.permissions, `${UI_RUNNER}: build`).toEqual({
            contents: 'read',
            packages: 'write',
            'security-events': 'write',
        });
        expect(ui.jobs.manifest!.permissions, `${UI_RUNNER}: manifest`).toEqual({ packages: 'write' });
    });

    // Nothing pushes with the checkout credential, and the build job mounts the workspace into the
    // scanner container, so the token must not be left in `.git/config`.
    it('does not persist the checkout credential in the ui runner workflow', () => {
        const checkouts = Object.values(workflow(UI_RUNNER).jobs)
            .flatMap((job) => job.steps ?? [])
            .filter((step) => step.uses?.startsWith('actions/checkout@'));
        expect(checkouts).toHaveLength(2);
        for (const step of checkouts) {
            expect(step.with?.['persist-credentials']).toBe(false);
        }
    });

    // The whole point of the gate: an image that fails it must not exist in the registry, so the
    // scan has to sit between the build and both the credential and the push.
    it('scans every image before it is pushed, and before the registry credential is on the runner', () => {
        const build = workflow(RELEASE).jobs.build!;
        const names = (build.steps ?? []).map((step) => step.name ?? step.uses ?? '');
        const gate = names.findIndex((name) => name.includes('--exit-code 1'));
        const login = names.findIndex((name) => name.includes('docker login'));
        const push = names.findIndex((name) => name.includes('--push'));
        expect(gate, 'nothing in the build job fails on a finding').toBeGreaterThan(-1);
        expect(gate).toBeLessThan(login);
        expect(gate).toBeLessThan(push);
        // Scanned from a tarball, so the bytes the gate reads are the bytes the push sends and
        // nothing has left the runner before the verdict.
        const commands = runs(build).join('\n');
        expect(commands).toContain('--output type=docker,dest=/tmp/image.tar');
        expect(commands).toContain('--input /tmp/image.tar');
        // The tar may not land in the workspace: for the two images whose context is `.` it would
        // be swept into the push build's context.
        expect(commands).not.toMatch(/dest=\$?\{?(PWD|GITHUB_WORKSPACE)/);
    });

    it('gates on secrets and on CRITICAL and HIGH, and pins the scanner', () => {
        const build = workflow(RELEASE).jobs.build!;
        const gate = runSteps(build).find((step) => step.name!.includes('--exit-code 1'))!;
        expect(gate.run).toContain('--scanners vuln,secret');
        expect(gate.run).toContain('--severity CRITICAL,HIGH');
        expect(read('.trivyignore')).toBeTruthy();
        // A scanner that moves under you turns a release into a bisect.
        expect(build.env!.TRIVY_IMAGE).toMatch(/^ghcr\.io\/aquasecurity\/trivy:\d+\.\d+\.\d+$/);
    });

    // Two narrowings, and the gate is only honest while both stay this narrow.
    it('narrows the gate by unfixed findings and by the one unpinnable binary, and no further', () => {
        const build = workflow(RELEASE).jobs.build!;
        const scans = runSteps(build).filter((step) => /trivy/i.test(step.run));
        expect(scans).toHaveLength(2);
        for (const step of scans) {
            // Blocking on a base package with no upstream patch does not produce a fixed image.
            expect(step.run, `${step.name} does not skip unfixed findings`).toContain('--ignore-unfixed');
            // Scoped to the one path Atlassian publishes as a single `latest` binary, so the same
            // CVEs still block anywhere else — gh carried several of them until 2.102.0.
            expect(step.run).toContain('--skip-files /usr/local/bin/acli');
            const skipped = [...step.run.matchAll(/--skip-files (\S+)/g)].map((match) => match[1]);
            expect(skipped, `${step.name} skips more than acli`).toEqual(['/usr/local/bin/acli']);
            // Narrowing the severity or dropping the secret scanner would hollow it out instead.
            expect(step.run).not.toMatch(/--skip-dirs|--vuln-type|--scanners vuln\b(?!,)/);
        }
        // Both passes carry the same flags, or the Security tab shows a different set from the
        // one the gate enforces.
        const flags = scans.map((step) => [...step.run.matchAll(/--[a-z-]+(?: [^\s\\]+)?/g)].map((m) => m[0]));
        const shared = flags.map((list) => list.filter((flag) => !/format|output|exit-code/.test(flag)).sort());
        expect(shared[0]).toEqual(shared[1]);
        // The skip is a stopgap with an owner, not a permanent carve-out. Read from the file
        // rather than the parsed job: the reference lives in a YAML comment, which the parser drops.
        expect(read(RELEASE), 'the acli skip names no issue that retires it').toMatch(/#\d+ tracks/);
    });

    // A gate on the SARIF pass would skip the upload on exactly the runs whose findings matter.
    it('uploads the SARIF even when the gate fails, under a category per matrix cell', () => {
        const build = workflow(RELEASE).jobs.build!;
        const sarif = runSteps(build).find((step) => step.run.includes('--format sarif'))!;
        expect(sarif.run).toContain('--exit-code 0');
        const upload = (build.steps ?? []).find((step) => step.uses?.startsWith('github/codeql-action/upload-sarif'))!;
        expect(upload, 'the scan result never reaches the Security tab').toBeTruthy();
        expect(upload.if).toBe('always()');
        // One category holds one result set: eight uploads sharing a name would leave only
        // whichever finished last.
        expect(upload.with!.category).toContain('matrix.image.name');
        expect(upload.with!.category).toContain('matrix.arch');
    });

    // Only one run sits pending per group, so a group shared across merges to main would let a
    // third push cancel the second's validation outright.
    it('supersedes pull-request runs and never queues two merges against each other', () => {
        const concurrency = workflow(CI).concurrency!;
        expect(concurrency.group).toContain('github.ref');
        expect(concurrency.group).toContain('github.run_id');
        expect(String(concurrency['cancel-in-progress'])).toContain('pull_request');
    });

    // Inside a called workflow the github context is the CALLER's, so a group built from
    // ${{ github.workflow }} would resolve to the same string in both files and the tag run would
    // queue behind itself forever. Neither group may name github.workflow, and the two must differ.
    it('does not make the called workflow wait on its own caller', () => {
        const groups = [CI, RELEASE, UI_RUNNER].map((path) => workflow(path).concurrency!.group);
        for (const group of groups) expect(group).not.toContain('github.workflow');
        expect(new Set(groups).size).toBe(groups.length);
    });

    it('pins every action to a major version', () => {
        for (const path of [CI, RELEASE, UI_RUNNER]) {
            for (const job of Object.values(workflow(path).jobs)) {
                for (const step of job.steps ?? []) {
                    if (step.uses) expect(step.uses, `${path}: ${step.uses} is not pinned`).toMatch(/@v\d+$/);
                }
            }
        }
        // The publish jobs hold `packages: write`, so every action on that path is GitHub-owned —
        // `actions/*` or `github/*`. The registry work and the scan are `run` steps calling a
        // CLI, which is what keeps aquasecurity/trivy-action off a job holding a token.
        for (const path of [RELEASE, UI_RUNNER]) {
            for (const job of Object.values(workflow(path).jobs)) {
                for (const step of job.steps ?? []) {
                    if (step.uses) {
                        expect(step.uses, `${path}: ${step.uses} runs beside packages: write`).toMatch(
                            /^(actions|github)\//
                        );
                    }
                }
            }
        }
    });
});

describe('ui runner image', () => {
    const dockerfile = () => read(UI_DOCKERFILE);
    const lockedPlaywright = () =>
        load<{ packages: Record<string, { version: string }> }>('package-lock.json').packages[
            'node_modules/playwright'
        ]!.version;

    it('ships node, the chromium playwright installs, its system deps and a postgres client', () => {
        const runtimeMajor = /FROM public\.ecr\.aws\/docker\/library\/node:(\d+)-alpine AS runtime/.exec(
            read('docker/Dockerfile')
        )?.[1];
        // Debian, not alpine: playwright publishes no musl chromium.
        expect(dockerfile()).toMatch(
            new RegExp(`^FROM public\\.ecr\\.aws/docker/library/node:${runtimeMajor}-bookworm-slim$`, 'm')
        );
        // git too: matrix.spec.ts and baseline.spec.ts read `git rev-parse HEAD`.
        expect(dockerfile()).toContain('apt-get install -y --no-install-recommends git postgresql-client');
        // The gate runs npm, so the base image's bundled copy is replaced rather than deleted; its
        // vendored tree is what the scan gate would otherwise block on.
        expect(dockerfile()).toMatch(/npm install -g "npm@\$\{NPM_VERSION\}"/);
        expect(dockerfile()).toMatch(/npx -y "playwright@\$\{PLAYWRIGHT_VERSION\}" install --with-deps chromium/);
        // A gate runs as uid 1000 with HOME=/tmp, so the browsers live outside root's home and are
        // readable by anyone.
        expect(dockerfile()).toContain('ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright');
        expect(dockerfile()).toContain('chmod -R a+rX /ms-playwright');
    });

    // The browser revision belongs to the playwright release, so the image takes the version the
    // lockfile resolves rather than carrying a second pin that could drift from it.
    it('takes the playwright version from the lockfile and refuses to build without one', () => {
        expect(dockerfile()).toMatch(/^ARG PLAYWRIGHT_VERSION$/m);
        expect(dockerfile()).toContain('test -n "$PLAYWRIGHT_VERSION"');
        const doc = workflow(UI_RUNNER);
        const version = Object.values(doc.jobs)
            .flatMap(runSteps)
            .find((step) => step.run.includes('package-lock.json'));
        expect(version, 'the version is not read from the lockfile').toBeTruthy();
        expect(version!.run).toContain('node_modules/playwright');
        expect(version!.run).toContain('$GITHUB_OUTPUT');
        const commands = Object.values(doc.jobs).flatMap(runs).join('\n');
        expect(commands).toContain('--build-arg PLAYWRIGHT_VERSION="$PLAYWRIGHT_VERSION"');
        expect(read(UI_RUNNER)).not.toContain(lockedPlaywright());
    });

    it('rebuilds when the Dockerfile or the lockfile changes on main', () => {
        const on = triggers(workflow(UI_RUNNER));
        expect(on.push!.branches).toEqual(['main']);
        expect(on.push!.paths!.sort()).toEqual(
            [UI_DOCKERFILE, '.github/workflows/ui-runner-image.yml', 'package-lock.json'].sort()
        );
        expect('workflow_dispatch' in on).toBe(true);
        // A manual run is free to start anywhere; only main may publish the tag gates pull.
        expect(workflow(UI_RUNNER).jobs.tag!.if).toBe("github.ref == 'refs/heads/main'");
    });

    it('publishes a tag named for the playwright version under the lowercased owner', () => {
        const commands = Object.values(workflow(UI_RUNNER).jobs).flatMap(runs).join('\n');
        expect(commands).toContain('tag=playwright-');
        expect(commands).toMatch(/tr 'A-Z' 'a-z'/);
        expect(commands).toContain('$REGISTRY/factory-ui-runner:$IMAGE_TAG');
        expect(commands).not.toMatch(/-t "ghcr\.io\//);
    });

    it('builds each architecture natively and merges the pair into one tag', () => {
        const doc = workflow(UI_RUNNER);
        const build = doc.jobs.build!;
        expect(build.strategy!.matrix!.arch).toEqual(['amd64', 'arm64']);
        const commands = runs(build).join('\n');
        expect(commands).toContain('docker buildx create');
        expect(commands).toContain('--platform "linux/$ARCH"');
        expect(commands).toContain('--provenance=false');
        expect(commands).toContain(`-f ${UI_DOCKERFILE}`);
        const merge = runs(doc.jobs.manifest!).join('\n');
        expect(needs(doc.jobs.manifest!)).toContain('build');
        expect(merge).toContain('docker buildx imagetools create');
        expect(merge).toContain('$IMAGE_TAG-amd64');
        expect(merge).toContain('$IMAGE_TAG-arm64');
    });

    // The same gate the release images pass: scanned from a tarball before the credential is on
    // the runner, with the release's flags and no narrowing beyond unfixed findings.
    it('scans the image before login and push, with the release gate flags', () => {
        const build = workflow(UI_RUNNER).jobs.build!;
        const names = (build.steps ?? []).map((step) => step.name ?? step.uses ?? '');
        const gate = names.findIndex((name) => name.includes('--exit-code 1'));
        expect(gate, 'nothing in the build job fails on a finding').toBeGreaterThan(-1);
        expect(gate).toBeLessThan(names.findIndex((name) => name.includes('docker login')));
        expect(gate).toBeLessThan(names.findIndex((name) => name.includes('--push')));
        const commands = runs(build).join('\n');
        expect(commands).toContain('--output type=docker,dest=/tmp/image.tar');
        const scans = runSteps(build).filter((step) => /trivy/i.test(step.run));
        expect(scans).toHaveLength(2);
        for (const step of scans) {
            expect(step.run).toContain('--input /tmp/image.tar');
            // The workspace is mounted as the scanner's cwd so `.trivyignore` applies; the npm the
            // gate needs carries findings only that file triages.
            expect(step.run).toContain('-v "$PWD:/work" -w /work');
            expect(step.run).toContain('--scanners vuln,secret');
            expect(step.run).toContain('--severity CRITICAL,HIGH');
            expect(step.run).toContain('--ignore-unfixed');
            expect(step.run).not.toMatch(/--skip-files|--skip-dirs|--vuln-type/);
        }
        expect(build.env!.TRIVY_IMAGE).toBe(workflow(RELEASE).jobs.build!.env!.TRIVY_IMAGE);
        const upload = (build.steps ?? []).find((step) => step.uses?.startsWith('github/codeql-action/upload-sarif'))!;
        expect(upload.if).toBe('always()');
        expect(upload.with!.category).toContain('matrix.arch');
    });
});
