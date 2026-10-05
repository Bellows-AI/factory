import { SERVICE_LABEL } from './labels.js';
import { readFileSync } from 'node:fs';
import { Agent, request as httpsRequest } from 'node:https';
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
export const HTTP_BAD_REQUEST = 400;
export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
export const HTTP_TOO_MANY_REQUESTS = 429;
export const HTTP_SERVER_ERROR_STATUS = 500;

/** How much of a failed response body rides an error message — a preview, not the whole payload. */
export const ERROR_PREVIEW_CHARS = 200;

/** How much of a failed response body rides the diagnosis log line — the cause needs more than a preview. */
export const DIAGNOSIS_BODY_CHARS = 500;

/**
 * Whether a 400 is the API server's own pre-handler malformed-request answer — Go's `net/http`
 * writes a bare `400 Bad Request` (optionally `: <explanation>`) before any kubernetes handler
 * runs, so it names the request bytes or the connection, never the API (issue #308: observed on
 * both GETs and POSTs, with nothing in the apiserver logs). A genuine API refusal is a JSON
 * `Status` object — `reason: BadRequest`/`Invalid` — and never matches. Deliberately narrow:
 * widening it to "any non-JSON 400" would retry permanent kubelet refusals (the log endpoint's
 * `container has not started`) for the poll's full patience; widen only with a logged body as
 * evidence.
 */
export const isMalformedRequest400 = (status: number, body: string): boolean =>
    status === HTTP_BAD_REQUEST && body.trim().startsWith('400 Bad Request');

/** The one spelling of "<status> with the API's own reason" every `answered` message composes. */
export const answerPreview = (status: number, body: string): string =>
    `answered ${status}: ${body.slice(0, ERROR_PREVIEW_CHARS)}`;

/** The shell convention for a killed process — the docker manager's timeout shape, matched here. */
export const TIMEOUT_EXIT_CODE = 124;

export interface K8sClaim {
    metadata?: { uid?: string; creationTimestamp?: string };
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

/**
 * The one reading of "did the API server refuse this?" — the message every k8s call site used to
 * spell out by hand, in one place. `null` is success; a string is the refusal, `what` naming the
 * operation ("creating the runner job") and the body preview carrying the apiserver's own reason.
 *
 * It answers a STRING rather than throwing because the channel is the caller's: the fence throws,
 * the publish answers `publishFailed(...)`, a helper answers `{ ok: false, reason: 'runner_error' }`
 * and a gate throws a CONTAINER_GONE-coded harness error. One message shape, five channels — the
 * previous 24 hand-rolled copies could drift on the shape, and the handful of sites that tolerate
 * a status (a gate secret's 409 means an earlier acquire of this same attempt already created it,
 * same name, same values; a fence delete's 404/409 means the object is already going) name it in
 * `tolerate` rather than each writing its own `&& status !== …` chain before the message.
 */
export const refusal = (res: K8sResponse, what: string, ...tolerate: number[]): string | null =>
    res.status < HTTP_ERROR_STATUS || tolerate.includes(res.status)
        ? null
        : `${what} ${answerPreview(res.status, res.body)}`;

/** `refusal` for the majority of call sites, whose channel is a thrown Error. */
export function expectOk(res: K8sResponse, what: string): void {
    const message = refusal(res, what);
    if (message) throw new Error(message);
}

/**
 * A POST's refusal, under the same transient-400 rule `readVerdict` applies to a GET (issue #308):
 * the API server's pre-handler plain-text `400 Bad Request` is connection damage, never this
 * Job's verdict — it THROWS, and the caller's catch arm leaves the job to its lease. A genuine
 * JSON `Status` refusal answers the message, as before. `null` is success.
 */
export function postRefusal(res: K8sResponse, what: string, ...tolerate: number[]): string | null {
    const message = refusal(res, what, ...tolerate);
    if (message && isMalformedRequest400(res.status, res.body)) throw new Error(message);
    return message;
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
    /** Injected by the tests; the real transport owns one dedicated agent, never the global one. */
    agent?: Agent;
    log?: (message: string) => void;
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
    const log = deps.log ?? ((message: string) => console.log(`[driver] ${message}`));
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
    // One dedicated agent with keep-alive OFF (issue #308): Node's global agent keeps sockets
    // alive, and a request written onto a connection the apiserver has just idle-closed is
    // answered — before any kubernetes handler runs — with the plain-text `400 Bad Request` the
    // driver saw seven times in twelve hours. A fresh connection per request costs a TLS
    // handshake per poll tick and buys the elimination of the reuse race by construction.
    const agent = deps.agent ?? new Agent({ keepAlive: false });

    return (method, path, body) =>
        new Promise<K8sResponse>((resolve, reject) => {
            const req = request(
                {
                    host,
                    port: Number(port),
                    method,
                    path,
                    ca,
                    agent,
                    timeout: REQUEST_TIMEOUT_MS,
                    headers: {
                        // Read per call: a rotated ServiceAccount token must not be remembered.
                        authorization: `Bearer ${readFile(`${serviceAccountDir}/token`, 'utf8').trim()}`,
                        [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE,
                    },
                },
                (res) => {
                    let text = '';
                    // The classification prefix, kept separately: once the sliding tail below has
                    // dropped the start of the stream, the `400 Bad Request` line readVerdict and
                    // postRefusal classify on (issue #308) would be gone from the diagnosis log
                    // and the resolved body alike. Bounded at the diagnosis length.
                    let prefix = '';
                    let truncated = false;
                    res.setEncoding('utf8');
                    res.on('data', (chunk: string) => {
                        if (prefix.length < DIAGNOSIS_BODY_CHARS) {
                            prefix = (prefix + chunk).slice(0, DIAGNOSIS_BODY_CHARS);
                        }
                        text += chunk;
                        // Only the tail survives OUTPUT_LIMIT downstream, so buffering a
                        // multi-megabyte single log line whole would be exactly the unbounded
                        // string the docker runner's cap exists to avoid. Keep a sliding tail.
                        if (text.length > STREAM_BUFFER_LIMIT) {
                            text = text.slice(-STREAM_BUFFER_TAIL);
                            truncated = true;
                        }
                    });
                    res.on('end', () => {
                        // A truncated answer carries the prefix ahead of the tail so the original
                        // start survives classification; an untruncated one is already whole.
                        const body = truncated ? prefix + text : text;
                        if ((res.statusCode ?? 0) >= HTTP_ERROR_STATUS) {
                            // The diagnosis line (issue #308): a refused answer carries everything
                            // the cause needs — method, path, status, headers and the first chunk
                            // of body — because the body IS the diagnosis: Go's pre-handler
                            // `400 Bad Request`, a proxy's answer, or the API's own Status JSON.
                            // Fired at the transport's own ≥300 refusal threshold, so a 3xx is
                            // diagnosed too.
                            log(
                                `${method} ${path} answered ${res.statusCode} ` +
                                    `headers=${JSON.stringify(res.headers ?? {})} ` +
                                    `body=${prefix}`
                            );
                        }
                        resolve({ status: res.statusCode ?? 0, body });
                    });
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
        phase?: string;
        /** The pod-level ending — `Evicted` and its message — when no container recorded one. */
        reason?: string;
        message?: string;
        containerStatuses?: {
            state?: {
                terminated?: { exitCode?: number; reason?: string; message?: string };
                running?: { startedAt?: string };
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
 * The items-level form is what callers that already hold the parsed list use, so the
 * terminating-skip rule has exactly one home.
 */
export function livePodOfItems(items: K8sPod[]): K8sPod | undefined {
    return items.find((item) => !item.metadata?.deletionTimestamp);
}

export function livePod(body: string): K8sPod | undefined {
    return livePodOfItems(parse<K8sPodList>(body).items ?? []);
}

/**
 * Why a pod's container ended without success, in the kubelet's own words — `StartError: exec:
 * "node": executable file not found` — or null when it exited 0 or has no state to read. The k8s
 * twin of the docker runner's `dockerErrorDetail`: a container that never started prints no
 * verdict line, and its status is the only place the cause survives.
 */
export function containerFailure(pod: K8sPod | undefined): string | null {
    const state = pod?.status?.containerStatuses?.[0]?.state;
    const terminated = state?.terminated;
    if (terminated && terminated.exitCode !== 0) {
        const reason = terminated.reason ?? `exit ${terminated.exitCode ?? 'unknown'}`;
        return terminated.message ? `${reason}: ${terminated.message}` : reason;
    }
    const waiting = state?.waiting;
    if (waiting?.reason) return waiting.message ? `${waiting.reason}: ${waiting.message}` : waiting.reason;
    return null;
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
    return servicePodRows(body).map(({ status }) => status);
}

/** One service pod of the lease-scoped list, read once for both the panel and the dead probe. */
interface ServicePodRow {
    status: ServiceStatus;
    pod: K8sPod;
}

function servicePodRows(body: string): ServicePodRow[] {
    let list: {
        items?: (K8sPod & {
            metadata?: { labels?: Record<string, string> };
            spec?: { containers?: { image?: string }[] };
        })[];
    };
    try {
        list = JSON.parse(body) as typeof list;
    } catch {
        return [];
    }
    const out: ServicePodRow[] = [];
    for (const item of list.items ?? []) {
        const name = item.metadata?.labels?.[SERVICE_LABEL];
        const image = item.spec?.containers?.[0]?.image;
        if (!name || !image) continue;
        out.push({ status: { name, image, state: (item.status?.phase ?? 'unknown').toLowerCase() }, pod: item });
    }
    return out.sort((a, b) => (a.status.name < b.status.name ? -1 : a.status.name > b.status.name ? 1 : 0));
}

/** Waiting reasons a Pending service pod never recovers from: docker fails these `run -d`s as infrastructure. */
const STUCK_WAITING_REASONS: ReadonlySet<string> = new Set([
    'ImagePullBackOff',
    'ErrImagePull',
    'InvalidImageName',
    'CreateContainerConfigError',
]);

const isGoneForGood = (phase: string, waitingReason: string | undefined): boolean =>
    phase === 'failed' ||
    phase === 'succeeded' ||
    (phase === 'pending' && STUCK_WAITING_REASONS.has(waitingReason ?? ''));

/** A dead service pod: its status, the pod to read the log of, and the kubelet's termination. */
export interface DeadServicePod extends ServiceStatus {
    pod: string;
    exitCode: number | null;
    reason: string | null;
}

/**
 * The service pods that are no longer running (issue #423). A service pod runs under
 * `restartPolicy: Never`, so `failed` and `succeeded` are both a service gone for good; the exit
 * and reason come off the first container's `terminated` state — the pod's own reason when
 * it has none, as an eviction leaves it — null when nothing recorded one. Pure and exported for the pinning, like `parseServicePods`.
 */
export function parseDeadServicePods(body: string): DeadServicePod[] {
    const out: DeadServicePod[] = [];
    for (const { status, pod } of servicePodRows(body)) {
        const name = pod.metadata?.name;
        const state = pod.status?.containerStatuses?.[0]?.state;
        if (!name || !isGoneForGood(status.state, state?.waiting?.reason)) continue;
        const ending = state?.terminated ?? state?.waiting;
        const reason = ending?.reason ?? pod.status?.reason ?? null;
        const message = ending?.message ?? pod.status?.message ?? null;
        out.push({
            pod: name,
            ...status,
            exitCode: state?.terminated?.exitCode ?? null,
            reason: reason && message ? `${reason}: ${message}` : (reason ?? message),
        });
    }
    return out;
}
