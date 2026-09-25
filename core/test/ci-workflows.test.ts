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
}

interface Job {
    uses?: string;
    needs?: string[];
    if?: string;
    steps?: Step[];
    services?: Record<string, { image: string }>;
}

interface Workflow {
    on?: Record<string, { branches?: string[]; tags?: string[] }>;
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

// yaml parses with the 1.2 core schema, so the `on:` key stays the string 'on'. A parser on the
// 1.1 schema would fold it to the boolean true; read both rather than depend on which one ships.
const triggers = (doc: Workflow) => doc.on ?? (doc as unknown as Record<string, Workflow['on']>).true!;
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
        expect(e2e.needs).toContain('validate');
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
        expect(image.needs).toContain(called![0]);
        const commands = runs(image).join('\n');
        expect(commands).toContain('-f docker/Dockerfile');
        expect(commands).toContain('--target runtime');
        // `github.ref_name` on a tag push is the bare tag, so the image carries the release name.
        expect(commands).toMatch(/-t factory-ai:\$\{\{ github\.ref_name \}\}/);
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

    it('supersedes only pull-request runs', () => {
        const concurrency = workflow(CI).concurrency!;
        expect(concurrency.group).toContain('github.ref');
        expect(String(concurrency['cancel-in-progress'])).toContain('pull_request');
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
