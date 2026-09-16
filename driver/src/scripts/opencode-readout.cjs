// The close-time opencode readout: one read-only query pair against the session database a
// finished run left behind — the ROOT session that ran in OPENCODE_DIR (subagents create children
// under a parent_id; the conversation a follow-up continues is the run's own root) and, from its
// messages, the finish reason of the run's last word, the context it reached, its cost, the last
// provider error it recorded, and the run's summary (the last assistant TEXT, what the run did,
// in the agent's own words). One JSON line on stdout; a failure prints one parseable error
// line — an empty answer and a broken query are otherwise indistinguishable to the parse.
//
// Environment (set by the driver; paths, never credentials):
//   OPENCODE_DB  — the session database: <workspaces>/<org>/<uuid>/.opencode/opencode/opencode.db.
//   OPENCODE_DIR — the working directory the run had. The database is per MEMBER (that is what
//                  makes a follow-up's `--session` resumable at all), so two concurrent tasks
//                  share one file: the scope is what keeps this readout answering only the
//                  session of the task that ran here, never whichever task closed last.
//   RUN_STARTED_MS — the run's start as epoch ms. A follow-up RESUMES the root conversation, so
//                  the turn count and the summary are bounded to messages created at or after
//                  this instant — the run's own delta, never the earlier runs' turns again.
//                  Absent, the whole conversation is counted (the pre-delta shape, kept for
//                  tolerance).
//
// The role is a field INSIDE the message's data JSON, not a column: filtering it in SQL throws
// "no such column: role" on every read, and the failure reads as an empty database. Filtered
// in JS instead, where the parsed role actually is. The message text lives in `part` rows —
// one row per block, keyed by message_id — and a database whose schema predates the table (or
// otherwise refuses the summary read) costs the summary alone, never the rest of the line.
const { DatabaseSync } = require('node:sqlite');

const RUN_STARTED_MS = Number(process.env.RUN_STARTED_MS);
const SUMMARY_MAX_CHARS = 400;

try {
    const dbPath = process.env.OPENCODE_DB;
    const dir = process.env.OPENCODE_DIR;
    if (!dbPath) throw new Error('OPENCODE_DB is not set');
    if (!dir)
        throw new Error(
            'OPENCODE_DIR is not set: the session database is per member, so a readout without a directory answers whichever task closed last'
        );
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const s = db
        .prepare('select id from session where parent_id is null and directory = ? order by time_created desc limit 1')
        .get(dir);
    if (s && s.id) {
        const msgs = db.prepare('select id, data from message where session_id=? order by id').all(s.id);
        let finish = null;
        let tokens = 0;
        let cost = 0;
        let error = null;
        // The agent-turn count: assistant messages of the ROOT session only. Subagent
        // conversations are child sessions under a parent_id, and the session selection above
        // already excluded them — what is left here is exactly the run's own conversation.
        let turns = 0;
        // The run's assistant messages, in conversation order — the summary walks them from
        // the end once the parts are in hand.
        const assistantIds = [];
        for (const m of msgs) {
            const d = JSON.parse(m.data);
            if (d.role !== 'assistant') continue;
            // The per-run delta: a message whose own created time predates this run belongs to
            // the run (or runs) before it. A message with no usable time cannot be placed in
            // either — skipped rather than mis-booked, for the same reason a parse miss is null.
            if (!Number.isNaN(RUN_STARTED_MS)) {
                const created = d.time && typeof d.time.created === 'number' ? d.time.created : null;
                if (created === null || created < RUN_STARTED_MS) continue;
            }
            turns += 1;
            assistantIds.push(String(m.id));
            if (d.finish) finish = d.finish;
            if (d.tokens && typeof d.tokens.total === 'number') tokens = Math.max(tokens, d.tokens.total);
            if (typeof d.cost === 'number') cost += d.cost;
            // The run's last word on why it stopped — an APIError whose provider message is the
            // premature stop's cause. The LAST one wins: an error opencode retried through is
            // history, and only the final rejection explains how the run ended.
            const message = d.error && (d.error.data?.message ?? d.error.message);
            if (typeof message === 'string' && message) error = message;
        }
        let summary = null;
        try {
            const texts = new Map();
            for (const p of db.prepare('select message_id, data from part where session_id=? order by id').all(s.id)) {
                const d = JSON.parse(p.data);
                if (d.type !== 'text' || typeof d.text !== 'string' || !d.text.trim()) continue;
                const held = texts.get(String(p.message_id));
                texts.set(String(p.message_id), held ? `${held} ${d.text}` : d.text);
            }
            for (let i = assistantIds.length - 1; i >= 0; i -= 1) {
                const text = texts.get(assistantIds[i]);
                if (!text) continue;
                summary = text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX_CHARS);
                break;
            }
        } catch {
            summary = null;
        }
        console.log(JSON.stringify({ id: s.id, finish, tokens, cost, turns, summary, error }));
    } else {
        console.log(JSON.stringify({ error: `no session ran in ${dir}` }));
    }
} catch (e) {
    console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
}
