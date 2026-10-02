import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    GIT_FIXTURE_CONFIG,
    SCRIPT_IDENTITY,
    git,
    hasGit,
    importEmptyCommits,
} from './fixtures/git-worktree-support.js';

/*
 * The PR summary script (issues #82, #389): the publish flow opens the pull request with what
 * the BRANCH accomplished, not what the command asked and not whatever commit happened to start
 * the branch. Same offline discipline as the probe — a `file://` bare remote, real commits, the
 * script file itself executed — because the title selection (surviving-weight scoring over the
 * final diff) and the body (commit list + shortstat) are exactly the bytes a PR carries.
 */
describe.skipIf(!hasGit())('the PR summary script', () => {
    let dir: string;
    let repo: string;

    beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-pr-summary-')));
        const work = join(dir, 'origin-work');
        mkdirSync(work, { recursive: true });
        git(work, 'init');
        writeFileSync(join(work, 'README.md'), '# summary\n');
        git(work, 'add', 'README.md');
        git(work, 'commit', '-m', 'init');
        const bare = join(dir, 'summary.git');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', '--bare', work, bare], { stdio: 'ignore' });
        repo = join(dir, 'clone');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', `file://${bare}`, repo], { stdio: 'ignore' });
    });

    const summarize = (
        base = 'origin/main',
        extraEnv: Record<string, string> = {}
    ): { title: string | null; body: string | null } => {
        const out = execFileSync('node', [join(import.meta.dirname, '..', 'src', 'scripts', 'pr-summary.cjs')], {
            env: { ...process.env, ...SCRIPT_IDENTITY, ...(base ? { BASE: base } : {}), ...extraEnv },
            cwd: repo,
            encoding: 'utf8',
        });
        return JSON.parse(out.trim().split('\n').filter(Boolean).pop()!);
    };

    const commit = (file: string, content: string | Buffer, message: string) => {
        const path = join(repo, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        git(repo, 'add', file);
        git(repo, 'commit', '-m', message);
    };

    /** An n-line text file, one line per counter — churn n in both the commit and the final diff. */
    const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');

    /** Commits the branch work one commit at a time; the branch starts at the clone default. */
    const onBranch = (work: () => void) => {
        git(repo, 'switch', '-c', 'factory/root');
        work();
    };

    it('titles the PR with the fix, not the opening regression test', () => {
        // The issue's headline case: a test-first branch whose largest commit is the failing
        // test must still be titled by the commit that fixes the thing (source tier).
        onBranch(() => {
            commit('session.test.ts', lines(30), 'Add failing regression test');
            commit('src/session.ts', lines(10), 'Fix session expiry during long-running tasks');
        });

        expect(summarize().title).toBe('Fix session expiry during long-running tasks');
    });

    it('reflects later scope changes in the title', () => {
        onBranch(() => {
            commit('a.txt', lines(1), 'Set up the module skeleton');
            commit('src/sync.ts', lines(30), 'Add retry with backoff to the sync client');
        });

        expect(summarize().title).toBe('Add retry with backoff to the sync client');
    });

    it('does not advertise fully reverted work', () => {
        onBranch(() => {
            commit('rewriter.ts', lines(100), 'Add the experimental rewriter');
            commit('fence.ts', lines(5), 'Fix the fence');
            commit('rewriter.ts', '', 'Revert "Add the experimental rewriter"');
        });

        // rewriter.ts is absent from the final diff, so both the add and the revert score
        // nothing against it — the surviving fence fix is the title.
        expect(summarize().title).toBe('Fix the fence');
    });

    it('titles an all-test branch by its heaviest surviving test commit', () => {
        onBranch(() => {
            commit('a.test.ts', lines(3), 'Add failing regression test');
            commit('b.test.ts', lines(30), 'Cover the fence with a regression test');
        });

        expect(summarize().title).toBe('Cover the fence with a regression test');
    });

    it('titles a single-commit branch with its only subject', () => {
        onBranch(() => {
            commit('only.txt', lines(4), 'The one commit names itself');
        });

        expect(summarize().title).toBe('The one commit names itself');
    });

    it('a binary-only commit does not outrank a smaller text commit', () => {
        onBranch(() => {
            commit('asset.bin', Buffer.from([0x00, 0xff, 0x7f, 0x00, 0x01]), 'Add the compiled fixture');
            commit('src/tiny.ts', lines(3), 'Add the parser guard');
        });

        // Binary rows count zero churn, so the binary commit cannot win on bulk.
        expect(summarize().title).toBe('Add the parser guard');
    });

    it('scores the surviving share, not the raw size', () => {
        onBranch(() => {
            commit('f.txt', lines(100), 'Add the parser');
            commit('g.txt', lines(10), 'Add the docs pointer');
            commit('f.txt', lines(50), 'Halve the parser');
        });

        // f.txt's final churn is 50; the first commit's surviving share min(100, 50) = 50 still
        // beats 10 — and the halving commit ties at 50, losing the tie to the earliest commit.
        expect(summarize().title).toBe('Add the parser');
    });

    it('never titles the PR with the driver’s backstop commit, whatever its churn', () => {
        // The publish commits the uncommitted leftovers itself, with the command's first line
        // as the subject — arriving here as BACKSTOP_TITLE. Being last, its churn survives
        // wholesale, so without the exclusion it would out-score every real commit and the PR
        // would be titled with the prompt (issue #389).
        onBranch(() => {
            commit('fence.ts', lines(5), 'Fix the fence');
            commit('leftovers.txt', lines(100), 'both OK (#10)');
        });

        const summary = summarize('origin/main', { BACKSTOP_TITLE: 'both OK (#10)' });
        expect(summary.title).toBe('Fix the fence');
        // The backstop commit keeps its place in the body — only the title excludes it.
        expect(summary.body).toContain('- both OK (#10)');
    });

    it('answers a null title when the backstop commit is the only commit', () => {
        onBranch(() => {
            commit('leftovers.txt', lines(5), 'both OK (#10)');
        });

        // Null sends the driver to its plan.title fallback — the same string, by construction.
        expect(summarize('origin/main', { BACKSTOP_TITLE: 'both OK (#10)' }).title).toBeNull();
        // Without the env there is no exclusion — a plain subject stays usable.
        expect(summarize().title).toBe('both OK (#10)');
    });

    it('strips control characters from a subject', () => {
        onBranch(() => {
            commit('a.txt', 'a\n', 'Fix\x01 the fence');
        });

        expect(summarize().title).toBe('Fix the fence');
    });

    it('a subject with only control characters is no title', () => {
        onBranch(() => {
            commit('b.txt', 'b\n', '\x01\x02\x03');
        });

        // Null sends the driver to its plan.title fallback, per half — the body still carries.
        const summary = summarize();
        expect(summary.title).toBeNull();
        expect(summary.body).toContain('## Commits');
    });

    it('a control-only subject does not suppress a lighter usable one', () => {
        // The heaviest survivor must still be able to carry a title: a commit whose subject
        // cleans away is not a candidate, so the next survivor names the PR.
        onBranch(() => {
            commit('big.txt', lines(50), '\x01\x02\x03');
            commit('small.txt', lines(3), 'Fix the fence');
        });

        expect(summarize().title).toBe('Fix the fence');
    });

    it('titles the PR with the work and lists what was done', () => {
        // The "no forced rewriting" pin: two equal one-line source commits tie, the earliest
        // wins, and the title is exactly what the old first-subject rule produced.
        onBranch(() => {
            commit('a.txt', 'a\n', 'Fix the sync re-claim fence');
            commit('b.txt', 'b\n', 'Cover the fence with a regression test');
        });

        const summary = summarize();
        expect(summary.title).toBe('Fix the sync re-claim fence');
        expect(summary.body).toContain('## Commits');
        expect(summary.body).toContain('- Fix the sync re-claim fence');
        expect(summary.body).toContain('- Cover the fence with a regression test');
        expect(summary.body).toMatch(/2 files? changed/);
    });

    it('degrades to nulls when there is no BASE or git cannot read it', () => {
        onBranch(() => {
            commit('a.txt', 'a\n', 'a commit');
        });
        expect(summarize('')).toEqual({ title: null, body: null });
        expect(summarize('origin/nope')).toEqual({ title: null, body: null });
    });

    it('caps the commit list', () => {
        const IMPORTED_COMMITS = 35;
        onBranch(() => {
            importEmptyCommits(repo, 'factory/root', IMPORTED_COMMITS);
            git(repo, 'switch', 'factory/root');
        });

        const summary = summarize();
        expect(summary.body).toContain('- ... and 5 more');
        // The capped commit lines, plus the one "- ... and N more" line — both start with "- ".
        const BODY_COMMIT_CAP = 30;
        const cappedLinesWithOverflowNote = BODY_COMMIT_CAP + 1;
        expect((summary.body!.match(/^- /gm) ?? []).length).toBe(cappedLinesWithOverflowNote);
    });

    it('truncates the title to 144 characters', () => {
        onBranch(() => {
            const OVERLONG_SUBJECT_LENGTH = 200;
            commit('x.txt', 'x\n', 'x'.repeat(OVERLONG_SUBJECT_LENGTH));
        });

        const TITLE_MAX = 144;
        expect(summarize().title).toBe('x'.repeat(TITLE_MAX));
    });

    it('truncates a dominant overlong subject on a code-point boundary', () => {
        onBranch(() => {
            // 200 multi-byte characters: UTF-16-unit truncation would split a surrogate pair
            // and hand GitHub a lone surrogate.
            commit('src/汉.ts', lines(10), '漢'.repeat(200));
        });

        const TITLE_MAX = 144;
        expect(summarize().title).toBe('漢'.repeat(TITLE_MAX));
    });

    it('keeps a 73-character subject whole (PR #191 lost the last letter at the old 72 cap)', () => {
        onBranch(() => {
            commit('y.txt', 'y\n', 'Web: task-outcome derivations as pure data, moved out of the task sidebar');
        });

        expect(summarize().title).toBe('Web: task-outcome derivations as pure data, moved out of the task sidebar');
    });
});
