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
const runSteps = (job: Job) => (job.steps ?? []).filter((step): step is Step & { run: string } => !!step.run);
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
        const commands = runs(e2e).join('\n');
        expect(commands).toContain('create database factory_e2e');
        expect(commands).toContain('create database factory_auth_e2e');
        expect(commands).toContain('playwright install');
        expect(commands).toContain('npm run verify:ui');
    });

    it('builds the production runtime image on a v* tag', () => {
        const doc = workflow(RELEASE);
        expect(triggers(doc).push!.tags).toContain('v*');
        const called = Object.entries(doc.jobs).find(([, job]) => job.uses === './.github/workflows/ci.yml');
        expect(called, 'the release workflow does not reuse the validation workflow').toBeTruthy();
        const image = doc.jobs.image!;
        expect(needs(image)).toContain(called![0]);
        const commands = runs(image).join('\n');
        expect(commands).toContain('-f docker/Dockerfile');
        expect(commands).toContain('--target runtime');
        // `github.ref_name` on a tag push is the bare tag, so the image carries the release name —
        // bound as an env value, because a ref name may contain shell metacharacters.
        expect(commands).toMatch(/-t "factory-ai:\$IMAGE_TAG"/);
        const normalize = runSteps(image).find((step) => step.run.includes('IMAGE_TAG='))!;
        expect(normalize.env!.TAG).toMatch(/^\$\{\{ github\.ref_name \}\}$/);
    });

    // `v1.0.0+build.1` is a legal git tag and an illegal docker tag; without normalization the
    // release job dies at `docker build` and never produces the artifact the issue asks for.
    it('folds a git tag into a tag docker accepts', () => {
        const image = workflow(RELEASE).jobs.image!;
        const normalize = runSteps(image).find((step) => step.run.includes('IMAGE_TAG='));
        expect(normalize, 'the git tag reaches docker unnormalized').toBeTruthy();
        expect(normalize!.run).toMatch(/tr -c 'A-Za-z0-9_\.-'/);
        // Folding is lossy, so a digest of the original keeps two refs that fold alike apart —
        // in the image tag, the tarball name and the artifact name, none of which may carry a
        // raw ref (a ref may contain a pipe; an artifact name may not).
        expect(normalize!.run).toMatch(/sha1sum/);
        const save = runSteps(image).find((step) => step.run.includes('docker save'))!;
        expect(save.run).toContain('-o "factory-ai-$IMAGE_TAG.tar"');
        const upload = (image.steps ?? []).find((step) => step.uses?.startsWith('actions/upload-artifact@'))!;
        for (const value of [upload.with!.name, upload.with!.path]) {
            expect(value).toContain('env.IMAGE_TAG');
            expect(value).not.toContain('github.ref_name');
        }
    });

    it('never interpolates a ref name into shell text', () => {
        for (const job of Object.values(workflow(RELEASE).jobs)) {
            for (const step of runSteps(job)) {
                expect(step.run, `${step.name} interpolates an expression into its script`).not.toMatch(/\$\{\{/);
            }
        }
    });

    it('retains the release image as a workflow artifact', () => {
        const image = workflow(RELEASE).jobs.image!;
        const upload = (image.steps ?? []).find((step) => step.uses?.startsWith('actions/upload-artifact@'));
        expect(upload, 'the release image is never uploaded').toBeTruthy();
    });

    it('needs no application secret on the validation or image path', () => {
        for (const path of [CI, RELEASE]) {
            expect(read(path), `${path} reads a repository secret`).not.toMatch(/secrets\./);
        }
    });

    it('grants the workflows read-only access to the repository', () => {
        for (const path of [CI, RELEASE]) {
            expect(workflow(path).permissions, path).toEqual({ contents: 'read' });
        }
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
    });
});
