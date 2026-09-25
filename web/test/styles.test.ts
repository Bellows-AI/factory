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

/** One block's [start, end) span, by brace counting from its opening `{` at or after `start`.
 * Split out of `blockSpans` so its own nested loop does not add to that function's cognitive
 * complexity. */
const closedBlockSpan = (css: string, start: number): [number, number] | null => {
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
        if (css[i] === '{') depth++;
        if (css[i] === '}') {
            depth--;
            if (depth === 0) return [start, i + 1];
        }
    }
    return null;
};

/** A block's [start, end) spans, by brace counting from each match of `openRe`. */
const blockSpans = (css: string, openRe: RegExp, missing: string): Array<[number, number]> => {
    const spans: Array<[number, number]> = [];
    for (const open of css.matchAll(openRe)) {
        const span = closedBlockSpan(css, open.index!);
        if (!span) throw new Error(missing);
        spans.push(span);
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

/** Every flat rule as [prelude, body]. Preludes are collected at any depth, so rules inside
 * @layer/@media land too; wrappers (@layer, @media) drop out because their body holds no
 * declaration. */
const rules = (css: string): Array<[string, string]> => {
    const parsed: Array<[string, string]> = [];
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const [, prelude, body] = match;
        if (/[a-zA-Z-]+\s*:/.test(body)) parsed.push([prelude.trim(), body]);
    }
    return parsed;
};

/** One file's color-literal violations: every match of either color syntax that falls outside
 * the token spans (`styles.css` only has any; every other file has none, so its spans are
 * empty and every match is a violation). Split out of the `it` below so its own nested loops do
 * not add to that callback's cognitive complexity. */
const colorViolationsIn = (rel: string, text: string, spans: Array<[number, number]>): string[] => {
    const violations: string[] = [];
    for (const colorRe of [COLOR_RE, NAMED_COLOR_RE]) {
        for (const match of text.matchAll(colorRe)) {
            const at = match.index ?? 0;
            if (!spans.some(([start, end]) => at >= start && at < end)) violations.push(`${rel}:${lineAt(text, at)}`);
        }
    }
    return violations;
};

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
            violations.push(...colorViolationsIn(rel, text, spans));
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

    it('stacks each Token usage measure in its own column so figures never collide (#246)', () => {
        // .usage-measure had no display rule of its own, so its figure/label/cache lines were
        // inline elements that flowed onto one line and wrapped wherever they happened to break
        // — the bug #246 reported. This pins the fix so it cannot silently regress.
        const css = stripComments(readFileSync(join(webSrc, 'styles.css'), 'utf8'));
        const body = rules(css).find(([prelude]) => prelude.trim() === '.usage-measure')?.[1] ?? '';
        expect(body).toMatch(/display:\s*flex/);
        expect(body).toMatch(/flex-direction:\s*column/);
    });
});

describe('the stylesheet — sizing and motion (#189)', () => {
    it('keeps every font size at or above the 12px floor (#189)', () => {
        // Decision-bearing text never renders under 12px; buttons, inputs and tabs carry 14px
        // through `font: inherit`. The chart tick is the one documented exception: the
        // narrowest plot's mono ticks sit at 11px, with collision checked by the overflow
        // matrix — it must stay exercised, not silently grow or shrink.
        const css = stripComments(readFileSync(join(webSrc, 'styles.css'), 'utf8'));
        const sizes = rules(css)
            .map(([prelude, body]) => [prelude, body.match(/font-size:\s*(\d+(?:\.\d+)?)px/)?.[1]] as const)
            .filter(([, size]) => size !== undefined)
            .map(([prelude, size]) => [prelude, Number(size)] as const);
        const MIN_TICK_FONT_PX = 11;
        const MIN_FONT_PX = 12;
        const under = sizes.filter(([prelude, size]) =>
            prelude === '.tick' ? size < MIN_TICK_FONT_PX : size < MIN_FONT_PX
        );
        expect(under.map(([prelude, size]) => `${prelude}: ${size}px`)).toEqual([]);
        expect(sizes.find(([prelude]) => prelude === '.tick')?.[1], 'the chart tick exception').toBe(MIN_TICK_FONT_PX);
    });

    it('holds the lamp still under prefers-reduced-motion (#189)', () => {
        // The one ambient animation goes static when the platform asks for reduced motion;
        // running/stopping stay live through their text, dot shape and static halo.
        const css = stripComments(readFileSync(join(webSrc, 'styles.css'), 'utf8'));
        const blocks = blockSpans(
            css,
            /@media \(prefers-reduced-motion: reduce\)\s*\{/g,
            'reduced-motion block never closes'
        );
        expect(blocks.length, 'one reduced-motion block').toBe(1);
        const block = css.slice(...blocks[0]!);
        expect(block).toMatch(/\.sidenav-dot-running[\s\S]*\.sidenav-dot-stopping[\s\S]*animation:\s*none/);
    });

    it('survives forced-colors: active (#189)', () => {
        // The system repaint recolors every token surface; what would silently vanish is the
        // accent focus ring, so it is pinned to the system highlight color.
        const css = stripComments(readFileSync(join(webSrc, 'styles.css'), 'utf8'));
        const blocks = blockSpans(css, /@media \(forced-colors: active\)\s*\{/g, 'forced-colors block never closes');
        expect(blocks.length, 'one forced-colors block').toBe(1);
        const block = css.slice(...blocks[0]!);
        expect(block).toMatch(/:focus-visible[\s\S]*outline-color:\s*Highlight/);
    });

    it('gives interactive controls a 36px desktop floor (#189)', () => {
        // Padding alone lands the default button at 35px; the floor makes every button, tab,
        // input and select clear 36. The compact shell restates 44 for touch in its media query.
        const css = stripComments(readFileSync(join(webSrc, 'styles.css'), 'utf8'));
        const flat = (prelude: string) => prelude.replace(/\s+/g, ' ');
        for (const selector of ['button', "input:not([type='checkbox']):not([type='radio']), select", '.inbox-tab']) {
            const bodies = rules(css)
                .filter(([prelude]) => flat(prelude) === selector)
                .map(([, body]) => body);
            expect(
                bodies.some((body) => /min-height:\s*36px/.test(body)),
                `${selector} carries a 36px min-height`
            ).toBe(true);
        }
    });

    it('clears 44px touch targets across the compact shell (#189)', () => {
        // The ≤900px rule lists every control the narrow shell must clear; new mobile-visible
        // controls join the list, they do not get their own one-off rule.
        const css = stripComments(readFileSync(join(webSrc, 'styles.css'), 'utf8'));
        const blocks = blockSpans(css, /@media \(max-width: 900px\)\s*\{/g, 'compact-shell media block never closes');
        const rule = blocks
            .map(([start, end]) => css.slice(start, end).match(/([^{}]+)\{[^{}]*min-height:\s*44px[^{}]*\}/))
            .find(Boolean);
        expect(rule, 'the 44px target rule').toBeTruthy();
        const prelude = rule![1]!;
        for (const selector of [
            '.appbar-trigger',
            '.mobile-nav-close',
            '.mobile-nav .sidenav-link',
            '.mobile-nav .sidenav-sublink',
            '.mobile-nav .sidenav-newtask',
            '.select-trigger',
            '.range-draft input',
            '.range-draft-actions button',
            '.page-header-actions button',
            '.inbox-tab',
            '.inbox-search input',
            '.inbox-search select',
            '.inbox-search button',
            '.chat-resume',
            '.task-actions button',
            '.task-remove-actions button',
            '.unsaved-actions button',
            '.env-tab',
            '.composer-start button',
            '.composer-param-input',
            '.legend-button',
            '.repo-search input',
            '.repo-search button',
            '.repo-table button',
            '.repo-save',
        ]) {
            expect(prelude.includes(selector), `${selector} in the 44px target list`).toBe(true);
        }
    });

    it('bootstraps the theme before paint with no inline or remote script (CSP: script-src self)', () => {
        const html = readFileSync(join(webSrc, '..', 'index.html'), 'utf8');
        // The external same-origin bootstrap must execute before the application entry, so the
        // palette is on <html> before the first paint and React never flips it.
        const bootstrapAt = html.indexOf('<script src="/theme-bootstrap.js">');
        const entryAt = html.indexOf('src="/src/main.tsx"');
        expect(bootstrapAt, 'index.html references the external bootstrap').toBeGreaterThanOrEqual(0);
        expect(entryAt, 'the bootstrap precedes the application entry').toBeGreaterThan(bootstrapAt);
        // Every script tag carries a src: no inline code exists to weaken `script-src 'self'`.
        for (const tag of html.matchAll(/<script\b[^>]*>/g)) expect(tag[0], 'script tag').toContain('src=');
        // And nothing loads from off-origin — the same self-hosting rule the fonts already follow.
        expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
    });

    it('never transitions, so a theme flip cannot pass through an intermediate palette', () => {
        const css = stripComments(readFileSync(join(webSrc, 'styles.css'), 'utf8'));
        expect(css.match(/transition\s*:[^;{}]*/gi) ?? []).toEqual([]);
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
