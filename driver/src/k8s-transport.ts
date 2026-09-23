import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { DriverConfig } from './config.js';
import { OUTPUT_LIMIT } from './runner.js';
import type { ServiceStatus } from './board.js';
import type { RuntimeSample } from './runner.js';
import { UUID } from './publish.js';
import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE } from './http.js';

/**
 * The kubernetes executor's shared low-level vocabulary: the wire types (`K8sResponse`,
 * `K8sJobStatus`, `K8sPodList`, `K8sClaim`), the real transport (`inClusterRequest`), and the
 * protocol constants and status thresholds every other `k8s-*.ts` file reads by import — the
 * transport is injected, the way `createBoard` takes `fetch`, so nothing here needs a cluster to
 * test. See docs/kubernetes.md for the full module map.
 */

/** A uuid, and nothing else — asserted before an id is interpolated into an API path or a pod name. */
export const JOB_ID = UUID;

/** Finished Job objects are reaped after an hour: the log is on the board, the pod is not worth keeping. */
export const TTL_SECONDS = 3_600;

/** `activeDeadlineSeconds` is whole seconds; the config it derives from is milliseconds. */
export const MS_PER_SECOND = 1_000;

/** How often the finished/failed status of the Job is polled. */
export const POLL_MS = 2_000;

/**
 * Consecutive failed reads before the run is abandoned to its lease. About half a minute when the
 * API server answers fast, up to about eight minutes when every attempt hangs out its request
 * timeout — enough to ride out an upgrade or a dropped connection, short enough that a half-dead
 * API server hands the job back to its lease instead of holding a worker slot for an hour. The
 * kubelet's deadline guarantees the JOB reaches a terminal state, but not that this driver can keep
 * READING it; an apiserver that answers 503 forever would otherwise renew a lease around a run
 * nobody can observe.
 */
export const POLL_MAX_CONSECUTIVE_FAILURES = 15;

/**
 * How long create() will wait for the fence's label sweep to actually empty the selector —
 * about five minutes at POLL_MS, the same patience the status poll has. A list that answers
 * nothing is what frees the checkout for the replacement; exceeding the bound is a throw, which
 * leaves the job to its lease — burning an attempt is the alternative to two writers on one
 * checkout.
 */
export const REPLACE_MAX_POLLS = 150;

/**
 * One API-server request, in milliseconds. The docker runner's child process answers the same
 * guarantee by exiting or not; a socket that never answers would otherwise wedge run() forever,
 * and the lease would be renewed around a run nobody can see.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** The tail of the runner's output the board is told about — bounded in lines and, below, in bytes. */
export const LOG_TAIL_LINES = 1_000;

/**
 * The k8s API server's status thresholds, named once for every read below: `< HTTP_ERROR_STATUS`
 * is success, `>= HTTP_OK_STATUS && < HTTP_ERROR_STATUS` is the 2xx range, and the rest name the
 * specific codes this driver branches on.
 */
export const HTTP_OK_STATUS = 200;
export const HTTP_ERROR_STATUS = 300;
export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
export const HTTP_TOO_MANY_REQUESTS = 429;
export const HTTP_SERVER_ERROR_STATUS = 500;

/** How much of a failed response body rides an error message — a preview, not the whole payload. */
export const ERROR_PREVIEW_CHARS = 200;

/** The shell convention for a killed process — the docker manager's timeout shape, matched here. */
export const TIMEOUT_EXIT_CODE = 124;

export interface K8sClaim {
    metadata?: { uid?: string };
    data?: { holder?: string; attempt?: string };
}

/**
 * Bounded rounds for the acquire loop: POST 409 → read the holder → the holder vanished or was
 * an older attempt we released → POST again. Takeover is strictly forward-only (a claim whose
 * attempt is ahead makes us stand down, never wait), so more than a couple of rounds is an
 * apiserver flapping; the bound turns that into a thrown error and the job goes back to its
 * lease instead of two writers racing one checkout.
 */
export const CLAIM_ROUNDS = 15;

/**
 * One call against the API server. The body is the raw response text rather than a parsed object:
 * the log endpoint answers plain text, and parsing is the caller's problem — which keeps the
 * injected fake a router over (method, path) and nothing more.
 */
export interface K8sResponse {
    status: number;
    body: string;
}

export type K8sMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type K8sRequest = (method: K8sMethod, path: string, body?: unknown) => Promise<K8sResponse>;

/**
 * Every k8s-executor function's transport bundle, in one parameter — the same `RunnerDeps`
 * technique `docker-runner.ts` uses, and for the same reason: `lint/complexity/useMaxParams`
 * caps a function at four, and almost every function here needs the transport, the sleep hook
 * and the namespace together.
 */
export interface K8sDeps {
    request: K8sRequest;
    sleep: (ms: number) => Promise<void>;
    config: DriverConfig;
}

/** The ServiceAccount volume every pod gets, holding the token and the cluster CA. */
const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/** The sliding buffer a streamed response is kept within — a multiple of OUTPUT_LIMIT, not the limit itself. */
const STREAM_BUFFER_OVERFLOW_MULTIPLE = 4;
const STREAM_BUFFER_TAIL_MULTIPLE = 2;
const STREAM_BUFFER_LIMIT = STREAM_BUFFER_OVERFLOW_MULTIPLE * OUTPUT_LIMIT;
const STREAM_BUFFER_TAIL = STREAM_BUFFER_TAIL_MULTIPLE * OUTPUT_LIMIT;

interface InClusterRequestDeps {
    env?: NodeJS.ProcessEnv;
    readFile?: typeof readFileSync;
    request?: typeof httpsRequest;
    serviceAccountDir?: string;
}

/**
 * The real transport: the API server the pod's own environment points at. Built only for a driver
 * running IN a cluster; everything that can fail is made to fail at construction rather than on the
 * first claim — `KUBERNETES_SERVICE_HOST` missing, or a ServiceAccount volume not mounted, are
 * startup errors, not mid-run surprises.
 */
export function inClusterRequest(deps: InClusterRequestDeps = {}): K8sRequest {
    const env = deps.env ?? process.env;
    const readFile = deps.readFile ?? readFileSync;
    const request = deps.request ?? httpsRequest;
    const serviceAccountDir = deps.serviceAccountDir ?? SERVICE_ACCOUNT_DIR;
    const host = env.KUBERNETES_SERVICE_HOST;
    const port = env.KUBERNETES_SERVICE_PORT ?? '443';
    if (!host) {
        throw new Error(
            'KUBERNETES_SERVICE_HOST is not set: this driver is not running in a cluster. ' +
                'EXECUTOR=kubernetes needs an in-cluster driver — run it in the cluster it serves.'
        );
    }
    // Read once: the CA does not rotate, and reading it here is what makes a pod without its
    // projected ServiceAccount volume fail at startup instead of on every claim.
    const ca = readFile(`${serviceAccountDir}/ca.crt`, 'utf8');

    return (method, path, body) =>
        new Promise<K8sResponse>((resolve, reject) => {
            const req = request(
                {
                    host,
                    port: Number(port),
                    method,
                    path,
                    ca,
                    timeout: REQUEST_TIMEOUT_MS,
                    headers: {
                        // Read per call: a rotated ServiceAccount token must not be remembered.
                        authorization: `Bearer ${readFile(`${serviceAccountDir}/token`, 'utf8').trim()}`,
                        [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE,
                    },
                },
                (res) => {
                    let text = '';
                    res.setEncoding('utf8');
                    res.on('data', (chunk: string) => {
                        text += chunk;
                        // Only the tail survives OUTPUT_LIMIT downstream, so buffering a
                        // multi-megabyte single log line whole would be exactly the unbounded
                        // string the docker runner's cap exists to avoid. Keep a sliding tail.
                        if (text.length > STREAM_BUFFER_LIMIT) text = text.slice(-STREAM_BUFFER_TAIL);
                    });
                    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
                }
            );
            // A half-open connection would otherwise hold the run forever — and the loop would
            // renew the lease around a runner nobody can observe or finish.
            req.on('timeout', () => {
                req.destroy(new Error(`the API server did not answer within ${REQUEST_TIMEOUT_MS}ms`));
            });
            req.on('error', reject);
            if (body !== undefined) req.write(JSON.stringify(body));
            req.end();
        });
}

/** The default `sleep` every k8s-executor factory takes, so the poll loops can be tested without it. */
export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface K8sJobStatus {
    succeeded?: number;
    failed?: number;
    conditions?: { type: string; reason?: string }[];
}

export interface K8sPod {
    metadata?: { name?: string; deletionTimestamp?: string };
    status?: {
        containerStatuses?: {
            state?: {
                terminated?: { exitCode?: number };
                waiting?: { reason?: string; message?: string };
            };
        }[];
    };
}

export interface K8sPodList {
    items?: K8sPod[];
}

/**
 * The one pod a job-name-scoped list names, skipping any mid-deletion — a re-claim's replaced
 * attempt can still list its predecessor's pod while it terminates, carrying the same label.
 */
export function livePod(body: string): K8sPod | undefined {
    return parse<K8sPodList>(body).items?.find((item) => !item.metadata?.deletionTimestamp);
}

/** Parses what the API server answers; a body that is not JSON reads as an empty object. */
export function parse<T>(body: string): T {
    try {
        return JSON.parse(body) as T;
    } catch {
        return {} as T;
    }
}

/*
 * The runner vitals under kubernetes. `docker stats` has no direct twin here; the metrics API
 * (`metrics.k8s.io`, served by the metrics-server a cluster may not run) is the closest one, and
 * its absence is not an error: the interface blesses null as "no fresh sample", so a cluster
 * without a metrics-server renders no vitals rather than a wrong number — the same answer any
 * failed docker read gets.
 */

/** CPU quantities as the metrics API prints them: nanos, micros, millis, or whole cores. */
const CPU_QUANTITY = /^([0-9]*\.?[0-9]+)(n|u|m)?$/;

/** Sub-milli CPU quantity suffixes, to millicores. */
const NANOS_PER_MILLI = 1e6;
const MICROS_PER_MILLI = 1e3;
const MILLICORES_PER_CORE = 1_000;

/** Millicores — the unit `cpuPercent` is a tenth of (1000m = one core = 100%). */
const cpuMillicores = (value: string): number | null => {
    const match = CPU_QUANTITY.exec(value.trim());
    if (!match) return null;
    const n = Number.parseFloat(match[1]!);
    if (!Number.isFinite(n)) return null;
    if (match[2] === 'n') return n / NANOS_PER_MILLI;
    if (match[2] === 'u') return n / MICROS_PER_MILLI;
    if (match[2] === 'm') return n;
    return n * MILLICORES_PER_CORE;
};

/** The binary and decimal SI prefixes metrics-server's memory quantities carry, to MiB. */
const BYTES_PER_MIB = 1_048_576;
const KIB_PER_MIB = 1_024;
const KILO = 1e3;
const MEGA = 1e6;
const GIGA = 1e9;
const TERA = 1e12;
const PETA = 1e15;
const EXA = 1e18;

/** Memory quantities to MiB: the binary suffixes metrics-server emits, plus plain bytes. */
const MEM_TO_MIB: Record<string, number> = {
    '': 1 / BYTES_PER_MIB,
    ki: 1 / KIB_PER_MIB,
    mi: 1,
    gi: KIB_PER_MIB,
    ti: KIB_PER_MIB * KIB_PER_MIB,
    pi: KIB_PER_MIB * KIB_PER_MIB * KIB_PER_MIB,
    ei: KIB_PER_MIB * KIB_PER_MIB * KIB_PER_MIB * KIB_PER_MIB,
    k: KILO / BYTES_PER_MIB,
    m: MEGA / BYTES_PER_MIB,
    g: GIGA / BYTES_PER_MIB,
    t: TERA / BYTES_PER_MIB,
    p: PETA / BYTES_PER_MIB,
    e: EXA / BYTES_PER_MIB,
};

const memMbOfQuantity = (value: string): number | null => {
    const match = /^([0-9]*\.?[0-9]+)\s*([A-Za-z]*)$/.exec(value.trim());
    if (!match) return null;
    const factor = MEM_TO_MIB[match[2]!.toLowerCase()];
    if (factor === undefined) return null;
    return Number.parseFloat(match[1]!) * factor;
};

/**
 * Pulls the vitals out of one PodMetrics object — the first container is the runner, the only
 * container the pod has. Pure and exported for the pinning, like `parseDockerStats`: null for
 * anything it cannot read, because a missed sample costs freshness, never the run.
 * `memPercent` is null by construction — the runner pod declares no memory limit, so there is
 * no denominator to divide by, and a percentage against the node's whole memory would not be
 * the number the docker dashboard renders either.
 */
export function parsePodMetrics(body: string): Omit<RuntimeSample, 'sampledAt'> | null {
    let metrics: { containers?: { usage?: { cpu?: unknown; memory?: unknown } }[] };
    try {
        metrics = JSON.parse(body) as { containers?: { usage?: { cpu?: unknown; memory?: unknown } }[] };
    } catch {
        return null;
    }
    const usage = metrics.containers?.[0]?.usage;
    const millicores = typeof usage?.cpu === 'string' ? cpuMillicores(usage.cpu) : null;
    const memUsedMb = typeof usage?.memory === 'string' ? memMbOfQuantity(usage.memory) : null;
    if (millicores === null || memUsedMb === null) return null;
    return { cpuPercent: millicores / 10, memUsedMb, memPercent: null };
}

/**
 * Pulls the attempt's service fleet out of the lease-scoped pod list — the same selector the
 * teardown tears down with, so the runner and gate pods never answer it. Pure and exported for
 * the pinning, like `parsePodMetrics`: the name is the `factory.service` label (the DNS name the
 * runner resolves), the image the pod's first container's, the state the pod phase lowercased —
 * `unknown` for a pod the API has not phased yet. Rows without a label or an image are skipped,
 * and garbage answers empty.
 */
export function parseServicePods(body: string): ServiceStatus[] {
    let list: {
        items?: {
            metadata?: { labels?: Record<string, string> };
            spec?: { containers?: { image?: string }[] };
            status?: { phase?: string };
        }[];
    };
    try {
        list = JSON.parse(body) as typeof list;
    } catch {
        return [];
    }
    const out: ServiceStatus[] = [];
    for (const item of list.items ?? []) {
        const name = item.metadata?.labels?.['factory.service'];
        const image = item.spec?.containers?.[0]?.image;
        if (!name || !image) continue;
        out.push({ name, image, state: (item.status?.phase ?? 'unknown').toLowerCase() });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
