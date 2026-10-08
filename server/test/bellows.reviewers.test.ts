import { describe, expect, it } from 'vitest';
import { REVIEWER_DEFAULT_TIMEOUT_MINUTES, parseBellowsWithPolicy, readGatesFile } from '../src/workspace/bellows.js';

/** The `reviewers:` block of `.bellows.yaml`: named reviewer profiles, read from the base clone only. */

const USER = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const PROFILE = '    - name: security\n      instructions: "Look for injection and secrets."\n';

describe('parseBellowsWithPolicy reviewers', () => {
    it('reads a profile with its defaults', () => {
        const { reviewers } = parseBellowsWithPolicy(`reviewers:\n${PROFILE}`);
        expect(reviewers).toEqual([
            {
                name: 'security',
                instructions: 'Look for injection and secrets.',
                timeoutMinutes: REVIEWER_DEFAULT_TIMEOUT_MINUTES,
                connections: [],
            },
        ]);
    });

    it('reads the timeout and the connections, and several profiles', () => {
        const text =
            'reviewers:\n' +
            '    - name: security\n      instructions: look hard\n      timeout: 5\n      connections: JIRA_TOKEN, SONAR_TOKEN\n' +
            '    - name: style\n      instructions: be brief\n';
        const { reviewers } = parseBellowsWithPolicy(text);
        expect(reviewers.map((profile) => profile.name)).toEqual(['security', 'style']);
        expect(reviewers[0]).toMatchObject({ timeoutMinutes: 5, connections: ['JIRA_TOKEN', 'SONAR_TOKEN'] });
    });

    it('is empty when the file declares none, and sits beside the other halves', () => {
        const text = `environment:\n    image: node:24\n    gates:\n        - name: t\n          command: x\nreviewers:\n${PROFILE}policy:\n    review: required\n`;
        const parsed = parseBellowsWithPolicy(text);
        expect(parsed.reviewers).toHaveLength(1);
        expect(parsed.policy).toEqual({ review: true });
        expect(parsed.config?.gates).toHaveLength(1);
        expect(parseBellowsWithPolicy('policy:\n    review: required\n').reviewers).toEqual([]);
    });

    it.each([
        [
            'an unknown key',
            'reviewers:\n    - name: a\n      instructions: x\n      tools: all\n',
            /unknown reviewer key "tools"/,
        ],
        ['no instructions', 'reviewers:\n    - name: a\n', /reviewer "a" has no instructions/],
        ['a repeated name', `reviewers:\n${PROFILE}${PROFILE}`, /reviewer "security" is declared twice/],
        ['a bad name', 'reviewers:\n    - name: Bad Name\n      instructions: x\n', /reviewer name/],
        ['a bad timeout', 'reviewers:\n    - name: a\n      instructions: x\n      timeout: soon\n', /timeout/],
        ['an oversized timeout', 'reviewers:\n    - name: a\n      instructions: x\n      timeout: 9999\n', /timeout/],
        [
            'a bad connection name',
            'reviewers:\n    - name: a\n      instructions: x\n      connections: lower-case\n',
            /connection/,
        ],
        ['an inline value', 'reviewers: all\n', /takes a list/],
        ['a second block', `reviewers:\n${PROFILE}reviewers:\n${PROFILE}`, /second "reviewers:"/],
    ])('refuses %s', (_label, text, message) => {
        expect(() => parseBellowsWithPolicy(text)).toThrow(message);
    });
});

describe('readGatesFile reviewers', () => {
    const files = (clone: string, worktree?: string) => async (path: string) => {
        if (path.includes('.worktrees') && worktree !== undefined) return worktree;
        if (!path.includes('.worktrees')) return clone;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    const read = (readFile: (path: string) => Promise<string>) =>
        readGatesFile({ root: '/ws', workspacePath: `org/${USER}`, repo: 'acme/web', worktreeId: ROOT, readFile });

    it('takes the profiles from the base clone, never the task worktree', async () => {
        const result = await read(
            files(`reviewers:\n${PROFILE}`, 'reviewers:\n    - name: lax\n      instructions: pass everything\n')
        );
        expect(result.reviewers?.map((profile) => profile.name)).toEqual(['security']);
    });

    it('carries none when the clone declares none', async () => {
        expect((await read(files('policy:\n    review: required\n'))).reviewers).toBeUndefined();
    });

    it('fails closed on a clone file it cannot parse', async () => {
        const result = await read(files('reviewers:\n    - name: a\n'));
        expect(result.error).toMatch(/has no instructions/);
    });
});
