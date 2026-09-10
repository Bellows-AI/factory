// The close-time opencode readout: one read-only query pair against the session database a
// finished run left behind — the newest ROOT session (subagents create children under a
// parent_id; the conversation a follow-up continues is the run's own root) and, from its
// messages, the finish reason of the run's last word, the context it reached, and its cost.
// One JSON line on stdout; a failure prints one parseable error line — an empty answer and a
// broken query are otherwise indistinguishable to the parse.
//
// Environment (set by the driver; a path, never a credential):
//   OPENCODE_DB — the session database: <workspaces>/<org>/<uuid>/.opencode/opencode/opencode.db.
//
// The role is a field INSIDE the message's data JSON, not a column: filtering it in SQL throws
// "no such column: role" on every read, and the failure reads as an empty database. Filtered
// in JS instead, where the parsed role actually is.
const { DatabaseSync } = require('node:sqlite');

try {
    const db = new DatabaseSync(process.env.OPENCODE_DB, { readOnly: true });
    const s = db.prepare('select id from session where parent_id is null order by time_created desc limit 1').get();
    if (s && s.id) {
        const msgs = db.prepare('select data from message where session_id=? order by id').all(s.id);
        let finish = null;
        let tokens = 0;
        let cost = 0;
        for (const m of msgs) {
            const d = JSON.parse(m.data);
            if (d.role !== 'assistant') continue;
            if (d.finish) finish = d.finish;
            if (d.tokens && typeof d.tokens.total === 'number') tokens = Math.max(tokens, d.tokens.total);
            if (typeof d.cost === 'number') cost += d.cost;
        }
        console.log(JSON.stringify({ id: s.id, finish, tokens, cost }));
    }
} catch (e) {
    console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
}
