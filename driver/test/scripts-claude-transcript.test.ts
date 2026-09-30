import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pathOf } from './fixtures/scripts-support.js';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const KIB = 1024;

/**
 * Runs the transcript export the way the driver's throwaway container does: env values in, the
 * export's own JSONL out (with the optional marker line first). The LAST stdout line is the
 * error line when the script failed; the marker, when present, is the first.
 */
function runScript(dir: string, env: Record<string, string | undefined> = {}): { stdout: string; lines: string[] } {
    const stdout = execFileSync('node', [pathOf('claude-transcript.cjs')], {
        env: {
            ...process.env,
            CLAUDE_TRANSCRIPT_DIR: dir,
            CLAUDE_SESSION_ID: SESSION_ID,
            TRANSCRIPT_LIMIT_BYTES: String(512 * KIB),
            ...env,
        },
        encoding: 'utf8',
    });
    return { stdout, lines: stdout.split('\n').filter((line) => line.trim() !== '') };
}

/** Writes a transcript with one assistant entry per line, `count` of them, timestamps spread. */
function writeTranscript(dir: string, count: number, sizePerLine = 40): void {
    const project = join(dir, 'projects', '-workspaces-org-member-.worktrees-mine');
    mkdirSync(project, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < count; i += 1) {
        lines.push(
            JSON.stringify({
                type: 'assistant',
                timestamp: `2026-08-20T0${i % 10}:00:00Z`,
                message: { content: [{ type: 'text', text: `entry ${i} ${'x'.repeat(sizePerLine)}` }] },
            })
        );
    }
    writeFileSync(join(project, `${SESSION_ID}.jsonl`), `${lines.join('\n')}\n`);
}

/**
 * The transcript export (issue #325): the run's session JSONL, delta-bounded like the turn
 * count, tail-kept at a byte cap with a marker line saying what was dropped. The parser on the
 * driver side (parseTranscriptRead) consumes exactly this shape — marker first, content after —
 * so the bytes this suite pins are the bytes the upload carries.
 */
describe('the claude-code transcript export', () => {
    let dir: string;
    beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-ctrans-')));
    });

    it('exports the session transcript as its own JSONL lines', () => {
        writeTranscript(dir, 3);
        const { lines } = runScript(dir);
        expect(lines).toHaveLength(3);
        for (const line of lines) {
            expect(() => JSON.parse(line)).not.toThrow();
            expect(JSON.parse(line).message.content[0].text).toContain('entry');
        }
    });

    it('exports only the entries this run wrote, when the driver passes the run start', () => {
        writeTranscript(dir, 4);
        const { lines } = runScript(dir, { RUN_STARTED_AT: '2026-08-20T02:00:00Z' });
        // Entries at 00:00 and 01:00 predate the run; 02:00 and 03:00 are its own.
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).message.content[0].text).toContain('entry 2');
    });

    it('never exports a subagent conversation', () => {
        const project = join(dir, 'projects', '-workspaces-org-member-.worktrees-mine');
        mkdirSync(project, { recursive: true });
        writeFileSync(join(project, `${SESSION_ID}.jsonl`), `${JSON.stringify({ type: 'assistant' })}\n`);
        // A different session id: a subagent conversation under the newer layout. Never read.
        writeFileSync(
            join(project, '44444444-4444-4444-8444-444444444444.jsonl'),
            `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'sidechain' }] } })}\n`
        );
        const { lines } = runScript(dir);
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain('sidechain');
    });

    it('tail-keeps at the byte cap, and says what was dropped in a marker line first', () => {
        writeTranscript(dir, 40, 700);
        const { lines } = runScript(dir, { TRANSCRIPT_LIMIT_BYTES: String(8 * KIB) });
        expect(lines.length).toBeGreaterThan(1);
        const marker = JSON.parse(lines[0]) as { truncated?: unknown; droppedLines?: unknown };
        expect(marker.truncated).toBe(true);
        expect(marker.droppedLines).toBeGreaterThan(0);
        // The kept lines are the LAST ones — the run's last words, not its preamble.
        const last = JSON.parse(lines[lines.length - 1]);
        expect(last.message.content[0].text).toContain('entry 39');
        for (const line of lines.slice(1)) expect(() => JSON.parse(line)).not.toThrow();
    });

    it('answers one error line when the transcript is missing, and when the env is wrong', () => {
        mkdirSync(join(dir, 'projects', '-workspaces-org-member-.worktrees-mine'), { recursive: true });
        const missing = runScript(dir);
        expect(missing.lines).toHaveLength(1);
        expect(String(JSON.parse(missing.lines[0]).error)).toContain('no transcript');

        const noLimit = runScript(dir, { TRANSCRIPT_LIMIT_BYTES: undefined });
        expect(noLimit.lines).toHaveLength(1);
        expect(String(JSON.parse(noLimit.lines[0]).error)).toContain('TRANSCRIPT_LIMIT_BYTES');

        const badSession = runScript(dir, { CLAUDE_SESSION_ID: '../../../etc/passwd' });
        expect(badSession.lines).toHaveLength(1);
        expect(String(JSON.parse(badSession.lines[0]).error)).toContain('not a session id');
    });
});
