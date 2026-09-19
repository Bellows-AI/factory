import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webSrc = fileURLToPath(new URL('../src', import.meta.url));
const docPath = fileURLToPath(new URL('../../docs/design-system.md', import.meta.url));

// Functional color syntaxes join hex and rgb/hsl, matched case-insensitively because CSS
// function names are. `transparent` and `currentColor` are theme keywords, not literals,
// so the named-color list below leaves them out — `currentColor` is in active use.
const COLOR_RE =
    /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|okl(ch|ab)\([^)]*\)|hwb\([^)]*\)|(lab|lch|light-dark|color(-mix)?)\([^)]*\)/gi;

// A named color only counts where a VALUE can start — after a declaration's `:` or a
// function's `(`/`,` — so property names ("white-space"), selectors and prose never collide
// with the list.
const NAMED_COLOR_RE = new RegExp(
    `(?<=[:,(]\\s*)(${'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
        .split(' ')
        .join('|')})\\b`,
    'gi'
);

/** Block comments removed, so prose cannot mint phantom tokens, classes or color mentions. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** A block's [start, end) spans, by brace counting from each match of `openRe`. */
const blockSpans = (css: string, openRe: RegExp, missing: string): Array<[number, number]> => {
    const spans: Array<[number, number]> = [];
    for (const open of css.matchAll(openRe)) {
        const start = open.index!;
        let depth = 0;
        let closed = false;
        for (let i = css.indexOf('{', start); i < css.length && !closed; i++) {
            if (css[i] === '{') depth++;
            if (css[i] === '}') {
                depth--;
                if (depth === 0) {
                    spans.push([start, i + 1]);
                    closed = true;
                }
            }
        }
        if (!closed) throw new Error(missing);
    }
    return spans;
};

/** Both token blocks — dark `:root` and light `:root[data-theme]` — the only legal homes for
 * color literals. A light theme (issue 117's toggle ships the palette in 148) is a second
 * `:root` block, nothing more. */
const tokenSpans = (css: string): Array<[number, number]> => {
    const spans = blockSpans(css, /^:root[^{\n]*\{/gm, 'styles.css token block never closes');
    expect(spans.length, 'styles.css has no token blocks').toBeGreaterThan(0);
    return spans;
};

/** The `@theme` blocks (`@theme inline` and the static one): Tailwind plumbing that references
 * tokens rather than consuming them, so the definition guards read it, but the use guard does
 * not — a `--color-*` row pointing at `var(--surface)` is not a call site. */
const themeSpans = (css: string): Array<[number, number]> =>
    blockSpans(css, /^@theme[^{\n]*\{/gm, 'styles.css @theme block never closes');

const walkFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? walkFiles(path) : [path];
    });

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

describe('the stylesheet', () => {
    it('keeps every color literal inside the token blocks', () => {
        // Comments are scanned too: prose in styles.css never quotes a raw color value —
        // a value a comment needs belongs in docs/design-system.md, which is not scanned.
        const violations: string[] = [];
        for (const path of walkFiles(webSrc)) {
            if (!/\.(css|ts|tsx)$/.test(path)) continue;
            const text = readFileSync(path, 'utf8');
            const rel = path.slice(webSrc.length + 1);
            const spans = rel === 'styles.css' ? tokenSpans(text) : [];
            for (const colorRe of [COLOR_RE, NAMED_COLOR_RE]) {
                for (const match of text.matchAll(colorRe)) {
                    const at = match.index ?? 0;
                    if (!spans.some(([start, end]) => at >= start && at < end))
                        violations.push(`${rel}:${lineAt(text, at)}`);
                }
            }
        }
        expect(violations).toEqual([]);
    });

    it('defines every var() the stylesheet references', () => {
        const css = stripComments(readFileSync(join(webSrc, 'styles.css'), 'utf8'));
        // The token blocks and the @theme blocks together are what may be referenced: a
        // var(--font-mono) call site resolves against the static @theme block.
        const defined = new Set(
            [...tokenSpans(css), ...themeSpans(css)].flatMap(([start, end]) =>
                [...css.slice(start, end).matchAll(/--([a-zA-Z][\w-]*)\s*:/g)].map((m) => m[1])
            )
        );
        const used = new Set([...css.matchAll(/var\(--([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
        // A typo'd token name silently no-ops in CSS, so an undefined reference must fail here.
        expect([...used].filter((token) => !defined.has(token))).toEqual([]);
    });

    it('uses every token it defines', () => {
        const css = stripComments(readFileSync(join(webSrc, 'styles.css'), 'utf8'));
        // Scanned with the @theme blocks cut out: their `--color-*: var(--token)` rows are
        // plumbing, not call sites, and would let an unused token hide behind its own exposure.
        let scanned = css;
        for (const [start, end] of themeSpans(css).reverse()) scanned = scanned.slice(0, start) + scanned.slice(end);
        const defined = tokenSpans(css).flatMap(([start, end]) =>
            [...css.slice(start, end).matchAll(/--([a-zA-Z][\w-]*)\s*:/g)].map((m) => m[1])
        );
        const used = new Set([...scanned.matchAll(/var\(--([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
        // A token with no call site is speculation: the set stays exactly as big as the UI needs.
        expect(defined.filter((token) => !used.has(token))).toEqual([]);
    });

    it('matches colors in every shape the UI writes them', () => {
        // Negative controls: the modern space-syntax rgb() is the easiest form to miss, CSS
        // function names are case-insensitive, and the named-color scan must collide with
        // neither property names nor the theme keywords.
        expect('background: #fff'.match(COLOR_RE)).toEqual(['#fff']);
        expect('background: rgb(0 0 0 / 60%)'.match(COLOR_RE)).toEqual(['rgb(0 0 0 / 60%)']);
        expect('color: oklch(70% 0.1 200)'.match(COLOR_RE)).toEqual(['oklch(70% 0.1 200)']);
        expect('color: COLOR-MIX(in srgb, red, blue)'.match(COLOR_RE)).toEqual(['COLOR-MIX(in srgb, red, blue)']);
        expect('color: red'.match(NAMED_COLOR_RE)).toEqual(['red']);
        expect('white-space: nowrap'.match(NAMED_COLOR_RE)).toBeNull();
        expect('background: currentColor'.match(NAMED_COLOR_RE)).toBeNull();
        expect('background: transparent'.match(NAMED_COLOR_RE)).toBeNull();
    });

    it('finds both token spans without swallowing a later block', () => {
        const css =
            ':root { --a: #111; }\n.panel { background: var(--a); }\n:root[data-theme="light"] { --a: #eee; }\n@media (min-width: 1px) { .b { color: #222; } }';
        const spans = tokenSpans(css);
        expect(spans.map(([start, end]) => css.slice(start, end))).toEqual([
            ':root { --a: #111; }',
            ':root[data-theme="light"] { --a: #eee; }',
        ]);
    });

    it('defines the same tokens in both theme blocks', () => {
        // Both blocks style the same <html>, so a token present in one but not the other does not
        // error — the light theme would silently render the dark value. Parity is the guard.
        const css = stripComments(readFileSync(join(webSrc, 'styles.css'), 'utf8'));
        const names = tokenSpans(css).map(
            ([start, end]) => new Set([...css.slice(start, end).matchAll(/--([a-zA-Z][\w-]*)\s*:/g)].map((m) => m[1]))
        );
        expect(names.length, 'expected exactly two theme blocks').toBe(2);
        const [dark, light] = names;
        expect([...light].filter((token) => !dark.has(token))).toEqual([]);
        expect([...dark].filter((token) => !light.has(token))).toEqual([]);
    });

    it('is the Tailwind v4 entry with the andon theme adopted (#148)', () => {
        const css = readFileSync(join(webSrc, 'styles.css'), 'utf8');
        expect(css).toMatch(/^@import "tailwindcss";/m);
        expect(css).toMatch(/^:root\[data-theme="light"]\s*\{/m);
        // The theme's one ambient motion is a breathing lamp; the old blink is gone.
        expect(css).not.toMatch(/@keyframes blink\b/);
        expect(css).toMatch(/--animate-lamp:\s*lamp 2\.4s ease-in-out infinite/);
    });

    it('keeps fonts self-hosted (CSP: font-src self)', () => {
        const text =
            readFileSync(join(webSrc, 'styles.css'), 'utf8') + readFileSync(join(webSrc, '..', 'index.html'), 'utf8');
        expect(text).not.toMatch(/fonts\.googleapis\.com|gstatic\.com/);
    });
});

describe('the design-system inventory', () => {
    // Both assertions read docs/design-system.md, so the inventory is enforced, not aspirational:
    // a new UI unit or a new class fails the suite until the document names it.
    const doc = readFileSync(docPath, 'utf8');

    it('inventories every UI unit under web/src', () => {
        const units = ['components', 'panels', 'pages', 'charts'].flatMap((dir) =>
            walkFiles(join(webSrc, dir)).map((path) => basename(path))
        );
        expect(units.filter((name) => !doc.includes(name))).toEqual([]);
    });

    it('documents every class the stylesheet defines', () => {
        const css = stripComments(readFileSync(join(webSrc, 'styles.css'), 'utf8'));
        // The text before every opening brace is a selector prelude — collected at any depth, so
        // a class defined only inside @media lands on the inventory's books like the rest.
        const defined = new Set<string>();
        for (const prelude of css.matchAll(/([^{}]*)\{/g)) {
            for (const match of prelude[1].matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(match[1]);
        }
        // Custom utilities carry no leading dot in their prelude, so they are collected here —
        // lamp-glow fails the inventory until the document names it, like any class.
        for (const match of css.matchAll(/@utility\s+([a-zA-Z][\w-]*)/g)) defined.add(match[1]);
        // A presence check, not a parse: doc.includes matches substrings, so the guard catches an
        // undocumented class, not an undocumented rule about it.
        expect([...defined].filter((name) => !doc.includes(name))).toEqual([]);
    });
});
