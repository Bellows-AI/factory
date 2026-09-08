import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBellows, readGatesFile } from '../src/workspace/bellows.js';

/**
 * The `.bellows.yaml` strict-subset parser, pure: text in, config or null out, named error thrown.
 *
 * No YAML package exists in this repo and none may be added, so the accepted grammar is pinned
 * here — the issue's example must parse, and everything outside the subset must fail loudly rather
 * than mis-parse, because a silently dropped gate is a check that never ran.
 */

const EXAMPLE = [
    'environment: ',
    '    image: node:24',
    '    gates:',
    '         - name: test',
    '           command: "npm test"',
].join('\n');

describe('parseBellows', () => {
    it('parses the issue example', () => {
        expect(parseBellows(EXAMPLE)).toEqual({
            image: 'node:24',
            gates: [{ name: 'test', command: 'npm test' }],
        });
    });

    it('tolerates comments and blank lines', () => {
        const text = [
            '# CI gates for this repository',
            '',
            'environment:',
            '    # the image gates run in',
            '    image: node:24',
            '',
            '    gates:',
            '        - name: test',
            '          command: npm test',
            '',
            '# trailing comment',
        ].join('\n');
        expect(parseBellows(text)).toEqual({
            image: 'node:24',
            gates: [{ name: 'test', command: 'npm test' }],
        });
    });

    it('reads bare, single-quoted and double-quoted scalars', () => {
        const text = [
            "environment:",
            "    image: 'ghcr.io/acme/ci:1'",
            '    gates:',
            '        - name: lint',
            "          command: 'npm run lint'",
            '        - name: test',
            '          command: "npm test"',
        ].join('\n');
        expect(parseBellows(text)).toEqual({
            image: 'ghcr.io/acme/ci:1',
            gates: [
                { name: 'lint', command: 'npm run lint' },
                { name: 'test', command: 'npm test' },
            ],
        });
    });

    it('keeps colons inside command values', () => {
        const text = [
            'environment:',
            '    image: node:24',
            '    gates:',
            '        - name: test',
            '          command: npx vitest run -t "a: b"',
        ].join('\n');
        expect(parseBellows(text)?.gates[0]?.command).toBe('npx vitest run -t "a: b"');
    });

    it('answers null for an empty or comment-only file', () => {
        expect(parseBellows('')).toBeNull();
        expect(parseBellows('# nothing here\n')).toBeNull();
    });

    it('answers an empty gate list when environment declares no gates', () => {
        expect(parseBellows('environment:\n    image: node:24\n')).toEqual({
            image: 'node:24',
            gates: [],
        });
    });

    it('accepts gates: with a trailing space, as environment: is accepted', () => {
        expect(
            parseBellows('environment: \n    image: node:24\n    gates: \n        - name: test\n          command: npm test\n'),
        ).toEqual({ image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] });
    });

    it('rejects a gate whose command is empty — a vacuously-green check', () => {
        expect(() =>
            parseBellows("environment:\n    image: node:24\n    gates:\n        - name: test\n          command: ''\n"),
        ).toThrow(/empty command/);
        expect(() =>
            parseBellows('environment:\n    image: node:24\n    gates:\n        - name: test\n          command:\n'),
        ).toThrow();
    });

    it('rejects a whitespace-only quoted command as empty — sh -c would exit green on it', () => {
        expect(() =>
            parseBellows(
                'environment:\n    image: node:24\n    gates:\n        - name: test\n          command: "  "\n',
            ),
        ).toThrow(/empty command/);
    });

    it('rejects a tab indent', () => {
        expect(() => parseBellows('environment:\n\timage: node:24\n')).toThrow(/tab/i);
    });

    it('rejects an unknown top-level key', () => {
        expect(() => parseBellows(`pipeline:\n    steps: []\n${EXAMPLE}`)).toThrow(/pipeline/);
    });

    it('rejects an unknown key inside environment', () => {
        expect(() =>
            parseBellows('environment:\n    image: node:24\n    timeout: 30\n'),
        ).toThrow(/timeout/);
    });

    it('rejects an unknown field in a gate', () => {
        expect(() =>
            parseBellows(
                'environment:\n    image: node:24\n    gates:\n        - name: test\n          cwd: /app\n',
            ),
        ).toThrow(/cwd/);
    });

    it('rejects gates without an image', () => {
        expect(() =>
            parseBellows('environment:\n    gates:\n        - name: test\n          command: npm t\n'),
        ).toThrow(/image/);
    });

    it('rejects an empty environment block', () => {
        expect(() => parseBellows('environment:\n')).toThrow(/environment/);
    });

    it('rejects more than 16 gates', () => {
        const lines = ['environment:', '    image: node:24', '    gates:'];
        for (let i = 0; i < 17; i++) {
            lines.push(`        - name: gate-${i}`, `          command: echo ${i}`);
        }
        expect(() => parseBellows(lines.join('\n'))).toThrow(/16/);
    });

    it('rejects a command longer than 4096 characters', () => {
        const long = 'echo ' + 'x'.repeat(4100);
        expect(() =>
            parseBellows(
                `environment:\n    image: node:24\n    gates:\n        - name: test\n          command: ${long}\n`,
            ),
        ).toThrow(/4096/);
    });

    it('rejects a gate name that cannot be a path segment', () => {
        const base = 'environment:\n    image: node:24\n    gates:\n';
        expect(() => parseBellows(`${base}        - name: a/b\n          command: x\n`)).toThrow(
            /name/,
        );
        expect(() => parseBellows(`${base}        - name: -rf\n          command: x\n`)).toThrow(
            /name/,
        );
        expect(() => parseBellows(`${base}        - name: ''\n          command: x\n`)).toThrow(
            /name/,
        );
    });

    it('rejects duplicate gate names', () => {
        expect(() =>
            parseBellows(
                'environment:\n    image: node:24\n    gates:\n        - name: test\n          command: a\n        - name: test\n          command: b\n',
            ),
        ).toThrow(/twice|duplicate/i);
    });

    it('rejects an image that smuggles a docker flag, whitespace or expansion', () => {
        expect(() =>
            parseBellows('environment:\n    image: -v /:/host\n    gates: []\n'),
        ).toThrow(/image/);
        expect(() =>
            parseBellows('environment:\n    image: node:24 alpine\n    gates: []\n'),
        ).toThrow(/image/);
        expect(() =>
            parseBellows('environment:\n    image: node:$TAG\n    gates: []\n'),
        ).toThrow(/image/);
    });

    it('rejects a mismatched or unclosed quote', () => {
        expect(() =>
            parseBellows(
                "environment:\n    image: node:24\n    gates:\n        - name: test\n          command: 'npm test\n",
            ),
        ).toThrow(/quote/);
    });

    it('rejects a gate item missing its command', () => {
        expect(() =>
            parseBellows('environment:\n    image: node:24\n    gates:\n        - name: test\n'),
        ).toThrow(/command/);
    });
});

describe('readGatesFile', () => {
    const USER = '0b9e6c50-8d13-4b8e-9dfb-2fa2d1ba4c71';
    const seam = (content: string | Error) => (path: string) =>
        content instanceof Error ? Promise.reject(content) : Promise.resolve(content);

    it('reads the repo checkout root under the member tree, by repo NAME', async () => {
        const seen: string[] = [];
        const result = await readGatesFile({
            root: '/workspaces',
            workspacePath: `4f7d3c2e-1a9b-4c8d-8e2f-3a5b6c7d8e9f/${USER}`,
            repo: 'Bellows-AI/factory',
            readFile: (path) => {
                seen.push(path);
                return Promise.resolve(EXAMPLE);
            },
        });
        expect(seen).toEqual([`/workspaces/4f7d3c2e-1a9b-4c8d-8e2f-3a5b6c7d8e9f/${USER}/factory/.bellows.yaml`]);
        expect(result).toEqual({
            config: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
            error: null,
        });
    });

    it('answers no gates for a missing file — the normal repository', async () => {
        const error = Object.assign(new Error('nope'), { code: 'ENOENT' });
        const result = await readGatesFile({
            root: '/workspaces',
            workspacePath: `o/${USER}`,
            repo: 'o/r',
            readFile: seam(error),
        });
        expect(result).toEqual({ config: null, error: null });
    });

    it('answers a named error for any other read failure', async () => {
        const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        const result = await readGatesFile({
            root: '/workspaces',
            workspacePath: `o/${USER}`,
            repo: 'o/r',
            readFile: seam(error),
        });
        expect(result.config).toBeNull();
        expect(result.error).toMatch(/permission denied/);
    });

    it('answers a named error for a file outside the accepted grammar', async () => {
        const result = await readGatesFile({
            root: '/workspaces',
            workspacePath: `o/${USER}`,
            repo: 'o/r',
            readFile: seam('pipeline:\n    steps: []\n'),
        });
        expect(result.config).toBeNull();
        expect(result.error).toMatch(/pipeline/);
    });

    it('reads nothing without a workspace root or a repo label', async () => {
        const seen: string[] = [];
        const readFile = (path: string) => {
            seen.push(path);
            return Promise.resolve(EXAMPLE);
        };
        expect(
            await readGatesFile({ root: null, workspacePath: `o/${USER}`, repo: 'o/r', readFile }),
        ).toEqual({ config: null, error: null });
        expect(
            await readGatesFile({ root: '/w', workspacePath: `o/${USER}`, repo: null, readFile }),
        ).toEqual({ config: null, error: null });
        expect(seen).toEqual([]);
    });

    it('refuses a workspace path whose user segment is not a uuid', async () => {
        const result = await readGatesFile({
            root: '/workspaces',
            workspacePath: 'org/../shared',
            repo: 'o/r',
            readFile: seam(EXAMPLE),
        });
        expect(result.config).toBeNull();
        expect(result.error).toMatch(/workspace path is not <orgId>\/<userId>/);
    });
});

/**
 * `readGatesFile` against a real checkout under `os.tmpdir()` — the seam tests above pin the
 * path and error plumbing, these pin what the default reader does with the filesystem itself:
 * a checkout-authored `.bellows.yaml` can be a symlink, so the read must refuse one rather than
 * follow it, and the size bound must survive a rewrite of the reader. Each test gets its own
 * mkdtemp tree and removes it.
 */
describe('readGatesFile against a real checkout', () => {
    const ORG = '4f7d3c2e-1a9b-4c8d-8e2f-3a5b6c7d8e9f';
    const USER = '0b9e6c50-8d13-4b8e-9dfb-2fa2d1ba4c71';
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'bellows-read-'));
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const checkoutWith = async (write: (checkout: string) => Promise<void>): Promise<void> => {
        const checkout = join(root, ORG, USER, 'factory');
        await mkdir(checkout, { recursive: true });
        await write(checkout);
    };

    const read = (): Promise<{ config: unknown; error: string | null }> =>
        readGatesFile({ root, workspacePath: `${ORG}/${USER}`, repo: 'Bellows-AI/factory' }) as Promise<{
            config: unknown;
            error: string | null;
        }>;

    it('refuses a .bellows.yaml that is a symlink out of the checkout, never leaking the target', async () => {
        const secret = join(root, 'outside.txt');
        await writeFile(secret, 'TOPSECRET-CREDENTIALS\n');
        await checkoutWith(async (checkout) => symlink(secret, join(checkout, '.bellows.yaml')));

        const result = await read();
        expect(result.config).toBeNull();
        expect(result.error).toBeTruthy();
        expect(result.error).not.toMatch(/TOPSECRET/);
    });

    it('refuses an oversized .bellows.yaml with the size-limit error', async () => {
        await checkoutWith(async (checkout) =>
            writeFile(join(checkout, '.bellows.yaml'), 'x'.repeat(64 * 1024 + 1)),
        );
        const result = await read();
        expect(result.config).toBeNull();
        expect(result.error).toMatch(/larger than 65536 bytes/);
    });

    it('refuses a whitespace-only quoted command read from disk', async () => {
        await checkoutWith(async (checkout) =>
            writeFile(
                join(checkout, '.bellows.yaml'),
                'environment:\n    image: node:24\n    gates:\n        - name: test\n          command: "  "\n',
            ),
        );
        const result = await read();
        expect(result.config).toBeNull();
        expect(result.error).toMatch(/empty command/);
    });

    it('parses an ordinary valid file from disk', async () => {
        await checkoutWith(async (checkout) => writeFile(join(checkout, '.bellows.yaml'), EXAMPLE));
        const result = await read();
        expect(result).toEqual({
            config: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
            error: null,
        });
    });
});
