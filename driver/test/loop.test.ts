import { describe, expect, it } from 'vitest';
import type { Board, BoardJob, LeaseState } from '../src/board.js';
import { loadDriverConfig, type DriverConfig } from '../src/config.js';
import type { RunOutcome, RunSession, Runner } from '../src/docker.js';
import { createLoop, type Loop } from '../src/loop.js';

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
    suspended: string[];
    beats: number;
}

/**
 * Hands out the given jobs, then answers empty. After `idleBeforeStop` empty answers it stops the
 * loop — the loop is an infinite poll, so something has to end it, and counting idle polls is the
 * one signal that means "it has claimed everything it is going to".
 */
function stubBoard(
    jobs: BoardJob[],
    options: { lease?: LeaseState; idleBeforeStop?: number; failClaims?: number; failSession?: boolean } = {},
): { board: BoardStub; attach: (loop: Loop) => void } {
    let loop: Loop | null = null;
    let idle = 0;
    let failures = options.failClaims ?? 0;
    const queue = [...jobs];

    const board: BoardStub = {
        completed: [],
        sessions: [],
        suspended: [],
        beats: 0,
        async suspend(claimed) {
            board.suspended.push(claimed.id);
            return 'held';
        },
        async session(claimed, sessionId, remoteSessionId) {
            if (options.failSession) throw new Error('board unreachable');
            board.sessions.push({ id: claimed.id, sessionId, remoteSessionId });
            return 'held';
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
        async complete(claimed, result) {
            board.completed.push({ id: claimed.id, ...result });
            return 'held';
        },
    };

    return { board, attach: (l) => (loop = l) };
}

function stubRunner(
    outcome: (job: BoardJob, session: RunSession | null) => Promise<RunOutcome>,
    remote: string | null = null,
): Runner & { killed: string[]; lookups: number } {
    const runner = {
        killed: [] as string[],
        lookups: 0,
        run: outcome,
        async remoteSessionId() {
            runner.lookups += 1;
            return remote;
        },
        async kill(killedJob: BoardJob) {
            runner.killed.push(killedJob.id);
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

async function drive(deps: { board: BoardStub; attach: (loop: Loop) => void; runner: Runner }, env = {}) {
    const loop = createLoop({ board: deps.board, runner: deps.runner, config: config(env), sleep });
    deps.attach(loop);
    await loop.start();
    return loop;
}

describe('the poll loop', () => {
    it('claims a job, runs it and reports success', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([
            { id: job(1).id, status: 'succeeded', exitCode: 0, output: 'done' },
        ]);
    });

    it('reports a non-zero exit as a failure, with the output', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ exitCode: 2, output: 'boom' }));

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: 2, output: 'boom' });
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
            { id: job(1).id, status: 'succeeded', exitCode: 0, output: 'done' },
        ]);
    });

    // A claim carrying resumeSessionId under opencode can only be board state from before a
    // RUNNER_CLI flip: standby is a Remote Control feature, and opencode refuses Remote Control at
    // startup. Failing it with a reason beats restoring a session the runner cannot adopt — or
    // re-running the command into a transcript somebody has been driving by hand.
    it('fails a job it cannot resume, with a reason, without running it', async () => {
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
});
