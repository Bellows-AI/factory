import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { hasNodeSqlite, pathOf } from './fixtures/scripts-support.js';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';

/** Registers the per-test transcript directory and the readout-running helper. Must be called
 * from inside a `describe` — `beforeEach` binds to whichever suite is current. */
function claudeTurnsFixture(): {
    dir: () => string;
    run: (transcriptDir: string, startedAt?: string) => { answer: Record<string, unknown> };
} {
    let dir: string;
    beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-cturns-')));
    });
    const run = (transcriptDir: string, startedAt?: string): { answer: Record<string, unknown> } => {
        const stdout = execFileSync('node', [pathOf('claude-turns.cjs')], {
            env: {
                ...process.env,
                CLAUDE_TRANSCRIPT_DIR: transcriptDir,
                CLAUDE_SESSION_ID: SESSION_ID,
                ...(startedAt !== undefined ? { RUN_STARTED_AT: startedAt } : {}),
            },
            encoding: 'utf8',
        });
        return { answer: JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()!) };
    };
    return { dir: () => dir, run };
}

/**
 * The close-time claude-code turn count, against a real transcript file — the artifact both
 * runners hand to a throwaway container. The parse is the part worth executing: the transcript
 * is JSONL where an assistant response is a `type: "assistant"` entry, the file is found by
 * GLOBBING the CLI munged project directory (a `projects` segment, then the session id file),
 * and a missing or unreadable transcript answers null — unmeasured, never zero.
 *
 * Split into two describe blocks for the line-count cap: the turn-counting rules here, the
 * summary and error-path rules below, sharing their fixture via `claudeTurnsFixture`.
 */
describe.skipIf(!hasNodeSqlite())('the claude-code turn count', () => {
    const fx = claudeTurnsFixture();

    it('counts the assistant entries of the run session transcript alone', () => {
        // The CLI munges the working directory into the projects/ segment; the script must
        // find the file by glob, not by reconstructing the munging.
        const project = join(fx.dir(), 'projects', '-workspaces-org-member-.worktrees-mine');
        mkdirSync(project, { recursive: true });
        writeFileSync(
            join(project, `${SESSION_ID}.jsonl`),
            [
                JSON.stringify({ type: 'user', message: 'fix it' }),
                JSON.stringify({ type: 'assistant', message: { role: 'assistant' } }),
                JSON.stringify({ type: 'assistant', message: { role: 'assistant' } }),
                JSON.stringify({ type: 'system' }),
                '',
            ].join('\n')
        );

        const { answer } = fx.run(fx.dir());
        expect(answer.turns).toBe(2);
    });

    it('never counts a subagent conversation', () => {
        // Older layouts ride sidechain entries in the same file; newer ones give the subagent
        // its own session id and file — excluded by the id match alone. Both are pinned.
        const project = join(fx.dir(), 'projects', '-workspaces-org-member-.worktrees-mine');
        mkdirSync(project, { recursive: true });
        writeFileSync(
            join(project, `${SESSION_ID}.jsonl`),
            [
                JSON.stringify({ type: 'assistant' }),
                JSON.stringify({ type: 'assistant', isSidechain: true }),
                JSON.stringify({ type: 'assistant', isSidechain: true }),
            ].join('\n')
        );
        // A DIFFERENT session in the same project: a subagent conversation under the newer
        // layout. Its file is never read — the run's session id is the scope.
        writeFileSync(
            join(project, '44444444-4444-4444-8444-444444444444.jsonl'),
            `${JSON.stringify({ type: 'assistant' })}\n`
        );

        const { answer } = fx.run(fx.dir());
        expect(answer.turns).toBe(1);
    });

    it('counts only the entries this run wrote, when the driver passes the run start', () => {
        // Same delta rule as the opencode readout: a follow-up resumes this transcript, and
        // the whole file would book the earlier runs' turns again. Entries without a
        // timestamp cannot be placed in either side and are skipped.
        const project = join(fx.dir(), 'projects', '-workspaces-org-member-.worktrees-mine');
        mkdirSync(project, { recursive: true });
        writeFileSync(
            join(project, `${SESSION_ID}.jsonl`),
            [
                JSON.stringify({ type: 'assistant', timestamp: '2026-08-20T05:00:00Z' }),
                JSON.stringify({ type: 'assistant', timestamp: '2026-08-20T07:00:00Z' }),
                JSON.stringify({ type: 'assistant', timestamp: '2026-08-20T08:00:00Z' }),
                JSON.stringify({ type: 'assistant' }),
            ].join('\n')
        );

        const TURNS_AFTER_BOUND = 2;
        const TURNS_UNBOUNDED = 4;
        const { answer } = fx.run(fx.dir(), '2026-08-20T06:00:00Z');
        expect(answer.turns).toBe(TURNS_AFTER_BOUND);
        // Without the bound the whole transcript counts, as before.
        expect(fx.run(fx.dir()).answer.turns).toBe(TURNS_UNBOUNDED);
    });
});

describe.skipIf(!hasNodeSqlite())('the claude-code turn count: summary and error paths', () => {
    const fx = claudeTurnsFixture();

    it('lifts the run summary: the last assistant entry carrying text blocks', () => {
        // The transcript's content is a string or a block array; text blocks join and
        // collapse. A trailing tool-only entry does not erase the last words before it.
        const project = join(fx.dir(), 'projects', '-workspaces-org-member-.worktrees-mine');
        mkdirSync(project, { recursive: true });
        writeFileSync(
            join(project, `${SESSION_ID}.jsonl`),
            [
                JSON.stringify({
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: 'first\nattempt' }] },
                }),
                JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
                JSON.stringify({
                    type: 'assistant',
                    message: {
                        content: [
                            { type: 'text', text: '  all  green.' },
                            { type: 'text', text: 'pushed.' },
                        ],
                    },
                }),
            ].join('\n')
        );

        const { answer } = fx.run(fx.dir());
        expect(answer.summary).toBe('all green. pushed.');
    });

    it('answers a null summary when no assistant entry carries text', () => {
        const project = join(fx.dir(), 'projects', '-workspaces-org-member-.worktrees-mine');
        mkdirSync(project, { recursive: true });
        writeFileSync(
            join(project, `${SESSION_ID}.jsonl`),
            [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })].join(
                '\n'
            )
        );

        const { answer } = fx.run(fx.dir());
        expect(answer.turns).toBe(1);
        expect(answer.summary).toBeNull();
    });

    it('answers null when the transcript is missing — the container died first, the run never spoke', () => {
        mkdirSync(join(fx.dir(), 'projects', '-workspaces-org-member-.worktrees-mine'), { recursive: true });
        const { answer } = fx.run(fx.dir());
        expect(answer.turns).toBeNull();
        expect(String(answer.error)).toContain('no transcript');
    });

    it('answers null when the session id is not a session id', () => {
        const stdout = execFileSync('node', [pathOf('claude-turns.cjs')], {
            env: { ...process.env, CLAUDE_TRANSCRIPT_DIR: fx.dir(), CLAUDE_SESSION_ID: '../../../etc/passwd' },
            encoding: 'utf8',
        });
        expect(JSON.parse(stdout.trim()).turns).toBeNull();
    });
});
