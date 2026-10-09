import { getEventListeners } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BoardJob, LeaseState } from '../src/board.js';
import { newJobState, raceStep } from '../src/loop-attempt.js';
import { concludeSetup, handBackFence, standDown } from '../src/loop-fence.js';
import type { AttemptCtx, SetupHalt } from '../src/loop-types.js';

const JOB = { id: 'job-1' } as BoardJob;

const FAULT: SetupHalt = {
    halt: 'fault',
    log: 'checkout sync failed: the remote said no',
    verdict: { status: 'failed', exitCode: null, output: 'nope', failureKind: 'runner_error' },
};
const LEAVE: SetupHalt = { halt: 'leave', log: 'checkout sync threw, leaving it to the lease' };
const REQUEUE: SetupHalt = { halt: 'requeue', log: 'checkout sync was lock-blocked, requeueing' };
const CONCLUDED: SetupHalt = {
    halt: 'concluded',
    log: 'pre-run helper "lint" concluded the job without launching the agent',
    verdict: { status: 'succeeded', exitCode: 0, output: '{"decided":"up-to-date"}' },
};

/**
 * One attempt's fence, stubbed down to the calls it owns: the checkout-claim release, the settle,
 * the suspend and the completion. Everything below is the promise issue #472 makes about a
 * conclusion and a stand-down — a new setup refusal cannot forget the release, because it never
 * gets to act.
 */
function fencedAttempt(fenced = true): { ctx: AttemptCtx; calls: string[]; lines: string[] } {
    const calls: string[] = [];
    const lines: string[] = [];
    const job = JOB;
    const ctx = {
        rt: {
            runner: {
                releaseFence: async (released: BoardJob) => {
                    calls.push(`release:${released.id}`);
                },
            },
            board: {
                suspend: async () => {
                    calls.push('suspend');
                    return 'ok' as LeaseState;
                },
                requeue: async (requeued: BoardJob) => {
                    calls.push(`requeue:${requeued.id}`);
                    return 'held' as LeaseState;
                },
            },
            report: async (reported: BoardJob) => {
                calls.push(`complete:${reported.id}`);
                return 'ok' as LeaseState;
            },
            log: (line: string) => {
                calls.push('log');
                lines.push(line);
            },
        },
        job,
        state: newJobState(),
        settle: async () => {
            calls.push('settle');
        },
        fenced,
        treeBefore: null,
    } as unknown as AttemptCtx;
    return { ctx, calls, lines };
}

/**
 * Both sequences begin the same way: the claim goes back before the attempt settles, whatever ended
 * it (issue #469). A stand-down parks a stopped turn and then says what the board said; a conclusion
 * says why it ended and reports it.
 */
const CLAIM_BACK = ['release:job-1', 'settle'];

/**
 * The rest is structural: "one owner" is a promise about the source, not about any path a test can
 * reach today — the refusals that would break it are exactly the ones not written yet. Pinned the
 * same way `scripts-*.test.ts` pins the bytes the images ship.
 */
const loopSources = (): readonly (readonly [string, string])[] => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    return readdirSync(dir)
        .filter((file) => /^loop-.*\.ts$/.test(file))
        .map((file) => [file, readFileSync(`${dir}/${file}`, 'utf8')] as const);
};

describe('the attempt fences have exactly one owner (issue #472)', () => {
    it('releases the checkout claim once, however often the fence runs', async () => {
        const { ctx, calls } = fencedAttempt();

        await handBackFence(ctx);
        await handBackFence(ctx);

        expect(calls).toEqual(['release:job-1']);
    });

    it('releases nothing for an attempt that never took the claim', async () => {
        const { ctx, calls } = fencedAttempt(false);
        ctx.state.stopped = true;

        await handBackFence(ctx);
        expect(await standDown(ctx, 'setup')).toBe(true);

        expect(calls).toEqual(['settle', 'suspend', 'log']);
    });

    it('stands a stopped attempt down as one sequence — release, settle, park', async () => {
        const { ctx, calls, lines } = fencedAttempt();
        ctx.state.stopped = true;

        expect(await standDown(ctx, 'setup')).toBe(true);

        expect(calls).toEqual([...CLAIM_BACK, 'suspend', 'log']);
        expect(lines.join('\n')).toContain('stopped during setup');
    });

    it('leaves the attempt to its holder when the lease was lost, without parking it', async () => {
        const { ctx, calls, lines } = fencedAttempt();
        ctx.state.lost = true;

        expect(await standDown(ctx, 'setup')).toBe(true);

        expect(calls).toEqual([...CLAIM_BACK, 'log']);
        expect(lines.join('\n')).toContain('lease was lost during setup');
    });

    it('runs the pre-park hook for a stopped attempt, after the settle and before the park', async () => {
        const { ctx, calls } = fencedAttempt();
        ctx.state.stopped = true;

        expect(await standDown(ctx, 'its run', async () => void calls.push('hook'))).toBe(true);

        expect(calls).toEqual([...CLAIM_BACK, 'hook', 'suspend', 'log']);
    });

    it.each(['lost', 'removed'] as const)('skips the pre-park hook when the lease is %s', async (verdict) => {
        const { ctx, calls, lines } = fencedAttempt();
        ctx.state[verdict] = true;

        expect(await standDown(ctx, 'its run', async () => void calls.push('hook'))).toBe(true);

        expect(calls).toEqual([...CLAIM_BACK, 'log']);
        expect(lines.join('\n')).toContain('during its run');
    });

    it('answers an attempt that is not down with nothing done', async () => {
        const { ctx, calls } = fencedAttempt();

        expect(await standDown(ctx, 'setup')).toBe(false);

        expect(calls).toEqual([]);
    });

    it.each([
        ['a fault', FAULT, 'complete:job-1'],
        ['a leave', LEAVE, null],
        ['a requeue', REQUEUE, 'requeue:job-1'],
        ['a conclusion', CONCLUDED, 'complete:job-1'],
    ] satisfies readonly (readonly [string, SetupHalt, string | null])[])(
        'concludes %s only after the claim is back',
        async (_what, halt, reported) => {
            const { ctx, calls, lines } = fencedAttempt();

            await concludeSetup(ctx, halt);

            // Issue #469: a replacement claimant starts the moment the job is completed, so the
            // release can never land after the report. A `leave` reports nothing at all; a
            // `requeue` hands the claim back instead of reporting (issue #559).
            expect(calls).toEqual([...CLAIM_BACK, 'log', ...(reported === null ? [] : [reported])]);
            expect(lines.join('\n')).toContain(halt.log);
        }
    );

    it('releases the claim from one loop file only', () => {
        const owners = loopSources()
            .filter(([, source]) => source.includes('releaseFence'))
            .map(([file]) => file);
        expect(owners).toEqual(['loop-fence.ts']);
    });

    it('defines both fences once, and no other loop file does', () => {
        const definers = loopSources()
            .filter(([, source]) => /export async function (standDown|concludeSetup)\(/.test(source))
            .map(([file]) => file);
        expect(definers).toEqual(['loop-fence.ts']);
    });

    it('keeps the helper steps pure — they answer data and settle for nobody', () => {
        // The pre-helper runs inside setup and is the other setup module, so a settlement or a
        // release of its own is a fence it should not own (issue #472).
        const helpers = loopSources().find(([file]) => file === 'loop-helpers.ts')?.[1] ?? '';
        expect(helpers.match(/await (ctx\.)?settle\(\)/g) ?? []).toEqual([]);
        expect(helpers.match(/releaseFence/g) ?? []).toEqual([]);
    });

    it('mints the attempt one signal, never one per step', () => {
        // The gate exec, the tree probe and the gate-session cancel all take `state.signal`: a
        // controller per transport is a controller that can answer a stand-down out of step with
        // the race that decides one (issue #472).
        const minting = loopSources()
            .filter(([file, source]) => file !== 'loop-attempt.ts' && source.includes('new AbortController'))
            .map(([file]) => file);
        expect(minting).toEqual([]);
    });

    it('leaves loop-run no second stand-down path and no phase-level check of its own', () => {
        // What remains of `down(state)` are re-checks after an await INSIDE a step (loop-gates,
        // loop-helpers); a phase boundary asks `standDown` (issue #488).
        const run = loopSources().find(([file]) => file === 'loop-run.ts')?.[1] ?? '';
        expect(run).not.toMatch(/settleNonFinish|\bdown\(/);
    });

    it('fences every phase boundary from loop-run, and nowhere else', () => {
        const callers = loopSources()
            .filter(([file, source]) => file !== 'loop-fence.ts' && /standDown\(ctx, '/.test(source))
            .map(([file]) => file);
        expect(callers).toEqual(['loop-run.ts']);
    });
});

describe('one abort signal per attempt (issue #472)', () => {
    it('is aborted by the heartbeat verdict, through abortNow', () => {
        const state = newJobState();

        expect(state.signal.aborted).toBe(false);
        state.abortNow();
        expect(state.signal.aborted).toBe(true);
    });

    it('answers the step that won the race', async () => {
        const state = newJobState();

        expect(await raceStep(state.signal, Promise.resolve('value'))).toEqual({ value: 'value' });
    });

    it('never waits on a step the attempt already stood down', async () => {
        const state = newJobState();
        state.abortNow();

        // A promise nobody can settle: the race must answer on the signal, not on the step.
        expect(await raceStep(state.signal, new Promise<string>(() => {}))).toBeNull();
    });

    it('never lets an abandoned step reject into the void', async () => {
        const state = newJobState();
        state.abortNow();
        const failures: unknown[] = [];
        const onRejection = (why: unknown) => failures.push(why);
        process.on('unhandledRejection', onRejection);
        try {
            // A step already in flight when the stand-down lands, rejecting after it was abandoned.
            expect(await raceStep(state.signal, Promise.reject(new Error('the step threw late')))).toBeNull();
            await new Promise((resolve) => setImmediate(resolve));
            expect(failures).toEqual([]);
        } finally {
            process.off('unhandledRejection', onRejection);
        }
    });

    it('answers null when the stand-down lands mid-step', async () => {
        const state = newJobState();
        const running = raceStep(state.signal, new Promise<string>(() => {}));

        state.abortNow();

        expect(await running).toBeNull();
    });

    it('leaves no abort listener behind when a step won', async () => {
        // An attempt has one step per phase; a signal that kept every finished step's listener
        // would hold them all until the attempt ends.
        const state = newJobState();

        await raceStep(state.signal, Promise.resolve('value'));

        expect(getEventListeners(state.signal, 'abort')).toHaveLength(0);
    });
});
