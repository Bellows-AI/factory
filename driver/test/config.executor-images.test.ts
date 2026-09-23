import { describe, expect, it } from 'vitest';
import { executorImage, loadDriverConfig } from '../src/config.js';

describe('task-selected executor images', () => {
    it('loads both executor images because one driver may claim either task type', () => {
        const config = loadDriverConfig({});
        expect(config.executorImages).toEqual({
            'claude-code': 'claude-executor',
            opencode: 'opencode-executor',
        });
    });

    it('allows deployment-specific image locations without changing task routing', () => {
        const config = loadDriverConfig({
            CLAUDE_EXECUTOR_IMAGE: 'registry/claude:2',
            OPENCODE_EXECUTOR_IMAGE: 'registry/opencode:3',
        });
        expect(executorImage(config, 'claude-code')).toBe('registry/claude:2');
        expect(executorImage(config, 'opencode')).toBe('registry/opencode:3');
    });

    it('refuses an unresolved task executor instead of choosing a fallback image', () => {
        expect(() => executorImage(loadDriverConfig({}), null)).toThrow(/no configured executor type/);
    });

    it('loads both task types under the kubernetes executor too', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes' });
        expect(config.executor).toBe('kubernetes');
        expect(config.executorImages['claude-code']).toBe('claude-executor');
        expect(config.executorImages.opencode).toBe('opencode-executor');
    });
});

describe('RUNNER_CACHE_WATCH', () => {
    const DEFAULT_CACHE_WATCH_POLL_MS = 30_000;

    it('defaults to off, and the poll period keeps its default', () => {
        const off = loadDriverConfig({});
        expect(off.cacheWatch).toBe(false);
        expect(off.cacheWatchPollMs).toBe(DEFAULT_CACHE_WATCH_POLL_MS);
    });

    it('accepts an explicit poll period for OpenCode tasks on the docker executor', () => {
        expect(loadDriverConfig({ RUNNER_CACHE_WATCH: '1', RUNNER_CACHE_WATCH_POLL_MS: '5000' })).toMatchObject({
            cacheWatch: true,
            cacheWatchPollMs: 5_000,
        });
    });

    it('refuses the kubernetes executor, where every tick would be a Job', () => {
        expect(() => loadDriverConfig({ RUNNER_CACHE_WATCH: '1', EXECUTOR: 'kubernetes' })).toThrow(
            /RUNNER_CACHE_WATCH.*EXECUTOR=kubernetes|EXECUTOR=kubernetes.*RUNNER_CACHE_WATCH/s
        );
    });
});
