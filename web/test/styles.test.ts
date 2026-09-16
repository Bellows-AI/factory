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
            for (const colorRe of [COLOR_RE, NAMED_COLOR_RE]) {
                for (const match of text.matchAll(colorRe)) {
                    const at = match.index ?? 0;
                    if (at < span[0] || at >= span[1]) violations.push(`${rel}:${lineAt(text, at)}`);
                }
            }
        }
        expect(violations).toEqual([]);
    });

    it('defines every var() the stylesheet references', () => {
        const css = stripComments(readFileSync(join(webSrc, 'styles.css'), 'utf8'));
        const [start, end] = rootSpan(css);
        const defined = new Set([...css.slice(start, end).matchAll(/--([a-zA-Z][\w-]*)\s*:/g)].map((m) => m[1]));
        const used = new Set([...css.matchAll(/var\(--([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
        // A typo'd token name silently no-ops in CSS, so an undefined reference must fail here.
        expect([...used].filter((token) => !defined.has(token))).toEqual([]);
    });

    it('uses every token it defines', () => {
        const css = stripComments(readFileSync(join(webSrc, 'styles.css'), 'utf8'));
        const [start, end] = rootSpan(css);
        const defined = [...css.slice(start, end).matchAll(/--([a-zA-Z][\w-]*)\s*:/g)].map((m) => m[1]);
        const used = new Set([...css.matchAll(/var\(--([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
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
        // A presence check, not a parse: doc.includes matches substrings, so the guard catches an
        // undocumented class, not an undocumented rule about it.
        expect([...defined].filter((name) => !doc.includes(name))).toEqual([]);
    });
});
