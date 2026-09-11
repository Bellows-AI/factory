// The close-time opencode readout: one read-only query pair against the session database a
// finished run left behind — the ROOT session that ran in OPENCODE_DIR (subagents create children
// under a parent_id; the conversation a follow-up continues is the run's own root) and, from its
// messages, the finish reason of the run's last word, the context it reached, its cost, and the
// last provider error it recorded. One JSON line on stdout; a failure prints one parseable error
// line — an empty answer and a broken query are otherwise indistinguishable to the parse.
//
// Environment (set by the driver; paths, never credentials):
//   OPENCODE_DB  — the session database: <workspaces>/<org>/<uuid>/.opencode/opencode/opencode.db.
//   OPENCODE_DIR — the working directory the run had. The database is per MEMBER (that is what
//                  makes a follow-up's `--session` resumable at all), so two concurrent tasks
//                  share one file: the scope is what keeps this readout answering only the
//                  session of the task that ran here, never whichever task closed last.
//
// The role is a field INSIDE the message's data JSON, not a column: filtering it in SQL throws
// "no such column: role" on every read, and the failure reads as an empty database. Filtered
// in JS instead, where the parsed role actually is.
const { DatabaseSync } = require('node:sqlite');

try {
    const dbPath = process.env.OPENCODE_DB;
    const dir = process.env.OPENCODE_DIR;
    if (!dbPath) throw new Error('OPENCODE_DB is not set');
    if (!dir) throw new Error('OPENCODE_DIR is not set: the session database is per member, so a readout without a directory answers whichever task closed last');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const s = db
        .prepare('select id from session where parent_id is null and directory = ? order by time_created desc limit 1')
        .get(dir);
    if (s && s.id) {
        const msgs = db.prepare('select data from message where session_id=? order by id').all(s.id);
        let finish = null;
        let tokens = 0;
        let cost = 0;
        let error = null;
        for (const m of msgs) {
            const d = JSON.parse(m.data);
            if (d.role !== 'assistant') continue;
            if (d.finish) finish = d.finish;
            if (d.tokens && typeof d.tokens.total === 'number') tokens = Math.max(tokens, d.tokens.total);
            if (typeof d.cost === 'number') cost += d.cost;
            // The run's last word on why it stopped — an APIError whose provider message is the
            // premature stop's cause. The LAST one wins: an error opencode retried through is
            // history, and only the final rejection explains how the run ended.
            const message = d.error && (d.error.data?.message ?? d.error.message);
            if (typeof message === 'string' && message) error = message;
        }
        console.log(JSON.stringify({ id: s.id, finish, tokens, cost, error }));
    } else {
        console.log(JSON.stringify({ error: `no session ran in ${dir}` }));
    }
} catch (e) {
    console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
}
