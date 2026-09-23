import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCRIPT_IDENTITY, git, hasGit, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * The merge-conflict-autofix block's deterministic preflight (issue #122), against real git —
 * offline throughout, the same `file://` bare-remote discipline `worktree.test.ts` uses, and the
 * same fixture (a task worktree already standing on `factory/<root>`, since the probe never syncs
 * one into being — it runs against the worktree the block's `repair` node already claimed).
 */

const SCRIPT_PATH = join(import.meta.dirname, '..', 'src', 'scripts', 'merge-conflict-probe.cjs');

interface ProbeOutput {
    verdict: 'up-to-date' | 'rebased' | 'conflicted';
    baseSha: string;
    headSha: string;
    conflictingPaths: string[];
}

interface ProbeVerdict {
    schema: string;
    version: number;
    ok: boolean;
    output?: ProbeOutput;
    reason?: string;
    error?: string;
}

describe.skipIf(!hasGit())('the merge-conflict-autofix probe script', () => {
    const fx = setupWorktreeFixture();

    const publication = (overrides: Record<string, unknown> = {}) => ({
        repo: 'acme/widgets',
        prNumber: 42,
        prUrl: 'https://github.com/acme/widgets/pull/42',
        headBranch: fx.branch(),
        baseBranch: 'main',
        ...overrides,
    });

    const probe = (input: unknown, env: Record<string, string> = {}): ProbeVerdict => {
        const out = execFileSync('node', [SCRIPT_PATH], {
            cwd: fx.worktree(),
            env: {
                ...process.env,
                ...SCRIPT_IDENTITY,
                HELPER_INPUT: JSON.stringify(input),
                // Hermetic by default: the sandbox this suite runs in may carry its own
                // GITHUB_TOKEN (for the `gh` CLI), and the fixture's remote is a `file://` bare
                // repository — a leaked token would trip the script's own https-only refusal for
                // reasons that have nothing to do with the case under test.
                GITHUB_TOKEN: '',
                ...env,
            },
            encoding: 'utf8',
        });
        return JSON.parse(out.trim().split('\n').filter(Boolean).pop()!);
    };

    it('answers up-to-date when the branch already contains its base — no rebase attempted', () => {
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        const before = git(fx.worktree(), 'rev-parse', 'HEAD');

        const result = probe({ publication: publication() });

        expect(result.ok).toBe(true);
        expect(result.output).toMatchObject({ verdict: 'up-to-date', conflictingPaths: [] });
        expect(git(fx.worktree(), 'rev-parse', 'HEAD')).toBe(before);
    });

    it('rebases cleanly onto a moved base and reports rebased', () => {
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'TASK.md', 'task work\n', 'the task commit');
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');

        const result = probe({ publication: publication() });

        expect(result.ok).toBe(true);
        expect(result.output?.verdict).toBe('rebased');
        expect(result.output?.conflictingPaths).toEqual([]);
        expect(existsSync(join(fx.worktree(), 'NEWS.md'))).toBe(true);
        expect(git(fx.worktree(), 'log', '--format=%s')).toContain('the task commit');
        const gitDir = git(fx.worktree(), 'rev-parse', '--git-dir');
        expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false);
        expect(existsSync(join(gitDir, 'rebase-apply'))).toBe(false);
    });

    it('leaves a known conflicted rebase state and lists the bounded conflicting paths', () => {
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'README.md', 'task rewrites the readme\n', 'conflicting task commit');
        fx.pushToOrigin('README.md', 'upstream rewrites the readme\n', 'conflicting upstream commit');

        const result = probe({ publication: publication() });

        expect(result.ok).toBe(true);
        expect(result.output?.verdict).toBe('conflicted');
        expect(result.output?.conflictingPaths).toEqual(['README.md']);
        const gitDir = git(fx.worktree(), 'rev-parse', '--git-dir');
        expect(existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))).toBe(true);
    });

    it('writes the same verdict to the state file the repair agent reads', () => {
        expect(fx.sync()).toEqual({ ok: true, reason: null });

        probe({ publication: publication() });

        const state = JSON.parse(
            readFileSync(join(fx.worktree(), '.factory', 'merge-conflict-probe.json'), 'utf8')
        ) as ProbeVerdict;
        expect(state).toMatchObject({ schema: 'merge-conflict-probe/v1', version: 1, ok: true });
        expect(state.output?.verdict).toBe('up-to-date');
    });

    it('fails as a precondition, naming it, when the thread recorded no publication', () => {
        expect(fx.sync()).toEqual({ ok: true, reason: null });

        const result = probe({ publication: null });

        expect(result).toMatchObject({ ok: false, reason: 'runner_error' });
        expect(result.error).toContain('no recorded PR publication');
    });

    it('fails, naming it, when the worktree stands on a different branch than the recorded head', () => {
        expect(fx.sync()).toEqual({ ok: true, reason: null });

        const result = probe({ publication: publication({ headBranch: 'factory/not-this-thread' }) });

        expect(result).toMatchObject({ ok: false, reason: 'runner_error' });
        expect(result.error).toContain('instead of the pull request');
    });

    it('aborts a stale mid-rebase state a previous attempt left, and re-probes cleanly', () => {
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'README.md', 'task rewrites the readme\n', 'conflicting task commit');
        fx.pushToOrigin('README.md', 'upstream rewrites the readme\n', 'conflicting upstream commit');
        // First probe leaves a real conflicted rebase mid-flight, exactly as a crashed repair
        // agent would leave it for the next attempt to find.
        expect(probe({ publication: publication() }).output?.verdict).toBe('conflicted');

        const result = probe({ publication: publication() });

        expect(result.ok).toBe(true);
        expect(result.output?.verdict).toBe('conflicted');
        expect(result.output?.conflictingPaths).toEqual(['README.md']);
    });

    it('fails, never disguising it as a conflict, when the autostash reapply leaves conflict markers', () => {
        // The nastiest legitimate state, the exact quirk driver/test/worktree.test.ts's own sync
        // suite pins for git-worktree.cjs: the rebase itself applies cleanly, but git exits 0
        // even though the reapplied STASH conflicts with the newly rebased tree. No rebase is
        // left in progress, so this must never be reported as "conflicted" — the repair agent's
        // prompt assumes a real mid-rebase state for `git rebase --continue`.
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'TASK.md', 'task work\n', 'the task commit');
        writeFileSync(join(fx.worktree(), 'README.md'), 'an agent was here\n');
        fx.pushToOrigin('README.md', 'upstream rewrites the readme\n', 'conflicting upstream commit');

        const result = probe({ publication: publication() });

        expect(result).toMatchObject({ ok: false, reason: 'runner_error' });
        expect(result.error).toContain('autostash reapply');
        // The edit survived, as conflict markers, and the autostash is retained for recovery —
        // never silently discarded just because the probe refused rather than routed to a repair.
        expect(readFileSync(join(fx.worktree(), 'README.md'), 'utf8')).toContain('an agent was here');
        expect(git(fx.worktree(), 'stash', 'list')).toContain('autostash');
    });

    it('fails, never disguising it as a conflict, when the rebase itself refuses for a non-conflict reason', () => {
        // A pre-rebase hook failure: the rebase never even starts, so no file is ever conflicted
        // — this must surface as a genuine helper failure (bounding the block's `repair -> repair`
        // retry edge), not route a fabricated "conflicted" state to the agent.
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        const hooksDir = join(git(fx.worktree(), 'rev-parse', '--git-common-dir'), 'hooks');
        mkdirSync(hooksDir, { recursive: true });
        const hookPath = join(hooksDir, 'pre-rebase');
        writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
        chmodSync(hookPath, 0o755);
        try {
            fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');

            const result = probe({ publication: publication() });

            expect(result).toMatchObject({ ok: false, reason: 'runner_error' });
            expect(result.error).toContain('did not complete');
            expect(result.error).not.toContain('conflict');
            const gitDir = git(fx.worktree(), 'rev-parse', '--git-dir');
            expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false);
            expect(existsSync(join(gitDir, 'rebase-apply'))).toBe(false);
        } finally {
            writeFileSync(hookPath, '');
        }
    });

    it('refuses a credentialed fetch against a non-https origin, naming it auth_failed', () => {
        expect(fx.sync()).toEqual({ ok: true, reason: null });

        const result = probe({ publication: publication() }, { GITHUB_TOKEN: 'a-test-token' });

        expect(result).toMatchObject({ ok: false, reason: 'auth_failed' });
        expect(result.error).toContain('non-https origin');
    });

    it('embeds the exact credential-helper snippet the push flow also carries', () => {
        const src = readFileSync(SCRIPT_PATH, 'utf8');
        const match = /const CREDENTIAL_HELPER = (.+);/.exec(src);
        expect(match).not.toBeNull();
        const embedded = new Function(`return (${match![1]})`)() as string;
        const fileContent = readFileSync(
            join(import.meta.dirname, '..', 'src', 'scripts', 'credential-helper.sh'),
            'utf8'
        ).trim();
        expect(embedded).toBe(fileContent);
    });
});
