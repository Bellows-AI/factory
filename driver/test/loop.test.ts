import { describe, expect, it } from 'vitest';
import type { Board, BoardJob, LeaseState, RuntimeReport } from '../src/board.js';
import { loadDriverConfig, type DriverConfig } from '../src/config.js';
import type { RunOutcome, RunSession, Runner, RuntimeSample } from '../src/docker.js';
import type { GateManager, GateServer } from '../src/gates.js';
import type { PublishResult, SyncResult } from '../src/publish.js';
import { createLoop, type GateStack, type Loop } from '../src/loop.js';

const USER = '44444444-4444-4444-8444-444444444444';

const job = (n: number, resumeSessionId: string | null = null): BoardJob => ({
    id: `0000000${n}-1111-4111-8111-111111111111`,
    command: `job ${n}`,
    attempts: 1,
    leaseToken: `0000000${n}-2222-4222-8222-222222222222`,
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    resumeSessionId,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
});

interface BoardStub extends Board {
    completed: { id: string; status: string; exitCode: number | null; output: string }[];
    sessions: { id: string; sessionId: string; remoteSessionId: string | null }[];
    progressed: { id: string; output: string; runtime: RuntimeReport | null }[];
    suspended: string[];
    beats: number;
    gatesReported: { id: string; results: { name: string; status: string; exitCode: number | null; output: string | null }[] }[];
    gatesReread: number;
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
    } = {},
): { board: BoardStub; attach: (loop: Loop) => void } {
    let loop: Loop | null = null;
    let idle = 0;
    let failures = options.failClaims ?? 0;
    const queue = [...jobs];

    const board: BoardStub = {
        completed: [],
        sessions: [],
        progressed: [],
        suspended: [],
        beats: 0,
        gatesReported: [],
        gatesReread: 0,
        async suspend(claimed) {
            board.suspended.push(claimed.id);
            return 'held';
        },
        async session(claimed, sessionId, remoteSessionId) {
            if (options.failSession) throw new Error('board unreachable');
            board.sessions.push({ id: claimed.id, sessionId, remoteSessionId });
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
            return options.lease ?? 'held';
        },
        async rereadGates(claimed) {
            board.gatesReread += 1;
            return options.rereadGates ?? null;
        },
        async complete(claimed, result) {
            board.completed.push({ id: claimed.id, ...result });
            return 'held';
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
    remote: string | null = null,
    sample: Omit<RuntimeSample, 'sampledAt'> | null = null,
    publish: PublishResult | null = null,
    sync: SyncResult | null = null,
): Runner & { killed: string[]; lookups: number; samples: number; published: BoardJob[]; synced: BoardJob[] } {
    const runner = {
        killed: [] as string[],
        lookups: 0,
        samples: 0,
        published: [] as BoardJob[],
        synced: [] as BoardJob[],
        run: outcome,
        async remoteSessionId() {
            runner.lookups += 1;
            return remote;
        },
        async sampleRuntime() {
            runner.samples += 1;
            return sample;
        },
        async kill(killedJob: BoardJob) {
            runner.killed.push(killedJob.id);
        },
        async publishGit(publishedJob: BoardJob) {
            runner.published.push(publishedJob);
            return publish ?? { ok: true, published: false, branch: null, prUrl: null, reason: null };
        },
        async syncCheckout(syncedJob: BoardJob) {
            runner.synced.push(syncedJob);
            return sync ?? { ok: true, reason: null };
        },
    };
    return runner;
}

const ok = (over: Partial<RunOutcome> = {}): RunOutcome => ({
    exitCode: 0,
    output: 'done',
    timedOut: false,
    idled: false,
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
    deps: { board: BoardStub; attach: (loop: Loop) => void; runner: Runner; gates?: GateStack },
    env = {},
) {
    const loop = createLoop({
        board: deps.board,
        runner: deps.runner,
        config: config(env),
        gates: deps.gates,
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
            { id: job(1).id, status: 'succeeded', exitCode: 0, output: 'done', contextTokens: null, contextCostUsd: null },
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

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded', contextTokens: 90433, contextCostUsd: 0.31 });
    });

    // An opencode run always leaves a session, so an empty scrape is a failed readout — said out
    // loud, because a silently-lost session presents later as "this run cannot take a follow-up"
    // with nothing anywhere naming why.
    it('says so when an opencode run closes with no session scraped', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ finishReason: 'stop', contextTokens: 1200, costUsd: 0 }));
        const logs: string[] = [];
        const loop = createLoop({
            board: board.board,
            runner,
            config: config({ RUNNER_CLI: 'opencode' }),
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
    });

    // Instructions are not enforcement: the deterministic publish runs after a succeeded run,
    // and its result changes the verdict — work that landed nowhere is not a success.
    it('publishes a succeeded run and says where the work landed', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(
            async () => ok(),
            null,
            null,
            { ok: true, published: true, branch: 'fix/10', prUrl: 'https://github.com/Bellows-AI/factory/pull/42', reason: null },
        );

        await drive({ ...board, runner });

        expect(runner.published).toHaveLength(1);
        expect(board.board.completed[0]?.status).toBe('succeeded');
        expect(board.board.completed[0]?.output).toContain('[driver] published fix/10 — https://github.com/Bellows-AI/factory/pull/42');
    });

    it('fails the verdict when the publish does not land', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(
            async () => ok(),
            null,
            null,
            { ok: false, published: false, branch: null, prUrl: null, reason: 'git step failed: authentication refused' },
        );

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.status).toBe('failed');
        expect(board.board.completed[0]?.output).toContain('[driver] publish failed — the work did not land: git step failed: authentication refused');
    });

    // A runner with no publishGit at all — the kubernetes shape, whose publish steps are future
    // work — runs and reports like any other: publishing is a capability the loop asks for, not
    // one it assumes.
    it('reports a clean run succeeded from a runner that cannot publish', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());
        delete (runner as Partial<Runner>).publishGit;

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.status).toBe('succeeded');
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
        const runner = stubRunner(
            async () => ok(),
            null,
            null,
            null,
            { ok: false, reason: 'the task branch could not be rebased onto origin/main: conflict in driver/src/loop.ts' },
        );

        await drive({ ...board, runner });

        expect(runner.synced).toHaveLength(1);
        // The run never started on an unknown tree.
        expect(board.board.completed[0]?.status).toBe('failed');
        expect(board.board.completed[0]?.output).toContain('could not be synced with the remote');
        expect(board.board.completed[0]?.output).toContain('conflict in driver/src/loop.ts');
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
            }),
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
                }),
        );

        const started = drive({ ...board, runner });
        // Let the heartbeat land its verdict before the run is allowed to end.
        await new Promise((resolve) => setTimeout(resolve, 5));
        finish();
        await started;

        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
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
        const runner = stubRunner(async () => ok(), null, null, null, { ok: false, reason: 'conflict in driver/src/loop.ts' });
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
            ok({ exitCode: 125, output: 'docker: Error response from daemon: Conflict. The container name is already in use', started: false }),
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

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: 125, output: 'the command failed' });
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
    // that does not exist. Reported before the run so the link works while the job is still going —
    // which, under Remote Control, is the only time it is worth anything.
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
        expect(board.board.sessions).toEqual([
            { id: job(1).id, sessionId: given, remoteSessionId: null },
        ]);
        expect(reportedFirst).toBe(true);
    });

    /**
     * The remote id is the one the Claude UI addresses a session by, and unlike the local uuid it
     * cannot be minted: Anthropic's backend assigns it when the bridge connects, seconds into the
     * run. So the worker goes and finds it, which is the whole reason this poll exists.
     */
    it('reports the remote session id once the bridge has one', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return ok();
        }, 'cse_015tb2nHhHNrBuL7ZDhn9Wx5');

        await drive({ ...board, runner }, { RUNNER_REMOTE_CONTROL: '1' });

        expect(board.board.sessions.map((s) => s.remoteSessionId)).toContain(
            'cse_015tb2nHhHNrBuL7ZDhn9Wx5',
        );
    });

    // Forty `docker exec`s that can never find anything: a headless run registers no bridge.
    it('does not go looking for a bridge on a headless run', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return ok();
        }, 'cse_never-read');

        await drive({ ...board, runner });

        expect(runner.lookups).toBe(0);
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
            { id: job(1).id, status: 'succeeded', exitCode: 0, output: 'final', contextTokens: null, contextCostUsd: null },
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
            null,
            { cpuPercent: 93, memUsedMb: 544, memPercent: 7 },
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
    });

    // A run is not failed by its own telemetry. The output stream is a preview; losing it costs
    // freshness, never the job.
    it('completes the job anyway when the output stream fails', async () => {        const board = stubBoard([job(1)], { failProgress: true });
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('tail one');
            await new Promise((resolve) => setTimeout(resolve, 5));
            onOutput?.('tail two');
            await new Promise((resolve) => setTimeout(resolve, 5));
            return ok({ output: 'final' });
        });

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([
            { id: job(1).id, status: 'succeeded', exitCode: 0, output: 'final', contextTokens: null, contextCostUsd: null },
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
            { id: job(1).id, status: 'succeeded', exitCode: 0, output: 'final', contextTokens: null, contextCostUsd: null },
        ]);
    });

    // An idle Remote Control session is nobody's failure: it is a job waiting for a human. Reporting
    // an exit code for it would make it indistinguishable from a run that ended.
    it('parks an idle runner instead of completing it', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ exitCode: 137, output: 'quiet', idled: true }));

        await drive({ ...board, runner });

        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // The other half of standby: the board hands the session back on the claim, and the runner
    // restores it rather than being given a new one. A fresh id here would strand the transcript
    // the human has been driving and move the link.
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
        const board = stubBoard([job(1)]);
        let given: RunSession | null | undefined;
        const runner = stubRunner(async (_job, session) => {
            given = session;
            return ok();
        });

        await drive({ ...board, runner }, { RUNNER_CLI: 'opencode' });

        expect(given).toBeNull();
        expect(board.board.sessions).toEqual([]);
        expect(board.board.completed).toEqual([
            { id: job(1).id, status: 'succeeded', exitCode: 0, output: 'done', contextTokens: null, contextCostUsd: null },
        ]);
    });

    // A claim carrying resumeSessionId under opencode WITHOUT a follow-up can only be board state
    // from before a RUNNER_CLI flip: standby is a Remote Control feature, and opencode refuses
    // Remote Control at startup. Failing it with a reason beats restoring a session the runner
    // cannot adopt — or idling a headless run to its deadline.
    it('fails a parked job it cannot resume, with a reason, without running it', async () => {
        const board = stubBoard([job(1, '44444444-4444-4444-8444-444444444444')]);
        let ran = 0;
        const runner = stubRunner(async () => {
            ran += 1;
            return ok();
        });

        await drive({ ...board, runner }, { RUNNER_CLI: 'opencode' });

        expect(ran).toBe(0);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: null });
        expect(board.board.completed[0]?.output).toContain('opencode');
    });

    /**
     * The follow-up carve-out, and the reason an opencode task is follow-up-able at all: the
     * child's session is opencode's OWN (scraped and reported when the parent ran), so the runner
     * restores it with `--session` and delivers the new command into it.
     */
    it('runs an opencode follow-up, restoring the session it carries', async () => {
        const board = stubBoard([{ ...job(1, 'ses_f86188c3dffeZGYO4yZq4atba9'), followUp: true }]);
        let given: RunSession | null | undefined;
        const runner = stubRunner(async (_job, session) => {
            given = session;
            return ok();
        });

        await drive({ ...board, runner }, { RUNNER_CLI: 'opencode' });

        expect(given).toEqual({ id: 'ses_f86188c3dffeZGYO4yZq4atba9', resume: true });
        expect(board.board.completed).toHaveLength(1);
        // Already on the board from the insert — nothing re-reported at spawn.
        expect(board.board.sessions).toEqual([]);
    });

    // opencode mints its own session id, so the loop learns it from the outcome — the runner
    // scrapes it out of the session database after the run and the board is told while the lease
    // is still live, because a follow-up resumes exactly this.
    it('reports the session id the runner scraped from a finished opencode run', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9' }));

        await drive({ ...board, runner }, { RUNNER_CLI: 'opencode' });

        expect(board.board.sessions).toEqual([
            { id: job(1).id, sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9', remoteSessionId: null },
        ]);
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
    // the tree the run edits — never in the pristine clone.
    it('acquires the gate environment under the task worktree key', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.acquired).toEqual([`bellows/${USER}/.worktrees/${gatedJob(1).id}`]);
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

    // The report must fit the board's body however many gates declared and however verbose they
    // were: the per-gate tail shrinks as the list grows.
    it('bounds the total reported gate output', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        stack.gates.manager.runGate = async (_key, name) => ({
            exitCode: 0,
            output: 'x'.repeat(40_000),
        });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        const last = board.board.gatesReported.at(-1)!.results;
        expect(last).toHaveLength(2);
        for (const gate of last) {
            expect((gate.output ?? '').length).toBeLessThanOrEqual(16 * 1024 / 2);
        }
    });

    it('fails a job whose gates file was broken, without running anything', async () => {
        const broken: BoardJob = { ...job(1), repo: 'Bellows-AI/factory', gateError: '.bellows.yaml line 3: unknown key "timeout"' };
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

    // An idle park is not a finished run: the gates would run on a session somebody is still
    // driving, and their verdict would mean nothing.
    it('runs no gates for a parked, a never-started or a lost run', async () => {
        const idleBoard = stubBoard([gatedJob(1)]);
        const idleStack = stubGateStack();
        await drive({ ...idleBoard, runner: stubRunner(async () => ok({ idled: true })), gates: idleStack.gates });
        expect(idleStack.stack.ran.names).toEqual([]);
        expect(idleBoard.board.completed).toEqual([]);

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
