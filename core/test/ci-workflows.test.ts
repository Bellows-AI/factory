import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
    name?: string;
    run?: string;
    uses?: string;
    with?: Record<string, string>;
    env?: Record<string, string>;
}

interface Job {
    uses?: string;
    // A single dependency is written as a scalar, several as a sequence.
    needs?: string | string[];
    if?: string;
    steps?: Step[];
    services?: Record<string, { image: string }>;
    strategy?: { matrix?: { image?: { name: string; context: string; args: string }[]; arch?: string[] } };
}

interface Workflow {
    on: Record<string, { branches?: string[]; tags?: string[] }>;
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
        for (const path of [CI, RELEASE]) {
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
        const imageMajor = /FROM node:(\d+)-alpine AS runtime/.exec(read('docker/Dockerfile'))?.[1];
        expect(imageMajor).toBeTruthy();
        const setups = Object.values(workflow(CI).jobs).flatMap((job) =>
            (job.steps ?? []).filter((step) => step.uses?.startsWith('actions/setup-node@'))
        );
        expect(setups.length).toBeGreaterThan(0);
        for (const step of setups) {
            expect(String(step.with!['node-version']).split('.')[0]).toBe(imageMajor);
        }
    });

    it('runs the browser suite only on merges to main', () => {
        const e2e = workflow(CI).jobs.e2e!;
        expect(needs(e2e)).toContain('validate');
        expect(e2e.if).toContain('refs/heads/main');
        expect(e2e.if).toContain('push');
    });

    it('gives the browser suite a timescale service and the two databases it names', () => {
        const e2e = workflow(CI).jobs.e2e!;
        const compose = load<{ services: Record<string, { image: string }> }>('docker-compose.yml');
        expect(e2e.services!.timescale!.image).toBe(compose.services.timescale!.image);
        // The service keeps its name — it is load-bearing across scripts — but the image is
        // plain PostgreSQL since #371 dropped the extension.
        expect(e2e.services!.timescale!.image).not.toMatch(/timescale/i);
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

    it('never interpolates a ref name into shell text', () => {
        for (const job of Object.values(workflow(RELEASE).jobs)) {
            for (const step of runSteps(job)) {
                expect(step.run, `${step.name} interpolates an expression into its script`).not.toMatch(/\$\{\{/);
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
        for (const path of [CI, RELEASE]) {
            expect(read(path), `${path} reads a repository secret`).not.toMatch(/secrets\./);
        }
        expect(read(RELEASE)).toMatch(/\$\{\{ github\.token \}\}/);
    });

    it('grants each workflow only the access its job needs', () => {
        expect(workflow(CI).permissions, CI).toEqual({ contents: 'read' });
        // The publish path writes packages and nothing else — no contents: write, so a release
        // can never move a ref.
        expect(workflow(RELEASE).permissions, RELEASE).toEqual({ contents: 'read', packages: 'write' });
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
        const groups = [CI, RELEASE].map((path) => workflow(path).concurrency!.group);
        for (const group of groups) expect(group).not.toContain('github.workflow');
        expect(new Set(groups).size).toBe(groups.length);
    });

    it('pins every action to a major version', () => {
        for (const path of [CI, RELEASE]) {
            for (const job of Object.values(workflow(path).jobs)) {
                for (const step of job.steps ?? []) {
                    if (step.uses) expect(step.uses, `${path}: ${step.uses} is not pinned`).toMatch(/@v\d+$/);
                }
            }
        }
        // The publish jobs hold `packages: write`, so no third-party action runs on that path at
        // all — the registry work is `run` steps calling the docker CLI.
        for (const job of Object.values(workflow(RELEASE).jobs)) {
            for (const step of job.steps ?? []) {
                if (step.uses) expect(step.uses, `${step.uses} runs beside packages: write`).toMatch(/^actions\//);
            }
        }
    });
});
