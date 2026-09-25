import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * scripts/check-docs.mjs resolves the docs root relative to its own location, so each case copies
 * it into a scratch repo with its own docs-site pages and runs it there.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function runCheck(pages: Record<string, string>) {
    const repo = mkdtempSync(join(tmpdir(), 'check-docs-'));
    mkdirSync(join(repo, 'scripts'));
    copyFileSync(join(ROOT, 'scripts/check-docs.mjs'), join(repo, 'scripts/check-docs.mjs'));
    const docs = join(repo, 'docs-site/src/content/docs');
    for (const [relative, body] of Object.entries(pages)) {
        const file = join(docs, relative);
        mkdirSync(dirname(file), { recursive: true });
        const editUrl = `https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/${relative}`;
        writeFileSync(file, `---\ntitle: T\ndescription: D\neditUrl: ${editUrl}\n---\n\n${body}\n`);
    }
    return spawnSync(process.execPath, [join(repo, 'scripts/check-docs.mjs')], { encoding: 'utf8' });
}

describe('check-docs internal links', () => {
    it('accepts a link to an existing page and to a directory index page', () => {
        const result = runCheck({
            'index.md': '[a](/factory/reference/api/) [b](/factory/guides/)',
            'reference/api.md': 'x',
            'guides/index.md': 'x',
        });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
    });

    it('rejects a link to a directory that has no index page', () => {
        const result = runCheck({ 'index.md': '[a](/factory/reference/)', 'reference/api.md': 'x' });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('broken internal link /factory/reference/');
    });

    it('rejects a `..` link that resolves to a file outside the docs root', () => {
        const result = runCheck({ 'index.md': '[a](/factory/../../../../scripts/check-docs.mjs)' });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('broken internal link /factory/../../../../scripts/check-docs.mjs');
    });
});
