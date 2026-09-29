import { LEASE_BATCH_MAX, type Board, type BoardLease, UUID_SHAPE } from './board.js';

/**
 * The orphan reaper (issue #301): the periodic watcher that reaps service objects whose owning
 * job can no longer use them. This file is the executor-neutral core — the decision table and
 * the sweep timer. The platform arms it drives are `k8s-reaper.ts` (pods, Services, the
 * attempt-scoped env Secrets, the checkout claim) and `docker-reaper.ts` (service containers
 * and their per-attempt network); the driver entrypoint picks one and starts the timer.
 *
 * The fence stays the one job-scoped actor at claim time; the reaper only ever acts on what the
 * BOARD says is dead, and never on the live attempt's own objects — so the two can share a job
 * id without racing.
 */

/** One reappable object, named the way its platform's delete call names it. */
export interface OrphanObject {
    kind: 'pod' | 'service' | 'container' | 'network';
    name: string;
}

/**
 * Every service object of one (job, attempt) pair, found by label. `createdAtMs` is the OLDEST
 * object in the group — the grace window is measured from the moment the fleet began to exist,
 * never from when the reaper first saw it.
 */
export interface OrphanGroup {
    jobId: string;
    leaseToken: string | null;
    createdAtMs: number;
    objects: OrphanObject[];
}

/**
 * Why a group was condemned:
 * - `gone`       the job is terminal, or the board has never heard of it — nothing can ever use
 *                these objects again.
 * - `superseded` the job is alive under a different (or no) lease — these objects belong to a
 *                dead attempt, and the live attempt's fence has either swept them already or
 *                needs no help; attempt-scoped deletes cannot reach the live attempt's objects.
 */
export type ReapVerdict = 'gone' | 'superseded';

/**
 * One platform's half of the reaper. `scan` enumerates and groups; `reap` deletes one group and
 * answers a line per object actually removed, for the log. Both fail SOFT — a scan that cannot
 * read answers nothing, and a reap that cannot delete is the next round's problem, because the
 * whole loop is periodic and idempotent.
 */
export interface ReaperArm {
    scan(): Promise<OrphanGroup[]>;
    reap(group: OrphanGroup, verdict: ReapVerdict): Promise<readonly string[]>;
}

/**
 * The statuses a job can never come back from — the objects its attempts created are orphans.
 * Exported because the reclaim loop's orphaned-claim decision (issue #344) must read the SAME
 * vocabulary the reaper decides with, not a restated list that can drift.
 */
export const TERMINAL_JOB_STATUSES: readonly string[] = ['succeeded', 'failed', 'dead', 'stopped'];

/**
 * The decision table, pure — the unit-test surface for the whole feature. `lease` is the board's
 * answer FOR THIS GROUP's job id, `undefined` when the board does not know the job. The board
 * state alone decides; the grace window only DEFERS an action already decided, never decides
 * one — which is why the fence's rejection of age-as-classification is preserved here too.
 */
export function reapDecision(
    lease: BoardLease | undefined,
    group: Pick<OrphanGroup, 'leaseToken' | 'createdAtMs'>,
    nowMs: number,
    graceMs: number
): ReapVerdict | null {
    let verdict: ReapVerdict | null;
    if (lease === undefined) {
        verdict = 'gone';
    } else if (TERMINAL_JOB_STATUSES.includes(lease.status)) {
        verdict = 'gone';
    } else if (lease.leaseToken !== null && lease.leaseToken === group.leaseToken) {
        // The live attempt's own objects: its teardown, and its fence, own them.
        verdict = null;
    } else {
        // Live job under another lease, or holding none at all — every labelled object is a
        // dead attempt's.
        verdict = 'superseded';
    }
    if (verdict === null) return null;
    if (nowMs - group.createdAtMs < graceMs) return null;
    return verdict;
}

/**
 * Asks the board about every id, in LEASE_BATCH_MAX-sized chunks. Null — ANY chunk refused —
 * aborts the whole round: absence must be proven for every id before anything is condemned.
 */
const lookupAll = async (
    board: Pick<Board, 'leases'>,
    ids: readonly string[],
    log: (message: string) => void
): Promise<Map<string, BoardLease> | null> => {
    const leases = new Map<string, BoardLease>();
    for (let i = 0; i < ids.length; i += LEASE_BATCH_MAX) {
        const answer = await board.leases(ids.slice(i, i + LEASE_BATCH_MAX));
        if (answer === null) {
            log('reaper: the board could not answer a lease lookup — reaping nothing this round');
            return null;
        }
        for (const row of answer) leases.set(row.id, row);
    }
    return leases;
};

/** Decides one group and reaps it, logging a line per object actually removed. */
const reapOne = async (
    arm: ReaperArm,
    group: OrphanGroup,
    ctx: { lease: BoardLease | undefined; graceMs: number; nowMs: number; log: (message: string) => void }
): Promise<void> => {
    const verdict = reapDecision(ctx.lease, group, ctx.nowMs, ctx.graceMs);
    if (verdict === null) return;
    for (const removed of await arm.reap(group, verdict)) {
        ctx.log(`reaper: job ${group.jobId} lease ${group.leaseToken ?? 'none'} (${verdict}) — removed ${removed}`);
    }
};

/**
 * The sweep loop. One round: scan → ask the board in batches → decide → reap → log. Failures are
 * logged, never thrown: this runs out of a timer, and a refused delete is the next round's
 * problem.
 */
export function createReaper(deps: {
    board: Pick<Board, 'leases'>;
    arm: ReaperArm;
    intervalMs: number;
    graceMs: number;
    log?: (message: string) => void;
    now?: () => number;
}): {
    sweep(): Promise<void>;
    start(): void;
    stop(): void;
} {
    const log = deps.log ?? ((message: string) => console.log(`[driver] ${message}`));
    const now = deps.now ?? (() => Date.now());
    let sweeping = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const sweep = async (): Promise<void> => {
        if (sweeping) return;
        sweeping = true;
        try {
            const groups = await deps.arm.scan();
            // A labelled object whose factory.job is not a uuid can never be a board job — a
            // foreign object, another tool's pod, a manual leftover. Asking the board about it
            // would 400 the WHOLE batch and disable the reaper for as long as the object lives,
            // so it is skipped at the source instead.
            const reapable: OrphanGroup[] = [];
            for (const group of groups) {
                if (UUID_SHAPE.test(group.jobId)) reapable.push(group);
                else log(`reaper: skipping a group whose factory.job label is not a uuid: ${group.jobId}`);
            }
            const ids = [...new Set(reapable.map((group) => group.jobId))];
            const leases = await lookupAll(deps.board, ids, log);
            if (leases === null) return;
            for (const group of reapable) {
                await reapOne(deps.arm, group, {
                    lease: leases.get(group.jobId),
                    graceMs: deps.graceMs,
                    nowMs: now(),
                    log,
                });
            }
        } catch (e) {
            log(`reaper: sweep failed, the next round retries: ${(e as Error).message}`);
        } finally {
            sweeping = false;
        }
    };

    return {
        sweep,
        start() {
            if (deps.intervalMs <= 0 || timer !== null) return;
            void sweep();
            timer = setInterval(() => {
                void sweep();
            }, deps.intervalMs);
            timer.unref();
        },
        stop() {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        },
    };
}
