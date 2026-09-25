import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every module in `core/src` must be re-exported from `core/src/index.ts`. The server and web
 * resolve `@factory-ai/core` to `core/dist`, so a new file that nobody re-exports is invisible to
 * them, and the failure it produces — "module has no exported member" — reads exactly like a stale
 * `core/dist` or a source bug, which is the trap AGENTS.md warns about under "Build coupling".
 *
 * This is a set comparison between a directory listing and one file's export lines, so it is not
 * expressible as a Biome/Grit pattern (those are per-file); it lives here beside the other
 * meta-tests instead, and fails with the name of the file that was forgotten.
 */

const dir = new URL('../src/', import.meta.url);
const index = readFileSync(new URL('index.ts', dir), 'utf8');

const modules = readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
    .map((name) => name.replace(/\.ts$/, ''));

describe('core/src/index.ts', () => {
    it('re-exports every module in core/src', () => {
        const missing = modules.filter((name) => !index.includes(`from './${name}.js'`));
        expect(missing).toEqual([]);
    });

    it('has modules to check', () => {
        // Guards the assertion above against a listing that silently went empty.
        expect(modules.length).toBeGreaterThan(0);
    });
});
