import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { createDockerRunner } from '../src/docker-runner.js';
import { startDeadline } from '../src/run-deadline.js';

/**
 * The extendable run deadline (issue #226): the docker runner's wall-clock kill timer, pushed out
 * by the wait for an agent's question. The kubernetes counterpart is pinned in `k8s.test.ts`.
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

    it('re-arms to the remaining time plus the extension, and every extension adds up', () => {
        const fired = vi.fn();
        const deadline = startDeadline(10 * SECOND, fired);
        vi.advanceTimersByTime(4 * SECOND);
        deadline.extend(HOUR);
        deadline.extend(HOUR);
        vi.advanceTimersByTime(10 * SECOND + 2 * HOUR - 4 * SECOND - 1);
        expect(fired).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fired).toHaveBeenCalledTimes(1);
    });

    it('stays cleared, and stays fired, whatever is extended afterwards', () => {
        const cleared = vi.fn();
        const clearedDeadline = startDeadline(SECOND, cleared);
        clearedDeadline.clear();
        clearedDeadline.extend(SECOND);
        vi.advanceTimersByTime(HOUR);
        expect(cleared).not.toHaveBeenCalled();

        const fired = vi.fn();
        const firedDeadline = startDeadline(SECOND, fired);
        vi.advanceTimersByTime(SECOND);
        firedDeadline.extend(SECOND);
        vi.advanceTimersByTime(HOUR);
        expect(fired).toHaveBeenCalledTimes(1);
    });
});

describe('the docker runner kill timer', () => {
    const job: BoardJob = {
        id: '11111111-1111-4111-8111-111111111111',
        command: 'ask a question',
        attempts: 1,
        leaseToken: '22222222-2222-4222-8222-222222222222',
        leaseExpiresAt: '2026-08-29T12:05:00.000Z',
        executorType: 'claude-code',
        masterPrompt:
            'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone',
        resumeSessionId: null,
        followUp: false,
        userId: '44444444-4444-4444-8444-444444444444',
        workspacePath: 'bellows/44444444-4444-4444-8444-444444444444',
    };
    const SESSION = '33333333-3333-4333-8333-333333333333';

    it('is re-armed to its remaining time plus the extension', async () => {
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
            { writeFile: async () => undefined, rm: async () => undefined }
        );
        const killed = () => calls.some((args) => args[0] === 'kill');

        const pending = runner.run(job, { id: SESSION, resume: false });
        for (let i = 0; i < 200 && spawned.mock.calls.length === 0; i++) await vi.advanceTimersByTimeAsync(0);
        expect(spawned).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(4 * SECOND);
        await runner.extendDeadline?.(job, HOUR);
        // The original ten seconds pass without a kill: the deadline moved.
        await vi.advanceTimersByTimeAsync(7 * SECOND);
        expect(killed()).toBe(false);

        // Due at 10s + the hour, 11s in: the kill lands there and reads as a timeout.
        await vi.advanceTimersByTimeAsync(HOUR - SECOND);
        expect(killed()).toBe(true);
        child.emit('close', 137);
        await expect(pending).resolves.toMatchObject({ timedOut: true, exitCode: 137 });
    });

    it('extending a run that is not in flight does nothing', async () => {
        const runner = createDockerRunner(loadDriverConfig({}), vi.fn() as unknown as typeof spawn, vi.fn());
        await expect(runner.extendDeadline?.(job, HOUR)).resolves.toBeUndefined();
    });
});
