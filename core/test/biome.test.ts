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

    // A tree-wide check is the heaviest spawn in the suite (vitest.config.ts), and the global 30s
    // testTimeout is not always enough headroom under worker contention — this one test gets its
    // own, larger budget rather than raising the timeout for every test.
    it('passes biome check on the repository', () => {
        // A vacuous pass (mis-shaped includes checking nothing) must fail, not pass.
        const MIN_FILES_CHECKED = 50;
        const result = runBiome(['check', '.']);
        expect(result.status, `biome check output:\n${result.stdout}${result.stderr}`).toBe(0);
        const checked = /Checked (\d+) files/.exec(result.stdout)?.[1];
        expect(checked, `biome check output:\n${result.stdout}${result.stderr}`).toBeDefined();
        expect(Number(checked)).toBeGreaterThan(MIN_FILES_CHECKED);
    }, 90_000);
});
