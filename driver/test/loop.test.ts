import { describe, expect, it } from 'vitest';
import type {
    Board,
    BoardJob,
    BoardLease,
    HeartbeatVerdict,
    LeaseState,
    Reclaim,
    RuntimeReport,
} from '../src/board.js';
import { loadDriverConfig, type DriverConfig } from '../src/config.js';
import type { DeadService, RunOutcome, RunSession, Runner, RuntimeSample } from '../src/runner.js';
import type { GateManager, GateServer } from '../src/gates.js';
import type { HelperPlan, HelperResult } from '../src/helpers.js';
import type { PublishResult, ReclaimResult, SyncResult } from '../src/publish.js';
import { createLoop, type Loop } from '../src/loop.js';
import { processReclaim, type ReclaimContext } from '../src/loop-reclaim.js';
import type { GateStack, LoopRuntime } from '../src/loop-types.js';
import { newJobState, watchOutput } from '../src/loop-attempt.js';

const USER = '44444444-4444-4444-8444-444444444444';

/** A fixed, valid Factory execution context — the shape master-prompt.test.ts pins; only its
 *  presence matters to this file's own tests, none of which assert its exact text. */
const MASTER_PROMPT =
    'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone';

const job = (n: number, resumeSessionId: string | null = null): BoardJob => ({
    id: `0000000${n}-1111-4111-8111-111111111111`,
    command: `job ${n}`,
    attempts: 1,
    leaseToken: `0000000${n}-2222-4222-8222-222222222222`,
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    masterPrompt: MASTER_PROMPT,
    resumeSessionId,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
});

interface BoardStub extends Board {
    completed: {
        id: string;
        status: string;
        exitCode: number | null;
        output: string;
        publication?: {
            repo: string;
            prNumber: number;
            prUrl: string;
            headBranch: string;
            baseBranch: string;
        } | null;
    }[];
    sessions: { id: string; sessionId: string | null }[];
    progressed: { id: string; output: string; runtime: RuntimeReport | null }[];
    suspended: string[];
    beats: number;
    gatesReported: {
        id: string;
        results: { name: string; status: string; exitCode: number | null; output: string | null }[];
    }[];
    gatesReread: number;
    publishTokenAsks: string[];
    reclaimGrants: Reclaim[];
    reclaimAcks: string[];
    leaseLookups: string[][];
    /** The artifact uploads the loop made (issue #325), in the order it made them. */
    artifacts: { id: string; kind: string; attempt: number; content: string; truncated: boolean }[];
}

/**
 * Hands out the given jobs, then answers empty. After `idleBeforeStop` empty answers it stops the
 * loop — the loop is an infinite poll, so something has to end it, and counting idle polls is the
 * one signal that means "it has claimed everything it is going to".
 */
function stubBoard(
    jobs: BoardJob[],
    options: {
        lease?: LeaseState;
        progressLease?: LeaseState;
        failProgress?: boolean;
        idleBeforeStop?: number;
        failClaims?: number;
        failSession?: boolean;
        rereadGates?: { gates: BoardJob['gates']; gateError: string | null } | null;
        threadDone?: boolean;
        completeLease?: LeaseState;
        completeFor?: (claimed: BoardJob) => { state: LeaseState; threadDone: boolean };
        cancelRequested?: boolean;
        removedOnBeat?: boolean;
        reclaims?: Reclaim[];
        ackReclaimLease?: 'ok' | 'lost' | 'missing';
        failAckReclaim?: boolean;
        publishToken?: string | null;
        /** The board's answer to `leases` — null models a refused lookup (issue #344). */
        leaseRows?: BoardLease[] | null;
    } = {}
): { board: BoardStub; attach: (loop: Loop) => void } {
    let loop: Loop | null = null;
    let idle = 0;
    let failures = options.failClaims ?? 0;
    const queue = [...jobs];
    const reclaimQueue = options.reclaims ? [...options.reclaims] : [];

    const board: BoardStub = {
        completed: [],
        sessions: [],
        progressed: [],
        suspended: [],
        beats: 0,
        gatesReported: [],
        gatesReread: 0,
        publishTokenAsks: [],
        reclaimGrants: [],
        reclaimAcks: [],
        leaseLookups: [],
        artifacts: [],
        async leases(ids) {
            board.leaseLookups.push([...ids]);
            if (options.leaseRows === undefined) return [];
            return options.leaseRows;
        },
        async suspend(claimed) {
            board.suspended.push(claimed.id);
            return 'held';
        },
        async session(claimed, sessionId) {
            if (options.failSession) throw new Error('board unreachable');
            board.sessions.push({ id: claimed.id, sessionId });
            return 'held';
        },
        async artifact(claimed, upload) {
            board.artifacts.push({ id: claimed.id, ...upload });
            return 'held';
        },
        async progress(claimed, output, runtime) {
            if (options.failProgress) throw new Error('board unreachable');
            board.progressed.push({ id: claimed.id, output, runtime: runtime ?? null });
            return options.progressLease ?? 'held';
        },
        async claim() {
            if (failures > 0) {
                failures -= 1;
                throw new Error('board unreachable');
            }
            const next = queue.shift();
            if (next) return next;
            idle += 1;
            if (idle >= (options.idleBeforeStop ?? 1)) loop?.stop();
            return null;
        },
        async heartbeat() {
            board.beats += 1;
            if (options.lease === 'lost') return 'lost';
            if (options.removedOnBeat) return 'removed';
            const verdict: HeartbeatVerdict = { result: 'held', cancelRequested: options.cancelRequested ?? false };
            return verdict;
        },
        async claimReclaim(_worker) {
            const next = reclaimQueue.shift();
            if (next) board.reclaimGrants.push(next);
            return next ?? null;
        },
        async ackReclaim(id) {
            if (options.failAckReclaim) throw new Error('board unreachable');
            board.reclaimAcks.push(id);
            return options.ackReclaimLease ?? 'ok';
        },
        async rereadGates(_claimed) {
            board.gatesReread += 1;
            return options.rereadGates ?? null;
        },
        async publishToken(claimed) {
            board.publishTokenAsks.push(claimed.id);
            return options.publishToken ?? null;
        },
        async complete(claimed, result) {
            board.completed.push({ id: claimed.id, ...result });
            if (options.completeFor) return options.completeFor(claimed);
            return { state: options.completeLease ?? 'held', threadDone: options.threadDone ?? false };
        },
        async gates(claimed, results) {
            board.gatesReported.push({ id: claimed.id, results });
            return options.lease ?? 'held';
        },
    };

    return { board, attach: (l) => (loop = l) };
}

function stubRunner(
    outcome: (job: BoardJob, session: RunSession | null, onOutput?: (tail: string) => void) => Promise<RunOutcome>,
    options: {
        sample?: Omit<RuntimeSample, 'sampledAt'> | null;
        publish?: PublishResult | null;
        sync?: SyncResult | null;
        syncError?: Error;
        reclaim?: { ok: boolean; removed: boolean; reason: string | null } | null;
        /** Answers popped per reclaimWorktree call, falling back to `reclaim` (issue #344). */
        reclaimSequence?: ReclaimResult[];
        /** The kubernetes orphan-claim reap; recorded in `reapAttempts` (issue #344). */
        reapOrphanedClaim?: (job: BoardJob) => Promise<boolean>;
        /** The post-gate tree probe's answer; absent leaves the runner without `probeTree`. */
        probeTree?: string | null;
        /** The dead-service probe (issue #423); every call is counted in `deadServiceProbes`. */
        deadServices?: () => Promise<DeadService[]>;
    } = {}
): Runner & {
    killed: string[];
    samples: number;
    published: BoardJob[];
    publishTokens: (string | undefined)[];
    synced: BoardJob[];
    reclaimed: BoardJob[];
    servicesReleased: string[];
    reapAttempts: BoardJob[];
    probed: BoardJob[];
    deadServiceProbes: number;
} {
    const { sample = null, publish = null, sync = null, syncError = null, reclaim = null } = options;
    const reclaimQueue = options.reclaimSequence ? [...options.reclaimSequence] : [];
    const runner = {
        servicesReleased: [] as string[],
        reapAttempts: [] as BoardJob[],
        probed: [] as BoardJob[],
        deadServiceProbes: 0,
        async deadServices() {
            runner.deadServiceProbes += 1;
            return options.deadServices ? options.deadServices() : [];
        },
        async releaseServices(releasedJob: BoardJob) {
            runner.servicesReleased.push(releasedJob.id);
        },
        killed: [] as string[],
        samples: 0,
        published: [] as BoardJob[],
        publishTokens: [] as (string | undefined)[],
        synced: [] as BoardJob[],
        reclaimed: [] as BoardJob[],
        run: outcome,
        async sampleRuntime() {
            runner.samples += 1;
            return sample;
        },
        async kill(killedJob: BoardJob) {
            runner.killed.push(killedJob.id);
        },
        async publishGit(publishedJob: BoardJob, publishToken?: string) {
            runner.published.push(publishedJob);
            runner.publishTokens.push(publishToken);
            return (
                publish ?? {
                    ok: true,
                    published: false,
                    branch: null,
                    prUrl: null,
                    reason: null,
                    repository: null,
                    baseBranch: null,
                    prNumber: null,
                }
            );
        },
        async syncCheckout(syncedJob: BoardJob) {
            runner.synced.push(syncedJob);
            if (syncError) throw syncError;
            return sync ?? { ok: true, reason: null };
        },
        async reclaimWorktree(reclaimedJob: BoardJob) {
            runner.reclaimed.push(reclaimedJob);
            const next = reclaimQueue.shift();
            if (next) return next;
            return reclaim ?? { ok: true, removed: true, reason: null };
        },
        ...(options.probeTree !== undefined
            ? {
                  probeTree: async (probedJob: BoardJob) => {
                      runner.probed.push(probedJob);
                      return options.probeTree ?? null;
                  },
              }
            : {}),
        ...(options.reapOrphanedClaim
            ? {
                  reapOrphanedClaim: async (orphanJob: BoardJob) => {
                      runner.reapAttempts.push(orphanJob);
                      return options.reapOrphanedClaim?.(orphanJob) ?? false;
                  },
              }
            : {}),
    };
    return runner;
}

const ok = (over: Partial<RunOutcome> = {}): RunOutcome => ({
    exitCode: 0,
    output: 'done',
    timedOut: false,
    started: true,
    ...over,
});

const config = (env: NodeJS.ProcessEnv = {}): DriverConfig => loadDriverConfig(env);

/**
 * Near-instant, so the suite never waits on a real poll interval or heartbeat period — but a
 * macrotask, not a resolved promise. An immediate `async () => {}` keeps the heartbeat spinning
 * inside the microtask queue, which starves every timer the fake runners are waiting on and hangs
 * the suite rather than failing it.
 */
const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function drive(
    deps: {
        board: BoardStub;
        attach: (loop: Loop) => void;
        runner: Runner;
        gates?: GateStack;
        log?: (message: string) => void;
    },
    env = {}
) {
    const loop = createLoop({
        board: deps.board,
        runner: deps.runner,
        config: config(env),
        gates: deps.gates,
        log: deps.log,
        sleep,
    });
    deps.attach(loop);
    await loop.start();
    return loop;
}

/**
 * A gate stack whose manager and server record what the loop asked of them. The manager answers
 * scripted exit codes; the server's listen answers a fixed port so the advertised URL is
 * predictable.
 */
function stubGateStack(outcomes: Record<string, number> = {}) {
    const stack = {
        acquired: [] as string[],
        released: [] as string[],
        registered: 0,
        unregistered: 0,
        cancelled: [] as string[],
        advertised: '',
        ran: { key: '', names: [] as string[] },
        manager: {
            acquire: async (key: string) => {
                stack.acquired.push(key);
            },
            runGate: async (key: string, name: string) => {
                stack.ran = { key, names: [...stack.ran.names, name] };
                const code = outcomes[name] ?? 0;
                return { exitCode: code, output: code === 0 ? `${name} ok` : `${name} failed badly` };
            },
            release: (key: string) => {
                stack.released.push(key);
            },
            stop: async () => {},
        } as GateManager,
        server: {
            register: () => {
                stack.registered += 1;
            },
            unregister: () => {
                stack.unregistered += 1;
            },
            cancel: (token: string) => {
                stack.cancelled.push(token);
            },
            // No ad-hoc gate ran through this stub, so the timeout note's verdict history is empty.
            lastRuns: () => [],
            listen: async () => 9099,
            close: async () => {},
        } as GateServer,
    };
    const gates: GateStack = {
        manager: stack.manager,
        server: stack.server,
        advertiseUrl: (port) => {
            stack.advertised = `http://host.docker.internal:${port}`;
            return stack.advertised;
        },
    };
    return { stack, gates };
}

const gatedJob = (n: number): BoardJob => ({
    ...job(n),
    repo: 'Bellows-AI/factory',
    gates: {
        image: 'node:24',
        gates: [
            { name: 'test', command: 'npm test' },
            { name: 'lint', command: 'npm run lint' },
        ],
    },
});

describe('the poll loop', () => {
    it('claims a job, runs it and reports success', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([
            {
                id: job(1).id,
                status: 'succeeded',
                exitCode: 0,
                output: 'done',
                contextTokens: null,
                contextCostUsd: null,
            },
        ]);
    });

    it('reports a non-zero exit as a failure, with the output', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ exitCode: 2, output: 'boom' }));

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: 2, output: 'boom' });
    });

    /**
     * A zero exit code is not proof of completion. opencode exits 0 when the model's context
     * limit cuts a task short mid-investigation — the only tell is the finish reason the runner
     * scrapes from the session database at close. Reported as a failure with the reason, so a
     * green verdict never hangs over work nothing was finished on; `stop`, and every runner
     * that scrapes nothing, keep the exit code in charge.
     */
    it('fails a run whose finish reason says it never completed, despite exit 0', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ output: 'reads only', finishReason: 'length' }));

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: 0 });
        expect(board.board.completed[0]?.output).toContain('finish reason: "length"');
    });

    /**
     * The finish reason says the run stopped talking; the session's last provider error says WHY.
     * Observed 2026-09-11: a 429 rate limit cut a run off mid-tool-call and the verdict named
     * only "tool-calls", sending its reader into the session database for the cause. When the
     * scrape carried an error, the note names it.
     */
    it('names the provider error beside the premature stop, when the scrape carried one', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () =>
            ok({
                output: 'reads only',
                finishReason: 'tool-calls',
                providerError: 'Error from provider (Console): Rate limit exceeded. Please try again later.',
            })
        );

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: 0 });
        expect(board.board.completed[0]?.output).toContain('finish reason: "tool-calls"');
        expect(board.board.completed[0]?.output).toContain('Rate limit exceeded. Please try again later.');
    });

    // A run that finished cleanly is not explained by an error it already retried through — the
    // provider error is only the premature stop's cause, never a healthy verdict's footnote.
    it('leaves a stopped run’s provider error out of the verdict', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () =>
            ok({ finishReason: 'stop', providerError: 'Error from provider (Console): Rate limit exceeded.' })
        );

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded', exitCode: 0 });
        expect(board.board.completed[0]?.output).not.toContain('Rate limit exceeded');
    });

    it('keeps a stop finish a success, whatever the session scrape reads', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ finishReason: 'stop' }));

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded', exitCode: 0 });
    });

    // The context the run reached rides the verdict: the finished row carries it beside its
    // vitals, which is where "died at a full window" is legible.
    it('reports the scraped context stats with the verdict', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ finishReason: 'stop', contextTokens: 90433, costUsd: 0.31 }));

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({
            status: 'succeeded',
            contextTokens: 90433,
            contextCostUsd: 0.31,
        });
    });

    it('reports the close-time agent-turn count with the verdict, and never a non-number', async () => {
        const board = stubBoard([job(1), job(2)]);
        let ran = 0;
        const runner = stubRunner(async () => (ran++ === 0 ? ok({ agentTurns: 11 }) : ok()));

        await drive({ ...board, runner });

        // A measured count rides the report.
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded', agentTurns: 11 });

        // The second job's runner read nothing: the field stays OFF the wire entirely, so the
        // board stores unmeasured — the never-zero contract holds on the driver's side too.
        expect(board.board.completed[1]).not.toHaveProperty('agentTurns');
    });

    it('reports the run summary with the verdict, and nothing when the read lifted none', async () => {
        const board = stubBoard([job(1), job(2)]);
        let ran = 0;
        const runner = stubRunner(async () => (ran++ === 0 ? ok({ summary: 'Fixed the failing gates' }) : ok()));

        await drive({ ...board, runner });

        // A summary rides the report: what the run did, in the agent's own words.
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded', summary: 'Fixed the failing gates' });

        // No summary read — the field stays off the wire, and the board stores null.
        expect(board.board.completed[1]).not.toHaveProperty('summary');
    });

    /**
     * The run artifacts (issue #325): the loop uploads the runner's full log and transcript at
     * close, while the lease is still live — before the verdict on the ordinary path, before the
     * park on a stop, never on a lost or removed row. Best-effort throughout; the pins below are
     * the ordering and the scoping, the upload helper's own failure rules live in
     * artifacts.test.ts.
     */
    it('uploads the run artifacts before the verdict, and none when the lease was lost', async () => {
        const events: string[] = [];
        const board = stubBoard([job(1)]);
        const rawComplete = board.board.complete.bind(board.board);
        board.board.complete = async (claimed, result) => {
            events.push(`completed with ${board.board.artifacts.length} artifact(s) uploaded`);
            return rawComplete(claimed, result);
        };
        const runner = stubRunner(async () =>
            ok({ fullLog: 'the whole log\n', logTruncated: true, transcript: '[{"role":"assistant"}]' })
        );

        // A second job whose heartbeat answers lost: nothing uploads, nothing completes.
        const second = stubBoard([job(2)], { lease: 'lost' });
        const rawCompleteSecond = second.board.complete.bind(second.board);
        second.board.complete = async (claimed, result) => {
            events.push('completed while lost');
            return rawCompleteSecond(claimed, result);
        };
        const losing = stubRunner(async () => ok({ fullLog: 'lost log' }));

        await drive({ ...board, runner });
        await drive({ ...second, runner: losing });

        expect(events).toEqual(['completed with 2 artifact(s) uploaded']);
        expect(board.board.artifacts).toEqual([
            { id: job(1).id, kind: 'log', attempt: 1, content: 'the whole log\n', truncated: true },
            { id: job(1).id, kind: 'transcript', attempt: 1, content: '[{"role":"assistant"}]', truncated: false },
        ]);
        expect(second.board.artifacts).toEqual([]);
    });

    it('uploads the artifacts before parking a stopped run', async () => {
        const events: string[] = [];
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        const rawSuspend = board.board.suspend.bind(board.board);
        board.board.suspend = async (claimed) => {
            events.push(`parked with ${board.board.artifacts.length} artifact(s) uploaded`);
            return rawSuspend(claimed);
        };
        const runner = stubRunner(async () => {
            // The stop lands once the run is live (the same shape the session-report-before-park
            // pin uses): the beats then carry the flag, and the container is killed mid-run.
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return ok({ fullLog: 'stopped log\n' });
        });

        await drive({ ...board, runner });

        expect(events).toEqual(['parked with 1 artifact(s) uploaded']);
        expect(board.board.artifacts.map((a) => a.kind)).toEqual(['log']);
        expect(board.board.suspended).toEqual([job(1).id]);
    });

    // An opencode run always leaves a session, so an empty scrape is a failed readout — said out
    // loud, because a silently-lost session presents later as "this run cannot take a follow-up"
    // with nothing anywhere naming why.
    it('says so when an opencode run closes with no session scraped', async () => {
        const board = stubBoard([{ ...job(1), executorType: 'opencode' }]);
        const runner = stubRunner(async () => ok({ finishReason: 'stop', contextTokens: 1200, costUsd: 0 }));
        const logs: string[] = [];
        const loop = createLoop({
            board: board.board,
            runner,
            config: config(),
            sleep,
            log: (m) => logs.push(m),
        });
        board.attach(loop);

        await loop.start();

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        expect(logs.some((m) => m.includes('the session readout came up empty'))).toBe(true);
    });

    // The container is already dead by the time this lands; the note is the only place a reader
    // learns the run was cut off rather than having genuinely failed.
    it('says so when it killed the runner on the timeout', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ exitCode: 137, output: 'partial', timedOut: true }));

        await drive({ ...board, runner }, { DRIVER_JOB_TIMEOUT_MS: '60000' });

        expect(board.board.completed[0]?.status).toBe('failed');
        expect(board.board.completed[0]?.output).toContain('killed after 60000ms');
        expect(board.board.completed[0]?.output).toContain(' — idle: no output');
        expect(board.board.completed[0]?.failureKind).toBe('timeout');
    });

    // The active/idle distinction (issue #339): a run whose tail was still moving when the wall
    // clock ran out was WORKING — the note must say so, with the last activity line, not leave
    // the reader to raw-SQL three sources to find out.
    it('says a timed-out run was still active when its output was still arriving', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('Now the two wording fixes:');
            return ok({ exitCode: 137, output: 'partial', timedOut: true });
        });

        await drive({ ...board, runner }, { DRIVER_JOB_TIMEOUT_MS: '60000' });

        expect(board.board.completed[0]?.status).toBe('failed');
        expect(board.board.completed[0]?.output).toContain('killed after 60000ms — still active: last output');
        expect(board.board.completed[0]?.output).toContain('last activity "Now the two wording fixes:"');
    });

    // The declared gates run AFTER the kill — a suite can take minutes — and the note must not
    // age the last output from VERDICT time: a run that was streaming when it died would read
    // idle because its gates were slow. Observed against the first cut of the note, which did.
    it('ages the timeout note from the run’s end, not the verdict the slow gates delay', async () => {
        const board = stubBoard([gatedJob(1)]);
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('still writing');
            return ok({ exitCode: 137, output: 'partial', timedOut: true });
        });
        const { gates, stack } = stubGateStack();
        stack.manager.runGate = async () => {
            await new Promise((resolve) => setTimeout(resolve, 2_500));
            return { exitCode: 0, output: 'ok' };
        };

        await drive({ ...board, runner, gates });

        expect(board.board.completed[0]?.failureKind).toBe('timeout');
        // The output was stamped the instant the run resolved; aged from the run's end the age
        // is ~0. Aged from the verdict — the bug — it would read the gates' 2.5s as "2s".
        expect(board.board.completed[0]?.output).toContain(' — still active: last output 0s ago');
    });

    // Instructions are not enforcement: the deterministic publish runs after a succeeded run,
    // and its result changes the verdict — work that landed nowhere is not a success.
    it('publishes a succeeded run and says where the work landed', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok(), {
            publish: {
                ok: true,
                published: true,
                branch: 'fix/10',
                prUrl: 'https://github.com/Bellows-AI/factory/pull/42',
                reason: null,
                repository: 'Bellows-AI/factory',
                baseBranch: 'main',
                prNumber: 42,
            },
        });

        await drive({ ...board, runner });

        expect(runner.published).toHaveLength(1);
        expect(board.board.completed[0]?.status).toBe('succeeded');
        expect(board.board.completed[0]?.output).toContain(
            '[driver] published fix/10 — https://github.com/Bellows-AI/factory/pull/42'
        );
        // The structured identity of the publication rides the verdict — the board records what
        // a thread shipped, and review traffic and the thread's wait key on it.
        expect(board.board.completed[0]?.publication).toEqual({
            repo: 'Bellows-AI/factory',
            prNumber: 42,
            prUrl: 'https://github.com/Bellows-AI/factory/pull/42',
            headBranch: 'fix/10',
            baseBranch: 'main',
        });
    });

    // A no-op publish — clean tree, nothing unpushed — invents no publication: the board must
    // not record a thread as having shipped a PR it did not.
    it('reports no publication when the publish is a no-op', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok(), {
            publish: {
                ok: true,
                published: false,
                branch: null,
                prUrl: null,
                reason: 'no uncommitted changes and nothing unpushed',
                repository: null,
                baseBranch: null,
                prNumber: null,
            },
        });

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.status).toBe('succeeded');
        expect(board.board.completed[0]?.publication).toBeUndefined();
    });

    it('fails the verdict when the publish does not land', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok(), {
            publish: {
                ok: false,
                published: false,
                branch: null,
                prUrl: null,
                reason: 'git step failed: authentication refused',
            },
        });

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.status).toBe('failed');
        expect(board.board.completed[0]?.output).toContain(
            '[driver] publish failed — the work did not land: git step failed: authentication refused'
        );
    });

    // The publish flag is the board's decision: on a workflow task only the graph's publish node
    // may push, so a mid-loop review's clean run must NOT — no publish containers/Job, and no
    // credential ask either (docs/workflows.md). Both executors read this one claim field.
    it('skips the publish when the claim says publish: false', async () => {
        const claimed = { ...job(1), publish: false };
        const board = stubBoard([claimed]);
        const runner = stubRunner(async () => ok(), {
            publish: {
                ok: true,
                published: true,
                branch: 'fix/10',
                prUrl: 'https://github.com/Bellows-AI/factory/pull/42',
                reason: null,
                repository: 'Bellows-AI/factory',
                baseBranch: 'main',
                prNumber: 42,
            },
        });

        await drive({ ...board, runner });

        expect(runner.published).toHaveLength(0);
        expect(board.board.publishTokenAsks).toHaveLength(0);
        // The run itself still succeeded — the work stays on the task branch in the worktree.
        expect(board.board.completed[0]?.status).toBe('succeeded');
    });

    // A claim without the flag is a board that predates it: publish exactly as before, so an old
    // board and a new driver — or a workflow-less task on the new board — behave byte-identically.
    it('publishes when the claim carries no publish flag at all', async () => {
        const claimed = { ...job(1) };
        delete (claimed as Partial<BoardJob>).publish;
        const board = stubBoard([claimed]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(runner.published).toHaveLength(1);
        expect(board.board.completed[0]?.status).toBe('succeeded');
    });

    // A runner with no publishGit at all — publishing is an optional capability the loop asks
    // for, not one it assumes; both shipped runners carry it, a third platform need not.
    it('reports a clean run succeeded from a runner that cannot publish', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());
        delete (runner as Partial<Runner>).publishGit;

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.status).toBe('succeeded');
        // The publish credential is the publisher's ask — no publisher, no ask.
        expect(board.board.publishTokenAsks).toHaveLength(0);
    });

    // The claim's installation token is an hour old at best; a run that outlives it must not
    // publish with a dead credential (job 43379d3a pushed with a token 34 minutes past expiry
    // and the publish failed on 401 with the work done). The loop asks right before the push
    // and lays the answer over the claim env; null keeps the claim env.
    it("publishes with the board's fresh credential laid over the claim env", async () => {
        const claimed = { ...job(1), env: { GITHUB_TOKEN: 'claim-token', CORE: 'claim-value' } };
        const board = stubBoard([claimed], { publishToken: 'ghs_fresh' });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.publishTokenAsks).toEqual([job(1).id]);
        // The credential rides the runner call; laying it over the claim env is the transport's
        // job (withPublishToken), pinned by the docker and kubernetes suites.
        expect(runner.publishTokens).toEqual(['ghs_fresh']);
    });

    it('publishes with the claim env untouched when the board holds nothing fresher', async () => {
        const claimed = { ...job(1), env: { GITHUB_TOKEN: 'claim-token', CORE: 'claim-value' } };
        const board = stubBoard([claimed]);
        const runner = stubRunner(async () => ok());
        const logs: string[] = [];

        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(board.board.publishTokenAsks).toEqual([job(1).id]);
        expect(runner.publishTokens).toEqual([undefined]);
        // Null is both the route's honest "nothing fresher" and its failure shape — the driver
        // cannot tell a 401 from an answer, so the degradation says itself either way.
        expect(logs.some((m) => m.includes('publish-token ask answered nothing fresh'))).toBe(true);
    });

    // Only a succeeded run publishes: a failed or truncated run's tree may be mid-thought, and
    // pushing it would publish work the author never saw a verdict on.
    it('does not publish a run that did not succeed', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ exitCode: 2, output: 'boom' }));

        await drive({ ...board, runner });

        expect(runner.published).toHaveLength(0);
    });

    it('does not publish a run that stopped talking early', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ finishReason: 'length' }));

        await drive({ ...board, runner });

        expect(runner.published).toHaveLength(0);
        expect(board.board.completed[0]?.status).toBe('failed');
    });

    // The checkout is synced before anything reads it — the run itself included. A sync failure
    // is the author's environment naming itself, and the run never starts on a tree of unknown
    // state.
    it('syncs the checkout before the run', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(runner.synced).toEqual([job(1)]);
        expect(board.board.completed[0]?.status).toBe('succeeded');
    });

    it('fails a task whose selected executor profile no longer resolves, before anything runs', async () => {
        const board = stubBoard([{ ...job(1), executorType: null }]);
        const runner = stubRunner(async () => {
            throw new Error('the runner must never be reached');
        });

        await drive({ ...board, runner });

        expect(runner.synced).toHaveLength(0);
        expect(board.board.completed[0]?.status).toBe('failed');
        expect(board.board.completed[0]?.output).toContain('selected executor no longer exists');
    });

    // Issue #244: the board always renders a master prompt for every agent claim, so a missing
    // one is a contract violation the driver refuses explicitly, before any setup — never a run
    // with no Factory execution context.
    it('fails a task with no master prompt, before anything runs', async () => {
        const board = stubBoard([{ ...job(1), masterPrompt: null }]);
        const runner = stubRunner(async () => {
            throw new Error('the runner must never be reached');
        });

        await drive({ ...board, runner });

        expect(runner.synced).toHaveLength(0);
        expect(board.board.completed[0]?.status).toBe('failed');
        expect(board.board.completed[0]?.output).toContain('no Factory execution context');
    });

    // The same no-fallback rule the null workspacePath refusal applies, extended to the task
    // worktree (issue #35): a repo-shaped label this driver cannot resolve a worktree path for
    // is failed with a reason, never run in a fallback location.
    it('fails a repo job whose worktree path cannot be resolved, before anything runs', async () => {
        const broken: BoardJob = { ...job(1), repo: 'Bellows-AI/factory', rootJobId: 'not-a-uuid' };
        const board = stubBoard([broken]);
        const runner = stubRunner(async () => {
            throw new Error('the runner must never be reached');
        });

        await drive({ ...board, runner });

        expect(runner.synced).toHaveLength(0);
        expect(board.board.completed[0]?.status).toBe('failed');
        expect(board.board.completed[0]?.output).toContain('do not resolve to a task worktree');
    });

    it('fails the attempt with the reason when the checkout sync fails', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok(), {
            sync: {
                ok: false,
                reason: 'the task branch could not be rebased onto origin/main: conflict in driver/src/loop.ts',
            },
        });

        await drive({ ...board, runner });

        expect(runner.synced).toHaveLength(1);
        // The run never started on an unknown tree.
        expect(board.board.completed[0]?.status).toBe('failed');
        expect(board.board.completed[0]?.output).toContain('could not be synced with the remote');
        expect(board.board.completed[0]?.output).toContain('conflict in driver/src/loop.ts');
    });

    // A poll that exhausted its patience is infrastructure, not a verdict (issue #308): the
    // exhaustion arrives as a THROW from syncCheckout, and the loop's catch leaves the job to its
    // lease — the same arm a stand-down takes — never a terminal `failed` with attempts left.
    it('leaves the job to its lease when the checkout sync poll exhausts — never reports failed', async () => {
        const board = stubBoard([job(1)]);
        const logs: string[] = [];
        const runner = stubRunner(async () => ok(), {
            syncError: new Error('reading the worktree sync job answered 400 15 times in a row: 400 Bad Request'),
        });

        await drive({ ...board, runner, log: (message) => logs.push(message) });

        expect(runner.synced).toHaveLength(1);
        expect(board.board.completed).toEqual([]);
        expect(logs.some((message) => message.includes('checkout sync threw, leaving it to the lease'))).toBe(true);
    });

    // The claim read the gates file before the sync freshened the checkout — the re-read is what
    // makes a gates file that just arrived gate THIS run instead of the next one.
    it('gates the run on the re-read answer when the sync surfaced a gates file', async () => {
        const board = stubBoard([job(1)], {
            rereadGates: {
                gates: null,
                gateError: '.bellows.yaml line 3: unknown key "ports"',
            },
        });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.gatesReread).toBe(1);
        // The run never started: a broken gates file is a failed job, now and not next task.
        expect(runner.synced).toHaveLength(1);
        expect(runner.published).toHaveLength(0);
        expect(board.board.completed[0]?.status).toBe('failed');
        expect(board.board.completed[0]?.output).toContain('could not be read as a gate declaration');
    });

    it('keeps the claim’s gates when the re-read is refused', async () => {
        const board = stubBoard([job(1)], { rereadGates: null });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.gatesReread).toBe(1);
        expect(board.board.completed[0]?.status).toBe('succeeded');
    });

    // The terminal reclaim (issue #47, revised): after the thread is DONE — every member terminal
    // AND the user's done on one of them, the board says so in the same breath as the verdict —
    // the per-thread task worktree is removed. A thread that merely finished keeps its tree: the
    // tree is the user's to free, and a failed task's tree is what its next turn continues from.
    it('reclaims the task worktree when the complete answer says the thread is done', async () => {
        const board = stubBoard([job(1)], { threadDone: true });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.status).toBe('succeeded');
        expect(runner.reclaimed).toEqual([job(1)]);
    });

    it('keeps the task worktree when the complete answer says the thread is not done', async () => {
        // The default answer is "the thread is not done" — a follow-up still queued, or a
        // finished thread the user has not closed. No reclaim attempt is made at all: the tree
        // belongs to a thread that might continue, or to a user who has not said done.
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.status).toBe('succeeded');
        expect(runner.reclaimed).toHaveLength(0);
    });

    it('reclaims after a pre-run failure, once the whole thread is done', async () => {
        // A job whose checkout cannot be synced is completed failed without ever running; the
        // reclaim is the same downstream-of-the-verdict step it is for a run.
        const repoJob = { ...job(1), repo: 'Bellows-AI/factory', workspacePath: `bellows/${USER}` };
        const board = stubBoard([repoJob], { threadDone: true });
        const runner = stubRunner(async () => ok(), { sync: { ok: false, reason: 'no disk' } });

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.status).toBe('failed');
        expect(runner.synced).toHaveLength(1);
        expect(runner.reclaimed).toEqual([repoJob]);
    });

    it('reports the verdict untouched when the reclaim refuses, and logs the reason', async () => {
        const logs: string[] = [];
        const board = stubBoard([job(1)], { threadDone: true });
        const runner = stubRunner(async () => ok(), {
            reclaim: {
                ok: false,
                removed: false,
                reason: 'refusing to remove /workspaces/bellows/44444444-4444-4444-8444-444444444444/.worktrees/0000000',
            },
        });
        const loop = createLoop({
            board: board.board,
            runner,
            config: config(),
            sleep,
            log: (m) => logs.push(m),
        });
        board.attach(loop);
        await loop.start();

        expect(board.board.completed[0]?.status).toBe('succeeded');
        expect(logs.some((m) => m.includes('task worktree could not be reclaimed'))).toBe(true);
    });

    it('reports the verdict untouched when the reclaim throws, and logs the error', async () => {
        const logs: string[] = [];
        const board = stubBoard([job(1)], { threadDone: true });
        const runner = stubRunner(async () => ok());
        runner.reclaimWorktree = async () => {
            throw new Error('daemon refused');
        };
        const loop = createLoop({
            board: board.board,
            runner,
            config: config(),
            sleep,
            log: (m) => logs.push(m),
        });
        board.attach(loop);
        await loop.start();

        expect(board.board.completed[0]?.status).toBe('succeeded');
        expect(logs.some((m) => m.includes('daemon refused'))).toBe(true);
    });

    it('does not reclaim a job whose verdict was lost to the board', async () => {
        // 409 means the tree belongs to whoever holds the lease now — and the board's terminality
        // answer rides that refusal as false, so nothing is removed on either ground.
        const board = stubBoard([job(1)], { completeLease: 'lost' });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(runner.reclaimed).toHaveLength(0);
    });

    /**
     * The reclaim race (greptile #3988007814), same-driver half: the board said "thread terminal",
     * the removal started — and a follow-up created in that window gets claimed and syncs against
     * the very tree being deleted. The in-driver barrier makes the follow-up wait out the
     * in-flight removal before its startup sync, which is the first touch of the task worktree.
     */
    it('waits out an in-flight reclaim of the same thread before a follow-up syncs', async () => {
        const root = job(1).id;
        const followUp: BoardJob = { ...job(2), followUp: true, resumeSessionId: 'ses_follow-up', rootJobId: root };
        const events: string[] = [];
        let releaseReclaim = () => {};
        const reclaimGate = new Promise<void>((resolve) => {
            releaseReclaim = resolve;
        });
        const board = stubBoard([job(1), followUp], {
            completeFor: (claimed) =>
                claimed.id === job(1).id ? { state: 'held', threadDone: true } : { state: 'held', threadDone: false },
        });
        const runner = stubRunner(async () => ok());
        runner.reclaimWorktree = async (claimed) => {
            runner.reclaimed.push(claimed);
            events.push(`reclaim-start:${claimed.id}`);
            await reclaimGate;
            events.push(`reclaim-done:${claimed.id}`);
            return { ok: true, removed: true, reason: null };
        };
        const realSync = runner.syncCheckout.bind(runner);
        runner.syncCheckout = async (claimed) => {
            events.push(`sync:${claimed.id}`);
            return realSync(claimed);
        };

        const started = drive({ ...board, runner }, { DRIVER_CONCURRENCY: '1' });
        // Let the root job finish, its verdict land and its reclaim start — then give the loop a
        // beat to claim the follow-up and park it on the barrier.
        for (let i = 0; i < 50 && !events.includes(`reclaim-start:${job(1).id}`); i += 1) await sleep();
        await sleep();
        await sleep();
        expect(events).toContain(`reclaim-start:${job(1).id}`);
        // The follow-up has been claimed but has NOT synced: the removal of its thread's tree is
        // still in flight.
        expect(events).not.toContain(`sync:${followUp.id}`);

        releaseReclaim();
        await started;

        // The follow-up synced only after the removal settled — never against a tree mid-deletion.
        expect(events.indexOf(`reclaim-done:${job(1).id}`)).toBeLessThan(events.indexOf(`sync:${followUp.id}`));
        expect(board.board.completed).toHaveLength(2);
        expect(runner.reclaimed).toEqual([job(1)]);
    });

    /**
     * The barrier is a set-and-clear cycle, not a one-shot latch: once a reclaim settles its
     * entry is dropped, so the next reclaim of the same thread registers afresh and claimants
     * wait on the CURRENT removal — never on a stale one, and never forever (a hung suite here is
     * a leaked entry). A settled entry would also be harmless to await, which is why this is
     * pinned by the full chain running to completion rather than by timing alone.
     */
    it('drops the barrier entry when the reclaim settles, so the next reclaim of the thread registers afresh', async () => {
        const root = job(1).id;
        const firstFollowUp: BoardJob = { ...job(2), followUp: true, resumeSessionId: 'ses_two', rootJobId: root };
        const secondFollowUp: BoardJob = { ...job(3), followUp: true, resumeSessionId: 'ses_three', rootJobId: root };
        const events: string[] = [];
        const resolvers = new Map<string, () => void>();
        const gatePromises = new Map<string, Promise<void>>();
        const makeGate = (id: string) => {
            gatePromises.set(
                id,
                new Promise<void>((resolve) => {
                    resolvers.set(id, resolve);
                })
            );
        };
        makeGate(job(1).id);
        makeGate(firstFollowUp.id);
        const board = stubBoard([job(1), firstFollowUp, secondFollowUp], {
            completeFor: (claimed) => ({ state: 'held', threadDone: claimed.id !== secondFollowUp.id }),
        });
        const runner = stubRunner(async () => ok());
        runner.reclaimWorktree = async (claimed) => {
            runner.reclaimed.push(claimed);
            events.push(`reclaim-start:${claimed.id}`);
            await gatePromises.get(claimed.id);
            events.push(`reclaim-done:${claimed.id}`);
            return { ok: true, removed: true, reason: null };
        };
        const realSync = runner.syncCheckout.bind(runner);
        runner.syncCheckout = async (claimed) => {
            events.push(`sync:${claimed.id}`);
            return realSync(claimed);
        };

        const started = drive({ ...board, runner }, { DRIVER_CONCURRENCY: '1' });
        // Root's removal in flight; release it so the first follow-up can go.
        for (let i = 0; i < 50 && !events.includes(`reclaim-start:${job(1).id}`); i += 1) await sleep();
        resolvers.get(job(1).id)?.();
        // The first follow-up's own reclaim must now be the live barrier — registered afresh,
        // after the root's entry was dropped.
        for (let i = 0; i < 50 && !events.includes(`reclaim-start:${firstFollowUp.id}`); i += 1) await sleep();
        await sleep();
        await sleep();
        expect(events).not.toContain(`sync:${secondFollowUp.id}`);
        resolvers.get(firstFollowUp.id)?.();

        await started;

        expect(events.indexOf(`reclaim-done:${job(1).id}`)).toBeLessThan(events.indexOf(`sync:${firstFollowUp.id}`));
        expect(events.indexOf(`reclaim-done:${firstFollowUp.id}`)).toBeLessThan(
            events.indexOf(`sync:${secondFollowUp.id}`)
        );
        expect(board.board.completed).toHaveLength(3);
        expect(runner.reclaimed).toEqual([job(1), firstFollowUp]);
    });

    // The cache watch killed the run mid-tool-call, so the scrape reads finish `tool-calls` — the
    // cache note must tell the whole story on its own, without the premature-stop note stacking a
    // second suspected cause on top.
    it('says so when the cache watch killed the run, and only says that', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () =>
            ok({
                exitCode: 137,
                output: 'partial',
                finishReason: 'tool-calls',
                cacheLost: '3 consecutive turns with no prompt-cache reads (input 84k/80k/63k tokens, 150-250s each)',
            })
        );

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.status).toBe('failed');
        const output = board.board.completed[0]?.output ?? '';
        expect(output).toContain('[driver] killed — the model provider stopped serving prompt cache');
        expect(output).toContain('3 consecutive turns with no prompt-cache reads');
        expect(output).toContain('Retry when the cache is healthy again');
        expect(output).not.toContain('ended before it finished');
    });

    // The whole reason the heartbeat exists: two containers must not go on writing to one checkout.
    it('kills the container and reports nothing once the lease is lost', async () => {
        const board = stubBoard([job(1)], { lease: 'lost' });
        let finish = () => {};
        const runner = stubRunner(
            () =>
                new Promise<RunOutcome>((resolve) => {
                    finish = () => resolve(ok());
                })
        );

        const started = drive({ ...board, runner });
        // Let the heartbeat land its verdict before the run is allowed to end.
        await new Promise((resolve) => setTimeout(resolve, 5));
        finish();
        await started;

        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // A network blink is not evidence that the lease moved. The next heartbeat remains the
    // authority, while the in-flight runner keeps its checkout and can still report normally.
    it('keeps running through a transient heartbeat failure and recovers on the next beat', async () => {
        const board = stubBoard([job(1)]);
        const rawHeartbeat = board.board.heartbeat.bind(board.board);
        const logs: string[] = [];
        let calls = 0;
        board.board.heartbeat = async (claimed) => {
            calls += 1;
            if (calls === 1) throw new Error('board blink');
            return rawHeartbeat(claimed);
        };
        const runner = stubRunner(async () => {
            while (calls < 2) await sleep();
            return ok();
        });

        await drive({ ...board, runner, log: (message) => logs.push(message) });

        expect(runner.killed).toEqual([]);
        expect(board.board.completed).toHaveLength(1);
        expect(logs.filter((message) => message.includes('heartbeat failed, continuing'))).toHaveLength(1);
    });

    // A Stop (issue #41) is a park, not an end: the board stamps the running row with the flag,
    // the heartbeat carries it back, and the container is killed so the run stops editing the
    // checkout — but the job goes back on the board, session intact, for a human to resume from
    // the Claude UI. Exactly the landing an idle run gets, and reporting nothing lets it stay
    // there.
    it('kills the container and parks the job when the heartbeat reports a stop request', async () => {
        const board = stubBoard([job(1)], { cancelRequested: true });
        let finish = () => {};
        const runner = stubRunner(
            () =>
                new Promise<RunOutcome>((resolve) => {
                    finish = () => resolve(ok());
                })
        );

        const started = drive({ ...board, runner });
        await new Promise((resolve) => setTimeout(resolve, 5));
        finish();
        await started;

        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // The park is the follow-up's launching pad, and a stopped opencode run's session id is
    // learned only at close (the scrape) — so it must be reported BEFORE the park lands, while
    // the row still runs under this lease. After it, the row is terminal, the report is refused,
    // and the stopped task settles sessionless: nothing to follow up (issue #152).
    it('reports the scraped session before parking a stopped opencode run', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([{ ...job(1), executorType: 'opencode' }], options);
        const events: string[] = [];
        const rawSuspend = board.board.suspend.bind(board.board);
        board.board.suspend = async (claimed) => {
            events.push(`parked with ${board.board.sessions.length} session(s) reported`);
            return rawSuspend(claimed);
        };
        const runner = stubRunner(async () => {
            // The stop lands once the run is live: the first beats answer false, the ones after
            // this carry the flag, and the container is killed while the run is in flight.
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return ok({ sessionId: 'ses_stoppedrun00000000001' });
        });

        await drive({ ...board, runner });

        expect(board.board.sessions).toEqual([{ id: job(1).id, sessionId: 'ses_stoppedrun00000000001' }]);
        expect(events).toEqual(['parked with 1 session(s) reported']);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // An opencode run ALWAYS leaves a session, so an empty scrape on a stopped run is the
    // readout having failed — said out loud on the stopped path too, because the cost is a
    // task that can never take a follow-up (issue #152).
    it('says so when a stopped opencode run has no session to report', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([{ ...job(1), executorType: 'opencode' }], options);
        const logs: string[] = [];
        const runner = stubRunner(async () => {
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return ok({ readoutError: 'the readout container failed: boom' });
        });

        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(logs.some((m) => m.includes('the session readout came up empty'))).toBe(true);
        expect(board.board.sessions).toEqual([]);
        expect(board.board.suspended).toEqual([job(1).id]);
    });

    // A stopped claude-code run has no scrape and no empty-scrape notice: the session was minted
    // and reported at spawn, and the helper must not fire the opencode-only complaint (issue #152).
    it('reports nothing extra when a stopped claude-code run has no scraped session', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        const logs: string[] = [];
        const runner = stubRunner(async () => {
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return ok();
        });

        await drive({ ...board, runner, log: (m) => logs.push(m) });

        // The spawn-time mint report only — nothing scraped, nothing added on the stopped path.
        expect(board.board.sessions).toHaveLength(1);
        expect(logs.some((m) => m.includes('the session readout came up empty'))).toBe(false);
        expect(board.board.suspended).toEqual([job(1).id]);
    });

    // Issue #126: a stop issued while the dashboard says "Waiting for the executor…" — the claim
    // and setup phase, before any container exists — must stand the attempt down immediately.
    // With the flag already set at the first beat (which beats before sleeping, not after), the
    // attempt ends before the sync even starts: the runner never spawns and the park lands at
    // once.
    it('stands a job down before the runner spawns when the stop arrived during setup', async () => {
        const board = stubBoard([job(1)], { cancelRequested: true });
        let ran = false;
        const runner = stubRunner(async () => {
            ran = true;
            return ok();
        });

        await drive({ ...board, runner });

        expect(ran).toBe(false);
        expect(runner.synced).toEqual([]);
        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // The same, MID-SYNC: the checkout sync is the slowest thing an attempt does before the
    // runner exists (a fresh clone of a large repo), and the stop must not wait out the git. The
    // abandoned sync finishes on its own — its cleanup is its own — while the attempt parks.
    it('stands a job down while the checkout sync is still running, without spawning the runner', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        runner.syncCheckout = async () => {
            // The stop lands while the sync is in flight.
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { ok: true, reason: null };
        };

        const started = drive({ ...board, runner });
        // Let the setup-poll heartbeat carry the stop in while the sync is pending.
        await new Promise((resolve) => setTimeout(resolve, 10));
        await started;

        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // A Remove racing the setup is answered the same way — nothing spawned, and nothing parked or
    // reported: the rows are gone and the tree belongs to the queue's reclaim.
    it('reports nothing when the thread is removed during setup', async () => {
        const board = stubBoard([job(1)], { removedOnBeat: true });
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });

        await drive({ ...board, runner });

        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([]);
        expect(board.board.completed).toEqual([]);
    });

    // A lease lost during setup leaves the job to its new holder: no verdict, no park.
    it('reports nothing when the lease is lost during setup', async () => {
        const board = stubBoard([job(1)], { lease: 'lost' });
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });

        await drive({ ...board, runner });

        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([]);
        expect(board.board.completed).toEqual([]);
    });

    // A stop observed AFTER the sync has completed finds the checkout fenced and held — with no
    // run ever to release it, the fence goes back before the attempt stands down (kubernetes's
    // checkout claim would otherwise outlive the job).
    it('hands the checkout fence back when the stop lands after the sync', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        const fenced: string[] = [];
        runner.releaseFence = async (fencedJob) => {
            fenced.push(fencedJob.id);
        };
        const rawReread = board.board.rereadGates.bind(board.board);
        board.board.rereadGates = async (claimed) => {
            // The stop lands after the sync, during the gates re-read — the re-read is slow
            // enough for the setup poll to carry the verdict in.
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return rawReread(claimed);
        };

        await drive({ ...board, runner });

        expect(fenced).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // And a stop that lands while the gate environment boots leaves no environment behind: the
    // release happens inside beginGates (or in the attempt's finally), never leaked.
    it('releases the gate environment when the stop lands while it boots', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        const { stack, gates } = stubGateStack();
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        const rawAcquire = stack.manager.acquire.bind(stack.manager);
        stack.manager.acquire = async (key, image, envBody, acquiredJob) => {
            // The stop lands while the gate environment is coming up — slow enough for the
            // setup poll to carry the verdict in before the attempt can launch.
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            await rawAcquire(key, image, envBody, acquiredJob);
        };

        const started = drive({ ...board, runner, gates });
        // Let the setup-poll heartbeat carry the stop in while the acquire is pending.
        await new Promise((resolve) => setTimeout(resolve, 10));
        await started;
        // The abandoned beginGates settles on its own timer and releases the environment then.
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(stack.released).toHaveLength(1);
        expect(stack.acquired).toHaveLength(1);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // The setup-phase kill is best-effort reclamation — no container was ever spawned. Awaited,
    // a slow or unresponsive daemon holds `beating`, and with it settle() and the stop's park,
    // past the setup poll period: the row sits `running` with nothing to wait out. The park must
    // land while the kill is still in flight, not after it.
    it('parks a stopped setup without waiting out the teardown kill', async () => {
        const board = stubBoard([job(1)], { cancelRequested: true });
        let releaseKill = () => {};
        let killSettled = false;
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        runner.kill = async (killed) => {
            runner.killed.push(killed.id);
            // Held until the park has landed: a stand-down that waits on this kill fails here.
            await new Promise<void>((resolve) => {
                releaseKill = () => {
                    killSettled = true;
                    resolve();
                };
            });
        };
        let parkedBeforeKill = false;
        const rawSuspend = board.board.suspend.bind(board.board);
        board.board.suspend = async (claimed) => {
            parkedBeforeKill = !killSettled;
            releaseKill();
            return rawSuspend(claimed);
        };

        await drive({ ...board, runner });

        expect(parkedBeforeKill).toBe(true);
        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    }, 2_000);

    // A stop that lands after beginGates has handed back a session but before the caller's own
    // down-check takes the early stand-down return skips the run try's cleanup finally — the
    // session this caller holds would stay registered and its environment never released. The
    // localized release must run before the fence goes back and the attempt stands down.
    it('releases the gate session when the stand-down lands after beginGates returns it', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        const { stack, gates } = stubGateStack();
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        // The first beat parks inside the board stub; advertiseUrl resolves it from inside
        // beginGates' final stretch — queuing the verdict's flag-set between beginGates' own
        // clean check and the caller's check, the exact window the leak lives in.
        let landBeat = () => {};
        const firstBeat = new Promise<void>((resolve) => {
            landBeat = resolve;
        });
        let beat = 0;
        const rawHeartbeat = board.board.heartbeat.bind(board.board);
        board.board.heartbeat = async (claimed) => {
            beat += 1;
            if (beat === 1) {
                await firstBeat;
                return { result: 'held', cancelRequested: true };
            }
            return rawHeartbeat(claimed);
        };
        gates.advertiseUrl = (port) => {
            landBeat();
            return `http://host.docker.internal:${port}`;
        };

        await drive({ ...board, runner, gates });

        expect(stack.registered).toBe(1);
        expect(stack.unregistered).toBe(1);
        expect(stack.released).toHaveLength(1);
        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // Remove's defensive half this side of the fence: the only way a heartbeat sees a 404 is the
    // board having deleted the thread while this attempt ran. The container dies, and nothing is
    // parked or reported — there is no row left to park and nobody left to read a verdict. (The
    // server refuses to remove a running thread, so this is a race the server already closes; the
    // driver still answers the status rather than reading it as a broken board.)
    it('kills the container and reports nothing when the board says the thread was removed', async () => {
        const board = stubBoard([job(1)], { removedOnBeat: true });
        let finish = () => {};
        const runner = stubRunner(
            () =>
                new Promise<RunOutcome>((resolve) => {
                    finish = () => resolve(ok());
                })
        );

        const started = drive({ ...board, runner });
        await new Promise((resolve) => setTimeout(resolve, 5));
        finish();
        await started;

        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([]);
        expect(board.board.completed).toEqual([]);
    });

    // The other half of Remove (issue #41): the thread's rows are gone and the queue hands this
    // driver the tree to take down. The worktree is reclaimed through the same runner call a
    // terminal thread's report() uses, fed a job synthesised from the row's identity, and acked
    // once the tree is down so the row stops being offered.
    it('drains the board’s reclaim queue: removes the removed thread’s worktree and acks it', async () => {
        const rowId = '55555555-5555-4555-8555-555555555555';
        const root = job(1).id;
        const board = stubBoard([], {
            idleBeforeStop: 1,
            reclaims: [
                {
                    id: rowId,
                    rootJobId: root,
                    repo: 'Bellows-AI/factory',
                    workspacePath: `bellows/${USER}`,
                    leaseExpiresAt: '2026-08-21T12:05:00.000Z',
                },
            ],
        });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.reclaimGrants).toHaveLength(1);
        // The tree is reclaimed under the thread's identity — the job is the removed root, the
        // row id rides as the lease token, exactly what keys the removal under kubernetes.
        expect(runner.reclaimed).toEqual([
            {
                id: root,
                command: '',
                attempts: 1,
                leaseToken: rowId,
                leaseExpiresAt: '2026-08-21T12:05:00.000Z',
                resumeSessionId: null,
                followUp: false,
                userId: null,
                workspacePath: `bellows/${USER}`,
                rootJobId: root,
                rootCommand: '',
                repo: 'Bellows-AI/factory',
                executorType: 'claude-code',
                masterPrompt: null,
            },
        ]);
        expect(board.board.reclaimAcks).toEqual([rowId]);
    });

    it('leaves a refused reclaim to its lease instead of acking it', async () => {
        const rowId = '55555555-5555-4555-8555-555555555555';
        const root = job(1).id;
        const logs: string[] = [];
        const board = stubBoard([], {
            idleBeforeStop: 1,
            reclaims: [
                {
                    id: rowId,
                    rootJobId: root,
                    repo: null,
                    workspacePath: null,
                    leaseExpiresAt: '2026-08-21T12:05:00.000Z',
                },
            ],
        });
        const runner = stubRunner(async () => ok());
        runner.reclaimWorktree = async () => ({ ok: false, removed: false, reason: 'the checkout is held' });
        const loop = createLoop({
            board: board.board,
            runner,
            config: config(),
            sleep,
            log: (m) => logs.push(m),
        });
        board.attach(loop);

        await loop.start();

        // No ack: the row survives its lease and is offered again (and to other workers), while
        // the refusal is said out loud exactly as a refused terminal reclaim is.
        expect(board.board.reclaimAcks).toEqual([]);
        expect(logs.some((m) => m.includes('could not be reclaimed: the checkout is held'))).toBe(true);
    });

    // A transient board error after the tree is already down must not take the driver with it:
    // like a refused reclaim, a throwing ack is left to the lease — the row is re-offered when it
    // expires — and the drain loop goes on polling.
    it('survives a reclaim ack failure instead of crashing the drain loop', async () => {
        const rowId = '55555555-5555-4555-8555-555555555555';
        const root = job(1).id;
        const logs: string[] = [];
        const board = stubBoard([], {
            idleBeforeStop: 1,
            reclaims: [
                {
                    id: rowId,
                    rootJobId: root,
                    repo: null,
                    workspacePath: null,
                    leaseExpiresAt: '2026-08-21T12:05:00.000Z',
                },
            ],
            failAckReclaim: true,
        });
        const runner = stubRunner(async () => ok());
        const loop = createLoop({
            board: board.board,
            runner,
            config: config(),
            sleep,
            log: (m) => logs.push(m),
        });
        board.attach(loop);

        await loop.start();

        // The ack never landed, so the row survives for its lease to expire and hand it back —
        // and start() resolved, where before the fix the rejection ended the driver.
        expect(board.board.reclaimAcks).toEqual([]);
        expect(logs.some((m) => m.includes('leaving it to the lease'))).toBe(true);
    });

    /*
     * The orphaned checkout claim (issue #344): a claim ConfigMap whose holder job the board no
     * longer knows stood every reclaim of the removed thread down forever — nothing else can see
     * a bare ConfigMap, so the reclaim loop is the only cleaner. The proof is the board's own
     * lease lookup, never a clock; the reap is uid-preconditioned in the runner; and the failure
     * lines throttle to state changes so a stuck row does not log an identical line every poll.
     */
    describe('an orphaned checkout claim', () => {
        const rowId = '55555555-5555-4555-8555-555555555555';
        const root = job(1).id;
        const heldRow: Reclaim = {
            id: rowId,
            rootJobId: root,
            repo: 'Bellows-AI/factory',
            workspacePath: `bellows/${USER}`,
            leaseExpiresAt: '2026-08-21T12:05:00.000Z',
        };
        const heldClaim = {
            name: `factory-job-${root}-claim`,
            attempt: '3',
            createdMs: Date.now() - 120_000,
        };
        const heldRefusal = (): ReclaimResult => ({
            ok: false,
            removed: false,
            reason: `the checkout is held (/workspaces/bellows/${USER}/.worktrees/${root}): job ${root} stands down: the checkout claim is held by a newer attempt (3 >= 1)`,
            heldClaim,
        });

        it('reaps an orphaned claim when the board no longer knows the holder job, then retries and acks', async () => {
            const logs: string[] = [];
            const board = stubBoard([], { idleBeforeStop: 1, reclaims: [heldRow] });
            const runner = stubRunner(async () => ok(), {
                reclaimSequence: [heldRefusal(), { ok: true, removed: true, reason: null }],
                reapOrphanedClaim: async () => true,
            });
            const loop = createLoop({
                board: board.board,
                runner,
                config: config(),
                sleep,
                log: (m) => logs.push(m),
            });
            board.attach(loop);

            await loop.start();

            // Proven against the board, then reaped, then the removal retried once — and the
            // row acked, so the offer stops.
            expect(board.board.leaseLookups).toEqual([[root]]);
            expect(runner.reapAttempts.map((j) => j.id)).toEqual([root]);
            expect(runner.reclaimed).toHaveLength(2);
            expect(board.board.reclaimAcks).toEqual([rowId]);
            const orphan = logs.find((m) => m.includes('orphaned'));
            expect(orphan).toContain(heldClaim.name);
            expect(orphan).toContain('attempt 3');
            expect(logs.some((m) => m.includes('could not be reclaimed'))).toBe(false);
        });

        it('reaps when the holder row is terminal — no attempt can ever come', async () => {
            const board = stubBoard([], {
                idleBeforeStop: 1,
                reclaims: [heldRow],
                leaseRows: [{ id: root, status: 'succeeded', leaseToken: null }],
            });
            const runner = stubRunner(async () => ok(), {
                reclaimSequence: [heldRefusal(), { ok: true, removed: true, reason: null }],
                reapOrphanedClaim: async () => true,
            });
            const loop = createLoop({ board: board.board, runner, config: config(), sleep, log: () => {} });
            board.attach(loop);

            await loop.start();

            expect(runner.reapAttempts.map((j) => j.id)).toEqual([root]);
            expect(board.board.reclaimAcks).toEqual([rowId]);
        });

        it('does not reap when the board still knows the holder job as live', async () => {
            const logs: string[] = [];
            const board = stubBoard([], {
                idleBeforeStop: 1,
                reclaims: [heldRow],
                leaseRows: [{ id: root, status: 'running', leaseToken: null }],
            });
            const runner = stubRunner(async () => ok(), {
                reclaimSequence: [heldRefusal()],
                reapOrphanedClaim: async () => true,
            });
            const loop = createLoop({
                board: board.board,
                runner,
                config: config(),
                sleep,
                log: (m) => logs.push(m),
            });
            board.attach(loop);

            await loop.start();

            expect(runner.reapAttempts).toEqual([]);
            expect(board.board.reclaimAcks).toEqual([]);
            expect(logs.some((m) => m.includes('could not be reclaimed'))).toBe(true);
        });

        it('does not reap when the board cannot answer the lease lookup', async () => {
            const board = stubBoard([], { idleBeforeStop: 1, reclaims: [heldRow], leaseRows: null });
            const runner = stubRunner(async () => ok(), {
                reclaimSequence: [heldRefusal()],
                reapOrphanedClaim: async () => true,
            });
            const loop = createLoop({ board: board.board, runner, config: config(), sleep, log: () => {} });
            board.attach(loop);

            await loop.start();

            expect(runner.reapAttempts).toEqual([]);
            expect(board.board.reclaimAcks).toEqual([]);
        });

        it('answers false from the reap without orphan fanfare, leaving the throttled failure log', async () => {
            const logs: string[] = [];
            const board = stubBoard([], { idleBeforeStop: 1, reclaims: [heldRow] });
            const runner = stubRunner(async () => ok(), {
                reclaimSequence: [heldRefusal()],
                reapOrphanedClaim: async () => false,
            });
            const loop = createLoop({
                board: board.board,
                runner,
                config: config(),
                sleep,
                log: (m) => logs.push(m),
            });
            board.attach(loop);

            await loop.start();

            // The proof passed and the delete was attempted, but the claim did not go: no
            // orphan line, no retry, no ack — the throttled refusal line is all this offer says.
            expect(runner.reapAttempts.map((j) => j.id)).toEqual([root]);
            expect(logs.some((m) => m.includes('orphaned'))).toBe(false);
            expect(logs.some((m) => m.includes('could not be reclaimed'))).toBe(true);
            expect(board.board.reclaimAcks).toEqual([]);
        });

        it('logs a changed age alone as no change, but a null age as unknown', async () => {
            const logs: string[] = [];
            const board = stubBoard([], { idleBeforeStop: 1, reclaims: [heldRow] });
            const runner = stubRunner(async () => ok(), {
                reclaimSequence: [
                    { ...heldRefusal(), heldClaim: { ...heldClaim, createdMs: null } },
                    { ok: true, removed: true, reason: null },
                ],
                reapOrphanedClaim: async () => true,
            });
            const loop = createLoop({
                board: board.board,
                runner,
                config: config(),
                sleep,
                log: (m) => logs.push(m),
            });
            board.attach(loop);

            await loop.start();

            const orphan = logs.find((m) => m.includes('orphaned'));
            expect(orphan).toContain('age unknown');
        });

        it('skips the orphan arm while a verdict-time reclaim of the same root is in flight', async () => {
            const logs: string[] = [];
            // The loop's barrier: report() holds the root's claim for its whole removal, and a
            // second done can queue a queue-row for the same root meanwhile — the one live
            // holder the queue path must not reap out from under.
            const runner = stubRunner(async () => ok(), {
                reclaimSequence: [heldRefusal()],
                reapOrphanedClaim: async () => {
                    throw new Error('the reap must never be reached while the barrier holds');
                },
            });
            const ctx: ReclaimContext = {
                board: {
                    leases: async () => {
                        throw new Error('the lookup must never be reached while the barrier holds');
                    },
                    ackReclaim: async () => 'ok',
                },
                runner,
                config: config(),
                log: (m) => logs.push(m),
                failureLog: new Map(),
                inFlightReclaim: (candidate) => candidate === root,
            };

            await processReclaim(ctx, heldRow);

            expect(runner.reapAttempts).toEqual([]);
            expect(runner.reclaimed).toHaveLength(1);
            expect(logs.some((m) => m.includes('could not be reclaimed'))).toBe(true);
        });

        it('clears the throttle entry on a settled row, so a later identical failure logs fresh', async () => {
            const logs: string[] = [];
            const refusal = heldRefusal();
            const board = stubBoard([], { idleBeforeStop: 20, reclaims: [heldRow, heldRow, heldRow] });
            const runner = stubRunner(async () => ok(), {
                reclaimSequence: [refusal, { ok: true, removed: true, reason: null }, refusal],
            });
            const loop = createLoop({
                board: board.board,
                runner,
                config: config(),
                sleep,
                log: (m) => logs.push(m),
            });
            board.attach(loop);

            await loop.start();

            // refusal (logged) → settled, entry cleared → the SAME refusal logs again.
            expect(logs.filter((m) => m.includes('could not be reclaimed'))).toHaveLength(2);
            expect(board.board.reclaimAcks).toEqual([rowId]);
        });

        it('throttles identical reclaim failures to one log line until the reason changes', async () => {
            const logs: string[] = [];
            const same = heldRefusal();
            const changed: ReclaimResult = {
                ...same,
                reason: 'the checkout is held (/workspaces/x): a different holder now',
                heldClaim: { ...heldClaim, attempt: '4' },
            };
            // The same row, re-offered three times with the same refusal, then once more after
            // the reason changed — five minutes a poll for a day, in the wild. (idleBeforeStop
            // stays high: the job-claim loop's idle count stops the whole loop, drains included,
            // and every row here must be offered before that.)
            const board = stubBoard([], {
                idleBeforeStop: 20,
                reclaims: [heldRow, heldRow, heldRow, { ...heldRow, leaseExpiresAt: '2026-08-21T13:05:00.000Z' }],
            });
            const runner = stubRunner(async () => ok(), {
                reclaimSequence: [same, same, same, changed],
            });
            const loop = createLoop({
                board: board.board,
                runner,
                config: config(),
                sleep,
                log: (m) => logs.push(m),
            });
            board.attach(loop);

            await loop.start();

            const failures = logs.filter((m) => m.includes('could not be reclaimed'));
            expect(failures).toHaveLength(2);
        });
    });

    it('never runs more than the configured number at once', async () => {
        const board = stubBoard([job(1), job(2), job(3), job(4)], { idleBeforeStop: 2 });
        let inFlight = 0;
        let peak = 0;
        const runner = stubRunner(async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return ok();
        });

        await drive({ ...board, runner }, { DRIVER_CONCURRENCY: '2' });

        expect(peak).toBe(2);
        expect(board.board.completed).toHaveLength(4);
    });

    it('keeps polling through a board that is briefly down', async () => {
        const board = stubBoard([job(1)], { failClaims: 2 });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed).toHaveLength(1);
    });

    // Blaming the command for the driver's broken docker would burn an attempt and eventually kill
    // the job. Saying nothing lets the lease expire and the job be offered again.
    it('leaves a job to its lease when the runner cannot start at all', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => {
            throw new Error('spawn docker ENOENT');
        });

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([]);
    });

    // The sync now fences before it writes (the re-claim claim/sweep moved into syncCheckout),
    // and a fence can refuse: the kubernetes claim answers a live newer attempt by throwing the
    // attempt's stand-down. That is the fence's own verdict, not the command's — completing the
    // job failed would burn the attempt on the replacement's arrival. The loop stays up and the
    // job goes back to its lease, exactly as a runner that cannot start does.
    it('leaves a job to its lease when the checkout sync throws', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());
        runner.syncCheckout = async () => {
            throw new Error('job 1 stands down: the checkout claim is held by a newer attempt (3 >= 2)');
        };

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([]);
    });

    // Issue #307: lock contention on the shared checkout is infrastructure, not a verdict. The
    // script's marker (`transient worktree sync:` — a wait-out on the checkout's sync lock, or a
    // fetch that kept losing the refs' locks to a concurrent git) sends the claim back to the
    // board instead of failing the run: an attempt is spent at the next claim, so maxAttempts
    // governs. The non-transient refusal below keeps reporting `failed`.
    it('leaves a job to its lease when the sync reports a transient lock failure', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok(), {
            sync: {
                ok: false,
                reason:
                    'transient worktree sync: the checkout lock /workspaces/bellows/x/factory/.git/factory-sync.lock ' +
                    'is still held after 120000ms — a concurrent sync of this clone is running; the claim should be retried',
            },
        });

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([]);
    });

    /*
     * After a kubernetes syncCheckout, the runner HOLDS the checkout claim; the loop's terminal
     * pre-run refusals complete the job failed WITHOUT runner.run, so run()'s finally — the
     * normal release path — never comes, and the factory-job-<id>-claim ConfigMap would sit
     * forever. These refusals must hand the claim back first, ownership-checked inside the
     * runner; docker implements no releaseFence, so the optional call is a no-op there.
     */
    const releaseEvents = (board: BoardStub, runner: Runner): { events: string[] } => {
        const events: string[] = [];
        runner.releaseFence = async (released) => {
            events.push(`release:${released.id}`);
        };
        const realComplete = board.complete.bind(board);
        board.complete = async (claimed, result) => {
            events.push(`complete:${claimed.id}`);
            return realComplete(claimed, result);
        };
        return { events };
    };

    it('releases the checkout fence before failing a job whose gates file cannot be read', async () => {
        const board = stubBoard([job(1)], { rereadGates: { gates: null, gateError: 'unknown key "ports"' } });
        const runner = stubRunner(async () => {
            throw new Error('the runner must never be reached');
        });
        const { events } = releaseEvents(board.board, runner);

        await drive({ ...board, runner });

        // Released BEFORE the verdict — a replacement claimant may start the moment the job is failed.
        expect(events).toEqual([`release:${job(1).id}`, `complete:${job(1).id}`]);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
    });

    it('releases the checkout fence before failing a job that declares gates this driver cannot run', async () => {
        const board = stubBoard([gatedJob(1)]);
        const runner = stubRunner(async () => {
            throw new Error('the runner must never be reached');
        });
        const { events } = releaseEvents(board.board, runner);

        await drive({ ...board, runner });

        expect(events).toEqual([`release:${job(1).id}`, `complete:${job(1).id}`]);
        expect(board.board.completed[0]?.output).toContain('no gate environment configured');
    });

    // The normal path must NOT release here: the run is about to take over, and run()'s own
    // finally is the owner of the claim until the attempt ends.
    it('does not release the fence on the normal path — the run owns the claim', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());
        const { events } = releaseEvents(board.board, runner);

        await drive({ ...board, runner });

        expect(events).toEqual([`complete:${job(1).id}`]);
        expect(board.board.completed[0]?.status).toBe('succeeded');
    });

    // And the sync-failure refusal releases nothing here either: k8s syncCheckout already took
    // the claim down itself (Foreground Job delete, then release) before answering ok:false.
    it('does not release the fence when the sync itself fails — the runner released it', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok(), {
            sync: {
                ok: false,
                reason: 'conflict in driver/src/loop.ts',
            },
        });
        const { events } = releaseEvents(board.board, runner);

        await drive({ ...board, runner });

        expect(events).toEqual([`complete:${job(1).id}`]);
        expect(board.board.completed[0]?.status).toBe('failed');
    });

    // The daemon can refuse to create the container while `docker run` itself succeeds as a
    // process — a leftover name, a volume or network a stack rebuild removed. The runner asks
    // its platform whether the container ever ran and stamps `started: false`; the loop
    // interprets no exit codes itself.
    it('leaves a job to its lease when the runner reports the container never started', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () =>
            ok({
                exitCode: 125,
                output: 'docker: Error response from daemon: Conflict. The container name is already in use',
                started: false,
            })
        );

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([]);
    });

    // The mirror case, and why classification lives in the runner rather than in an exit code
    // here: a run that started and exited 125 — a shell or an agent CLI can — is a genuine
    // verdict, and swallowing it would rerun the job to death instead of reporting the failure.
    it('reports a started run that exited 125 as the failure it is', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ exitCode: 125, output: 'the command failed' }));

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({
            status: 'failed',
            exitCode: 125,
            output: 'the command failed',
        });
    });

    // Found by running the driver for real, not by this suite: the beat period is a third of the
    // lease, 100s at the default, and waiting it out before reporting left every finished job
    // sitting in `running` for a minute and a half. A fake sleep that resolves instantly cannot see
    // that, so this one models a period that never elapses.
    it('reports a finished job without waiting out the heartbeat period', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());
        const loop = createLoop({
            board: board.board,
            runner,
            config: config(),
            sleep: (ms) => (ms >= 60_000 ? new Promise<void>(() => {}) : sleep()),
        });
        board.attach(loop);

        await loop.start();

        expect(board.board.completed).toHaveLength(1);
    });

    // The id the board is told has to be the one the runner is given, or the UI links to a session
    // that does not exist. Reported before the run so the link works while the job is still going.
    it('reports the session it is about to run as, before starting the container', async () => {
        const board = stubBoard([job(1)]);
        let given = '';
        let reportedFirst = false;
        const runner = stubRunner(async (_job, session) => {
            if (!session) throw new Error('a claude-code run always has a session');
            given = session.id;
            reportedFirst = board.board.sessions.length === 1;
            return ok();
        });

        await drive({ ...board, runner });

        expect(given).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(board.board.sessions).toEqual([{ id: job(1).id, sessionId: given }]);
        expect(reportedFirst).toBe(true);
    });

    // Losing the link is not losing the job.
    it('runs the job anyway when the session cannot be reported', async () => {
        const board = stubBoard([job(1)], { failSession: true });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed).toHaveLength(1);
    });

    /**
     * The live-output contract, end to end: the runner hands the loop its newest tail as it grows,
     * and the loop flushes each distinct tail to the board while the run is still going — so the
     * dashboard shows the work instead of a spinner. The final complete report carries `final`,
     * not the last tail: the preview never replaces the verdict.
     */
    it('streams the output tail to the board while the run goes', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('tail one');
            while (board.board.progressed.length < 1) await sleep();
            onOutput?.('tail two');
            while (board.board.progressed.length < 2) await sleep();
            return ok({ output: 'final' });
        });

        await drive({ ...board, runner });

        expect(board.board.progressed).toEqual([
            { id: job(1).id, output: 'tail one', runtime: null },
            { id: job(1).id, output: 'tail two', runtime: null },
        ]);
        expect(board.board.completed).toEqual([
            {
                id: job(1).id,
                status: 'succeeded',
                exitCode: 0,
                output: 'final',
                contextTokens: null,
                contextCostUsd: null,
            },
        ]);
    });

    /**
     * The vitals ride the same flush as the tail: the "is it stuck or working" answer travels with
     * the work it describes. The activity line is derived from the tail at flush time, so the
     * numbers and the line describe the same moment; a sample alone (quiet agent, unchanged tail)
     * is worth a report of its own.
     */
    it('reports the container vitals beside the output tail', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(
            async (_job, _session, onOutput) => {
                onOutput?.('$ npm test\n\x1b[32m→ Read src/x.ts\x1b[0m');
                // The first flush carries no vitals (the sample is still in flight); hold the run
                // open until the sampled one lands, which is the flush a quiet agent's vitals
                // trigger on their own.
                while (!board.board.progressed.some((p) => p.runtime)) await sleep();
                return ok({ output: 'final' });
            },
            { sample: { cpuPercent: 93, memUsedMb: 544, memPercent: 7 } }
        );

        await drive({ ...board, runner });

        expect(runner.samples).toBeGreaterThan(0);
        const sampled = board.board.progressed.find((p) => p.runtime);
        expect(sampled?.runtime).toMatchObject({
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7,
            activity: '→ Read src/x.ts',
        });
        expect(sampled?.runtime?.sampledAt).toBeTruthy();
        // A vitals-only sample is byte-identical to the pre-services wire shape: no key at all,
        // never an empty array the board would store.
        expect('services' in (sampled?.runtime ?? {})).toBe(false);
    });

    /**
     * The attempt's service fleet rides the same flush (issue #60): the dashboard can answer
     * "did db come up" while the run is going. A services-only sample — vitals unreadable, a
     * kubernetes cluster with no metrics-server for one — carries null numbers rather than
     * skipping the flush; the fleet must not depend on the metrics API.
     */
    it('flushes the service fleet beside the vitals, and null numbers when there are no vitals', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(
            async (_job, _session, onOutput) => {
                onOutput?.('$ docker compose up db\n→ waiting for postgres');
                while (!board.board.progressed.some((p) => p.runtime?.services)) await sleep();
                return ok({ output: 'final' });
            },
            {
                sample: {
                    cpuPercent: null,
                    memUsedMb: null,
                    memPercent: null,
                    services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
                },
            }
        );

        await drive({ ...board, runner });

        const sampled = board.board.progressed.find((p) => p.runtime);
        expect(sampled?.runtime).toMatchObject({
            cpuPercent: null,
            memUsedMb: null,
            services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
        });
        expect(sampled?.runtime?.activity).toBe('→ waiting for postgres');
    });

    // A run is not failed by its own telemetry. The output stream is a preview; losing it costs
    // freshness, never the job.
    it('completes the job anyway when the output stream fails', async () => {
        const board = stubBoard([job(1)], { failProgress: true });
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('tail one');
            await new Promise((resolve) => setTimeout(resolve, 5));
            onOutput?.('tail two');
            await new Promise((resolve) => setTimeout(resolve, 5));
            return ok({ output: 'final' });
        });

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([
            {
                id: job(1).id,
                status: 'succeeded',
                exitCode: 0,
                output: 'final',
                contextTokens: null,
                contextCostUsd: null,
            },
        ]);
    });

    // Same failure, rate-limited: an unreachable board during a three-hour session must not write
    // a log line every flush period.
    it('complains about a failing output stream once, not per flush', async () => {
        const board = stubBoard([job(1)], { failProgress: true });
        const logs: string[] = [];
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('tail one');
            await new Promise((resolve) => setTimeout(resolve, 5));
            onOutput?.('tail two');
            await new Promise((resolve) => setTimeout(resolve, 5));
            return ok();
        });
        const loop = createLoop({
            board: board.board,
            runner,
            config: config(),
            sleep,
            log: (m) => logs.push(m),
        });
        board.attach(loop);

        await loop.start();

        expect(logs.filter((m) => m.includes('could not stream output'))).toHaveLength(1);
    });

    // The 409 a stream report gets back is NOT a kill order: the heartbeat is the one place that
    // decides a superseded run must die, and a telemetry refusal must not duplicate that decision.
    it('does not kill the runner when the board refuses the output stream', async () => {
        const board = stubBoard([job(1)], { progressLease: 'lost' });
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('tail one');
            while (board.board.progressed.length < 1) await sleep();
            return ok({ output: 'final' });
        });

        await drive({ ...board, runner });

        expect(board.board.progressed).toHaveLength(1);
        expect(runner.killed).toEqual([]);
        expect(board.board.completed).toEqual([
            {
                id: job(1).id,
                status: 'succeeded',
                exitCode: 0,
                output: 'final',
                contextTokens: null,
                contextCostUsd: null,
            },
        ]);
    });

    // The board hands the session back on the claim, and the runner restores it rather than being
    // given a new one. A fresh id here would strand the transcript the conversation continues
    // from and move the link.
    it('resumes the session the board hands back, and does not report it again', async () => {
        const parked = '44444444-4444-4444-8444-444444444444';
        const board = stubBoard([job(1, parked)]);
        let given: RunSession | null = null;
        const runner = stubRunner(async (_job, session) => {
            given = session;
            return ok();
        });

        await drive({ ...board, runner });

        expect(given).toEqual({ id: parked, resume: true });
        expect(board.board.sessions).toEqual([]);
    });

    it('drains what is already running before it returns', async () => {
        const board = stubBoard([job(1), job(2)], { idleBeforeStop: 1 });
        const runner = stubRunner(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return ok();
        });

        await drive({ ...board, runner });

        expect(board.board.completed).toHaveLength(2);
    });

    // "Never log the merged environment" (docs/configuration.md) starts HERE — this is the first
    // process the values enter on their way to a runner.
    it('never logs the environment a claim carries', async () => {
        const messages: string[] = [];
        const envJob: BoardJob = { ...job(1), env: { SECRET_TOKEN: 'board-secret-value' } };
        const board = stubBoard([envJob], { idleBeforeStop: 1 });
        const loop = createLoop({
            board: board.board,
            runner: stubRunner(async () => ok()),
            config: config(),
            log: (m) => messages.push(m),
            sleep,
        });
        board.attach(loop);
        await loop.start();

        expect(messages.length).toBeGreaterThan(0);
        expect(messages.join('\n')).not.toContain('board-secret-value');
    });
});

describe('an opencode runner', () => {
    // opencode mints its own session ids and cannot adopt one (acceptsSessionId: false). Minting a
    // uuid here and reporting it would put a session on the board that the runner never used — so
    // the honest answer is no session at all.
    it('runs headless: no session is minted, reported or given', async () => {
        const board = stubBoard([{ ...job(1), executorType: 'opencode' }]);
        let given: RunSession | null | undefined;
        const runner = stubRunner(async (_job, session) => {
            given = session;
            return ok();
        });

        await drive({ ...board, runner });

        expect(given).toBeNull();
        expect(board.board.sessions).toEqual([]);
        expect(board.board.completed).toEqual([
            {
                id: job(1).id,
                status: 'succeeded',
                exitCode: 0,
                output: 'done',
                contextTokens: null,
                contextCostUsd: null,
            },
        ]);
    });

    /**
     * The follow-up carve-out, and the reason an opencode task is follow-up-able at all: the
     * child's session is opencode's OWN (scraped and reported when the parent ran), so the runner
     * restores it with `--session` and delivers the new command into it.
     */
    it('runs an opencode follow-up, restoring the session it carries', async () => {
        const board = stubBoard([
            { ...job(1, 'ses_f86188c3dffeZGYO4yZq4atba9'), executorType: 'opencode', followUp: true },
        ]);
        let given: RunSession | null | undefined;
        const runner = stubRunner(async (_job, session) => {
            given = session;
            return ok();
        });

        await drive({ ...board, runner });

        expect(given).toEqual({ id: 'ses_f86188c3dffeZGYO4yZq4atba9', resume: true });
        expect(board.board.completed).toHaveLength(1);
        // Already on the board from the insert — nothing re-reported at spawn.
        expect(board.board.sessions).toEqual([]);
    });

    // opencode mints its own session id, so the loop learns it from the outcome — the runner
    // scrapes it out of the session database after the run and the board is told while the lease
    // is still live, because a follow-up resumes exactly this.
    it('reports the session id the runner scraped from a finished opencode run', async () => {
        const board = stubBoard([{ ...job(1), executorType: 'opencode' }]);
        const runner = stubRunner(async () => ok({ sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9' }));

        await drive({ ...board, runner });

        expect(board.board.sessions).toEqual([{ id: job(1).id, sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9' }]);
        expect(board.board.completed).toHaveLength(1);
    });
});

describe('verification gates', () => {
    it('runs every declared gate after the agent finishes, and only then reports success', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        let ranBeforeOutcome = false;
        const runner = stubRunner(async () => {
            ranBeforeOutcome = stack.stack.acquired.length > 0;
            return ok({ output: 'agent did the work' });
        });

        await drive({ ...board, runner, gates: stack.gates });

        // The environment was ensured BEFORE the agent ran — the ad-hoc channel needs it live
        // mid-run, not after it.
        expect(ranBeforeOutcome).toBe(true);
        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        expect(board.board.gatesReported.map((r) => r.results.map((g) => g.status))).toEqual([
            ['running'],
            ['passed'],
            ['passed', 'running'],
            ['passed', 'passed'],
        ]);
        const complete = board.board.completed[0]!;
        expect(complete.status).toBe('succeeded');
        // The verdict lands after every gate report — a reader never sees a succeeded task whose
        // checks are still shown as running.
        expect(board.board.gatesReported.length).toBeGreaterThan(0);
        // The environment goes back to its cooldown either way — filed under the task's worktree.
        expect(stack.stack.released).toEqual([`bellows/${USER}/.worktrees/${gatedJob(1).id}`]);
        expect(stack.stack.unregistered).toBe(1);
    });

    it('fails the job with the first failing gate, and relays its output', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack({ lint: 3 });
        const runner = stubRunner(async () => ok({ output: 'agent did the work' }));

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        const complete = board.board.completed[0]!;
        expect(complete.status).toBe('failed');
        expect(complete.exitCode).toBe(3);
        expect(complete.output).toContain('lint');
        expect(complete.output).toContain('lint failed badly');
        expect(complete.output).toContain('agent did the work');
    });

    it('keeps the heartbeat beating while the gates run', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        let beatsWhenRunnerResolved = 0;
        const runner = stubRunner(async () => {
            beatsWhenRunnerResolved = board.board.beats;
            // The gates take real time; a lease could expire under them.
            await new Promise((resolve) => setTimeout(resolve, 5));
            return ok();
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        // settle() — the heartbeat's stop signal — waits until AFTER the gates have run, so the
        // lease is kept alive through a gate phase that can outlast it. (This is what stopped a
        // minutes-long suite from losing the lease mid-gates and double-running the job.)
        expect(board.board.beats).toBeGreaterThan(beatsWhenRunnerResolved);
    });

    it('releases the environment when registration fails after the container came up', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        // The endpoint cannot bind — the container, however, is already up.
        stack.gates.server.listen = async () => {
            throw new Error('EADDRNOTAVAIL');
        };
        const runner = stubRunner(async () => {
            throw new Error('the runner must never be reached');
        });

        await drive({ ...board, runner, gates: stack.gates });

        // The job fails with the reason — and the environment goes back to its cooldown instead
        // of leaking, one live container per failed claim until the driver restarts.
        expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
        expect(board.board.completed[0]?.output).toContain('could not be started');
        expect(stack.stack.released).toEqual([`bellows/${USER}/.worktrees/${gatedJob(1).id}`]);
    });

    // The worktree (issue #35) is the checkout the gates share with the coding agent: the
    // environment is acquired, and every gate runs, in `<org>/<uuid>/.worktrees/<root id>` —
    // the tree the run edits — never in the pristine clone. The acquire repeats before every
    // gate: the cooldown may have torn the environment down mid-run, and acquire is the revive.
    it('acquires the gate environment under the task worktree key', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        // One acquire in beginGates plus one per declared gate (2 in the fixture).
        expect(stack.stack.acquired).toEqual([
            `bellows/${USER}/.worktrees/${gatedJob(1).id}`,
            `bellows/${USER}/.worktrees/${gatedJob(1).id}`,
            `bellows/${USER}/.worktrees/${gatedJob(1).id}`,
        ]);
        expect(stack.stack.ran.key).toBe(`bellows/${USER}/.worktrees/${gatedJob(1).id}`);
    });

    it('registers the ad-hoc token and releases it, and never leaves it registered', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.registered).toBe(1);
        expect(stack.stack.unregistered).toBe(1);
        expect(stack.stack.advertised).toBe('http://host.docker.internal:9099');
    });

    // A gate that cannot RUN at all — the harness failed, docker exec refused — is a failed gate
    // with the reason, not a crash of the run and not a silent pass.
    it('fails the gate, not the run, when the gate itself cannot be executed', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        stack.gates.manager.runGate = async () => {
            throw Object.assign(new Error('Error response from daemon: No such container'), { code: 125 });
        };
        const runner = stubRunner(async () => ok({ output: 'agent did the work' }));

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: 125 });
        expect(board.board.completed[0]?.output).toContain('No such container');
    });

    // The gate cooldown can tear the environment down mid-run — the agent's last ad-hoc gate
    // call armed it, and a run that keeps working past GATE_COOLDOWN_MS watches the timer fire
    // before the gates pass. The close-of-run gates re-acquire, exactly as the ad-hoc endpoint
    // does, so a cooldown teardown can never fail a finished run at the finish line.
    it('re-acquires the gate environment before each gate, so a cooldown teardown mid-run cannot fail the close-of-run gates', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        let up = true;
        const acquired: string[] = [];
        const ran: string[] = [];
        stack.gates.manager.acquire = async (key: string) => {
            up = true;
            acquired.push(key);
        };
        stack.gates.manager.runGate = async (key: string, name: string) => {
            if (!up) throw Object.assign(new Error(`no gate environment for ${key}`), { code: 125 });
            ran.push(name);
            return { exitCode: 0, output: `${name} ok` };
        };
        const key = `bellows/${USER}/.worktrees/${gatedJob(1).id}`;
        // The cooldown fired while the agent kept working past its last ad-hoc gate call.
        const runner = stubRunner(async () => {
            up = false;
            return ok({ output: 'agent did the work' });
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        expect(board.board.completed[0]?.output).not.toContain('no gate environment');
        expect(ran).toEqual(['test', 'lint']);
        expect(acquired).toEqual([key, key, key]);
    });

    // A gate that cannot run at all is a failed gate — an environment that cannot be re-acquired
    // at the gates pass is the same shape, never a silent pass and never a run crash.
    it('fails the gate, not the run, when the environment cannot be re-acquired at the gates pass', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        let acquires = 0;
        stack.gates.manager.acquire = async (_key: string) => {
            acquires += 1;
            if (acquires > 1) throw new Error('daemon unreachable');
        };
        const ran: string[] = [];
        stack.gates.manager.runGate = async (_key: string, name: string) => {
            ran.push(name);
            return { exitCode: 0, output: `${name} ok` };
        };
        const runner = stubRunner(async () => ok({ output: 'agent did the work' }));

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: 125 });
        expect(board.board.completed[0]?.output).toContain('daemon unreachable');
        expect(ran).toEqual([]);
    });

    // The lease is checked BEFORE the re-acquire, but the heartbeat can mark it lost while the
    // acquire is still pending — a slow docker revival or cluster request outlives that beat. A
    // superseded attempt must not start its gate on a checkout another attempt owns.
    it('does not start the gate when the lease is lost while the environment is being re-acquired', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        let loseLease = false;
        board.board.heartbeat = async () => {
            board.board.beats += 1;
            return loseLease ? 'lost' : { result: 'held', cancelRequested: false };
        };
        const realGates = board.board.gates.bind(board.board);
        board.board.gates = async (claimed, results) => {
            // The gates pass opens with its first report; the lease is reclaimed from that moment.
            loseLease = true;
            return realGates(claimed, results);
        };
        let acquires = 0;
        stack.gates.manager.acquire = async () => {
            acquires += 1;
            if (acquires === 1) return; // beginGates, before the run — no re-acquire yet.
            // The revival is slow: the heartbeat's lost verdict lands while this is pending.
            await new Promise((resolve) => setTimeout(resolve, 5));
        };
        const ran: string[] = [];
        stack.gates.manager.runGate = async (_key: string, name: string) => {
            ran.push(name);
            return { exitCode: 0, output: `${name} ok` };
        };
        const runner = stubRunner(async () => ok({ output: 'agent did the work' }));

        await drive({ ...board, runner, gates: stack.gates });

        // The heartbeat did mark the lease lost while the re-acquire was pending…
        expect(runner.killed).toEqual([gatedJob(1).id]);
        // …and the gate never ran against the checkout the next attempt now owns — nor does a
        // verdict land: a lost lease settles the attempt the way a lost run does, unreported.
        expect(ran).toEqual([]);
        expect(board.board.completed).toHaveLength(0);
    });

    // The report must fit the board's body however many gates declared and however verbose they
    // were: the per-gate tail shrinks as the list grows.
    it('bounds the total reported gate output', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        stack.gates.manager.runGate = async (_key, _name) => ({
            exitCode: 0,
            output: 'x'.repeat(40_000),
        });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        const last = board.board.gatesReported.at(-1)!.results;
        expect(last).toHaveLength(2);
        for (const gate of last) {
            expect((gate.output ?? '').length).toBeLessThanOrEqual((16 * 1024) / 2);
        }
    });

    it('fails a job whose gates file was broken, without running anything', async () => {
        const broken: BoardJob = {
            ...job(1),
            repo: 'Bellows-AI/factory',
            gateError: '.bellows.yaml line 3: unknown key "timeout"',
        };
        const board = stubBoard([broken]);
        const stack = stubGateStack();
        let ran = 0;
        const runner = stubRunner(async () => {
            ran += 1;
            return ok();
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(ran).toBe(0);
        expect(stack.stack.acquired).toEqual([]);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: null });
        expect(board.board.completed[0]?.output).toContain('unknown key');
    });

    // The kubernetes executor has its own gate manager (a Job per gate run), so a gated job
    // runs and gates there exactly as it does under docker: the environment is acquired with
    // the attempt's job as context, every declared gate runs, and the verdict follows them.
    it('runs a gated job under the kubernetes executor like any other', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack({ test: 0, lint: 0 });
        let ran = 0;
        const runner = stubRunner(async () => {
            ran += 1;
            return ok();
        });

        await drive({ ...board, runner, gates: stack.gates }, { EXECUTOR: 'kubernetes' });

        expect(ran).toBe(1);
        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    // No gate stack configured (an operator who never asked for gates) but a repo declares them:
    // the same refusal, because running the task WITHOUT its gates and calling it success would
    // be exactly the lie the feature exists to stop.
    it('refuses gates when the driver has no gate stack at all', async () => {
        const board = stubBoard([gatedJob(1)]);
        let ran = 0;
        const runner = stubRunner(async () => {
            ran += 1;
            return ok();
        });

        await drive({ ...board, runner });

        expect(ran).toBe(0);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: null });
    });

    /*
     * The declared services are what the gates test against — `.bellows.yaml` names `db` so that
     * `npm test` can reach it — so the fleet must outlive the run until the last gate has run.
     * Torn down inside run(), every service-backed gate failed on a name that no longer resolved.
     */
    it('keeps the services up through the declared gates and releases them after', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok());
        let gatesRunAtRelease: string[] | null = null;
        runner.releaseServices = async (released) => {
            gatesRunAtRelease = [...stack.stack.ran.names];
            runner.servicesReleased.push(released.id);
        };

        await drive({ ...board, runner, gates: stack.gates });

        expect(gatesRunAtRelease).toEqual(['test', 'lint']);
        expect(runner.servicesReleased).toEqual([gatedJob(1).id]);
    });

    it('releases the services on every way a run can end', async () => {
        const plain = stubRunner(async () => ok());
        await drive({ ...stubBoard([job(1)]), runner: plain });
        expect(plain.servicesReleased).toEqual([job(1).id]);

        const unstarted = stubRunner(async () => ok({ started: false }));
        await drive({ ...stubBoard([job(2)]), runner: unstarted });
        expect(unstarted.servicesReleased).toEqual([job(2).id]);

        const thrown = stubRunner(async () => {
            throw new Error('the daemon refused');
        });
        await drive({ ...stubBoard([job(3)]), runner: thrown });
        expect(thrown.servicesReleased).toEqual([job(3).id]);
    });

    it('runs no gates for a never-started or a lost run', async () => {
        const unstartedBoard = stubBoard([gatedJob(2)]);
        const unstartedStack = stubGateStack();
        await drive({
            ...unstartedBoard,
            runner: stubRunner(async () => ok({ started: false })),
            gates: unstartedStack.gates,
        });
        expect(unstartedStack.stack.ran.names).toEqual([]);
        expect(unstartedBoard.board.completed).toEqual([]);

        const lostBoard = stubBoard([gatedJob(3)], { lease: 'lost' });
        const lostStack = stubGateStack();
        await drive({
            ...lostBoard,
            // Let the heartbeat land its verdict before the run ends, as the lost-lease test above
            // does — an instant run would finish before the first beat.
            runner: stubRunner(async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                return ok();
            }),
            gates: lostStack.gates,
        });
        expect(lostStack.stack.ran.names).toEqual([]);
    });

    // A refused start (a .bellows.yaml the parser rejects) is a final verdict with no agent
    // work behind it: gates over the untouched checkout would only bury the refusal under a
    // `vitest: not found` exit 127.
    it('runs no gates for a refused start, and reports the refusal alone', async () => {
        const board = stubBoard([gatedJob(4)]);
        const stack = stubGateStack();
        const refusal = '.bellows.yaml: unknown key "ports"';
        await drive({
            ...board,
            runner: stubRunner(async () => ok({ exitCode: null, output: refusal, refused: true })),
            gates: stack.gates,
        });
        expect(stack.stack.ran.names).toEqual([]);
        const complete = board.board.completed[0]!;
        expect(complete.status).toBe('failed');
        expect(complete.output).toBe(refusal);
    });

    // The minted session was reported before the runner spawned, but a refused start never ran
    // the agent, so no transcript exists under that id. Left on the row, a follow-up would inherit
    // it and `--resume` into "No conversation found".
    it('clears the session it minted when the start is refused', async () => {
        const board = stubBoard([gatedJob(4)]);
        let minted = '';
        await drive({
            ...board,
            runner: stubRunner(async (_job, session) => {
                minted = session!.id;
                return ok({ exitCode: null, output: '.bellows.yaml: unknown key "ports"', refused: true });
            }),
            gates: stubGateStack().gates,
        });
        expect(board.board.sessions).toEqual([
            { id: gatedJob(4).id, sessionId: minted },
            { id: gatedJob(4).id, sessionId: null },
        ]);
    });

    // A refused follow-up still owns its parent's conversation: the transcript exists, and the
    // next follow-up must be able to resume it.
    it('keeps a resumed session when the start is refused', async () => {
        const board = stubBoard([{ ...gatedJob(4), followUp: true, resumeSessionId: 'ses_parent' }]);
        await drive({
            ...board,
            runner: stubRunner(async () => ok({ exitCode: null, output: 'refused', refused: true })),
            gates: stubGateStack().gates,
        });
        expect(board.board.sessions).toEqual([]);
    });

    // An ordinary job must not pay for the feature: no container, no registration, no reports.
    it('never touches the gate stack for a job without gates', async () => {
        const board = stubBoard([job(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.acquired).toEqual([]);
        expect(stack.stack.registered).toBe(0);
        expect(stack.stack.released).toEqual([]);
        expect(board.board.gatesReported).toEqual([]);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });
});

describe('block-helper steps (issue #207)', () => {
    /** A runner whose `runHelper` records every call and answers scripted results in order. */
    function runnerWithHelper(
        run: (job: BoardJob, session: RunSession | null) => Promise<RunOutcome>,
        results: HelperResult[]
    ) {
        const runner = stubRunner(run);
        const calls: { jobId: string; plan: HelperPlan; token: string | undefined }[] = [];
        const queue = [...results];
        runner.runHelper = async (helperJob, plan, token) => {
            calls.push({ jobId: helperJob.id, plan, token });
            return queue.shift() ?? { ok: true, output: null };
        };
        return { runner, calls };
    }

    const helperPlan = (over: Partial<HelperPlan> = {}): HelperPlan => ({
        helperId: 'noop',
        phase: 'pre',
        input: null,
        githubWriting: false,
        ...over,
    });

    it('runs a declared pre-helper before the agent, and never launches the agent when it fails', async () => {
        const runCalls: string[] = [];
        const board = stubBoard([{ ...job(1), helperPlans: [helperPlan()] }]);
        const { runner, calls } = runnerWithHelper(
            async (helperJob) => {
                runCalls.push(helperJob.id);
                return ok();
            },
            [{ ok: false, reason: 'runner_error', message: 'the helper blew up' }]
        );

        await drive({ ...board, runner });

        expect(calls).toHaveLength(1);
        expect(calls[0]!.plan.phase).toBe('pre');
        // The agent never launches — the whole point of the pre-phase gate.
        expect(runCalls).toEqual([]);
        expect(board.board.completed).toEqual([
            {
                id: job(1).id,
                status: 'failed',
                exitCode: null,
                output: expect.stringContaining('the helper blew up'),
                failureKind: 'helper',
            },
        ]);
    });

    it('runs the agent normally after a pre-helper succeeds', async () => {
        const board = stubBoard([{ ...job(1), helperPlans: [helperPlan()] }]);
        const { runner, calls } = runnerWithHelper(async () => ok(), [{ ok: true, output: null }]);

        await drive({ ...board, runner });

        expect(calls).toHaveLength(1);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('asks the board for a fresh install token before a github-writing pre-helper, never a read-only one', async () => {
        // publish: false isolates the assertion to the pre-helper's own ask — otherwise the
        // ordinary publish flow (publishIfDue) asks for its own fresh token too, on a job this
        // plain would otherwise publish (absent `publish` reads as "publish").
        const board = stubBoard([{ ...job(1), publish: false, helperPlans: [helperPlan({ githubWriting: true })] }], {
            publishToken: 'fresh-install-token',
        });
        const { runner, calls } = runnerWithHelper(async () => ok(), [{ ok: true, output: null }]);

        await drive({ ...board, runner });

        expect(board.board.publishTokenAsks).toEqual([job(1).id]);
        expect(calls[0]!.token).toBe('fresh-install-token');

        const readOnlyBoard = stubBoard([
            { ...job(2), publish: false, helperPlans: [helperPlan({ githubWriting: false })] },
        ]);
        const { runner: readOnlyRunner, calls: readOnlyCalls } = runnerWithHelper(
            async () => ok(),
            [{ ok: true, output: null }]
        );
        await drive({ ...readOnlyBoard, runner: readOnlyRunner });
        expect(readOnlyBoard.board.publishTokenAsks).toEqual([]);
        expect(readOnlyCalls[0]!.token).toBeUndefined();
    });

    it('runs a declared post-helper after the agent, and fails the verdict — skipping publish — when it fails', async () => {
        const board = stubBoard([
            { ...job(1), repo: 'Bellows-AI/factory', helperPlans: [helperPlan({ phase: 'post' })] },
        ]);
        const { runner, calls } = runnerWithHelper(
            async () => ok(),
            [{ ok: false, reason: 'malformed_output', message: 'unreadable verdict' }]
        );
        runner.publishGit = async (publishedJob) => {
            runner.published.push(publishedJob);
            return {
                ok: true,
                published: true,
                branch: 'fix/1',
                prUrl: 'https://github.com/o/r/pull/1',
                reason: null,
                repository: 'o/r',
                baseBranch: 'main',
                prNumber: 1,
            };
        };

        await drive({ ...board, runner });

        expect(calls[0]!.plan.phase).toBe('post');
        expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
        expect(board.board.completed[0]!.output).toContain('unreadable verdict');
        // Publish never runs: a failed post-helper dooms the verdict exactly like a failed gate.
        expect(runner.published).toEqual([]);
    });

    it('a succeeding post-helper does not disturb an otherwise-succeeded verdict', async () => {
        const board = stubBoard([{ ...job(1), helperPlans: [helperPlan({ phase: 'post' })] }]);
        const { runner, calls } = runnerWithHelper(async () => ok(), [{ ok: true, output: { fine: true } }]);

        await drive({ ...board, runner });

        expect(calls).toHaveLength(1);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('pays no helper work at all for a job with no declared plans, or a runner with no runHelper', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());
        expect(runner.runHelper).toBeUndefined();

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('stands a job down while a pre-helper is still running, without launching the agent', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([{ ...job(1), helperPlans: [helperPlan()] }], options);
        const runCalls: string[] = [];
        const runner = stubRunner(async (helperJob) => {
            runCalls.push(helperJob.id);
            throw new Error('the agent must not launch');
        });
        const released: string[] = [];
        runner.releaseFence = async (fencedJob) => {
            released.push(fencedJob.id);
        };
        runner.runHelper = async () => {
            // The stop lands while the pre-helper is in flight.
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { ok: true, output: null };
        };

        const started = drive({ ...board, runner });
        // Let the setup-poll heartbeat carry the stop in while the helper is pending.
        await new Promise((resolve) => setTimeout(resolve, 10));
        await started;

        expect(runCalls).toEqual([]);
        expect(released).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    it('releases the kubernetes checkout fence when a pre-helper fails, since no runner launches to release it', async () => {
        const board = stubBoard([{ ...job(1), helperPlans: [helperPlan()] }]);
        const { runner } = runnerWithHelper(
            async () => ok(),
            [{ ok: false, reason: 'unknown_helper', message: 'nope' }]
        );
        const released: string[] = [];
        runner.releaseFence = async (fencedJob) => {
            released.push(fencedJob.id);
        };

        await drive({ ...board, runner });

        expect(released).toEqual([job(1).id]);
    });

    describe('pre-helper conclude and composite helper programs (issue #230)', () => {
        it('completes the job succeeded exactly once when a pre-helper concludes, never launching the agent', async () => {
            const runCalls: string[] = [];
            const board = stubBoard([{ ...job(1), helperPlans: [helperPlan()] }]);
            const { runner, calls } = runnerWithHelper(
                async (helperJob) => {
                    runCalls.push(helperJob.id);
                    return ok();
                },
                [{ ok: true, output: { decided: 'up-to-date' }, control: 'conclude' }]
            );

            await drive({ ...board, runner });

            expect(calls).toHaveLength(1);
            expect(runCalls).toEqual([]);
            expect(board.board.completed).toEqual([
                {
                    id: job(1).id,
                    status: 'succeeded',
                    exitCode: 0,
                    output: JSON.stringify({ decided: 'up-to-date' }),
                },
            ]);
        });

        it('a pre-helper answering control: "continue" explicitly runs the agent, same as answering none at all', async () => {
            const board = stubBoard([{ ...job(1), helperPlans: [helperPlan()] }]);
            const { runner, calls } = runnerWithHelper(
                async () => ok(),
                [{ ok: true, output: null, control: 'continue' }]
            );

            await drive({ ...board, runner });

            expect(calls).toHaveLength(1);
            expect(board.board.completed[0]).toMatchObject({ status: 'succeeded', exitCode: 0 });
        });

        it('a concluding pre-helper skips every later declared pre-plan', async () => {
            const board = stubBoard([
                { ...job(1), helperPlans: [helperPlan({ input: 'first' }), helperPlan({ input: 'second' })] },
            ]);
            const { runner, calls } = runnerWithHelper(
                async () => ok(),
                [{ ok: true, output: null, control: 'conclude' }]
            );

            await drive({ ...board, runner });

            expect(calls).toHaveLength(1);
            expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        });

        it('a post-helper reporting "conclude" fails the verdict with invalid_control and skips publish', async () => {
            const board = stubBoard([
                { ...job(1), repo: 'Bellows-AI/factory', helperPlans: [helperPlan({ phase: 'post' })] },
            ]);
            const { runner } = runnerWithHelper(async () => ok(), [{ ok: true, output: null, control: 'conclude' }]);
            runner.publishGit = async (publishedJob) => {
                runner.published.push(publishedJob);
                return {
                    ok: true,
                    published: true,
                    branch: 'fix/1',
                    prUrl: 'https://github.com/o/r/pull/1',
                    reason: null,
                    repository: 'o/r',
                    baseBranch: 'main',
                    prNumber: 1,
                };
            };

            await drive({ ...board, runner });

            expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
            expect(board.board.completed[0]!.output).toContain('only valid for a pre-run helper');
            expect(runner.published).toEqual([]);
        });

        it('sequences a declared composite plan over its child script steps, propagating output between them', async () => {
            const board = stubBoard([{ ...job(1), helperPlans: [helperPlan({ helperId: 'sequence-fixture' })] }]);
            const { runner, calls } = runnerWithHelper(
                async () => ok(),
                [
                    { ok: true, output: { echoed: 'first' } },
                    { ok: true, output: { echoed: 'second' } },
                ]
            );

            await drive({ ...board, runner });

            expect(calls).toHaveLength(2);
            expect(calls[0]!.plan.helperId).toBe('noop');
            expect(calls[0]!.plan.input).toEqual({ step: 0, seed: null });
            expect(calls[1]!.plan.helperId).toBe('noop');
            expect(calls[1]!.plan.input).toEqual({ step: 1, receivedFromStep0: { echoed: 'first' } });
            expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        });

        it("a composite's own finalize decides conclude vs. continue from its declared input", async () => {
            const concludingBoard = stubBoard([
                { ...job(1), helperPlans: [helperPlan({ helperId: 'sequence-fixture', input: { conclude: true } })] },
            ]);
            const { runner: concludingRunner } = runnerWithHelper(
                async () => ok(),
                [
                    { ok: true, output: null },
                    { ok: true, output: null },
                ]
            );
            await drive({ ...concludingBoard, runner: concludingRunner });
            expect(concludingBoard.board.completed[0]).toMatchObject({ status: 'succeeded', exitCode: 0 });

            const continuingBoard = stubBoard([
                { ...job(2), helperPlans: [helperPlan({ helperId: 'sequence-fixture', input: { conclude: false } })] },
            ]);
            const runCalls: string[] = [];
            const { runner: continuingRunner } = runnerWithHelper(
                async (helperJob) => {
                    runCalls.push(helperJob.id);
                    return ok();
                },
                [
                    { ok: true, output: null },
                    { ok: true, output: null },
                ]
            );
            await drive({ ...continuingBoard, runner: continuingRunner });
            expect(runCalls).toEqual([job(2).id]);
        });

        it("propagates a composite child's own failure reason unchanged, and never runs the following child", async () => {
            const board = stubBoard([{ ...job(1), helperPlans: [helperPlan({ helperId: 'sequence-fixture' })] }]);
            const { runner, calls } = runnerWithHelper(
                async () => ok(),
                [{ ok: false, reason: 'timeout', message: 'the child ran out of time' }]
            );

            await drive({ ...board, runner });

            expect(calls).toHaveLength(1);
            expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
            expect(board.board.completed[0]!.output).toContain('timeout');
            expect(board.board.completed[0]!.output).toContain('the child ran out of time');
        });

        it('stands the job down between composite child steps, without ever running the second child or the agent', async () => {
            const options: { cancelRequested?: boolean } = {};
            const board = stubBoard(
                [{ ...job(1), helperPlans: [helperPlan({ helperId: 'sequence-fixture' })] }],
                options
            );
            const runCalls: string[] = [];
            const runner = stubRunner(async (helperJob) => {
                runCalls.push(helperJob.id);
                throw new Error('the agent must not launch');
            });
            const released: string[] = [];
            runner.releaseFence = async (fencedJob) => {
                released.push(fencedJob.id);
            };
            const childCalls: HelperPlan[] = [];
            runner.runHelper = async (_helperJob, plan) => {
                childCalls.push(plan);
                // The stop lands while the FIRST child is in flight.
                options.cancelRequested = true;
                await new Promise((resolve) => setTimeout(resolve, 30));
                return { ok: true, output: null };
            };

            const started = drive({ ...board, runner });
            await new Promise((resolve) => setTimeout(resolve, 10));
            await started;

            expect(childCalls).toHaveLength(1);
            expect(runCalls).toEqual([]);
            expect(released).toEqual([job(1).id]);
            expect(board.board.suspended).toEqual([job(1).id]);
            expect(board.board.completed).toEqual([]);
        });

        it('fails closed as invalid_composite_plan when the declared plan itself claims githubWriting, before any child runs', async () => {
            const board = stubBoard([
                { ...job(1), helperPlans: [helperPlan({ helperId: 'sequence-fixture', githubWriting: true })] },
            ]);
            const { runner, calls } = runnerWithHelper(async () => ok(), []);

            await drive({ ...board, runner });

            expect(calls).toEqual([]);
            expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
            expect(board.board.completed[0]!.output).toContain('invalid_composite_plan');
        });

        it("asks the board for no token at all when neither of a composite's declared steps writes to GitHub", async () => {
            // sequence-fixture's own two steps both declare githubWriting: false — each child call
            // still goes through the SAME per-child token-minting closure a plain plan's single call
            // does (pinned by "asks the board for a fresh install token…" above), so a composite whose
            // steps are all read-only asks the board for nothing, exactly like a read-only plain plan.
            const board = stubBoard(
                [{ ...job(1), publish: false, helperPlans: [helperPlan({ helperId: 'sequence-fixture' })] }],
                {
                    publishToken: 'fresh-install-token',
                }
            );
            const { runner, calls } = runnerWithHelper(
                async () => ok(),
                [
                    { ok: true, output: null },
                    { ok: true, output: null },
                ]
            );

            await drive({ ...board, runner });

            expect(board.board.publishTokenAsks).toEqual([]);
            expect(calls.map((c) => c.token)).toEqual([undefined, undefined]);
        });
    });
});

describe('the output pump snapshot', () => {
    /**
     * The timeout note's active/idle verdict keys on the age of the last CHANGED tail (issue
     * #339). A runner that re-pushes the same tail — kubernetes's repeated identical log polls —
     * must not fake freshness: only a changed tail stamps the pump, and the activity line is the
     * newest tail's last non-empty line.
     */
    it('stamps lastOutputAt only when the tail changes, and derives the activity line', async () => {
        const board = stubBoard([]);
        const runner = stubRunner(async () => ok());
        const rt: LoopRuntime = {
            board: board.board,
            runner,
            config: config(),
            log: () => {},
            sleep,
            reclaims: new Map(),
            report: async () => 'held',
        };
        const state = newJobState();
        const pump = watchOutput(rt, job(1), state);
        try {
            expect(pump.snapshot().lastOutputAt).toBeNull();
            expect(pump.snapshot().activity).toBeNull();

            pump.push('$ npm test');
            const first = pump.snapshot().lastOutputAt;
            expect(first).not.toBeNull();
            expect(pump.snapshot().activity).toBe('$ npm test');

            // The same tail again — a re-poll, not progress. The stamp must not move.
            pump.push('$ npm test');
            expect(pump.snapshot().lastOutputAt).toBe(first);

            await new Promise((resolve) => setTimeout(resolve, 2));
            pump.push('$ npm run lint\n');
            expect(pump.snapshot().lastOutputAt).toBeGreaterThan(first!);
            expect(pump.snapshot().activity).toBe('$ npm run lint');
        } finally {
            state.finished = true;
            state.wake();
        }
    });
});

describe('a dead declared service (issue #423)', () => {
    /**
     * A service that died before the gates run makes every gate fail on an environment the agent
     * cannot fix. The gates are skipped, the verdict names the service — its exit and its last
     * log lines — and lands as `services`, never `gate`, so the workflow's gate-fix edge cannot
     * spend a round on it.
     */
    const mongo: DeadService = {
        name: 'test-mongo',
        image: 'mongo:8.0.11',
        state: 'failed',
        exitCode: 1,
        reason: 'Error',
        logTail: 'chown: changing ownership of /data/db: Operation not permitted',
    };

    it('skips the declared gates and fails the verdict as services, naming the service', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok({ output: 'agent did the work' }), {
            deadServices: async () => [mongo],
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual([]);
        expect(board.board.gatesReported).toEqual([]);
        const complete = board.board.completed[0]!;
        expect(complete).toMatchObject({ status: 'failed', failureKind: 'services', exitCode: 0 });
        expect(complete.output).toContain('agent did the work');
        expect(complete.output).toContain(
            '[driver] service "test-mongo" (mongo:8.0.11) failed — exit 1 (Error); declared gates skipped'
        );
        expect(complete.output).toContain('chown: changing ownership of /data/db: Operation not permitted');
        // Nothing an unverified run produced is published, and the fleet still goes.
        expect(runner.published).toEqual([]);
        expect(runner.servicesReleased).toEqual([gatedJob(1).id]);
    });

    it('runs the gates when every service is alive, probing once', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        expect(runner.deadServiceProbes).toBe(1);
        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('runs the gates when the probe itself fails, and logs why', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const logs: string[] = [];
        const runner = stubRunner(async () => ok(), {
            deadServices: async () => {
                throw new Error('the API server is away');
            },
        });

        await drive({ ...board, runner, gates: stack.gates, log: (m) => logs.push(m) });

        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        expect(logs.some((m) => m.includes('the API server is away'))).toBe(true);
    });

    it('never probes a refused run or an ungated job', async () => {
        const board = stubBoard([gatedJob(1), job(2)]);
        const stack = stubGateStack();
        let ran = 0;
        const runner = stubRunner(
            async () => (ran++ === 0 ? ok({ exitCode: 1, output: 'refused', refused: true }) : ok()),
            { deadServices: async () => [mongo] }
        );

        await drive({ ...board, runner, gates: stack.gates });

        expect(runner.deadServiceProbes).toBe(0);
        expect(board.board.completed.map((c) => c.failureKind ?? null)).toEqual(['runner_error', null]);
    });

    it('never probes a run whose gates are skipped — an unclean exit or a blocked agent', async () => {
        const board = stubBoard([gatedJob(1), gatedJob(2)]);
        const stack = stubGateStack();
        let ran = 0;
        const runner = stubRunner(
            async () =>
                ran++ === 0 ? ok({ exitCode: 1 }) : ok({ output: 'FACTORY_BLOCKED: acli is not authenticated' }),
            { deadServices: async () => [mongo] }
        );

        await drive({ ...board, runner, gates: stack.gates });

        expect(runner.deadServiceProbes).toBe(0);
        expect(stack.stack.ran.names).toEqual([]);
        expect(board.board.completed.map((c) => c.failureKind ?? null)).toEqual(['runner_error', 'blocked']);
    });

    it('ranks a timeout above the dead service', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok({ exitCode: 124, timedOut: true }), {
            deadServices: async () => [mongo],
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual([]);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'timeout' });
    });
});

describe('the verdict failure kind (issue #339)', () => {
    /**
     * Every terminal path names its kind on the verdict, so "how many timeouts this week" and
     * "timeouts where the gates passed" are queries, not archaeology. Precedence when several
     * conditions land on one run: timeout, then cache, then gate, then helper, then publish,
     * then the plain runner error.
     */
    it('names a failed gate gate', async () => {
        const board = stubBoard([gatedJob(1)]);
        const runner = stubRunner(async () => ok());
        const { gates } = stubGateStack({ test: 3 });

        await drive({ ...board, runner, gates });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'gate' });
    });

    it('names an unlanded publish publish', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok(), {
            publish: {
                ok: false,
                published: false,
                branch: null,
                prUrl: null,
                reason: 'the push was refused',
                repository: null,
                baseBranch: null,
                prNumber: null,
            },
        });

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'publish' });
    });

    it('names a failed post-helper helper', async () => {
        const board = stubBoard([
            { ...job(1), helperPlans: [{ helperId: 'noop', phase: 'post', input: null, githubWriting: false }] },
        ]);
        const runner = stubRunner(async () => ok());
        runner.runHelper = async () => ({ ok: false, reason: 'malformed_output', message: 'unreadable verdict' });

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'helper' });
    });

    it('names a failed pre-helper helper — the agent never launched', async () => {
        const board = stubBoard([
            { ...job(1), helperPlans: [{ helperId: 'noop', phase: 'pre', input: null, githubWriting: false }] },
        ]);
        const runner = stubRunner(async () => {
            throw new Error('the runner must never be reached');
        });
        runner.runHelper = async () => ({ ok: false, reason: 'runner_error', message: 'the helper blew up' });

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'helper' });
    });

    it('names a cache kill cache_lost', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () =>
            ok({ exitCode: 1, output: 'cut', cacheLost: '3 consecutive turns with no prompt-cache reads' })
        );

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'cache_lost' });
    });

    it('names a plain non-zero exit and a premature finish runner_error', async () => {
        const board = stubBoard([job(1), job(2)]);
        let ran = 0;
        const runner = stubRunner(async () =>
            ran++ === 0 ? ok({ exitCode: 2, output: 'boom' }) : ok({ output: 'reads only', finishReason: 'length' })
        );

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'runner_error' });
        expect(board.board.completed[1]).toMatchObject({ status: 'failed', failureKind: 'runner_error' });
    });

    it('puts no kind on a succeeded verdict', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.status).toBe('succeeded');
        expect(board.board.completed[0]).not.toHaveProperty('failureKind');
    });

    it('names every pre-run refusal runner_error', async () => {
        // The claim refusals and setup refusals are the driver's own environment failing, never
        // the agent's work — all of them are runner errors, and none is a gate (that name is
        // reserved for a gate RUN that failed).
        const refusalCases: {
            job: BoardJob;
            fragment: string;
            sync?: SyncResult;
            rereadGates?: { gates: BoardJob['gates']; gateError: string | null } | null;
        }[] = [
            { job: { ...job(1), executorType: null }, fragment: 'selected executor no longer exists' },
            { job: { ...job(1), masterPrompt: null }, fragment: 'no Factory execution context' },
            {
                job: { ...job(1), repo: 'Bellows-AI/factory', rootJobId: 'not-a-uuid' },
                fragment: 'do not resolve to a task worktree',
            },
            {
                job: job(2),
                fragment: 'could not be synced with the remote',
                sync: { ok: false, reason: 'the task branch could not be rebased onto origin/main' },
            },
            {
                job: job(3),
                fragment: 'could not be read as a gate declaration',
                rereadGates: { gates: null, gateError: '.bellows.yaml line 3: unknown key "ports"' },
            },
        ];
        for (const refusal of refusalCases) {
            const board = stubBoard([refusal.job], { rereadGates: refusal.rereadGates });
            const runner = stubRunner(
                async () => {
                    throw new Error('the runner must never be reached');
                },
                { sync: refusal.sync }
            );

            await drive({ ...board, runner });

            expect(board.board.completed[0]?.status, refusal.fragment).toBe('failed');
            expect(board.board.completed[0]?.output, refusal.fragment).toContain(refusal.fragment);
            expect(board.board.completed[0]?.failureKind, refusal.fragment).toBe('runner_error');
        }
    });
});

/**
 * Gates judge work: a run that did not finish cleanly left none, and a failed gate over it would
 * fire the workflow's `gate-failed` edge on work that never happened (task d0a4146f).
 */
describe('gates over a run that did not finish cleanly', () => {
    it.each([
        ['a non-zero exit', ok({ exitCode: 2, output: 'boom' }), "the agent's run exited 2", 'runner_error'],
        [
            'a null exit',
            ok({ exitCode: null, output: 'boom' }),
            "the agent's run exited without an exit code",
            'runner_error',
        ],
        [
            'a cache kill',
            ok({ exitCode: 1, output: 'cut', cacheLost: '3 consecutive turns with no prompt-cache reads' }),
            'the run was killed for prompt-cache loss',
            'cache_lost',
        ],
        [
            'a premature finish',
            ok({ output: 'reads only', finishReason: 'length' }),
            "the agent's run ended before it finished",
            'runner_error',
        ],
    ])('skips the declared gates after %s, naming why, keeping the kind', async (_label, outcome, why, kind) => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack({ test: 1 });
        const runner = stubRunner(async () => outcome);

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual([]);
        expect(board.board.gatesReported).toEqual([]);
        const complete = board.board.completed[0]!;
        expect(complete).toMatchObject({ status: 'failed', failureKind: kind });
        expect(complete.output).toContain(`[driver] gates skipped — ${why}`);
        // Teardown still runs on the skip path.
        expect(stack.stack.unregistered).toBe(1);
        expect(stack.stack.released).toEqual([`bellows/${USER}/.worktrees/${gatedJob(1).id}`]);
        expect(runner.servicesReleased).toEqual([gatedJob(1).id]);
    });

    // 044 names "timeouts where the gates passed" as a query: a timed-out run keeps its gates.
    it('still runs the gates over a timed-out run', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok({ exitCode: 137, output: 'partial', timedOut: true }));

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'timeout' });
        expect(board.board.completed[0]?.output).not.toContain('gates skipped');
    });

    it('says nothing about gates for a job that declares none', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ exitCode: 2, output: 'boom' }));

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.output).toBe('boom');
    });
});

describe('the agent reporting it is blocked', () => {
    it('reads the close-time blocked line: no gates, no publish, failed blocked', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(
            async () =>
                ok({
                    output: 'I could not start.',
                    summary: 'acli answered 401 on every call. FACTORY_BLOCKED: acli is not authenticated',
                    blockedLine: 'acli is not authenticated',
                }),
            {
                publish: {
                    ok: true,
                    published: true,
                    branch: 'b',
                    prUrl: null,
                    reason: null,
                    repository: null,
                    baseBranch: null,
                    prNumber: null,
                },
            }
        );

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual([]);
        expect(runner.published).toEqual([]);
        const complete = board.board.completed[0]!;
        expect(complete).toMatchObject({ status: 'failed', exitCode: 0, failureKind: 'blocked' });
        expect(complete.output).toContain('[driver] the agent reported it is blocked: acli is not authenticated');
        expect(complete.output).toContain('[driver] gates skipped — the agent reported it is blocked');
    });

    // No close-time read answered (no summary, no blocked line): the output tail is all there is.
    it('falls back to the output tail when no close-time read answered', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () =>
            ok({ output: 'tried twice\nFACTORY_BLOCKED: no access to the staging cluster\n' })
        );

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'blocked' });
        expect(board.board.completed[0]?.output).toContain(
            'the agent reported it is blocked: no access to the staging cluster'
        );
    });

    // The summary is collapsed to one line: a marker mentioned inside it is not the agent's last line.
    it('does not read a marker the successful final message merely mentions', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () =>
            ok({ output: 'done', summary: 'Added FACTORY_BLOCKED: handling and verified all tests pass.' })
        );

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('ignores a marker line far above the final message, and one that does not start a line', async () => {
        const board = stubBoard([job(1), job(2)]);
        let ran = 0;
        const far = ['FACTORY_BLOCKED: early worry', ...Array.from({ length: 30 }, (_, i) => `line ${i}`)].join('\n');
        const runner = stubRunner(async () =>
            ran++ === 0 ? ok({ output: far }) : ok({ output: 'the docs mention FACTORY_BLOCKED: as a marker' })
        );

        await drive({ ...board, runner });

        expect(board.board.completed.map((c) => c.status)).toEqual(['succeeded', 'succeeded']);
    });

    it('ranks blocked after timeout and before services and gate', async () => {
        const { verdictFailureKind } = await import('../src/loop-verdict.js');
        const failure = { name: 'test', exitCode: 1, output: '' };
        const dead = { name: 'db', image: 'mongo', state: 'failed', exitCode: 1, reason: null, logTail: '' };
        const base = { outcome: ok(), failure, deadServices: [dead], helperFailure: null, blocked: 'x' };
        expect(verdictFailureKind({ ...base, outcome: ok({ timedOut: true }) }, false, 'failed')).toBe('timeout');
        expect(verdictFailureKind({ ...base, outcome: ok({ cacheLost: 'c' }) }, false, 'failed')).toBe('cache_lost');
        expect(verdictFailureKind(base, false, 'failed')).toBe('blocked');
        expect(verdictFailureKind({ ...base, blocked: null }, false, 'failed')).toBe('services');
        expect(verdictFailureKind({ ...base, blocked: null, deadServices: [] }, false, 'failed')).toBe('gate');
    });
});

/**
 * A gate-fix round that changed nothing can only fail the same gate again: the driver reports
 * whether the tree moved since the startup sync, and the board rests the `gate-failed` edge on false.
 */
describe('the tree change behind a failed gate', () => {
    const synced = { ok: true, reason: null, fingerprint: 'head:aaaa' };

    it.each([
        ['unchanged', 'head:aaaa', false],
        ['changed', 'head:bbbb', true],
    ])('reports a %s tree after a failed gate', async (_label, after, changed) => {
        const board = stubBoard([gatedJob(1)]);
        const runner = stubRunner(async () => ok(), { sync: synced, probeTree: after });

        await drive({ ...board, runner, gates: stubGateStack({ test: 1 }).gates });

        expect(runner.probed).toHaveLength(1);
        expect(board.board.completed[0]).toMatchObject({ failureKind: 'gate', treeChanged: changed });
    });

    it.each([
        ['the probe answers nothing', synced, null],
        ['the sync printed no fingerprint', { ok: true, reason: null }, 'head:aaaa'],
    ])('reports nothing when %s', async (_label, sync, probe) => {
        const board = stubBoard([gatedJob(1)]);
        const runner = stubRunner(async () => ok(), { sync, probeTree: probe });

        await drive({ ...board, runner, gates: stubGateStack({ test: 1 }).gates });

        expect(board.board.completed[0]).toMatchObject({ failureKind: 'gate' });
        expect(board.board.completed[0]).not.toHaveProperty('treeChanged');
    });

    it('never probes when the gates pass', async () => {
        const board = stubBoard([gatedJob(1)]);
        const runner = stubRunner(async () => ok(), { sync: synced, probeTree: 'head:aaaa' });

        await drive({ ...board, runner, gates: stubGateStack().gates });

        expect(runner.probed).toEqual([]);
        expect(board.board.completed[0]).not.toHaveProperty('treeChanged');
    });
});

/** A Stop or Remove ends every gate of the attempt where it stands — never a failed gate verdict. */
describe('a stop cancels the gates', () => {
    it('aborts the declared gate in flight, runs no later gate, and parks the turn stopped', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        const stack = stubGateStack();
        const ran: string[] = [];
        let aborted = false;
        stack.gates.manager.runGate = (_key, name, _command, signal) => {
            ran.push(name);
            options.cancelRequested = true;
            return new Promise((resolve) => {
                signal?.addEventListener('abort', () => {
                    aborted = true;
                    resolve({ exitCode: 137, output: 'killed' });
                });
            });
        };
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        expect(aborted).toBe(true);
        expect(ran).toEqual(['test']);
        expect(board.board.completed).toEqual([]);
        expect(board.board.suspended).toEqual([gatedJob(1).id]);
        // The cancelled gate is never reported failed — `gate-failed` cannot read it.
        expect(board.board.gatesReported.flatMap((r) => r.results).some((g) => g.status === 'failed')).toBe(false);
        expect(stack.stack.unregistered).toBe(1);
        expect(runner.servicesReleased).toEqual([gatedJob(1).id]);
    });

    it('settles a removed thread without a verdict when the remove lands during the gates', async () => {
        const options: { removedOnBeat?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        const stack = stubGateStack();
        stack.gates.manager.runGate = (_key, _name, _command, signal) => {
            options.removedOnBeat = true;
            return new Promise((resolve) => {
                signal?.addEventListener('abort', () => resolve({ exitCode: 137, output: 'killed' }));
            });
        };
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.completed).toEqual([]);
        expect(board.board.suspended).toEqual([]);
    });

    // The agent's ad-hoc gate runs go through the gate server, which the runner kill never reaches.
    it('cancels the ad-hoc gate token when the stop lands during the run', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        const stack = stubGateStack();
        let token = '';
        stack.gates.server.register = (minted: string) => {
            token = minted;
        };
        const runner = stubRunner(async () => {
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return ok();
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(token).not.toBe('');
        expect(stack.stack.cancelled).toEqual([token]);
        expect(board.board.suspended).toEqual([gatedJob(1).id]);
    });

    it('cancels nothing on an ordinary finish', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();

        await drive({ ...board, runner: stubRunner(async () => ok()), gates: stack.gates });

        expect(stack.stack.cancelled).toEqual([]);
    });

    // The tree probe runs after the gates' own stand-down check: a Stop landing while it is
    // pending must still park the turn, never complete a failed gate a `gate-failed` edge reads.
    it('parks the turn stopped when the stop lands during the post-gate tree probe', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        const runner = stubRunner(async () => ok(), {
            sync: { ok: true, reason: null, fingerprint: 'head:aaaa' },
        });
        let probeSignal: AbortSignal | undefined;
        runner.probeTree = async (_job, signal) => {
            probeSignal = signal;
            options.cancelRequested = true;
            while (runner.killed.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
            return 'head:bbbb';
        };

        await drive({ ...board, runner, gates: stubGateStack({ test: 1 }).gates });

        expect(board.board.completed).toEqual([]);
        expect(board.board.suspended).toEqual([gatedJob(1).id]);
        // The transport is cancelled too, so a pending aux Job never holds the Stop.
        expect(probeSignal?.aborted).toBe(true);
    });
});
