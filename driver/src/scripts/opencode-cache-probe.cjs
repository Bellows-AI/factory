// The live cache probe: the newest root session's newest completed assistant turns, read-only,
// while a run is LIVE (sqlite's WAL serves a reader beside a writer). The driver polls this
// every CACHE_WATCH_POLL_MS and kills a run whose provider stopped serving prompt cache — the
// close-time readout answers the same question, but only once the run is over, and a corpse
// reports nothing.
//
// Environment (set by the driver; a path and a constant, never credentials):
//   OPENCODE_DB       — the session database: <workspaces>/<org>/<uuid>/.opencode/opencode/opencode.db;
//   CACHE_WATCH_TURNS — how many completed turns the verdict inspects (the driver's
//                       CACHE_WATCH_TURNS constant, so the trigger cannot drift between here
//                       and the code that judges the turns).
//
// The role is a field INSIDE the message's data JSON, not a column — filtered in JS, for the
// same reason the close-time readout gives. One JSON line on stdout; a failure prints one
// parseable error line.
const { DatabaseSync } = require('node:sqlite');

const TURNS = Number(process.env.CACHE_WATCH_TURNS);

try {
    const db = new DatabaseSync(process.env.OPENCODE_DB, { readOnly: true });
    const s = db.prepare('select id from session where parent_id is null order by time_created desc limit 1').get();
    if (s && s.id) {
        const msgs = db.prepare('select data from message where session_id=? order by id desc limit 12').all(s.id);
        const turns = [];
        for (const m of msgs) {
            const d = JSON.parse(m.data);
            if (d.role !== 'assistant') continue;
            const t = d.time || {};
            if (!t.completed) continue;
            const tk = d.tokens || {};
            turns.push({
                input: tk.input || 0,
                cacheRead: (tk.cache || {}).read || 0,
                ms: t.completed - (t.created || t.completed),
            });
            if (turns.length >= TURNS) break;
        }
        console.log(JSON.stringify({ id: s.id, turns }));
    }
} catch (e) {
    console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
}
