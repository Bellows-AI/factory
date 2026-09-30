// The close-time claude-code transcript export (issue #325): the run's session transcript — the
// per-run delta of it, exactly like the turn count — printed as JSONL on stdout, tail-kept to a
// byte cap, for the driver to upload to the board as the attempt's `transcript` artifact. The
// transcript itself already persists on the workspaces volume (FACTORY_TRANSCRIPT_DIR is the
// runner's CLAUDE_CONFIG_DIR, issue #55); this read lifts the run's own slice of it onto the
// board, where an investigating client can fetch it without volume access.
//
// Environment (set by the driver; paths, never credentials):
//   CLAUDE_TRANSCRIPT_DIR  — the thread's transcript directory (see claude-turns.cjs).
//   CLAUDE_SESSION_ID      — the session id the run was given; matching it excludes subagent
//                            conversations under the newer layout, which record them under
//                            their own session ids and files. (Older layouts rode sidechain
//                            entries in the same file; the export keeps every line the session's
//                            file carries — it is the transcript, not a count.)
//   RUN_STARTED_AT         — the run's start as an ISO instant. A follow-up RESUMES this
//                            transcript, so only entries written at or after the run began are
//                            this run's. Absent, the whole transcript is exported.
//   TRANSCRIPT_LIMIT_BYTES — the byte cap. The LAST bytes are kept, cut at a line boundary; when
//                            anything was dropped, the FIRST output line is a marker:
//                            {"truncated":true,"droppedLines":N}. The driver sniffs and strips
//                            that line; everything after it is the transcript's own JSONL.
//
// Any failure prints one parseable error line — `{"error": ...}` — and nothing else: an empty
// answer and a broken read are otherwise indistinguishable to the parser.
const fs = require('node:fs');
const path = require('node:path');

const RUN_STARTED_MS = Date.parse(process.env.RUN_STARTED_AT ?? '');
const BYTE_LIMIT = Number(process.env.TRANSCRIPT_LIMIT_BYTES);

try {
    const dir = process.env.CLAUDE_TRANSCRIPT_DIR;
    const sessionId = process.env.CLAUDE_SESSION_ID;
    if (!dir) throw new Error('CLAUDE_TRANSCRIPT_DIR is not set');
    if (!sessionId) throw new Error('CLAUDE_SESSION_ID is not set');
    if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) throw new Error(`not a session id: ${sessionId}`);
    if (!Number.isFinite(BYTE_LIMIT) || BYTE_LIMIT <= 0) throw new Error('TRANSCRIPT_LIMIT_BYTES is not a byte cap');

    const projects = path.join(dir, 'projects');
    const found = fs
        .readdirSync(projects, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(projects, e.name, `${sessionId}.jsonl`))
        .find((file) => fs.existsSync(file));
    if (!found) throw new Error(`no transcript for session ${sessionId} under ${projects}`);

    // The per-run delta, line-granular like the transcript itself: an entry written before this
    // run began belongs to the run (or runs) before it. An entry with no timestamp cannot be
    // placed in either — skipped rather than mis-booked, the same rule the turn count keeps.
    const lines = [];
    for (const line of fs.readFileSync(found, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        if (!Number.isNaN(RUN_STARTED_MS)) {
            let at = null;
            try {
                const entry = JSON.parse(line);
                at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : null;
            } catch {
                at = null;
            }
            if (at === null || Number.isNaN(at) || at < RUN_STARTED_MS) continue;
        }
        lines.push(line);
    }

    // Tail-keep at the cap, cut at a line boundary: the run's last words are what an
    // investigating reader needs, the head is session preamble. Whatever was dropped is said by
    // the marker line, so a reader knows the head exists somewhere else.
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
