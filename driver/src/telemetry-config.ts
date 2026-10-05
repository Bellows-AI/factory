/**
 * Each executor's telemetry config file, rendered by the driver (issue #452). The file decides
 * where telemetry goes and whether prompt and tool bodies ride along, so the agent (uid 1000) must
 * not own it — and the entrypoint runs as that same uid, so it cannot be the one to write the
 * endpoint in. The driver renders the file instead and delivers it root-owned and 0444 into a
 * root-owned directory: a `docker cp` archive on docker, a read-only Secret mount on kubernetes.
 *
 * - claude-code: managed settings, the one scope that outranks every settings file the agent
 *   can reach — a copy of docker/claude-executor/managed-settings.json.
 * - opencode: the opencode-otel plugin's config, found through OPENCODE_OTEL_CONFIG_PATH — a copy
 *   of docker/opencode-executor/otel.json.
 *
 * Deliberate copies (driver/ imports nothing from the rest of the repo);
 * `driver/test/telemetry-shipping.test.ts` pins each to its image's file.
 */
import { CLAUDE_CODE, OPENCODE, type ExecutorType } from './executors.js';

const READ_ONLY = 0o444;

export function claudeManagedSettings(endpoint: string): string {
    const settings = {
        $schema: 'https://json.schemastore.org/claude-code-settings.json',
        env: {
            CLAUDE_CODE_ENABLE_TELEMETRY: '1',
            OTEL_METRICS_EXPORTER: 'otlp',
            OTEL_LOGS_EXPORTER: 'otlp',
            OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
            OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
            OTEL_METRIC_EXPORT_INTERVAL: '10000',
            OTEL_METRICS_INCLUDE_ACCOUNT_UUID: 'false',
            OTEL_LOG_USER_PROMPTS: '0',
            OTEL_LOG_ASSISTANT_RESPONSES: '0',
            OTEL_LOG_TOOL_DETAILS: '0',
        },
    };
    return `${JSON.stringify(settings, null, 4)}\n`;
}

export function opencodeOtelConfig(endpoint: string): string {
    return `${JSON.stringify({ endpoint, protocol: 'http/json', metricsTemporality: 'delta' }, null, 4)}\n`;
}

/** Where an executor's CLI reads its telemetry config, and the rendered body. */
export interface TelemetryConfig {
    dir: string;
    file: string;
    body: string;
}

export function telemetryConfig(executorType: ExecutorType | null, endpoint: string): TelemetryConfig {
    if (executorType === CLAUDE_CODE) {
        return { dir: '/etc/claude-code', file: 'managed-settings.json', body: claudeManagedSettings(endpoint) };
    }
    if (executorType === OPENCODE) {
        return { dir: '/etc/opencode-otel', file: 'otel.json', body: opencodeOtelConfig(endpoint) };
    }
    throw new Error('the claimed task has no configured executor type');
}

// The ustar header layout: each field's byte offset, and the widths its numbers are written in.
const BLOCK = 512;
const OCTAL = 8;
const ID_WIDTH = 8;
const NUMBER_WIDTH = 12;
const CHECKSUM_DIGITS = 6;
const AT = { mode: 100, uid: 108, gid: 116, size: 124, mtime: 136, checksum: 148, type: 156 } as const;
const AT_MAGIC = 257;
const AT_UNAME = 265;
const AT_GNAME = 297;

/** A NUL-terminated octal field of `width` bytes, the ustar number encoding. */
const octal = (value: number, width: number): string => `${value.toString(OCTAL).padStart(width - 1, '0')}\0`;

/**
 * The config as a one-entry ustar archive for `docker cp -`. The archive, not a file path:
 * `docker cp` keeps a copied file's owner from its tar header, and a plain file path makes that
 * header the DRIVER's uid — uid 1000 itself when the driver runs as `node`. Here it is 0:0, mode
 * 0444, whoever runs the driver.
 */
export function telemetryConfigTar({ file, body: text }: TelemetryConfig): Buffer {
    const body = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(BLOCK);
    header.write(file, 0, 'ascii');
    header.write(octal(READ_ONLY, ID_WIDTH), AT.mode, 'ascii');
    header.write(octal(0, ID_WIDTH), AT.uid, 'ascii');
    header.write(octal(0, ID_WIDTH), AT.gid, 'ascii');
    header.write(octal(body.length, NUMBER_WIDTH), AT.size, 'ascii');
    header.write(octal(0, NUMBER_WIDTH), AT.mtime, 'ascii');
    header.write(' '.repeat(ID_WIDTH), AT.checksum, 'ascii');
    header.write('0', AT.type, 'ascii');
    header.write('ustar\u000000', AT_MAGIC, 'ascii');
    header.write('root', AT_UNAME, 'ascii');
    header.write('root', AT_GNAME, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(OCTAL).padStart(CHECKSUM_DIGITS, '0')}\0 `, AT.checksum, 'ascii');
    const padding = Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK);
    return Buffer.concat([header, body, padding, Buffer.alloc(BLOCK + BLOCK)]);
}

/** The pod-spec volume the telemetry config rides in — the attempt's Secret. */
export interface TelemetryConfigVolume {
    name: string;
    secret: { secretName: string; items: { key: string; path: string }[]; defaultMode: number };
}

/**
 * The kubernetes delivery: the per-attempt Secret (which k8s-fence.ts puts the rendered file in,
 * keyed by its file name) mounted read-only and 0444 over the config's directory — root-owned in
 * the pod.
 */
export function telemetryConfigK8s(
    { dir, file }: TelemetryConfig,
    secretName: string
): { mount: { name: string; mountPath: string; readOnly: true }; volume: TelemetryConfigVolume } {
    const name = 'telemetry-config';
    const items = [{ key: file, path: file }];
    return {
        mount: { name, mountPath: dir, readOnly: true },
        volume: { name, secret: { secretName, items, defaultMode: READ_ONLY } },
    };
}
