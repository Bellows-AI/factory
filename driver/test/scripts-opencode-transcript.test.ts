import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { hasNodeSqlite, pathOf } from './fixtures/scripts-support.js';

const MINE = '/workspaces/org/member/.worktrees/mine';
const OTHER = '/workspaces/org/member/.worktrees/other';
const KIB = 1024;

const insertSession = (db: DatabaseSync, id: string, directory: string, created: number): void => {
    db.prepare('insert into session (id, parent_id, directory, time_created) values (?, null, ?, ?)').run(
        id,
        directory,
        created
    );
};

const insertMessage = (db: DatabaseSync, sessionId: string, data: object): number => {
    const result = db
        .prepare('insert into message (session_id, data) values (?, ?)')
        .run(sessionId, JSON.stringify(data));
    return Number(result.lastInsertRowid);
};

const insertPart = (db: DatabaseSync, messageId: number, sessionId: string, text: string): void => {
    db.prepare('insert into part (message_id, session_id, data) values (?, ?, ?)').run(
        messageId,
        sessionId,
        JSON.stringify({ type: 'text', text })
    );
};

const runScript = (dbPath: string, dir: string, env: Record<string, string | undefined> = {}) => {
    const stdout = execFileSync('node', [pathOf('opencode-transcript.cjs')], {
        env: {
            ...process.env,
            OPENCODE_DB: dbPath,
            OPENCODE_DIR: dir,
            TRANSCRIPT_LIMIT_BYTES: String(512 * KIB),
            ...env,
        },
        encoding: 'utf8',
    });
    return { stdout, lines: stdout.split('\n').filter((line) => line.trim() !== '') };
};

/**
 * The opencode transcript export (issue #325), against a real sqlite database: the run's root
 * conversation, one JSON line per message (`{role, time, text}`), delta-bounded like the
 * readout's turn count and tail-kept at the byte cap with the marker line first. The directory
 * scope is the part worth executing: the database is per MEMBER, so two concurrent tasks share
 * one file and the export must answer only the session that ran in OPENCODE_DIR.
 */
describe.skipIf(!hasNodeSqlite())('the opencode transcript export', () => {
    let dbPath: string;
    beforeEach(() => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-otrans-')));
        dbPath = join(dir, 'opencode.db');
        const db = new DatabaseSync(dbPath);
        db.exec('create table session (id text primary key, parent_id text, directory text, time_created integer)');
        db.exec('create table message (id integer primary key, session_id text, data text)');
        db.exec('create table part (id integer primary key, message_id integer, session_id text, data text)');
        // The other task's session, older — the contamination the directory scope excludes.
        insertSession(db, 'ses_other', OTHER, 1000);
        insertMessage(db, 'ses_other', { role: 'assistant', time: { created: 1000 } });
        // This task's, newer — the one the export answers.
        insertSession(db, 'ses_mine', MINE, 2000);
        db.close();
    });

    it('exports the root session of its directory as one JSON line per message, in order', () => {
        const db = new DatabaseSync(dbPath);
        insertMessage(db, 'ses_mine', { role: 'user', time: { created: 2001 } });
        const assistant = insertMessage(db, 'ses_mine', { role: 'assistant', time: { created: 2002 } });
        insertPart(db, assistant, 'ses_mine', 'all green, pushed.');
        db.close();

        const { lines } = runScript(dbPath, MINE);
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0])).toEqual({ role: 'user', time: 2001, text: null });
        expect(JSON.parse(lines[1])).toEqual({ role: 'assistant', time: 2002, text: 'all green, pushed.' });
    });

    it('exports only the messages this run wrote, when the driver passes the run start', () => {
        const db = new DatabaseSync(dbPath);
        insertMessage(db, 'ses_mine', { role: 'user', time: { created: 1500 } });
        insertMessage(db, 'ses_mine', { role: 'assistant', time: { created: 2500 } });
        insertMessage(db, 'ses_mine', { role: 'assistant', time: { created: 2600 } });
        db.close();

        const { lines } = runScript(dbPath, MINE, { RUN_STARTED_MS: '2000' });
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).time).toBe(2500);
        // Without the bound the whole conversation exports.
        expect(runScript(dbPath, MINE).lines).toHaveLength(3);
    });

    it('answers only its own directory, loudly nothing for a scope that matches no session', () => {
        const db = new DatabaseSync(dbPath);
        insertMessage(db, 'ses_mine', { role: 'assistant', time: { created: 2001 } });
        db.close();

        const { lines } = runScript(dbPath, '/workspaces/org/member/.worktrees/nobody');
        expect(lines).toHaveLength(1);
        expect(String(JSON.parse(lines[0]).error)).toContain('no session ran in');
    });

    it('tail-keeps at the byte cap, and says what was dropped in a marker line first', () => {
        const db = new DatabaseSync(dbPath);
        for (let i = 0; i < 30; i += 1) {
            const id = insertMessage(db, 'ses_mine', { role: 'assistant', time: { created: 2000 + i } });
            insertPart(db, id, 'ses_mine', `message ${i} ${'x'.repeat(300)}`);
        }
        db.close();

        const { lines } = runScript(dbPath, MINE, { TRANSCRIPT_LIMIT_BYTES: String(6 * KIB) });
        expect(lines.length).toBeGreaterThan(1);
        const marker = JSON.parse(lines[0]) as { truncated?: unknown; droppedLines?: unknown };
        expect(marker.truncated).toBe(true);
        expect(marker.droppedLines).toBeGreaterThan(0);
        // The kept lines are the LAST ones.
        const last = JSON.parse(lines[lines.length - 1]);
        expect(last.text).toContain('message 29');
        for (const line of lines.slice(1)) expect(() => JSON.parse(line)).not.toThrow();
    });

    it('costs the text alone, never the export, when the schema predates the part table', () => {
        const db = new DatabaseSync(dbPath);
        insertMessage(db, 'ses_mine', { role: 'assistant', time: { created: 2001 } });
        db.close();
        const droppart = new DatabaseSync(dbPath);
        droppart.exec('drop table part');
        droppart.close();

        const { lines } = runScript(dbPath, MINE);
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toEqual({ role: 'assistant', time: 2001, text: null });
    });

    it('answers one error line when the env is wrong', () => {
        const noDir = runScript(dbPath, MINE, { OPENCODE_DIR: undefined });
        expect(noDir.lines).toHaveLength(1);
        expect(String(JSON.parse(noDir.lines[0]).error)).toContain('OPENCODE_DIR');

        const noLimit = runScript(dbPath, MINE, { TRANSCRIPT_LIMIT_BYTES: undefined });
        expect(noLimit.lines).toHaveLength(1);
        expect(String(JSON.parse(noLimit.lines[0]).error)).toContain('TRANSCRIPT_LIMIT_BYTES');
    });
});
