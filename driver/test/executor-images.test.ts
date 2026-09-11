import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The executor images carry the branch reporter — the in-container twin of
 * plugins/agent-telemetry — and nothing else in the offline suite reads these files, so the
 * assertions here are what pins the wire contract and the entrypoint wiring. The build contexts
 * are the image directories, so a file that goes missing fails here instead of silently
 * un-attributing every executor run.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const CLAUDE_REPORTER = 'docker/claude-executor/branch-reporter.cjs';
const OPENCODE_REPORTER = 'docker/opencode-executor/branch-reporter.cjs';

describe('the executor branch reporter', () => {
    // Deliberate copies, like the collector's per-branch blocks: one file per image, byte-equal
    // after the agent constant, so a fix to one lands in the other by construction. The agent
    // values are exactly the ones agentOf() derives from the OTLP metric names — a mismatch here
    // would report branch spans no session summary would ever join to.
    it('ships in both images, identical except the agent it reports as', () => {
        const claude = read(CLAUDE_REPORTER);
        const opencode = read(OPENCODE_REPORTER);
        const stripAgent = (s: string) => s.replace(/const AGENT = '[^']+';/, "const AGENT = 'X';");
        expect(stripAgent(opencode)).toBe(stripAgent(claude));
        expect(claude).toContain("const AGENT = 'claude-code';");
        expect(opencode).toContain("const AGENT = 'opencode';");
    });

    // claude-home/ cannot hold it: the Remote Control auth volume mounts over CLAUDE_CONFIG_DIR
    // and would shadow the script on exactly the runs that most want to be attributed.
    it('is copied to /usr/local/bin by both Dockerfiles, never into a config home', () => {
        for (const dir of ['docker/claude-executor', 'docker/opencode-executor']) {
            const dockerfile = read(`${dir}/Dockerfile`);
            expect(dockerfile).toMatch(
                new RegExp(`COPY[^\\n]*branch-reporter\\.cjs /usr/local/bin/branch-reporter\\.cjs`),
            );
            expect(dockerfile).not.toMatch(/home\/COPY[^\n]*branch-reporter/);
            expect(dockerfile).not.toMatch(/branch-reporter[^\n]*-home\//);
        }
    });

    // The entrypoint shape: launched beside the CLI (never as its child, so a CLI crash cannot
    // take it down mid-run), stdio discarded (the run's output stream is the CLI's), a close-time
    // `--once` sample, and the CLI's exit status preserved through the `exec` it replaced.
    it.each([
        ['docker/claude-executor/entrypoint.sh', 'claude'],
        ['docker/opencode-executor/entrypoint.sh', 'opencode'],
    ])('%s launches the reporter beside the CLI and samples once at close', (entrypoint, cli) => {
        const entry = read(entrypoint);
        // --disable-warning: node:sqlite still emits an ExperimentalWarning on stderr, and the
        // reporter's contract is that IT never speaks — node's own warning must not either.
        expect(entry).toMatch(
            /node --disable-warning=ExperimentalWarning \/usr\/local\/bin\/branch-reporter\.cjs >\/dev\/null 2>&1 &\n/,
        );
        expect(entry).toMatch(/branch-reporter\.cjs --once/);
        // The CLI runs as a foreground child now, so the close-time sample can run after it;
        // a leftover `exec` would turn the script into the PID-1 replacement and skip it.
        expect(entry).not.toMatch(new RegExp(`^exec ${cli} `, 'm'));
        expect(entry).toMatch(new RegExp(`^${cli} "\\$@"$`, 'm'));
        expect(entry).toMatch(/exit "\$STATUS"/);
    });

    // opencode mints its own session ids and tells nobody before the run starts — discovery
    // polls the session database live. The query must be the shipped readout's: the readout is
    // what decided "newest root session" means the run's own conversation (subagents create
    // children), and the two readers must never disagree about which row that is.
    it('discovers the opencode session with the shipped readout’s exact query', () => {
        const query = 'select id from session where parent_id is null order by time_created desc limit 1';
        expect(read(OPENCODE_REPORTER)).toContain(query);
        expect(read('driver/src/scripts/opencode-readout.cjs')).toContain(query);
    });
});
