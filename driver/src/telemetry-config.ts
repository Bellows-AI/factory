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
const DIRECTORY = 0o755;

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
        // The runner's `-p` session runs in auto mode; without these the classifier denies a
        // task's own dependency change and credential check as if on a developer machine.
        autoMode: {
            environment: [
                '$defaults',
                '**Host containment**: Factory runner — a single-task, ephemeral container or Kubernetes pod with its own git worktree under /workspaces. The Factory driver owns pushing, pull requests and branch moves (its git guard hook enforces that). This is not a developer machine.',
                '**Secrets management**: Factory injects the credentials this task needs (for example a Jira or GitHub token) as environment variables, and they are meant to be used against the service they belong to.',
            ],
            allow: [
                '$defaults',
                "Task Dependency Changes: Adding, upgrading or removing a package with npm, yarn or pnpm in the task worktree, from the project's configured registry, when the task calls for that dependency change — the lockfile update and the package's install scripts included. Registry overrides and packages from git URLs or tarballs are not covered.",
                "Credential Presence Checks: Listing the NAMES of environment variables with their values removed or masked, and calling a task-provided credential's own service (its whoami, myself or current-user endpoint) to test that it authenticates — as long as the value itself is never printed or written anywhere.",
            ],
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

/** One ustar entry: a 512-byte header, then the body padded to the block size. */
function tarEntry(name: string, mode: number, type: '0' | '5', text = ''): Buffer {
    const body = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, 'ascii');
    header.write(octal(mode, ID_WIDTH), AT.mode, 'ascii');
    header.write(octal(0, ID_WIDTH), AT.uid, 'ascii');
    header.write(octal(0, ID_WIDTH), AT.gid, 'ascii');
    header.write(octal(body.length, NUMBER_WIDTH), AT.size, 'ascii');
    header.write(octal(0, NUMBER_WIDTH), AT.mtime, 'ascii');
    header.write(' '.repeat(ID_WIDTH), AT.checksum, 'ascii');
    header.write(type, AT.type, 'ascii');
    header.write('ustar\u000000', AT_MAGIC, 'ascii');
    header.write('root', AT_UNAME, 'ascii');
    header.write('root', AT_GNAME, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(OCTAL).padStart(CHECKSUM_DIGITS, '0')}\0 `, AT.checksum, 'ascii');
    return Buffer.concat([header, body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK)]);
}

const parentOf = (dir: string): string => dir.slice(0, dir.lastIndexOf('/')) || '/';
const baseOf = (dir: string): string => dir.slice(dir.lastIndexOf('/') + 1);

/** Where `docker cp -` extracts the archive: the config directory's parent. */
export const telemetryCopyTarget = ({ dir }: TelemetryConfig): string => parentOf(dir);

/**
 * The config as a ustar archive for `docker cp -` into `telemetryCopyTarget`: its directory
 * (0755) and the file (0444), both 0:0. The archive, not a file path: `docker cp` keeps a copied
 * entry's owner from its tar header, and a plain file path makes that header the DRIVER's uid —
 * uid 1000 itself when the driver runs as `node`. The directory rides along so an image without it
 * (a custom runner image, the stubs scripts/test-jobs.sh runs) still gets a root-owned one.
 */
export function telemetryConfigTar({ dir, file, body }: TelemetryConfig): Buffer {
    const base = baseOf(dir);
    return Buffer.concat([
        tarEntry(`${base}/`, DIRECTORY, '5'),
        tarEntry(`${base}/${file}`, READ_ONLY, '0', body),
        Buffer.alloc(BLOCK + BLOCK),
    ]);
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
