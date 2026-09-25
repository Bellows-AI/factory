import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Resolved lazily: a missing devDependency must fail the behavior cases, not
// abort suite collection before the declarative cases report.
const biomeBin = () =>
    join(dirname(createRequire(import.meta.url).resolve('@biomejs/biome/package.json')), 'bin', 'biome');

// A tree-wide format drift prints a diff per file; the 1 MiB default would overflow
// exactly when the failure message matters most.
const BYTES_PER_KIB = 1024;
const SPAWN_MAX_BUFFER_MIB = 16;
const SPAWN_MAX_BUFFER_BYTES = SPAWN_MAX_BUFFER_MIB * BYTES_PER_KIB * BYTES_PER_KIB;

const runBiome = (args: string[], options: { cwd?: string; input?: string } = {}) =>
    spawnSync(process.execPath, [biomeBin(), ...args], {
        encoding: 'utf8',
        cwd: options.cwd ?? root,
        input: options.input,
        maxBuffer: SPAWN_MAX_BUFFER_BYTES,
    });

describe('biome', () => {
    it('is configured at the root with the style the tree is written in', () => {
        expect(existsSync(join(root, 'biome.json')), 'biome.json missing at the repo root').toBe(true);
        const config = JSON.parse(readFileSync(join(root, 'biome.json'), 'utf8'));
        expect(config.formatter).toMatchObject({
            indentStyle: 'space',
            indentWidth: 4,
            lineWidth: 120,
            lineEnding: 'lf',
        });
        expect(config.javascript.formatter).toMatchObject({
            quoteStyle: 'single',
            jsxQuoteStyle: 'double',
            semicolons: 'always',
            trailingCommas: 'es5',
            arrowParentheses: 'always',
        });
        expect(config.linter).toMatchObject({ enabled: true });
        expect(config.linter.rules.preset).toBe('recommended');
        for (const glob of ['core/**', 'server/**', 'web/**', 'driver/**']) {
            expect(config.files.includes).toContain(glob);
        }
    });

    it('loads every lint plugin in lint/', () => {
        const config = JSON.parse(readFileSync(join(root, 'biome.json'), 'utf8'));
        for (const plugin of [
            './lint/no-shared-literals.grit',
            './lint/no-inline-container-scripts.grit',
            './lint/no-cross-package-imports.grit',
        ]) {
            expect(config.plugins, `${plugin} is not loaded`).toContain(plugin);
            expect(existsSync(join(root, plugin)), `${plugin} is missing`).toBe(true);
        }
    });

    /**
     * A Grit plugin that fails to compile does NOT fail the run: Biome reports
     * "<plugin> errored: …" once per file at `info` severity and then matches nothing, so a broken
     * ratchet is indistinguishable from a clean one. The known way in is a regex alternation group
     * — Grit binds a group to a variable, so `(src|test)` compiles to "matched 1 variables, but
     * expected 0". Assert the absence of that message, not just the absence of hits.
     *
     * Scoped to one directory rather than the tree: a plugin that fails to compile says so once per
     * file it visits, so any non-empty file set proves it, and the tree-wide spawn below is already
     * the suite's heaviest single operation — running a second one here timed out under the
     * contention of a full run while passing in isolation.
     */
    it('runs every plugin without a compile error', () => {
        const result = runBiome(['check', 'driver/src', '--reporter=json', '--max-diagnostics=2000']);
        expect(result.stdout, `biome printed no JSON report:\n${result.stderr}`).not.toBe('');
        const report = JSON.parse(result.stdout) as { diagnostics?: { category?: string; message?: string }[] };
        const errored = (report.diagnostics ?? []).filter(
            (d) => d.category === 'plugin' && /errored:/.test(d.message ?? '')
        );
        expect(
            errored.map((d) => d.message),
            'a lint plugin failed to compile'
        ).toEqual([]);
    });

    it('exposes the lint and format scripts and an exact-pinned biome devDependency', () => {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        expect(pkg.scripts.lint).toBe('biome check .');
        expect(pkg.scripts.format).toBe('biome format --write .');
        expect(pkg.devDependencies['@biomejs/biome']).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('formats a violating snippet into the pinned style', () => {
        const messy = 'const a = 1\nfunction f() {\n\treturn "text";\n}\n';
        const result = runBiome(['format', '--stdin-file-path=core/style-probe.ts'], { input: messy });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("const a = 1;\nfunction f() {\n    return 'text';\n}\n");
    });

    it('still fails a file that violates a rule (negative control)', () => {
        const result = runBiome(['lint', '--stdin-file-path=core/bad-probe.ts'], { input: 'debugger;\n' });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).not.toBe('');
    });

    // A tree-wide `biome check` is the suite's heaviest single spawn — it alone can take longer
    // than the file's default budget under the contention the shared testTimeout already absorbs
    // for everything else (vitest.config.ts), so it gets its own longer allowance rather than
    // raising the global one for every other, far lighter test.
    const BIOME_CHECK_TIMEOUT_MS = 120_000;
    it(
        'passes biome check on the repository',
        () => {
            // A vacuous pass (mis-shaped includes checking nothing) must fail, not pass.
            const MIN_FILES_CHECKED = 50;
            const result = runBiome(['check', '.']);
            expect(result.status, `biome check output:\n${result.stdout}${result.stderr}`).toBe(0);
            const checked = /Checked (\d+) files/.exec(result.stdout)?.[1];
            expect(checked, `biome check output:\n${result.stdout}${result.stderr}`).toBeDefined();
            expect(Number(checked)).toBeGreaterThan(MIN_FILES_CHECKED);
        },
        BIOME_CHECK_TIMEOUT_MS
    );
});
