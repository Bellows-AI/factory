// The close-time opencode transcript export (issue #325): the run's root conversation — the
// per-run delta of it, exactly like the readout's turn count — printed as JSONL on stdout,
// tail-kept to a byte cap, for the driver to upload to the board as the attempt's `transcript`
// artifact. Opencode keeps no file a reader could open (its records live in the per-member sqlite
// database), so this read is the export: one JSON line per message, `{role, time, text}`, in
// conversation order — a reshaped view, not raw database bytes, for the same reason the readout
// never prints them.
//
// Environment (set by the driver; paths, never credentials):
//   OPENCODE_DB            — the session database (see opencode-readout.cjs).
//   OPENCODE_DIR           — the working directory the run had. The database is per MEMBER, so the
//                            scope is what keeps this export answering only the session of the
//                            task that ran here, never whichever task closed last.
//   RUN_STARTED_MS         — the run's start as epoch ms. A follow-up RESUMES the root
//                            conversation, so only messages created at or after this instant are
//                            this run's. Absent, the whole conversation is exported.
//   TRANSCRIPT_LIMIT_BYTES — the byte cap. The LAST bytes are kept, cut at a line boundary; when
//                            anything was dropped, the FIRST output line is a marker:
//                            {"truncated":true,"droppedLines":N}. The driver sniffs and strips
//                            that line; everything after it is the export's own JSONL.
//
// The role is a field INSIDE the message's data JSON, not a column (see opencode-readout.cjs for
// why the filter runs in JS). The message text lives in `part` rows — one row per block, keyed by
// message_id — and a database whose schema predates the table costs the text alone, never the
// rest of the export. Any failure prints one parseable error line.
const { DatabaseSync } = require('node:sqlite');

const RUN_STARTED_MS = Number(process.env.RUN_STARTED_MS);
const BYTE_LIMIT = Number(process.env.TRANSCRIPT_LIMIT_BYTES);

try {
    const dbPath = process.env.OPENCODE_DB;
    const dir = process.env.OPENCODE_DIR;
    if (!dbPath) throw new Error('OPENCODE_DB is not set');
    if (!dir)
        throw new Error(
            'OPENCODE_DIR is not set: the session database is per member, so an export without a directory answers whichever task closed last'
        );
    if (!Number.isFinite(BYTE_LIMIT) || BYTE_LIMIT <= 0) throw new Error('TRANSCRIPT_LIMIT_BYTES is not a byte cap');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const s = db
        .prepare('select id from session where parent_id is null and directory = ? order by time_created desc limit 1')
        .get(dir);
    if (!s || !s.id) throw new Error(`no session ran in ${dir}`);

    // The text parts, keyed by message id — the same join the readout's summary read makes. A
    // schema without the table costs the text alone; the export still answers.
    const texts = new Map();
    try {
        for (const p of db.prepare('select message_id, data from part where session_id=? order by id').all(s.id)) {
            const d = JSON.parse(p.data);
            if (d.type !== 'text' || typeof d.text !== 'string' || !d.text.trim()) continue;
            const held = texts.get(String(p.message_id));
            texts.set(String(p.message_id), held ? `${held} ${d.text}` : d.text);
        }
    } catch {
        // No part table (or an unreadable one): every message exports with text null.
    }

    const lines = [];
    for (const m of db.prepare('select id, data from message where session_id=? order by id').all(s.id)) {
        let d;
        try {
            d = JSON.parse(m.data);
        } catch {
            continue;
        }
        const role = d.role === 'assistant' || d.role === 'user' ? d.role : null;
        if (!role) continue;
        // The per-run delta, the readout's own rule: a message whose created time predates this
        // run belongs to the run (or runs) before it, and one with no usable time cannot be
        // placed in either — skipped rather than mis-booked.
        const created = d.time && typeof d.time.created === 'number' ? d.time.created : null;
        if (!Number.isNaN(RUN_STARTED_MS) && (created === null || created < RUN_STARTED_MS)) continue;
        const text = texts.get(String(m.id));
        lines.push(JSON.stringify({ role, time: created, text: typeof text === 'string' ? text : null }));
    }

    // Tail-keep at the cap, cut at a line boundary — the conversation's last words are what an
    // investigating reader needs — with the marker line saying what was dropped.
    const kept = [];
    let bytes = 0;
    let droppedLines = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const size = Buffer.byteLength(lines[i] + '\n', 'utf8');
        if (bytes + size > BYTE_LIMIT && kept.length > 0) {
            droppedLines = i + 1;
            break;
        }
        kept.unshift(lines[i]);
        bytes += size;
    }
    if (droppedLines > 0) {
        console.log(JSON.stringify({ truncated: true, droppedLines }));
    }
    for (const line of kept) console.log(line);
} catch (e) {
    console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
}
