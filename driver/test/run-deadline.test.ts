import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { createDockerRunner } from '../src/docker-runner.js';
import { startDeadline } from '../src/run-deadline.js';
import type { StepSink } from '../src/step-control.js';
import { SUPERVISOR_ENV, SUPERVISOR_WINDDOWN_MS } from '../src/supervisor-contract.js';

/**
 * The paused runtime budget while an agent waits for an answer. The kubernetes counterpart is pinned in `k8s.test.ts`.
 */

const SECOND = 1_000;
const HOUR = 3_600_000;

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('startDeadline', () => {
    it('fires after its time, once', () => {
        const fired = vi.fn();
        startDeadline(10 * SECOND, fired);
        vi.advanceTimersByTime(10 * SECOND - 1);
        expect(fired).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        vi.advanceTimersByTime(HOUR);
        expect(fired).toHaveBeenCalledTimes(1);
    });

    it('waits indefinitely and resumes only the unused runtime budget', () => {
        const fired = vi.fn();
        const deadline = startDeadline(10 * SECOND, fired);
        vi.advanceTimersByTime(4 * SECOND);
        deadline.pause(true);
        vi.advanceTimersByTime(48 * HOUR);
        deadline.pause(true);
        expect(fired).not.toHaveBeenCalled();
        deadline.pause(false);
        deadline.pause(false);
        vi.advanceTimersByTime(6 * SECOND - 1);
        expect(fired).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fired).toHaveBeenCalledTimes(1);
    });

    it('cannot revive a cleared or fired deadline', () => {
        const fired = vi.fn();
        const deadline = startDeadline(SECOND, fired);
        deadline.pause(true);
        deadline.clear();
        deadline.pause(false);
        vi.advanceTimersByTime(HOUR);
        expect(fired).not.toHaveBeenCalled();
        const expired = startDeadline(SECOND, fired);
        vi.advanceTimersByTime(SECOND);
        expired.pause(true);
        expired.pause(false);
        vi.advanceTimersByTime(HOUR);
        expect(fired).toHaveBeenCalledTimes(1);
    });
});

describe('the docker runner kill timer', () => {
    const job: BoardJob = {
        id: '11111111-1111-4111-8111-111111111111',
        command: 'ask a question',
        rootCommand: 'ask a question',
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
        userId: '44444444-4444-4444-8444-444444444444',
        workspacePath: 'bellows/44444444-4444-4444-8444-444444444444',
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: 'tok' },
    };
    const SESSION = '33333333-3333-4333-8333-333333333333';
    // A supervisor that releases the agent (`go`) and then never reports: the run ends only by the
    // backstop this suite is about — the budget the supervisor enforces, plus its wind-down.
    const supervisorSteps: StepSink = {
        submit: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        awaitReport: () => new Promise(() => undefined),
        contacted: () => true,
    };

    it('pauses until the answer and resumes its remaining budget', async () => {
        const calls: string[][] = [];
        const exec = vi.fn(async (args: string[]) => {
            calls.push(args);
            // The kill resolves its container through the attempt's own lease label.
            if (args[0] === 'ps' && args.some((a) => a.startsWith('label=factory.lease'))) {
                return { stdout: 'runner-1\n' };
            }
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const child = new EventEmitter() as ChildProcess;
        child.stdout = new EventEmitter() as ChildProcess['stdout'];
        child.stderr = new EventEmitter() as ChildProcess['stderr'];
        const spawned = vi.fn(() => child);
        const runner = createDockerRunner(
            loadDriverConfig({ DRIVER_JOB_TIMEOUT_MS: String(10 * SECOND) }),
            spawned as unknown as typeof spawn,
            exec,
            // No real file I/O: fake timers cannot advance a write that is waiting on the disk.
            { files: { writeFile: async () => undefined, rm: async () => undefined }, steps: supervisorSteps }
        );
        const killed = () => calls.some((args) => args[0] === 'kill');

        const pending = runner.run(job, { id: SESSION, resume: false });
        for (let i = 0; i < 200 && spawned.mock.calls.length === 0; i++) await vi.advanceTimersByTimeAsync(0);
        expect(spawned).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(4 * SECOND);
        await runner.pauseDeadline?.(job, true);
        // Even a two-day wait consumes no runtime budget.
        await vi.advanceTimersByTimeAsync(48 * HOUR);
        expect(killed()).toBe(false);

        // Only six seconds of active runtime remain, and then the wind-down the supervisor is given
        // to end the agent and finalize before this backstop kills the whole group.
        await runner.pauseDeadline?.(job, false);
        await vi.advanceTimersByTimeAsync(6 * SECOND + SUPERVISOR_WINDDOWN_MS - 1);
        expect(killed()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(killed()).toBe(true);
        child.emit('close', 137);
        await expect(pending).resolves.toMatchObject({ timedOut: true, exitCode: 137 });
    });

    // Issue #733: environment.setup ran before the agent, inside the same run budget.
    it('kills the run at the budget left after environment.setup', async () => {
        const calls: string[][] = [];
        const exec = vi.fn(async (args: string[]) => {
            calls.push(args);
            if (args[0] === 'ps' && args.some((a) => a.startsWith('label=factory.lease'))) {
                return { stdout: 'runner-1\n' };
            }
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const child = new EventEmitter() as ChildProcess;
        child.stdout = new EventEmitter() as ChildProcess['stdout'];
        child.stderr = new EventEmitter() as ChildProcess['stderr'];
        const spawned = vi.fn(() => child);
        const runner = createDockerRunner(
            loadDriverConfig({ DRIVER_JOB_TIMEOUT_MS: String(10 * SECOND) }),
            spawned as unknown as typeof spawn,
            exec,
            { files: { writeFile: async () => undefined, rm: async () => undefined }, steps: supervisorSteps }
        );
        const killed = () => calls.some((args) => args[0] === 'kill');

        const pending = runner.run({ ...job, setupMs: 3 * SECOND }, { id: SESSION, resume: false });
        for (let i = 0; i < 200 && spawned.mock.calls.length === 0; i++) await vi.advanceTimersByTimeAsync(0);
        // The budget the supervisor enforces, plus its wind-down: the backstop's own.
        await vi.advanceTimersByTimeAsync(7 * SECOND + SUPERVISOR_WINDDOWN_MS - 1);
        expect(killed()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(killed()).toBe(true);
        child.emit('close', 137);
        await expect(pending).resolves.toMatchObject({ timedOut: true });
    });

    it('pausing a run that is not in flight does nothing', async () => {
        const runner = createDockerRunner(loadDriverConfig({}), vi.fn() as unknown as typeof spawn, vi.fn());
        await expect(runner.pauseDeadline?.(job, true)).resolves.toBeUndefined();
    });
});
