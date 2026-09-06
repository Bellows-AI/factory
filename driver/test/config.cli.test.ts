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

    // The kubernetes runner speaks claude-code only: its Job spec is `--session-id`/`--resume`
    // argv, and an opencode job arrives with no session at all. Left runnable, every claim would
    // burn an attempt on the runner's own refusal — discovered mid-job what the loader exists to
    // catch at startup.
    it('refuses the kubernetes executor under opencode', () => {
        expect(() => loadDriverConfig({ RUNNER_CLI: 'opencode', EXECUTOR: 'kubernetes' })).toThrow(
            /RUNNER_CLI=opencode.*EXECUTOR=kubernetes|EXECUTOR=kubernetes.*RUNNER_CLI=opencode/s,
        );
        // And each alone is fine — the refusal is about the pair, not either half.
        expect(() => loadDriverConfig({ RUNNER_CLI: 'opencode' })).not.toThrow();
        expect(() => loadDriverConfig({ EXECUTOR: 'kubernetes' })).not.toThrow();
    });
});
