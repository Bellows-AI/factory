import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { bellowsReadEnv, collectServices, MAX_BELLOWS_BYTES, splitBellowsSections } from '../src/services.js';
import { bellowsService as svc, bellowsTree } from './fixtures/bellows-tree.js';

const USER = '44444444-4444-4444-8444-444444444444';
const ROOT = '33333333-3333-4333-8333-333333333333';

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    rootJobId: ROOT,
    repo: 'acme/app',
    command: 'fix the failing build',
    attempts: 1,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    masterPrompt: 'contract',
    resumeSessionId: null,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
};

/*
 * Issue #444: the readout ran over the member's BASE clones only, while gates read the task
 * worktree — so a service (or a `user:`) added by a commit the base clone had not checked out
 * never reached the container. The task's own repo is read from its worktree; every other
 * checkout of a multi-repo workspace still from its base clone. Runs the shipped script with the
 * env the driver builds, against a real member tree on disk.
 */
describe('bellows-read.sh: which tree each checkout is read from', () => {
    let tree: ReturnType<typeof bellowsTree>;
    const write = (rel: string, text: string): void => tree.write(rel, text);
    const read = (j: BoardJob = job): string =>
        tree.read(bellowsReadEnv(loadDriverConfig({ WORKSPACE_MOUNT: tree.mount }), j));

    beforeEach(() => {
        tree = bellowsTree(job.workspacePath!);
    });

    it('reads the task repo from its worktree when the base clone differs', () => {
        write('app/.bellows.yaml', svc('postgres'));
        write(`.worktrees/${ROOT}/.bellows.yaml`, svc('postgres', '\n    user: "999:999"'));
        const specs = collectServices(splitBellowsSections(read()));
        expect(specs).toEqual([expect.objectContaining({ name: 'postgres', user: { uid: 999, gid: 999 } })]);
    });

    it('reads a service declared only in the worktree', () => {
        write(`.worktrees/${ROOT}/.bellows.yaml`, svc('redis'));
        expect(splitBellowsSections(read())).toEqual([{ repo: 'app', text: expect.stringContaining('redis') }]);
    });

    it('never falls back to the base clone when the worktree has no file', () => {
        write('app/.bellows.yaml', svc('postgres'));
        mkdirSync(join(tree.mount, job.workspacePath!, '.worktrees', ROOT), { recursive: true });
        expect(splitBellowsSections(read())).toEqual([]);
    });

    it('still reads every other checkout from its base clone, under its own marker', () => {
        write('app/.bellows.yaml', svc('stale'));
        write(`.worktrees/${ROOT}/.bellows.yaml`, svc('postgres'));
        write('api/.bellows.yaml', svc('redis'));
        const sections = splitBellowsSections(read());
        expect(sections.map((s) => s.repo).sort()).toEqual(['api', 'app']);
        expect(
            collectServices(sections)
                .map((s) => s.name)
                .sort()
        ).toEqual(['postgres', 'redis']);
    });

    it('names both checkouts when the worktree and another base clone declare the same service', () => {
        write(`.worktrees/${ROOT}/.bellows.yaml`, svc('postgres'));
        write('api/.bellows.yaml', svc('postgres'));
        expect(() => collectServices(splitBellowsSections(read()))).toThrow(
            /defined in both (api\/ and app\/|app\/ and api\/)/
        );
    });

    it('reads every base clone when the job has no repo', () => {
        write('app/.bellows.yaml', svc('postgres'));
        write(`.worktrees/${ROOT}/.bellows.yaml`, svc('redis'));
        const sections = splitBellowsSections(read({ ...job, repo: null }));
        expect(sections).toEqual([{ repo: 'app', text: expect.stringContaining('postgres') }]);
    });

    it('refuses an oversize worktree file in place', () => {
        write(`.worktrees/${ROOT}/.bellows.yaml`, 'x'.repeat(MAX_BELLOWS_BYTES + 1));
        expect(() => splitBellowsSections(read())).toThrow(/larger than/);
    });
});
