import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { networkName, plannedServices, serviceContainerName, serviceRunArgs } from '../src/services.js';
import { awaitServicesRunning } from '../src/service-restart.js';

const USER = '44444444-4444-4444-8444-444444444444';

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    rootCommand: 'fix the failing build',
    attempts: 1,
    maxAttempts: 3,
    lastAttempt: false,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    executorRefusal: null,
    planRefusal: null,
    skillRefusal: null,
    masterPrompt:
        'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone',
    resumeSessionId: null,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
};

describe('the planned services (issue #769)', () => {
    it('are exactly the services the claim carries', () => {
        const services = [
            { name: 'db', image: 'postgres:16', environment: [], ports: [5432] },
            { name: 'cache', image: 'redis', environment: [] },
        ];
        expect(plannedServices({ ...job, services })).toEqual(services);
    });

    it('are empty when the claim carries none', () => {
        expect(plannedServices(job)).toEqual([]);
    });

    it('leave the container argv untouched by a declared port', () => {
        const bare = { name: 'db', image: 'postgres:16', environment: [] };
        expect(serviceRunArgs(job, { ...bare, ports: [5432] })).toEqual(serviceRunArgs(job, bare));
    });
});

describe('the service container arguments', () => {
    /*
     * The naming contract every helper here obeys: a name is derived from the job id AND the
     * lease token, and the token is minted fresh on every claim and never repeats. So a stale
     * attempt can compute the names it used, but those names can only ever resolve to the
     * resources its own attempt created — structurally, no ownership gate needed.
     */
    it('names the network after the job and the attempt', () => {
        expect(networkName(job)).toBe(
            'factory-job-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222-services'
        );
    });

    it('names the service container after the job, the attempt, and the service', () => {
        expect(serviceContainerName(job, 'cache')).toBe(
            'factory-job-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222-svc-cache'
        );
    });

    it('starts a detached container on the job network, aliased by service name', () => {
        // The alias is the whole point: inside the job's network, `cache` resolves to this
        // container, which is what makes `redis://cache:6379` work in the author's tests. The
        // lease label beside the job label is what scopes every teardown and kill to this
        // attempt's fleet — the job label alone is shared by every attempt of the job.
        const line = serviceRunArgs(job, {
            name: 'cache',
            image: 'redis',
            environment: [{ key: 'ALLOW_EMPTY', value: 'yes' }],
        });
        expect(line).toEqual([
            'run',
            '-d',
            // The default hardening (#382) — this service declared no opt-out.
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--name',
            serviceContainerName(job, 'cache'),
            '--label',
            `factory.job=${job.id}`,
            '--label',
            `factory.lease=${job.leaseToken}`,
            '--label',
            'factory.service=cache',
            '--network',
            networkName(job),
            '--network-alias',
            'cache',
            '-e',
            'ALLOW_EMPTY=yes',
            'redis',
        ]);
    });

    it('never publishes a port on the host', () => {
        // Parse refuses the `ports:` key; this pins that the argv side has no way to publish one
        // either. The daemon running this argv is root on the host — a published port is the one
        // step from "a service for my tests" to "a listener on somebody's machine".
        const line = serviceRunArgs(job, { name: 'db', image: 'postgres', environment: [] });
        expect(line).not.toContain('-p');
        expect(line).not.toContain('--publish');
    });

    it('re-asserts the name, image and env keys before they reach argv', () => {
        // parseBellows enforces all three; this is the same assertion the runner makes about a
        // session id it is about to interpolate — the argv builder does not trust its caller.
        expect(() => serviceRunArgs(job, { name: 'bad name', image: 'redis', environment: [] })).toThrow(
            /not a safe service name/
        );
        expect(() =>
            serviceRunArgs(job, { name: 'db', image: 'redis', environment: [{ key: 'A B', value: '1' }] })
        ).toThrow(/not a valid environment variable name/);
        expect(() => serviceRunArgs(job, { name: 'db', image: '--privileged', environment: [] })).toThrow(
            /not a safe image reference/
        );
    });
});

describe('the RUNNER_SERVICES switch', () => {
    it('is on by default, and an explicit 0/false is the opt-out', () => {
        expect(loadDriverConfig({}).servicesEnabled).toBe(true);
        expect(loadDriverConfig({ RUNNER_SERVICES: '' }).servicesEnabled).toBe(true);
        expect(loadDriverConfig({ RUNNER_SERVICES: '0' }).servicesEnabled).toBe(false);
        expect(loadDriverConfig({ RUNNER_SERVICES: 'false' }).servicesEnabled).toBe(false);
        expect(loadDriverConfig({ RUNNER_SERVICES: '1' }).servicesEnabled).toBe(true);
    });

    it('is allowed under both executors — service pods under kubernetes, containers under docker', () => {
        // The kubernetes runner starts each declared service as a pod with a headless Service
        // as its DNS name, so the flag no longer refuses that executor: the switch decides
        // WHETHER services run, and the executor decides HOW.
        expect(() => loadDriverConfig({ RUNNER_SERVICES: '1', EXECUTOR: 'kubernetes' })).not.toThrow();
        expect(loadDriverConfig({ RUNNER_SERVICES: '1', EXECUTOR: 'kubernetes' }).servicesEnabled).toBe(true);
        expect(() => loadDriverConfig({ RUNNER_SERVICES: '1', EXECUTOR: 'docker' })).not.toThrow();
    });
});

describe('awaitServicesRunning (issue #560)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const specs = [
        { name: 'db', image: 'mongo', environment: [] },
        { name: 'cache', image: 'redis', environment: [] },
    ];
    const status = (name: string, state: string) => ({ name, image: 'x', state });
    const noWait = async () => {};

    it('returns once every service is listed running, re-listing through a failed read', async () => {
        const answers = [
            () => Promise.resolve([status('db', 'running')]),
            () => Promise.reject(new Error('daemon blinked')),
            () => Promise.resolve([status('db', 'running'), status('cache', 'running')]),
        ];
        let lists = 0;
        await awaitServicesRunning(specs, () => answers[lists++]!(), noWait);
        expect(lists).toBe(3);
    });

    it('throws at once, naming it, when a restarted service is already dead', async () => {
        let lists = 0;
        const list = async () => {
            lists += 1;
            return [status('db', 'exited'), status('cache', 'running')];
        };
        await expect(awaitServicesRunning(specs, list, noWait)).rejects.toThrow(
            'service "db" exited after the restart'
        );
        expect(lists).toBe(1);
    });

    // Codex review on #562: a poll counter alone lets slow listings stretch a 300s budget to hours.
    it('bounds the wait by the clock, however long each listing takes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        let lists = 0;
        const slow = async () => {
            lists += 1;
            vi.setSystemTime(Date.now() + 30_000);
            return [status('db', 'pending'), status('cache', 'running')];
        };
        await expect(awaitServicesRunning(specs, slow, noWait)).rejects.toThrow(
            'service "db" not running 300s after the restart'
        );
        expect(lists).toBe(10);
    });

    it('names a listing that keeps failing instead of calling the service not running', async () => {
        const failing = async () => {
            throw new Error('the API server is away');
        };
        await expect(awaitServicesRunning(specs, failing, noWait)).rejects.toThrow(
            'the services could not be listed 300s after the restart: the API server is away'
        );
    });

    it('stops polling once the attempt stands down', async () => {
        const stand = new AbortController();
        let lists = 0;
        const list = async () => {
            lists += 1;
            if (lists === 2) stand.abort();
            return [status('db', 'pending')];
        };
        await expect(awaitServicesRunning(specs, list, noWait, { signal: stand.signal })).rejects.toThrow(
            'the restart was abandoned: the attempt stood down'
        );
        expect(lists).toBe(2);
    });

    it.each<[string, { timeoutMs: number } | undefined, number]>([
        ['throws naming what never ran once the timeout has passed', undefined, 300_000],
        ['stops at a supplied budget, still naming the whole restart timeout', { timeoutMs: 6_000 }, 6_000],
    ])('%s', async (_label, options, budget) => {
        let slept = 0;
        const sleep = async (ms: number) => {
            slept += ms;
        };
        await expect(
            awaitServicesRunning(specs, async () => [status('db', 'running')], sleep, options)
        ).rejects.toThrow('service "cache" not running 300s after the restart');
        expect(slept).toBe(budget);
    });
});
