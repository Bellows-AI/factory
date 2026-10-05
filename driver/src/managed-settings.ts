/**
 * The claude-code runner's managed settings, rendered by the driver (issue #452). Managed scope
 * outranks every settings file the agent can reach, so the agent (uid 1000) must not own it — and
 * the entrypoint runs as that same uid, so it cannot be the one to write the endpoint in. The
 * driver renders the file instead and delivers it root-owned and 0444: a `docker cp` archive on
 * docker, a read-only Secret mount on kubernetes.
 *
 * A deliberate copy of docker/claude-executor/managed-settings.json (driver/ imports nothing from
 * the rest of the repo); `driver/test/telemetry-shipping.test.ts` pins the two together.
 */
import { CLAUDE_CODE } from './executors.js';

/** The directory the CLI reads `managed-settings.json` from. */
export const MANAGED_SETTINGS_DIR = '/etc/claude-code';
export const MANAGED_SETTINGS_FILE = 'managed-settings.json';
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
 * The managed settings as a one-entry ustar archive for `docker cp -`. The archive, not a file
 * path: `docker cp` keeps a copied file's owner from its tar header, and a plain file path makes
 * that header the DRIVER's uid — uid 1000 itself when the driver runs as `node`. Here it is 0:0,
 * mode 0444, whoever runs the driver.
 */
export function managedSettingsTar(endpoint: string): Buffer {
    const body = Buffer.from(claudeManagedSettings(endpoint), 'utf8');
    const header = Buffer.alloc(BLOCK);
    header.write(MANAGED_SETTINGS_FILE, 0, 'ascii');
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

/** The pod-spec volume a claude-code runner's managed settings ride in — the attempt's Secret. */
export interface ManagedSettingsVolume {
    name: string;
    secret: { secretName: string; items: { key: string; path: string }[]; defaultMode: number };
}

/**
 * The kubernetes delivery: the per-attempt Secret (which k8s-fence.ts puts the rendered file in)
 * mounted read-only and 0444 over the image's directory — root-owned in the pod. Only a
 * claude-code runner reads managed settings; any other gets neither entry.
 */
export function managedSettingsK8s(
    executorType: string | null,
    secretName: string
): { mounts: { name: string; mountPath: string; readOnly: true }[]; volumes: ManagedSettingsVolume[] } {
    if (executorType !== CLAUDE_CODE) return { mounts: [], volumes: [] };
    const name = 'managed-settings';
    const items = [{ key: MANAGED_SETTINGS_FILE, path: MANAGED_SETTINGS_FILE }];
    return {
        mounts: [{ name, mountPath: MANAGED_SETTINGS_DIR, readOnly: true }],
        volumes: [{ name, secret: { secretName, items, defaultMode: READ_ONLY } }],
    };
}
