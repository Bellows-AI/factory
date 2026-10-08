import type { PublishResult } from './publish.js';

/**
 * The control endpoint's draft-publication route (`POST /publish`), one per control token — so one
 * lease. The agent calls it mid-run to push its branch and open (or update) a DRAFT pull request;
 * the loop (`loop-publish.ts`) decides whether this attempt may publish and runs the same
 * `publishCheckout` the end-of-run publish does, which reuses the branch's PR instead of opening
 * another. The request carries no field: what is published is the attempt's own checkout.
 */

/** A `POST /publish` body names nothing, so one past this is an attack. */
export const PUBLISH_BODY_LIMIT = 1024;

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_NOT_IMPLEMENTED = 501;
const HTTP_BAD_GATEWAY = 502;

/**
 * What the loop answers the route with: the publish itself, or why this attempt may not:
 * `forbidden` (the board reserves publication for another step, `job.publish === false`),
 * `unsupported` (a runner that cannot push) or `gone` (the lease is lost, a Stop landed or the run ended).
 */
export type PublishVerdict = PublishResult | 'forbidden' | 'unsupported' | 'gone';

export interface PublishRelay {
    publish(): Promise<PublishVerdict>;
}

export interface PublishAnswer {
    status: number;
    body: unknown;
}

const BUSY: PublishAnswer = { status: HTTP_CONFLICT, body: { error: 'a publish is already running' } };

/** The wire answer of a publish verdict: what landed, or the reason it did not. */
export function publishAnswer(verdict: PublishVerdict): PublishAnswer {
    if (verdict === 'forbidden') {
        return { status: HTTP_FORBIDDEN, body: { error: 'this task publishes at its own step, not on request' } };
    }
    if (verdict === 'unsupported') {
        return { status: HTTP_NOT_IMPLEMENTED, body: { error: 'this executor cannot publish' } };
    }
    if (verdict === 'gone') return { status: HTTP_UNAUTHORIZED, body: { error: 'unknown token' } };
    if (!verdict.ok) return { status: HTTP_BAD_GATEWAY, body: { error: verdict.reason } };
    return {
        status: HTTP_OK,
        body: {
            published: verdict.published,
            branch: verdict.branch,
            prUrl: verdict.prUrl,
            prNumber: verdict.prNumber,
            reason: verdict.reason,
        },
    };
}

/** The per-token state: whether a publish is in flight (a second caller is told, never queued). */
export interface PublishSlot {
    running: boolean;
}

/** `POST /publish` once the token is known: one at a time per token, through the loop's relay. */
export async function servePublish(slot: PublishSlot, relay: PublishRelay | null): Promise<PublishAnswer> {
    if (!relay) return publishAnswer('unsupported');
    if (slot.running) return BUSY;
    slot.running = true;
    try {
        return publishAnswer(await relay.publish());
    } finally {
        slot.running = false;
    }
}
