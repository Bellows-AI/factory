import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webSrc = fileURLToPath(new URL('../src', import.meta.url));
const docPath = fileURLToPath(new URL('../../docs/design-system.md', import.meta.url));

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

/** The :root token block's [start, end) span, by brace counting from the first `:root {`. */
const rootSpan = (css: string): [number, number] => {
    const open = css.match(/^:root\s*\{/m);
    expect(open, 'styles.css has no :root block').not.toBeNull();
    const start = open!.index!;
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
        if (css[i] === '{') depth++;
        if (css[i] === '}') {
            depth--;
            if (depth === 0) return [start, i + 1];
        }
    }
    throw new Error('styles.css :root block never closes');
};

const walkFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? walkFiles(path) : [path];
    });

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

describe('the stylesheet', () => {
    it('keeps every color literal inside the :root token block', () => {
        // Comments are scanned too: prose in styles.css never quotes a raw color value —
        // a value a comment needs belongs in docs/design-system.md, which is not scanned.
        const violations: string[] = [];
        for (const path of walkFiles(webSrc)) {
            if (!/\.(css|ts|tsx)$/.test(path)) continue;
            const text = readFileSync(path, 'utf8');
            const rel = path.slice(webSrc.length + 1);
            const span = rel === 'styles.css' ? rootSpan(text) : [-1, -1];
            for (const match of text.matchAll(COLOR_RE)) {
                const at = match.index ?? 0;
                if (at < span[0] || at >= span[1]) violations.push(`${rel}:${lineAt(text, at)}`);
            }
        }
        expect(violations).toEqual([]);
    });

    it('defines every var() the stylesheet references', () => {
        const css = readFileSync(join(webSrc, 'styles.css'), 'utf8');
        const [start, end] = rootSpan(css);
        const defined = new Set([...css.slice(start, end).matchAll(/--([a-zA-Z][\w-]*)\s*:/g)].map((m) => m[1]));
        const used = new Set([...css.matchAll(/var\(--([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
        // A typo'd token name silently no-ops in CSS, so an undefined reference must fail here.
        expect([...used].filter((token) => !defined.has(token))).toEqual([]);
    });

    it('uses every token it defines', () => {
        const css = readFileSync(join(webSrc, 'styles.css'), 'utf8');
        const [start, end] = rootSpan(css);
        const defined = [...css.slice(start, end).matchAll(/--([a-zA-Z][\w-]*)\s*:/g)].map((m) => m[1]);
        const used = new Set([...css.matchAll(/var\(--([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
        // A token with no call site is speculation: the set stays exactly as big as the UI needs.
        expect(defined.filter((token) => !used.has(token))).toEqual([]);
    });

    it('matches colors in every shape the UI writes them', () => {
        // Negative controls: the modern space-syntax rgb() is the easiest form to miss.
        expect('background: #fff'.match(COLOR_RE)).toEqual(['#fff']);
        expect('background: rgb(0 0 0 / 60%)'.match(COLOR_RE)).toEqual(['rgb(0 0 0 / 60%)']);
    });

    it('finds the :root span without swallowing a later block', () => {
        const css =
            ':root { --a: #111; }\n.panel { background: var(--a); }\n@media (min-width: 1px) { .b { color: #222; } }';
        const [start, end] = rootSpan(css);
        expect(css.slice(start, end)).toBe(':root { --a: #111; }');
    });
});

describe('the design-system inventory', () => {
    // Both assertions read docs/design-system.md, so the inventory is enforced, not aspirational:
    // a new UI unit or a new class fails the suite until the document names it.
    const doc = readFileSync(docPath, 'utf8');

    it('inventories every UI unit under web/src', () => {
        const units = ['components', 'panels', 'pages', 'charts'].flatMap((dir) =>
            readdirSync(join(webSrc, dir), { withFileTypes: true })
                .filter((entry) => entry.isFile())
                .map((entry) => entry.name)
        );
        expect(units.filter((name) => !doc.includes(name))).toEqual([]);
    });

    it('documents every class the stylesheet defines', () => {
        // Comments are stripped first: prose in styles.css may mention file names and other
        // dotted text without putting those "classes" on the inventory's books.
        const css = readFileSync(join(webSrc, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const defined = new Set<string>();
        for (const rule of css.match(/[^{}]+\{[^}]*\}/g) ?? []) {
            for (const match of rule.split('{')[0].matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(match[1]);
        }
        expect([...defined].filter((name) => !doc.includes(name))).toEqual([]);
    });
});
