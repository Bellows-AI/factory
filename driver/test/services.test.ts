import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import {
    collectServices,
    networkName,
    parseBellows,
    readBellowsArgs,
    serviceContainerName,
    serviceRunArgs,
    splitBellowsSections,
} from '../src/services.js';

const USER = '44444444-4444-4444-8444-444444444444';

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    resumeSessionId: null,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
};

/*
 * Issue #6: a repo author should be able to ask the runner for auxiliary containers — a database,
 * a cache — the way a CI pipeline declares services. The file is `.bellows.yaml`, Drone-style. It
 * is read out of the author's checkouts by the DRIVER, which owns the docker socket the runner
 * deliberately does not have, so everything here is about two things: a strict parse of a file
 * written by somebody this process does not know, and argv arrays worth pinning the way
 * `dockerArgs` is pinned.
 */
describe('parseBellows', () => {
    it('parses the drone-style shape', () => {
        const text = [
            '# databases and such, for the tests this repo wants to run',
            'services:',
            '  - name: cache',
            '    image: redis',
            '',
            '  - name: db',
            '    image: postgres:16',
            '    environment:',
            '      POSTGRES_PASSWORD: secret',
            '      POSTGRES_DB: "app db"',
            '      ALLOW_EMPTY: yes',
            '      RETRIES: 3',
        ].join('\n');
        expect(parseBellows(text)).toEqual([
            { name: 'cache', image: 'redis', environment: [] },
            {
                name: 'db',
                image: 'postgres:16',
                environment: [
                    { key: 'POSTGRES_PASSWORD', value: 'secret' },
                    { key: 'POSTGRES_DB', value: 'app db' },
                    { key: 'ALLOW_EMPTY', value: 'yes' },
                    { key: 'RETRIES', value: '3' },
                ],
            },
        ]);
    });

    it('reads a file with no services as no services', () => {
        // An empty file, a file of comments, or one that simply does not use the key yet: none of
        // these is an error. A checkout carries `.bellows.yaml` only when it wants services.
        expect(parseBellows('')).toEqual([]);
        expect(parseBellows('# nothing here\n')).toEqual([]);
        expect(parseBellows('services:\n')).toEqual([]);
    });

    it('strips comments, including one after a value, but not inside quotes', () => {
        const text = [
            'services:',
            '  - name: db # the main one',
            '    image: postgres:16 # pinned',
            '    environment:',
            '      TOKEN: "ab # cd"',
        ].join('\n');
        expect(parseBellows(text)).toEqual([
            {
                name: 'db',
                image: 'postgres:16',
                environment: [{ key: 'TOKEN', value: 'ab # cd' }],
            },
        ]);
    });

    it('decodes the escapes a quoted scalar promises', () => {
        // The service runs on what the author DECLARED. A double-quoted scalar follows the
        // backslash rules of YAML 1.2 §7.3.2 and a single-quoted one the doubled-quote rule of
        // §7.3.1 — stripping the quotes without decoding shipped the escape syntax itself to
        // the container as the credential.
        const text = [
            'services:',
            '  - name: db',
            '    image: postgres',
            '    environment:',
            '      PASSWORD: "pa\\"ss"',
            '      KEY: \'it\'\'s\'',
            '      PATH: "a\\\\b"',
            '      WINPATH: \'C:\\path\'',
            '      BODY: "line1\\nline2\\tend"',
        ].join('\n');
        expect(parseBellows(text)[0]?.environment).toEqual([
            { key: 'PASSWORD', value: 'pa"ss' },
            { key: 'KEY', value: 'it\'s' },
            { key: 'PATH', value: 'a\\b' },
            { key: 'WINPATH', value: 'C:\\path' },
            { key: 'BODY', value: 'line1\nline2\tend' },
        ]);
    });

    it('refuses an escape it does not decode in a double-quoted scalar', () => {
        // Strictness posture: a typo like `\q` passed through with its backslash would hand the
        // container a credential the author did not write, silently.
        expect(() =>
            parseBellows('services:\n  - name: db\n    image: postgres\n    environment:\n      BAD: "a\\qb"\n'),
        ).toThrow(/escape/);
    });

    it('decodes every valid YAML 1.2 double-quoted escape, including the variable-length hex forms', () => {
        // §7.3.2 in full: the one-character escapes beyond the common set, the escaped space, and
        // the hex forms — `\x` of exactly 2 digits, `\u` of 4, `\U` of 8, decoded through
        // String.fromCodePoint so an astral plane character survives as the surrogate pair the
        // container process expects. A valid file must parse.
        const text = [
            'services:',
            '  - name: db',
            '    image: postgres',
            '    environment:',
            '      BELL: "\\a"',
            '      VTAB: "\\v"',
            '      ESC: "\\e"',
            '      SPACED: "a\\ b"',
            '      NEL: "\\N"',
            '      NBSP: "\\_"',
            '      LS: "\\L"',
            '      PS: "\\P"',
            '      HEX8: "\\x41"',
            '      HEX16: "\\u0041"',
            '      ASTRAL: "\\U0001F600"',
        ].join('\n');
        expect(parseBellows(text)[0]?.environment).toEqual([
            { key: 'BELL', value: '\u0007' },
            { key: 'VTAB', value: '\u000B' },
            { key: 'ESC', value: '\u001B' },
            { key: 'SPACED', value: 'a b' },
            { key: 'NEL', value: '\u0085' },
            { key: 'NBSP', value: '\u00A0' },
            { key: 'LS', value: '\u2028' },
            { key: 'PS', value: '\u2029' },
            { key: 'HEX8', value: 'A' },
            { key: 'HEX16', value: 'A' },
            { key: 'ASTRAL', value: '\u{1F600}' },
        ]);
    });

    it('refuses a malformed hex escape — wrong digit count, non-hex digits, or outside Unicode', () => {
        // §7.3.2 fixes the digit count per escape letter, and Unicode caps code points at
        // 0x10FFFF — a shorter run would silently decode a code point the author did not write,
        // and an oversize one is an error the spec itself names.
        for (const bad of ['\\u12', '\\xZZ', '\\U001F600', '\\UFFFFFFFF']) {
            expect(() =>
                parseBellows(`services:\n  - name: db\n    image: postgres\n    environment:\n      BAD: "${bad}"\n`),
            ).toThrow(/escape/);
        }
    });

    it('cuts a comment after an escaped quote inside a double-quoted value', () => {
        // `\"` must not toggle the quote tracker: the comment after the scalar is still a
        // comment, and the scalar still closes where it closes.
        const text = [
            'services:',
            '  - name: db',
            '    image: postgres',
            '    environment:',
            '      TOKEN: "va\\"" # note',
        ].join('\n');
        expect(parseBellows(text)).toEqual([
            { name: 'db', image: 'postgres', environment: [{ key: 'TOKEN', value: 'va"' }] },
        ]);
    });

    it('refuses a service with no name or no image', () => {
        expect(() => parseBellows('services:\n  - image: redis\n')).toThrow(/missing "name"/);
        expect(() => parseBellows('services:\n  - name: cache\n')).toThrow(/missing "image"/);
    });

    it('refuses a name that is not a lowercase DNS label', () => {
        // The name becomes a container name suffix and a network alias — what DNS answers with
        // inside the job's network. Uppercase, edge hyphens, separators and length are all
        // refused at parse, where the message can say why, rather than at the daemon.
        for (const name of ['Cache', 'cache-2-x-', '-cache', 'ca che', 'ca/che', 'a'.repeat(31)]) {
            expect(() => parseBellows(`services:\n  - name: ${name}\n    image: redis\n`), name).toThrow(
                /lowercase DNS label/,
            );
        }
        expect(parseBellows('services:\n  - name: a\n    image: redis\n')).toHaveLength(1);
        expect(parseBellows(`services:\n  - name: ${'a'.repeat(30)}\n    image: redis\n`)).toHaveLength(1);
    });

    it('refuses an unknown top-level key', () => {
        // A full pipeline syntax would silently do nothing here. Saying "unknown key" turns a
        // pasted Drone file from a quiet no-op into an error a human reads.
        expect(() => parseBellows('pipeline:\n  - name: cache\n    image: redis\n')).toThrow(/unknown key "pipeline"/);
    });

    it('refuses unknown service keys — which is where port publishing dies', () => {
        // Services are reachable only from inside the job's network. `ports:` is how a CI config
        // would publish them on the HOST, and the driver's daemon is root on that host, so a
        // published port is not a supported feature that failed but a key that never parses.
        expect(() => parseBellows('services:\n  - name: db\n    image: postgres\n    ports: ["5432:5432"]\n')).toThrow(
            /unknown service key "ports"/,
        );
        expect(() => parseBellows('services:\n  - name: db\n    image: postgres\n    volumes: ["/x:/y"]\n')).toThrow(
            /unknown service key "volumes"/,
        );
    });

    it('refuses a duplicate service name in one file', () => {
        expect(() =>
            parseBellows('services:\n  - name: cache\n    image: redis\n  - name: cache\n    image: valkey\n'),
        ).toThrow(/duplicate service name "cache"/);
    });

    it('refuses an environment key that is not a shell identifier', () => {
        expect(() =>
            parseBellows('services:\n  - name: db\n    image: postgres\n    environment:\n      "A B": 1\n'),
        ).toThrow(/not a valid environment variable name/);
    });

    it('refuses a duplicate environment key in one service, like every other duplicate', () => {
        // Two `A:` lines would reach docker as `-e A=1 -e A=2` and silently resolve to the last.
        expect(() =>
            parseBellows(
                'services:\n  - name: db\n    image: postgres\n    environment:\n      A: 1\n      A: 2\n',
            ),
        ).toThrow(/duplicate environment key "A"/);
    });

    it('refuses an environment entry too heavy for an argv', () => {
        // `-e` values travel on a `docker run` argv, and execve caps a single argument far below
        // what a pasted certificate collection weighs — better a refusal that names the key than
        // a daemon error that reads as infrastructure.
        const big = 'x'.repeat(8193);
        expect(() =>
            parseBellows(`services:\n  - name: db\n    image: postgres\n    environment:\n      PEM: ${big}\n`),
        ).toThrow(/too long/);
        const longKey = 'K'.repeat(257);
        expect(() =>
            parseBellows(`services:\n  - name: db\n    image: postgres\n    environment:\n      ${longKey}: 1\n`),
        ).toThrow(/too long/);
    });

    it('refuses an image that is not an image reference', () => {
        // The image names what the daemon executes, so it is an allowlist: no whitespace, no `$`,
        // no `=`, no leading `-`. Not docker's full grammar — a reference this refuses but the
        // daemon would take is a clear refusal, where the reverse trade is flag injection.
        for (const image of ['--privileged', '-v=/:/host', 'alpine sh -c pwn', '$(id)', '`id`', 'redis=latest']) {
            expect(() => parseBellows(`services:\n  - name: db\n    image: "${image}"\n`), image).toThrow(
                /does not look like an image reference/,
            );
        }
    });

    it('accepts the image shapes a real checkout writes, including a registry with a port', () => {
        for (const image of ['redis', 'postgres:16', 'ghcr.io/team/db:1.2', 'registry:5000/team/db:1.2']) {
            expect(parseBellows(`services:\n  - name: db\n    image: ${image}\n`)[0]?.image, image).toBe(image);
        }
        const digest = `${'a'.repeat(64)}`;
        expect(parseBellows(`services:\n  - name: db\n    image: redis@sha256:${digest}\n`)[0]?.image).toBe(
            `redis@sha256:${digest}`,
        );
    });

    it('tolerates a byte-order mark in front of the first key', () => {
        expect(parseBellows('\uFEFFservices:\n  - name: db\n    image: postgres\n')).toHaveLength(1);
    });

    it('caps how many services one workspace may ask for', () => {
        // Enforced on the merge, not per file: the readout's section markers are ordinary lines a
        // file can forge, and the checkouts are many by design — so a single file could otherwise
        // multiply its way past a per-file cap.
        const items = Array.from({ length: 11 }, (_, i) => `  - name: svc${i}\n    image: redis\n`).join('');
        expect(() => collectServices([{ repo: 'demo', text: `services:\n${items}` }])).toThrow(
            /at most 10 services across the workspace, got 11/,
        );
        const ten = Array.from({ length: 10 }, (_, i) => `  - name: svc${i}\n    image: redis\n`).join('');
        expect(collectServices([{ repo: 'demo', text: `services:\n${ten}` }])).toHaveLength(10);
        const spread = Array.from({ length: 11 }, (_, i) => ({
            repo: `r${i}`,
            text: `services:\n  - name: db${i}\n    image: redis\n`,
        }));
        expect(() => collectServices(spread)).toThrow(/at most 10 services across the workspace, got 11/);
    });
});

describe('splitBellowsSections', () => {
    // The readout container prints one marker per checkout that has a file, then the file. The
    // marker carries the checkout's directory name, which becomes a path segment in error
    // messages — and is the only part of the container's output this process reasons about, so
    // it is asserted here with the same rule the server applies to a checkout's name.
    it('splits the readout into per-checkout sections', () => {
        const output = [
            '###__bellows:factory',
            'services:',
            '  - name: db',
            '    image: postgres',
            '###__bellows:web',
            'services:',
            '  - name: cache',
            '    image: redis',
        ].join('\n');
        expect(splitBellowsSections(output)).toEqual([
            { repo: 'factory', text: 'services:\n  - name: db\n    image: postgres' },
            { repo: 'web', text: 'services:\n  - name: cache\n    image: redis' },
        ]);
    });

    it('answers nothing for a readout with no markers', () => {
        expect(splitBellowsSections('')).toEqual([]);
        expect(splitBellowsSections('some stray output\n')).toEqual([]);
    });

    it('refuses a marker whose name is not a path segment', () => {
        for (const repo of ['../etc', 'a/b', '-x', '.x', '']) {
            expect(() => splitBellowsSections(`###__bellows:${repo}\n`), repo).toThrow(/not a path segment/);
        }
    });

    it('turns the readout’s oversize refusal into the author-facing error', () => {
        // An oversize file comes back as the readout's own error marker instead of unbounded
        // content — the alternative was a maxBuffer failure classifying as infrastructure and
        // burning the job's attempts on a file that cannot change.
        expect(() =>
            splitBellowsSections('###__bellows:demo\n###__bellows_error:/workspaces/x/demo/.bellows.yaml is larger than 65536 bytes\n'),
        ).toThrow(/is larger than 65536 bytes/);
    });
});

describe('collectServices', () => {
    it('merges the services of every checkout in the workspace', () => {
        const specs = collectServices([
            { repo: 'factory', text: 'services:\n  - name: db\n    image: postgres\n' },
            { repo: 'web', text: 'services:\n  - name: cache\n    image: redis\n' },
        ]);
        expect(specs.map((s) => s.name)).toEqual(['db', 'cache']);
    });

    it('refuses one name claimed by two checkouts', () => {
        // Two repos both defining `db` would race for one alias. There is no merge rule worth
        // guessing — first-wins and last-wins both read as "the wrong database" — so the job
        // fails with the two repos named.
        expect(() =>
            collectServices([
                { repo: 'factory', text: 'services:\n  - name: db\n    image: postgres\n' },
                { repo: 'web', text: 'services:\n  - name: db\n    image: mysql\n' },
            ]),
        ).toThrow(/"db" is defined in both factory\/ and web\//);
    });
});

describe('the bellows readout arguments', () => {
    // The driver has no host path into a named volume — the same fact that gave the opencode
    // session readout its throwaway container. The runner image is used rather than pulling a
    // busybox: every job already needs it present.
    it('cats every checkout\'s .bellows.yaml over the workspaces volume, marked per checkout', () => {
        const line = readBellowsArgs(loadDriverConfig({}), job);
        expect(line.slice(0, 8)).toEqual([
            'run',
            '--rm',
            '-v',
            // Read-only: the script only cats, and the mount covers every member's tree.
            'factory-ai_workspaces:/workspaces:ro',
            '--entrypoint',
            'sh',
            'claude-executor',
            '-c',
        ]);
        const script = line[8];
        expect(script).toContain(`/workspaces/bellows/${USER}/*/.bellows.yaml`);
        expect(script).toContain('###__bellows:');
        expect(script).toContain('basename');
        expect(script).toContain('[ -f "$f" ] || continue');
        // The readout's output crosses execFile's maxBuffer, so the script bounds each file and
        // refuses an oversize one in place — an author refusal, not a failed read.
        expect(script).toContain('wc -c');
        expect(script).toContain('65536');
        expect(script).toContain('###__bellows_error:');
    });

    it('refuses a workspace path that is not <org>/<uuid>', () => {
        // COPIED from docker.ts, which states the full why: the board is not something this
        // process trusts with a fragment of a command, and here it is interpolated into a shell
        // script run by a container this process spawns.
        expect(() => readBellowsArgs(loadDriverConfig({}), { ...job, workspacePath: `bellows/../../etc` })).toThrow(
            /no usable workspace path/,
        );
    });
});

describe('the service container arguments', () => {
    /*
     * The naming contract every helper here obeys: a name is derived from the job id AND the
     * lease token, and the token is minted fresh on every claim and never repeats. So a stale
     * attempt can compute the names it used, but those names can only ever resolve to the
     * resources its own attempt created — structurally, no ownership gate needed.
     */
    it('names the network after the job and the attempt', () => {
        expect(networkName(job)).toBe(
            'factory-job-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222-services',
        );
    });

    it('names the service container after the job, the attempt, and the service', () => {
        expect(serviceContainerName(job, 'cache')).toBe(
            'factory-job-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222-svc-cache',
        );
    });

    it('starts a detached container on the job network, aliased by service name', () => {
        // The alias is the whole point: inside the job's network, `cache` resolves to this
        // container, which is what makes `redis://cache:6379` work in the author's tests. The
        // lease label beside the job label is what scopes every teardown and kill to this
        // attempt's fleet — the job label alone is shared by every attempt of the job.
        const line = serviceRunArgs(job, {
            name: 'cache',
            image: 'redis',
            environment: [{ key: 'ALLOW_EMPTY', value: 'yes' }],
        });
        expect(line).toEqual([
            'run',
            '-d',
            '--name',
            serviceContainerName(job, 'cache'),
            '--label',
            `factory.job=${job.id}`,
            '--label',
            `factory.lease=${job.leaseToken}`,
            '--label',
            'factory.service=cache',
            '--network',
            networkName(job),
            '--network-alias',
            'cache',
            '-e',
            'ALLOW_EMPTY=yes',
            'redis',
        ]);
    });

    it('never publishes a port on the host', () => {
        // Parse refuses the `ports:` key; this pins that the argv side has no way to publish one
        // either. The daemon running this argv is root on the host — a published port is the one
        // step from "a service for my tests" to "a listener on somebody's machine".
        const line = serviceRunArgs(job, { name: 'db', image: 'postgres', environment: [] });
        expect(line).not.toContain('-p');
        expect(line).not.toContain('--publish');
    });

    it('re-asserts the name, image and env keys before they reach argv', () => {
        // parseBellows enforces all three; this is the same assertion the runner makes about a
        // session id it is about to interpolate — the argv builder does not trust its caller.
        expect(() =>
            serviceRunArgs(job, { name: 'bad name', image: 'redis', environment: [] }),
        ).toThrow(/not a safe service name/);
        expect(() =>
            serviceRunArgs(job, { name: 'db', image: 'redis', environment: [{ key: 'A B', value: '1' }] }),
        ).toThrow(/not a valid environment variable name/);
        expect(() =>
            serviceRunArgs(job, { name: 'db', image: '--privileged', environment: [] }),
        ).toThrow(/not a safe image reference/);
    });
});

describe('the RUNNER_SERVICES switch', () => {
    it('is off by default, so argv and lifecycle are unchanged until somebody types it', () => {
        expect(loadDriverConfig({}).servicesEnabled).toBe(false);
        expect(loadDriverConfig({ RUNNER_SERVICES: '0' }).servicesEnabled).toBe(false);
        expect(loadDriverConfig({ RUNNER_SERVICES: 'false' }).servicesEnabled).toBe(false);
        expect(loadDriverConfig({ RUNNER_SERVICES: '1' }).servicesEnabled).toBe(true);
    });

    it('is allowed under both executors — service pods under kubernetes, containers under docker', () => {
        // The kubernetes runner starts each declared service as a pod with a headless Service
        // as its DNS name, so the flag no longer refuses that executor: the switch decides
        // WHETHER services run, and the executor decides HOW.
        expect(() => loadDriverConfig({ RUNNER_SERVICES: '1', EXECUTOR: 'kubernetes' })).not.toThrow();
        expect(loadDriverConfig({ RUNNER_SERVICES: '1', EXECUTOR: 'kubernetes' }).servicesEnabled).toBe(true);
        expect(() => loadDriverConfig({ RUNNER_SERVICES: '1', EXECUTOR: 'docker' })).not.toThrow();
    });
});
