import type { FastifyRequest } from 'fastify';
import { orgOf } from '../auth/plugin.js';
import type { JobStore } from '../db/job-store-read-model.js';
import type { OrgRegistry } from '../orgs.js';

/**
 * The job board a request lands on is its caller's org's (#99): the session, the personal
 * token or the worker secret's resolved org each names one, and the runtime resolved from
 * it carries that org's store. Absent in the route-test mode with no stores behind the
 * registry.
 */
export async function storeFor(orgs: OrgRegistry, request: FastifyRequest): Promise<JobStore | null> {
    const rt = await orgs.for(orgOf(request));
    return rt?.jobs ?? null;
}

/**
 * The boards a WORKER call may reach. The shared secret authenticates the driver, not an
 * org, so a claim names no row and no org: it is offered EVERY org's queue, first claim
 * wins and the empty orgs cost one idle poll each. Every other worker route arrives with
 * the org the auth hook read from the row its URL names, and is a one-element list.
 */
export async function boardsFor(orgs: OrgRegistry, request: FastifyRequest): Promise<JobStore[]> {
    if (request.auth?.kind === 'worker' && request.auth.orgId === null) {
        const boards: JobStore[] = [];
        for (const org of await orgs.list()) {
            const rt = await orgs.for(org.id);
            if (rt?.jobs) boards.push(rt.jobs);
        }
        return boards;
    }
    const store = await storeFor(orgs, request);
    return store ? [store] : [];
}

/** The workflow definitions the create may resolve against — the caller's org's (#99). */
export async function workflowsFor(orgs: OrgRegistry, request: FastifyRequest) {
    const rt = await orgs.for(orgOf(request));
    return rt?.workflows ?? null;
}

export type BoardScanner = <T>(
    boards: readonly JobStore[],
    log: (e: Error) => void,
    claimOf: (board: JobStore) => Promise<T | null>
) => Promise<T | null>;

async function scanBoards<T>(
    boards: readonly JobStore[],
    order: readonly number[],
    log: (e: Error) => void,
    claimOf: (board: JobStore) => Promise<T | null>
): Promise<T | null> {
    let failed: Error | null = null;
    for (const index of order) {
        const board = boards[index]!;
        try {
            const claimed = await claimOf(board);
            if (claimed !== null) return claimed;
        } catch (e) {
            failed = e as Error;
            log(failed);
        }
    }
    if (failed) throw failed;
    return null;
}

/**
 * The scan a worker poll walks across the org boards. The registry lists organizations in
 * a stable order, so the starting board rotates one position per poll — a fixed first
 * board would let one busy org fill every driver slot while later orgs starve. The job
 * and the reclaim scans each carry their OWN counter: the driver polls both queues
 * concurrently, and one shared counter would let every interleaved poll advance the
 * other's phase — with two orgs and one reclaim poll per job poll, every job claim would
 * start at the same org and starve the other. A board that throws costs itself the poll,
 * not the others: claim preparation can fail for one org alone (an installation-token
 * mint), and one unhealthy org must not block the rest. Every board failing is still a
 * broken board, not an idle one: the last error is rethrown, so the guard's 503 — the
 * driver's log-and-repoll signal — survives.
 */
export function boardScan(): BoardScanner {
    let turn = 0;
    return async <T>(
        boards: readonly JobStore[],
        log: (e: Error) => void,
        claimOf: (board: JobStore) => Promise<T | null>
    ): Promise<T | null> => {
        const start = turn++ % boards.length;
        const order = Array.from({ length: boards.length }, (_, i) => (start + i) % boards.length);
        return scanBoards(boards, order, log, claimOf);
    };
}
