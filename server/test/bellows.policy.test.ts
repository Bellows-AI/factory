import { describe, expect, it } from 'vitest';
import { parseBellows, parseBellowsWithPolicy, readGatesFile } from '../src/workspace/bellows.js';

/** The `policy:` block of `.bellows.yaml`: the evidence a task must carry, read from the base clone only. */

const ENVIRONMENT =
    'environment:\n    image: node:24\n    gates:\n        - name: test\n          command: "npm test"\n';
const USER = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';

describe('parseBellowsWithPolicy', () => {
    it('reads both required keys and leaves the gates half untouched', () => {
        const text = `${ENVIRONMENT}policy:\n    gates: required\n    review: "required"\n`;
        expect(parseBellowsWithPolicy(text).policy).toEqual({ gates: true, review: true });
        expect(parseBellows(text)?.gates).toEqual([{ name: 'test', command: 'npm test' }]);
    });

    it('reads a review-only policy from a file with no environment', () => {
        expect(parseBellowsWithPolicy('policy:\n    review: required\n')).toEqual({
            config: null,
            policy: { review: true },
        });
    });

    it('is empty when the file declares none', () => {
        expect(parseBellowsWithPolicy(ENVIRONMENT).policy).toEqual({});
    });

    it.each([
        ['an unknown key', 'policy:\n    merge: required\n', /unknown policy key "merge"/],
        ['a value other than required', `${ENVIRONMENT}policy:\n    gates: optional\n`, /must be "required"/],
        ['a missing value', `${ENVIRONMENT}policy:\n    gates:\n`, /must be "required"/],
        ['a repeated key', `${ENVIRONMENT}policy:\n    gates: required\n    gates: required\n`, /declared twice/],
        [
            'a second block',
            `${ENVIRONMENT}policy:\n    review: required\npolicy:\n    gates: required\n`,
            /second "policy:"/,
        ],
        ['an inline value', 'policy: required\n', /takes keys/],
        ['required gates with no environment', 'policy:\n    gates: required\n', /requires gates/],
    ])('refuses %s', (_name, text, message) => {
        expect(() => parseBellowsWithPolicy(text)).toThrow(message);
    });
});

describe('readGatesFile reads the policy from the base clone only', () => {
    const cloneFile = `/workspaces/o/${USER}/r/.bellows.yaml`;
    const worktreeFile = `/workspaces/o/${USER}/.worktrees/${ROOT}/.bellows.yaml`;
    const read = (files: Record<string, string>) =>
        readGatesFile({
            root: '/workspaces',
            workspacePath: `o/${USER}`,
            repo: 'o/r',
            worktreeId: ROOT,
            readFile: (path) => {
                const text = files[path];
                if (text === undefined) return Promise.reject(Object.assign(new Error('absent'), { code: 'ENOENT' }));
                return Promise.resolve(text);
            },
        });

    it('keeps the clone policy when the run edited its worktree file to drop it', async () => {
        const result = await read({
            [cloneFile]: `${ENVIRONMENT}policy:\n    gates: required\n`,
            [worktreeFile]: ENVIRONMENT,
        });
        expect(result.source).toBe('worktree');
        expect(result.policy).toEqual({ gates: true });
    });

    it('ignores a policy the run added to its own worktree file', async () => {
        const result = await read({
            [cloneFile]: ENVIRONMENT,
            [worktreeFile]: `${ENVIRONMENT}policy:\n    review: required\n`,
        });
        expect(result.policy).toBeUndefined();
    });

    it('fails closed when the clone file cannot be parsed', async () => {
        const result = await read({ [cloneFile]: 'policy:\n    merge: required\n', [worktreeFile]: ENVIRONMENT });
        expect(result.config).toBeNull();
        expect(result.error).toMatch(/unknown policy key/);
    });
});
