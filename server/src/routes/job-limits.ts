import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply } from 'fastify';
import type { JobStatus, RuntimeVitals, ServiceStatus } from '../db/job-store-types.js';
import { bad, badSegment } from './helpers.js';

/**
 * Size limits, HTTP status constants and the small shared response shapes every job route in
 * `jobs.ts` and its sibling validators build on. Split out purely to keep each file under the
 * repo's line-count ceiling — see docs/jobs.md for the invariants these numbers encode.
 */

export const BYTES_PER_KIB = 1024;

/**
 * A command is a shell line, not a payload. 16 KiB is far past anything a human writes, and past
 * anything a generated one should be; the body limit is a little above it so an oversized command
 * is refused with a reason rather than a bare connection error.
 */
export const COMMAND_LIMIT = 16_384;
const BODY_LIMIT_KIB = 128;
export const BODY_LIMIT = BODY_LIMIT_KIB * BYTES_PER_KIB;

/**
 * The repo and executor labels a task may carry. The repo label is display metadata for the tasks
 * chat — the chat groups by repository. The executor label is consumed at claim time: the claim
 * reads the AUTHOR's executor row of that name, uses its type to select the runner, and carries
 * the pasted config under that runner's config env name (docs/env.md). Both labels are validated
 * by shape only, under the same path-segment rules a
 * checkout's directory name obeys, never against the member's configured rows: `job` is an audit
 * record, and the rows it would be validated against come and go with a PUT. A label that matches
 * no current row remains unresolved on the claim and is failed explicitly by the driver. A length cap would dead-end an executor name
 * the selection route accepted, so neither field has one here either — the body limit bounds them
 * the way it bounds the command. The repo rule is `repoReason` in `helpers.ts`. See docs/jobs.md.
 */
export function executorReason(value: string): string | null {
    return badSegment('executor', value);
}

/**
 * The publication a run reports (036): the PR identity a successful publish landed. The URL is
 * validated to the one spelling the driver mints — it is not data, it is a protocol. Branch names
 * are git refs truncated to the shape a ref can take, bounded far below scanner depth.
 */
export const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/;
export const BRANCH_LIMIT = 255;
/** Past any legal PR url — a value this long is a protocol violation, not a long link. */
export const PR_URL_LIMIT = 2048;

/**
 * Output is truncated here, not trusted from the worker. The body limit lets 128 KiB through and a
 * job's tail is for debugging, not archival — the OTLP pipeline is where logs belong.
 */
const OUTPUT_LIMIT_KIB = 64;
export const OUTPUT_LIMIT = OUTPUT_LIMIT_KIB * BYTES_PER_KIB;

/**
 * The runtime vitals a worker may report beside the tail. Numbers are bounded past anything a
 * real container reaches (a busy multi-core container exceeds 100% CPU; ten petabytes of RAM does
 * not exist), the activity line is capped because it is one CLI line and not a log, and the
 * timestamp must parse — the UI reads its staleness off it. The numbers may be null: "not read
 * this round" is honest data beside a service fleet that was read (a cluster with no
 * metrics-server reports exactly that). The attempt's `.bellows.yaml` services ride the same
 * object under the same grammar the driver's own parser enforces — copied, not imported.
 */
const CPU_PERCENT_MAX = 10_000;
const MEM_MB_MAX = 10_000_000;
const MEM_PERCENT_MAX = 100;
const RUNTIME_ACTIVITY_LIMIT = 512;
/** `sampledAt` rides back as a timestamp string; this is a defensive truncation, not a format. */
const SAMPLED_AT_LIMIT = 64;

/** The context stats a verdict may carry: a token count no real window reaches, a cost no run hits. */
export const CONTEXT_TOKENS_MAX = 100_000_000;
export const CONTEXT_COST_MAX = 1_000_000;
/** `job.agent_turns` is an int4 column: the route is the boundary that keeps the verdict writable. */
export const AGENT_TURNS_MAX = 2_147_483_647;
/**
 * The close-time summary is one line of prose, not a log — the driver truncates to a line and
 * the route is the boundary past which a stream cannot enter the list payload.
 */
export const SUMMARY_LIMIT = 512;

/** The workspace's ten-service cap, and the name/state shapes the driver's parser enforces. */
const SERVICES_MAX = 10;
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
const SERVICE_STATE = /^[a-z][a-z-]{0,31}$/;
/** Past any legal registry path — an image that long must not bounce every flush of a live run. */
const SERVICE_IMAGE_LIMIT = 2048;
/** A gate is a short label, not a description; well past anything a checkout's yaml declares. */
export const GATE_NAME_LIMIT = 64;

function serviceStatus(raw: unknown, at: string): ServiceStatus | string {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `${at} must be an object`;
    const { name, image, state } = raw as Record<string, unknown>;
    if (typeof name !== 'string' || !SERVICE_NAME.test(name)) {
        return `${at}.name must be a lowercase DNS label`;
    }
    if (typeof image !== 'string' || !image.trim() || image.length > SERVICE_IMAGE_LIMIT) {
        return `${at}.image must be a non-empty string of at most ${SERVICE_IMAGE_LIMIT} characters`;
    }
    if (typeof state !== 'string' || !SERVICE_STATE.test(state)) {
        return `${at}.state must be a lowercase word`;
    }
    return { name, image, state };
}

function badCpuPercent(cpuPercent: unknown): boolean {
    return (
        cpuPercent !== null &&
        (typeof cpuPercent !== 'number' ||
            !Number.isFinite(cpuPercent) ||
            cpuPercent < 0 ||
            cpuPercent > CPU_PERCENT_MAX)
    );
}

function badMemUsedMb(memUsedMb: unknown): boolean {
    return (
        memUsedMb !== null &&
        (typeof memUsedMb !== 'number' || !Number.isFinite(memUsedMb) || memUsedMb < 0 || memUsedMb > MEM_MB_MAX)
    );
}

function badMemPercent(memPercent: unknown): boolean {
    return (
        memPercent !== undefined &&
        memPercent !== null &&
        (typeof memPercent !== 'number' ||
            !Number.isFinite(memPercent) ||
            memPercent < 0 ||
            memPercent > MEM_PERCENT_MAX)
    );
}

function badActivity(activity: unknown): boolean {
    return activity !== undefined && activity !== null && (typeof activity !== 'string' || !activity.trim());
}

function badSampledAt(sampledAt: unknown): boolean {
    return typeof sampledAt !== 'string' || !sampledAt.trim() || Number.isNaN(Date.parse(sampledAt));
}

/** The `runtime.services` fleet: validated item by item, an empty result meaning "no fleet". */
function parseServiceFleet(services: unknown): ServiceStatus[] | string | undefined {
    if (services === undefined) return undefined;
    if (!Array.isArray(services) || services.length > SERVICES_MAX) {
        return `runtime.services must be an array of at most ${SERVICES_MAX} items`;
    }
    const fleet: ServiceStatus[] = [];
    for (const [i, item] of services.entries()) {
        const one = serviceStatus(item, `runtime.services[${i}]`);
        if (typeof one === 'string') return one;
        fleet.push(one);
    }
    // An empty list is "no fleet", the shape the driver actually reports: no key at all.
    return fleet.length === 0 ? undefined : fleet;
}

/** Returns the validated value, null for "no sample this round", or the reason the object is bad. */
export function runtimeVitals(raw: unknown): RuntimeVitals | null | string {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) return 'runtime must be an object';
    const fields = raw as Record<string, unknown>;
    const { cpuPercent, memUsedMb, memPercent, activity, sampledAt, services } = fields;
    if (badCpuPercent(cpuPercent)) return `runtime.cpuPercent must be a number 0..${CPU_PERCENT_MAX} or null`;
    if (badMemUsedMb(memUsedMb)) return `runtime.memUsedMb must be a number 0..${MEM_MB_MAX} or null`;
    if (badMemPercent(memPercent)) return `runtime.memPercent must be a number 0..${MEM_PERCENT_MAX} or null`;
    if (badActivity(activity)) return 'runtime.activity must be a non-empty string or null';
    if (badSampledAt(sampledAt)) return 'runtime.sampledAt must be a parseable timestamp';
    const fleet = parseServiceFleet(services);
    if (typeof fleet === 'string') return fleet;
    return {
        cpuPercent: cpuPercent as number | null,
        memUsedMb: memUsedMb as number | null,
        memPercent: (memPercent as number | null | undefined) ?? null,
        activity: typeof activity === 'string' ? activity.trim().slice(0, RUNTIME_ACTIVITY_LIMIT) : null,
        sampledAt: (sampledAt as string).slice(0, SAMPLED_AT_LIMIT),
        ...(fleet ? { services: fleet } : {}),
    };
}

export const LEASE_SECONDS_DEFAULT = 300;
export const LEASE_SECONDS_MAX = 3600;

export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 200;

/** Far past the `cse_` tokens seen in practice, and short enough that it cannot be an essay. */
export const REMOTE_SESSION_LIMIT = 256;

/**
 * What an agent session id may look like. Not pinned to a uuid: claude-code's are, but opencode
 * mints its own (`ses_…`), and the board's job is to RECORD the session the run used, not to
 * second-guess a foreign CLI's id format. Still an opaque-token check, not free-form: the value
 * rides back to the driver on a follow-up claim and becomes runner argv there.
 */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export const STATUSES: readonly JobStatus[] = [
    'queued',
    'running',
    'standby',
    'succeeded',
    'failed',
    'dead',
    'stopped',
];

export function leaseSeconds(raw: unknown): number | null {
    if (raw === undefined || raw === null) return LEASE_SECONDS_DEFAULT;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > LEASE_SECONDS_MAX) return null;
    return raw;
}

/** A worker's own name, reported on every claim so a stray container can be identified and killed. */
export const WORKER_NAME_LIMIT = 128;

/** The body limit shared by every worker/person control route below — no payload, just ids and a token. */
export const CONTROL_BODY_LIMIT = 4096;

export const HTTP_OK = 200;
export const HTTP_CREATED = 201;
export const HTTP_ACCEPTED = 202;
export const HTTP_NO_CONTENT = 204;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
export const HTTP_UNAVAILABLE = 503;

const NO_BOARD_MESSAGE = 'No job board for this organization';

export function noBoard(reply: FastifyReply) {
    return bad(reply, ERROR_CODES.JOBS_UNAVAILABLE, NO_BOARD_MESSAGE, HTTP_UNAVAILABLE);
}

/** The lease-guarded routes all answer the same two refusals; named once instead of a dozen times. */
export function notFoundJob(reply: FastifyReply) {
    return reply.code(HTTP_NOT_FOUND).send({ error: 'No such job', code: ERROR_CODES.NOT_FOUND });
}

export function leaseLost(reply: FastifyReply) {
    return reply.code(HTTP_CONFLICT).send({ error: 'Lease lost', code: ERROR_CODES.LEASE_LOST });
}
