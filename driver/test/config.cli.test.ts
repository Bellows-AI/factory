import { describe, expect, it } from 'vitest';
import { loadDriverConfig } from '../src/config.js';

/**
 * RUNNER_CLI selects which CLI the runner image speaks. In its own file rather than beside the
 * other config tests so each change to it stays one reviewable unit.
 */
describe('RUNNER_CLI', () => {
    it('defaults to claude-code, so an existing driver changes nothing', () => {
        expect(loadDriverConfig({}).cli).toBe('claude-code');
        expect(loadDriverConfig({ RUNNER_CLI: '' }).cli).toBe('claude-code');
    });

    it('accepts opencode', () => {
        expect(loadDriverConfig({ RUNNER_CLI: 'opencode' }).cli).toBe('opencode');
    });

    // A typo must not read as claude-code and hand every prompt to a CLI that answers with
    // "unknown flag" — the same fatal-enum rule EXECUTOR and JOB_BOARD_URL follow.
    it('refuses an unknown CLI rather than falling back', () => {
        for (const cli of ['claude', 'opencode-ai', 'OC', 'claude code']) {
            expect(() => loadDriverConfig({ RUNNER_CLI: cli }), `"${cli}"`).toThrow(/RUNNER_CLI/);
        }
    });

    // The image has to speak the selected CLI, so the default follows the switch. An explicit
    // EXECUTOR_IMAGE still wins — an operator pinning a registry image knows better than the
    // default. The empty string counts as unset: that is exactly what compose's
    // `${EXECUTOR_IMAGE:-}` delivers, and it is how the cli-aware default survives compose.
    it('defaults the image to the selected CLI\'s runner', () => {
        expect(loadDriverConfig({}).image).toBe('claude-executor');
        expect(loadDriverConfig({ RUNNER_CLI: 'opencode' }).image).toBe('opencode-executor');
        expect(loadDriverConfig({ RUNNER_CLI: 'opencode', EXECUTOR_IMAGE: '' }).image).toBe(
            'opencode-executor',
        );
        expect(loadDriverConfig({ RUNNER_CLI: 'opencode', EXECUTOR_IMAGE: 'registry/oc:2' }).image).toBe(
            'registry/oc:2',
        );
    });

    // Remote Control is claude-code's bridge: the auth volume, the tty and the idle-parking loop
    // all exist to serve a claude.ai session. A config that half-works is worse than one that
    // refuses to start — the job would run headless and simply never appear anywhere drivable.
    it('refuses Remote Control under opencode', () => {
        expect(() => loadDriverConfig({ RUNNER_CLI: 'opencode', RUNNER_REMOTE_CONTROL: '1' })).toThrow(
            /RUNNER_REMOTE_CONTROL.*RUNNER_CLI|RUNNER_CLI.*RUNNER_REMOTE_CONTROL/s,
        );
        expect(() => loadDriverConfig({ RUNNER_REMOTE_CONTROL: '1' })).not.toThrow();
    });

    // skipPermissions appends a claude-code flag. opencode takes its permissions from the
    // opencode.json baked into the image, so the flag would be a no-op that reads as a decision
    // made — the exact silent lie it exists to avoid.
    it('refuses skip-permissions under opencode', () => {
        expect(() => loadDriverConfig({ RUNNER_CLI: 'opencode', RUNNER_SKIP_PERMISSIONS: '1' })).toThrow(
            /RUNNER_SKIP_PERMISSIONS.*RUNNER_CLI|RUNNER_CLI.*RUNNER_SKIP_PERMISSIONS/s,
        );
        expect(() => loadDriverConfig({ RUNNER_SKIP_PERMISSIONS: '1' })).not.toThrow();
    });

    // The kubernetes runner carries opencode the same way the docker one does: `run
    // [--session <id>] <command>` argv, a session database persisted on the workspaces volume,
    // and the close-time scrape. The one refusal that remains is the cache watch's, which is
    // about the watch's own platform cost, not the CLI pair.
    it('loads under the kubernetes executor', () => {
        const loaded = loadDriverConfig({ RUNNER_CLI: 'opencode', EXECUTOR: 'kubernetes' });
        expect(loaded.cli).toBe('opencode');
        expect(loaded.executor).toBe('kubernetes');
        // Each half alone is fine too, as ever — the pair is not special.
        expect(loadDriverConfig({ RUNNER_CLI: 'opencode' }).executor).toBe('docker');
        expect(loadDriverConfig({ EXECUTOR: 'kubernetes' }).cli).toBe('claude-code');
    });
});

/**
 * RUNNER_CACHE_WATCH arms a mid-run kill switch over provider quality: the watch polls the
 * opencode session database for turns whose prompt cache stopped hitting, and kills the run when
 * enough consecutive turns have completed slow and uncached. Its own file, like RUNNER_CLI's,
 * because every combination it cannot survive is a decision to state at startup rather than a
 * surprise to discover mid-job.
 */
describe('RUNNER_CACHE_WATCH', () => {
    // Off by default, like every switch that kills work: arming it is something somebody typed.
    it('defaults to off, and the poll period keeps its default', () => {
        const off = loadDriverConfig({ RUNNER_CLI: 'opencode' });
        expect(off.cacheWatch).toBe(false);
        expect(off.cacheWatchPollMs).toBe(30_000);
    });

    it('accepts an explicit poll period', () => {
        expect(
            loadDriverConfig({ RUNNER_CLI: 'opencode', RUNNER_CACHE_WATCH: '1', RUNNER_CACHE_WATCH_POLL_MS: '5000' })
                .cacheWatchPollMs,
        ).toBe(5_000);
    });

    // The probe reads opencode's session database — a claude-code transcript answers nothing to
    // the query, and a watch that could never fire would read as a broken feature.
    it('refuses claude-code, where there is nothing to read', () => {
        expect(() => loadDriverConfig({ RUNNER_CACHE_WATCH: '1' })).toThrow(/RUNNER_CACHE_WATCH.*RUNNER_CLI|RUNNER_CLI.*RUNNER_CACHE_WATCH/s);
        expect(() => loadDriverConfig({ RUNNER_CLI: 'opencode', RUNNER_CACHE_WATCH: '1' })).not.toThrow();
    });

    // The watch stays docker-only on its own merits now: each tick is one throwaway container on
    // a warm daemon, while the kubernetes form would be a Job per tick — pod admission every
    // poll period, a tax no watch is worth paying the cluster. Pinned so the refusal survives a
    // reorder of the config checks.
    it('refuses the kubernetes executor, where every tick would be a Job', () => {
        expect(() =>
            loadDriverConfig({ RUNNER_CLI: 'opencode', RUNNER_CACHE_WATCH: '1', EXECUTOR: 'kubernetes' }),
        ).toThrow(/RUNNER_CACHE_WATCH.*EXECUTOR=kubernetes|EXECUTOR=kubernetes.*RUNNER_CACHE_WATCH/s);
        // And each half alone is fine — the refusal is about the pair, not either half.
        expect(() => loadDriverConfig({ RUNNER_CLI: 'opencode', RUNNER_CACHE_WATCH: '1' })).not.toThrow();
        expect(() => loadDriverConfig({ RUNNER_CACHE_WATCH: '1' })).toThrow(/RUNNER_CLI=claude-code/);
    });

    // Remote Control needs no refusal of its own: it requires claude-code, and the claude-code
    // refusal above already fires — an armed watch is headless by construction. Pinned here so
    // that invariant survives a later reorder of the checks.
    it('is unrepresentable under Remote Control', () => {
        expect(() =>
            loadDriverConfig({ RUNNER_CACHE_WATCH: '1', RUNNER_REMOTE_CONTROL: '1' }),
        ).toThrow(/RUNNER_CLI=claude-code/);
        expect(() =>
            loadDriverConfig({
                RUNNER_CLI: 'opencode',
                RUNNER_CACHE_WATCH: '1',
                RUNNER_REMOTE_CONTROL: '1',
            }),
        ).toThrow(/RUNNER_REMOTE_CONTROL is not supported under RUNNER_CLI=opencode/);
    });
});
