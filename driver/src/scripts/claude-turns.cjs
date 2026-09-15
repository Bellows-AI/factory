// The close-time claude-code turn count: how many assistant response cycles the run's ROOT
// conversation took, read from the transcript the run wrote onto the workspaces volume while it
// lived (FACTORY_TRANSCRIPT_DIR is the runner's CLAUDE_CONFIG_DIR, so the transcript is on disk
// the moment the CLI writes it — nothing dies with the container). One JSON line on stdout; any
// failure prints `{ "turns": null }` with the reason — unmeasured, never zero.
//
// Environment (set by the driver; paths, never credentials):
//   CLAUDE_TRANSCRIPT_DIR — the thread's transcript directory: the path the runner passed as
//                           FACTORY_TRANSCRIPT_DIR. The CLI munges the working directory into
//                           projects/<dir>/, so the transcript is found by glob, not by guess.
//   CLAUDE_SESSION_ID     — the session id the run was given. The file IS the session: matching
//                           the id excludes subagent conversations, which the CLI records under
//                           their own session ids (and, in older layouts, marks isSidechain on
//                           the entries — excluded here too, the same root-only rule either way).
//
// The parse is pinned to the shapes below: a JSONL file where each line is an event object and
// an assistant response is a `type: "assistant"` entry. A parse miss is null, not a wrong
// number — a CLI that changes its transcript shape costs its turn figure, never corrupts it.
const fs = require('node:fs');
const path = require('node:path');

try {
    const dir = process.env.CLAUDE_TRANSCRIPT_DIR;
    const sessionId = process.env.CLAUDE_SESSION_ID;
    if (!dir) throw new Error('CLAUDE_TRANSCRIPT_DIR is not set');
    if (!sessionId) throw new Error('CLAUDE_SESSION_ID is not set');
    if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) throw new Error(`not a session id: ${sessionId}`);

    const projects = path.join(dir, 'projects');
    const found = fs
        .readdirSync(projects, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(projects, e.name, `${sessionId}.jsonl`))
        .find((file) => fs.existsSync(file));
    if (!found) throw new Error(`no transcript for session ${sessionId} under ${projects}`);

    let turns = 0;
    for (const line of fs.readFileSync(found, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (entry.type !== 'assistant') continue;
        // A sidechain entry is a subagent conversation riding the same file — not the run's
        // own conversation, never counted.
        if (entry.isSidechain === true) continue;
        turns += 1;
    }
    console.log(JSON.stringify({ turns }));
} catch (e) {
    console.log(JSON.stringify({ turns: null, error: e instanceof Error ? e.message : String(e) }));
}
