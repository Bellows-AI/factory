import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './fixtures/repo-files.js';

describe('kind lane argument validation', () => {
    it.each([
        ['--cluster', '--phase', 'typo'],
        ['--cluster', '--phase'],
        ['--phase', 'recovery'],
        ['--phase', 'all'],
        ['--netpol', '--phase', 'recovery'],
        ['--netpol', '--cluster'],
        ['--unknown'],
    ])('refuses %j before starting any lane', (...args) => {
        const result = spawnSync('bash', ['scripts/test-k8s.sh', ...args], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 5000,
        });
        expect(result.status).toBe(2);
        expect(result.stdout).not.toContain('# chart');
        expect(result.stderr).toBe('');
    });
});
