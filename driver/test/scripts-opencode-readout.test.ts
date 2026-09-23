import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { hasNodeSqlite, pathOf } from './fixtures/scripts-support.js';

const OTHER_SESSION_CREATED = 1000;
const MINE_SESSION_CREATED = 2000;

const MINE = '/workspaces/org/member/.worktrees/mine';
const OTHER = '/workspaces/org/member/.worktrees/other';

/** One root session row, with the columns the script reads. */
const insertSession = (db: DatabaseSync, id: string, directory: string, created: number): void => {
    db.prepare('insert into session (id, parent_id, directory, time_created) values (?, null, ?, ?)').run(
        id,
        directory,
        created
    );
};

/** One message row; `data` is the JSON blob the script reads fields out of. */
const insertMessage = (db: DatabaseSync, sessionId: string, data: object): void => {
    db.prepare('insert into message (session_id, data) values (?, ?)').run(sessionId, JSON.stringify(data));
};

const runReadout = (dbPath: string, dir: string, startedMs?: string): { answer: Record<string, unknown> } => {
    const stdout = execFileSync('node', [pathOf('opencode-readout.cjs')], {
        env: {
            ...process.env,
            OPENCODE_DB: dbPath,
            OPENCODE_DIR: dir,
            ...(startedMs !== undefined ? { RUN_STARTED_MS: startedMs } : {}),
        },
        encoding: 'utf8',
    });
    return { answer: JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()!) };
};

/**
 * Builds a fresh session database with the two-task contamination shape every test guards
 * against — the older OTHER task's session, and MINE, the newer one the readout must answer —
 * and registers the `beforeEach` that creates it. Must be called from inside a `describe`.
 */
function opencodeReadoutFixture(): { dbPath: () => string; run: typeof runReadout } {
    let dbPath: string;
    beforeEach(() => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-ocread-')));
        dbPath = join(dir, 'opencode.db');
        const db = new DatabaseSync(dbPath);
        db.exec('create table session (id text primary key, parent_id text, directory text, time_created integer)');
        db.exec('create table message (id integer primary key, session_id text, data text)');
        // The other task's session is the OLDER one; today's newest-root-session scrape answers it
        // for both tasks, which is the contamination the directory scope exists to end.
        insertSession(db, 'ses_other', OTHER, OTHER_SESSION_CREATED);
        insertMessage(db, 'ses_other', { role: 'assistant', finish: 'stop', tokens: { total: 11 }, cost: 0.01 });
        // This task's, newer — the one the readout must answer.
        insertSession(db, 'ses_mine', MINE, MINE_SESSION_CREATED);
        db.close();
    });
    return { dbPath: () => dbPath, run: runReadout };
}

/**
 * The close-time opencode session readout, against a real sqlite database — the artifact both
 * runners hand to a throwaway container. The scope is the part worth executing: the session
 * database is per MEMBER (that is what makes a follow-up's `--session` resumable at all), so two
 * concurrent tasks share one file and the readout must answer only the session that ran in
 * OPENCODE_DIR — the newest root session whose `directory` is that path, which is the working
 * directory the runner gave the run.
 *
 * Split into three describe blocks for the line-count cap, sharing the two-task fixture above:
 * scoping here, the last provider error and turn count below, and the run summary last.
 */
describe.skipIf(!hasNodeSqlite())('the opencode session readout', () => {
    const fx = opencodeReadoutFixture();

    it('answers the newest root session of its directory, and never another task’s', () => {
        const { answer } = fx.run(fx.dbPath(), MINE);
        expect(answer.id).toBe('ses_mine');
    });

    it('answers nothing when no session ran in its directory, though the database has sessions', () => {
        // The loud failure: a scope key that matches nothing must NOT fall back to the newest
        // session in the file — that fallback is the cross-task contamination.
        const { answer } = fx.run(fx.dbPath(), '/workspaces/org/member/.worktrees/nobody');
        expect(answer.id).toBeUndefined();
        expect(String(answer.error)).toContain('no session');
    });

    it('refuses to run without a directory to scope to', () => {
        const { OPENCODE_DIR: _omit, ...env } = process.env;
        const stdout = execFileSync('node', [pathOf('opencode-readout.cjs')], {
            env: { ...env, OPENCODE_DB: fx.dbPath() },
            encoding: 'utf8',
        });
        expect(JSON.parse(stdout.trim()).error).toContain('OPENCODE_DIR');
    });

    it('carries the finish reason, context and cost of the in-scope session', () => {
        const db = new DatabaseSync(fx.dbPath());
        insertMessage(db, 'ses_mine', {
            role: 'assistant',
            finish: 'stop',
            tokens: { total: 90433.4 },
            cost: 0.31,
        });
        db.close();

        const { answer } = fx.run(fx.dbPath(), MINE);
        // Raw, not rounded: rounding is the driver parse's job (parseOpencodeRunOutcome), and the
        // script carries the database's own number.
        expect(answer).toMatchObject({ id: 'ses_mine', finish: 'stop', tokens: 90433.4, cost: 0.31, error: null });
    });
});

describe.skipIf(!hasNodeSqlite())('the opencode session readout: errors and turn counting', () => {
    const fx = opencodeReadoutFixture();

    it('lifts the last provider error the session recorded', () => {
        const db = new DatabaseSync(fx.dbPath());
        insertMessage(db, 'ses_mine', { role: 'assistant', finish: 'tool-calls', tokens: { total: 100016 }, cost: 0 });
        insertMessage(db, 'ses_mine', {
            role: 'assistant',
            error: {
                name: 'APIError',
                data: { message: 'Error from provider (Console): Rate limit exceeded.', statusCode: 429 },
            },
        });
        db.close();

        const { answer } = fx.run(fx.dbPath(), MINE);
        expect(answer).toMatchObject({
            id: 'ses_mine',
            finish: 'tool-calls',
            tokens: 100016,
            error: 'Error from provider (Console): Rate limit exceeded.',
        });
    });

    it('counts the assistant responses of the root conversation, never a subagent child', () => {
        // The agent-turn definition: one assistant response cycle in the run's ROOT conversation.
        // A subagent's session is a CHILD under a parent_id — its messages belong to another
        // conversation, and the root-only session selection has to keep them out of the count.
        const CHILD_SESSION_CREATED = 3000;
        const db = new DatabaseSync(fx.dbPath());
        insertMessage(db, 'ses_mine', { role: 'user' });
        insertMessage(db, 'ses_mine', { role: 'assistant', finish: 'stop' });
        insertMessage(db, 'ses_mine', { role: 'assistant', finish: 'tool-calls' });
        insertMessage(db, 'ses_mine', { role: 'assistant', finish: 'stop' });
        // A child session under ses_mine: subagent conversation, never counted.
        db.prepare('insert into session (id, parent_id, directory, time_created) values (?, ?, ?, ?)').run(
            'ses_child',
            'ses_mine',
            MINE,
            CHILD_SESSION_CREATED
        );
        insertMessage(db, 'ses_child', { role: 'assistant', finish: 'stop' });
        insertMessage(db, 'ses_child', { role: 'assistant', finish: 'stop' });
        db.close();

        const ROOT_ASSISTANT_TURNS = 3;
        const { answer } = fx.run(fx.dbPath(), MINE);
        expect(answer.turns).toBe(ROOT_ASSISTANT_TURNS);
    });

    it('counts only the turns this run wrote, when the driver passes the run start', () => {
        // A follow-up RESUMES the root conversation: without the bound, its close-time read
        // would book the earlier runs' turns again, and the task total would overstate. The
        // bound is the run's own start (epoch ms); messages without a usable time cannot be
        // placed in either side, so they are skipped, never mis-booked.
        const db = new DatabaseSync(fx.dbPath());
        insertMessage(db, 'ses_mine', { role: 'assistant', finish: 'stop', time: { created: 1000 } });
        insertMessage(db, 'ses_mine', { role: 'assistant', finish: 'stop', time: { created: 9000 } });
        insertMessage(db, 'ses_mine', { role: 'assistant', finish: 'stop', time: { created: 9500 } });
        insertMessage(db, 'ses_mine', { role: 'assistant', finish: 'stop' });
        db.close();

        const TURNS_AFTER_BOUND = 2;
        const TURNS_UNBOUNDED = 4;
        const { answer } = fx.run(fx.dbPath(), MINE, '8000');
        expect(answer.turns).toBe(TURNS_AFTER_BOUND);
        // Without the bound the whole conversation counts, as before.
        expect(fx.run(fx.dbPath(), MINE).answer.turns).toBe(TURNS_UNBOUNDED);
    });

    it('reports the LAST error when the run errored, retried through it, and errored again', () => {
        const db = new DatabaseSync(fx.dbPath());
        insertMessage(db, 'ses_mine', {
            role: 'assistant',
            error: { name: 'APIError', data: { message: 'transient 500, retried through', statusCode: 500 } },
        });
        insertMessage(db, 'ses_mine', { role: 'assistant', finish: 'stop', tokens: { total: 5 }, cost: 0 });
        db.close();

        const { answer } = fx.run(fx.dbPath(), MINE);
        expect(answer.error).toBe('transient 500, retried through');
    });

    it('answers a session with no errors as error null', () => {
        const db = new DatabaseSync(fx.dbPath());
        insertMessage(db, 'ses_mine', { role: 'assistant', finish: 'stop', tokens: { total: 5 }, cost: 0 });
        db.close();

        const { answer } = fx.run(fx.dbPath(), MINE);
        expect(answer.error).toBeNull();
    });
});

describe.skipIf(!hasNodeSqlite())('the opencode session readout: run summary', () => {
    const fx = opencodeReadoutFixture();

    it('lifts the run summary: the last assistant text part, collapsed to one line', () => {
        // The text lives in `part` rows keyed by message_id — one row per block. The LAST
        // assistant message carrying text wins; a tool-only trailing turn does not erase it.
        const db = new DatabaseSync(fx.dbPath());
        db.exec('create table part (id integer primary key, message_id text, session_id text, data text)');
        const insert = db.prepare('insert into message (session_id, data) values (?, ?)');
        const m1 = insert.run('ses_mine', JSON.stringify({ role: 'assistant', finish: 'stop' }));
        const m2 = insert.run('ses_mine', JSON.stringify({ role: 'assistant', finish: 'stop' }));
        const insertPart = db.prepare('insert into part (message_id, session_id, data) values (?, ?, ?)');
        insertPart.run(String(m1.lastInsertRowid), 'ses_mine', JSON.stringify({ type: 'text', text: 'earlier' }));
        insertPart.run(String(m2.lastInsertRowid), 'ses_mine', JSON.stringify({ type: 'tool', tool: 'bash' }));
        insertPart.run(
            String(m2.lastInsertRowid),
            'ses_mine',
            JSON.stringify({ type: 'text', text: '  done —  tests\npass.  ' })
        );
        db.close();

        const { answer } = fx.run(fx.dbPath(), MINE);
        expect(answer.summary).toBe('done — tests pass.');
    });

    it('answers a null summary when the schema predates the part table — the summary degrades alone', () => {
        // An older opencode keeps no `part` rows: the summary read throws inside its own guard
        // and costs the summary, never the turns or the finish reason beside it.
        const db = new DatabaseSync(fx.dbPath());
        insertMessage(db, 'ses_mine', { role: 'assistant', finish: 'stop' });
        db.close();

        const { answer } = fx.run(fx.dbPath(), MINE);
        expect(answer.turns).toBe(1);
        expect(answer.summary).toBeNull();
    });

    it('bounds the summary to this run, like the turn count', () => {
        // A follow-up's summary is ITS last words, never the resumed conversation's older text.
        // The older-created message is the transcript's LAST: without the bound it wins on
        // position, with the bound it is skipped for being before the run started.
        const db = new DatabaseSync(fx.dbPath());
        db.exec('create table part (id integer primary key, message_id text, session_id text, data text)');
        const insert = db.prepare('insert into message (session_id, data) values (?, ?)');
        const fresh = insert.run('ses_mine', JSON.stringify({ role: 'assistant', time: { created: 9000 } }));
        const old = insert.run('ses_mine', JSON.stringify({ role: 'assistant', time: { created: 1000 } }));
        const insertPart = db.prepare('insert into part (message_id, session_id, data) values (?, ?, ?)');
        insertPart.run(String(fresh.lastInsertRowid), 'ses_mine', JSON.stringify({ type: 'text', text: 'new words' }));
        insertPart.run(String(old.lastInsertRowid), 'ses_mine', JSON.stringify({ type: 'text', text: 'old words' }));
        db.close();

        expect(fx.run(fx.dbPath(), MINE, '8000').answer.summary).toBe('new words');
        expect(fx.run(fx.dbPath(), MINE).answer.summary).toBe('old words');
    });
});
