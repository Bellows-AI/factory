import { describe, expect, it } from 'vitest';
import { networkName, serviceContainerName } from '../src/services.js';
import type { BoardJob } from '../src/board.js';
import { createDockerReaper, parseDockerCreatedAt } from '../src/docker-reaper.js';
import type { ExecDocker } from '../src/docker-runner-support.js';
import type { OrphanGroup } from '../src/reaper.js';

/**
 * The docker reaper arm, offline: the daemon seam is the same `ExecDocker` injected function the
 * runner tests stand in for, so the test is a router over argv that records what the arm asked
 * the daemon for. No daemon, no containers.
 */

const JOB = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const JOB2 = '44444444-4444-4444-8444-444444444444';
const LEASE2 = '33333333-3333-4333-8333-333333333333';

const job = { id: JOB, leaseToken: LEASE } as BoardJob;

/** One `docker ps --format '{{json .}}'` line for a service container. */
const psLine = (fields: { id: string; jobId: string; lease: string; created: string; service?: string }) =>
    JSON.stringify({
        ID: fields.id,
        Labels: `factory.job=${fields.jobId},factory.lease=${fields.lease},factory.service=${fields.service ?? 'timescale'}`,
        CreatedAt: fields.created,
        State: 'running',
        Image: 'postgres:16',
    });

const PS_ARGS = ['ps', '-a', '--filter', 'label=factory.service', '--format', '{{json .}}'];

const router = (answers: string[][]): { execDocker: ExecDocker; calls: string[][] } => {
    const calls: string[][] = [];
    return {
        calls,
        execDocker: async (args) => {
            calls.push([...args]);
            const hit = answers.find((candidate) => candidate.length > 0 && candidate[0] === args[0]);
            if (hit) {
                answers.splice(answers.indexOf(hit), 1);
                return { stdout: hit.slice(1).join('\n') };
            }
            return { stdout: '' };
        },
    };
};

const group = (overrides: Partial<OrphanGroup> = {}): OrphanGroup => ({
    jobId: JOB,
    leaseToken: LEASE,
    createdAtMs: 0,
    objects: [{ kind: 'container', name: `${JOB}-${LEASE}-svc-timescale` }],
    ...overrides,
});

describe("parseDockerCreatedAt — docker's own timestamp spelling", () => {
    it('reads "2026-09-14 10:00:00 +0000 UTC" into epoch millis', () => {
        expect(parseDockerCreatedAt('2026-09-14 10:00:00 +0000 UTC')).toBe(Date.parse('2026-09-14T10:00:00Z'));
    });

    it('honors a non-UTC offset', () => {
        expect(parseDockerCreatedAt('2026-09-14 12:30:00 +0200 CEST')).toBe(Date.parse('2026-09-14T10:30:00Z'));
    });

    it('answers 0 for anything it cannot read — eligible, never a crash', () => {
        expect(parseDockerCreatedAt('')).toBe(0);
        expect(parseDockerCreatedAt('yesterday, probably')).toBe(0);
    });
});

describe('the docker reaper arm: scan', () => {
    it('filters by the factory.service label and groups by job and lease', async () => {
        const { execDocker, calls } = router([
            [
                PS_ARGS[0]!,
                psLine({ id: 'c1', jobId: JOB, lease: LEASE, created: '2026-09-01 00:00:00 +0000 UTC' }),
                psLine({
                    id: 'c2',
                    jobId: JOB2,
                    lease: LEASE2,
                    created: '2026-09-02 00:00:00 +0000 UTC',
                    service: 'redis',
                }),
                // A runner container: job+lease but no service label — the fence's territory.
                JSON.stringify({
                    ID: 'runner',
                    Labels: `factory.job=${JOB},factory.lease=${LEASE}`,
                    CreatedAt: '2026-09-01 00:00:00 +0000 UTC',
                }),
                // Unlabelled junk.
                JSON.stringify({ ID: 'junk', Labels: '', CreatedAt: '2026-09-01 00:00:00 +0000 UTC' }),
            ],
        ]);
        const arm = createDockerReaper(execDocker);

        const groups = await arm.scan();

        expect(calls).toEqual([PS_ARGS]);
        expect(groups).toEqual([
            {
                jobId: JOB,
                leaseToken: LEASE,
                createdAtMs: Date.parse('2026-09-01T00:00:00Z'),
                objects: [{ kind: 'container', name: 'c1' }],
            },
            {
                jobId: JOB2,
                leaseToken: LEASE2,
                createdAtMs: Date.parse('2026-09-02T00:00:00Z'),
                objects: [{ kind: 'container', name: 'c2' }],
            },
        ]);
    });

    it('answers nothing when the daemon refuses the list', async () => {
        const execDocker: ExecDocker = async () => {
            throw new Error('cannot connect to the Docker daemon');
        };
        const arm = createDockerReaper(execDocker);

        await expect(arm.scan()).resolves.toEqual([]);
    });
});

describe('the docker reaper arm: reap', () => {
    it('removes each container by id, detaches the network, and removes the derived network', async () => {
        const { execDocker, calls } = router([
            // The network inspect: one attached endpoint the teardown must disconnect first.
            ['network', 'gate-env'],
        ]);
        const arm = createDockerReaper(execDocker);

        const removed = await arm.reap(group(), 'gone');

        expect(removed).toEqual([
            `container ${JOB}-${LEASE}-svc-timescale`,
            `network factory-job-${JOB}-${LEASE}-services`,
        ]);
        expect(calls).toEqual([
            ['rm', '-f', `${JOB}-${LEASE}-svc-timescale`],
            ['network', 'inspect', '--format', '{{range .Containers}}{{println .Name}}{{end}}', networkName(job)],
            ['network', 'disconnect', '-f', networkName(job), 'gate-env'],
            ['network', 'rm', networkName(job)],
        ]);
    });

    it('tolerates a container vanishing between the list and its removal', async () => {
        const failing: ExecDocker = async (args) => {
            if (args[0] === 'rm') {
                throw new Error('Error response from daemon: No such container: gone');
            }
            return { stdout: '' };
        };
        const arm = createDockerReaper(failing);

        // The vanished container is not this round's removal; the network teardown continues.
        expect(await arm.reap(group(), 'gone')).toEqual([`network factory-job-${JOB}-${LEASE}-services`]);
    });

    it("keeps the derived network scoped to the group's own attempt", async () => {
        const { execDocker, calls } = router([]);
        const arm = createDockerReaper(execDocker);

        await arm.reap(group({ jobId: JOB2, leaseToken: LEASE2 }), 'superseded');

        // The network name carries THIS group's lease token — never the live attempt's.
        expect(calls).toContainEqual(['network', 'rm', networkName({ id: JOB2, leaseToken: LEASE2 } as BoardJob)]);
    });

    it('names the service container the way the fleet builder does', () => {
        // The pin that keeps the reaper's idea of a name from drifting from the spawner's.
        expect(serviceContainerName(job, 'timescale')).toBe(`factory-job-${JOB}-${LEASE}-svc-timescale`);
    });
});
