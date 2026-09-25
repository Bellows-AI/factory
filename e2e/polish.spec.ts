import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * The application-wide interaction, contrast, and motion check (issue 189): the rendered values
 * the static stylesheet contracts can only describe. WCAG ratios are computed in the browser
 * from computed rgb() values — no Node-side reimplementation of the token recipes — and the
 * motion, focus and target measurements run in both themes by flipping `data-theme` on <html>.
 * Runs on the open board (AUTH_MODE=none, seeded offline server) beside navigation.spec.ts.
 */

type Pair = readonly [fg: string, bg: string];

/** The WCAG 2.2 AA thresholds: one per matrix, so no pair can silently omit its own. */
const TEXT_THRESHOLD = 4.5;
const BOUNDARY_THRESHOLD = 3;

/** Text pairs at the 4.5:1 normal-text threshold: every token that ever carries text, on every
 * surface it sits on — including the lamp colors, which pills and status lines render as text. */
const TEXT_PAIRS: readonly Pair[] = [
    ['--ink', '--surface'],
    ['--ink', '--surface-raised'],
    ['--ink', '--surface-sunken'],
    ['--ink-muted', '--surface'],
    ['--ink-muted', '--surface-raised'],
    ['--ink-muted', '--surface-sunken'],
    ['--accent', '--surface'],
    ['--accent', '--surface-raised'],
    ['--ink-inverse', '--accent'],
    ['--on-warn', '--lamp-wait'],
    ['--on-bad', '--lamp-stop'],
    ['--lamp-run', '--surface'],
    ['--lamp-run', '--surface-raised'],
    ['--lamp-wait', '--surface'],
    ['--lamp-wait', '--surface-raised'],
    ['--lamp-stop', '--surface'],
    ['--lamp-stop', '--surface-raised'],
] as const;

/** Non-text pairs at the 3:1 boundary threshold: the series fill and the focus ring's worst
 * adjacent surface. The gridlines and hairlines are decorative by contract (design-system.md). */
const BOUNDARY_PAIRS: readonly Pair[] = [
    ['--chart-primary', '--surface'],
    ['--accent', '--surface-sunken'],
] as const;

/** Flips the palette by attribute — the light theme rides `data-theme="light"` on <html>, so
 * both themes render from the same server without touching persistence. */
const setTheme = (page: Page, theme: 'dark' | 'light') =>
    theme === 'light'
        ? page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
        : page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

/** WCAG 2.2 contrast for one token pair, computed in the page. Chrome serializes computed
 * colors in whatever space the token was written in (`oklch(…)`), so each color is rasterized
 * through a one-pixel canvas — the browser's own conversion to sRGB bytes, not a Node-side or
 * hand-rolled reimplementation of the token recipes. */
async function measure(page: Page, pair: Pair): Promise<{ pair: Pair; ratio: number }> {
    const ratio = await page.evaluate(([fgToken, bgToken]) => {
        const probe = document.createElement('div');
        probe.style.color = `var(${fgToken})`;
        probe.style.backgroundColor = `var(${bgToken})`;
        document.body.appendChild(probe);
        const styles = getComputedStyle(probe);
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        const luminance = (cssColor: string) => {
            context.fillStyle = cssColor;
            context.fillRect(0, 0, 1, 1);
            const channels = context.getImageData(0, 0, 1, 1).data;
            const [r, g, b] = [channels[0]!, channels[1]!, channels[2]!].map((channel) => {
                const s = channel / 255;
                // The WCAG sRGB linearization cutoff.
                return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        const fg = luminance(styles.color);
        const bg = luminance(styles.backgroundColor);
        probe.remove();
        const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
        return (hi + 0.05) / (lo + 0.05);
    }, pair);
    return { pair, ratio };
}

/** A running dot to observe: a real one when the seed has a live run, otherwise one injected
 * into the sidenav — the class is what carries the animation, whatever rendered it. */
async function runningDot(page: Page): Promise<Locator> {
    let dot = page.locator('.sidenav-dot-running').first();
    if ((await dot.count()) === 0) {
        await page.locator('.sidenav').waitFor({ state: 'attached' });
        await page.evaluate(() => {
            const injected = document.createElement('span');
            injected.className = 'sidenav-dot-running';
            document.querySelector('.sidenav')?.appendChild(injected);
        });
        dot = page.locator('.sidenav-dot-running').first();
    }
    return dot;
}

async function assertRing(target: Locator, label: string) {
    await target.focus();
    const ring = await target.evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, color: s.outlineColor };
    });
    expect(ring.style, `${label} outline style`).toBe('solid');
    expect(ring.width, `${label} outline width`).toBe('2px');
    expect(ring.offset, `${label} outline offset`).toBe('2px');
    expect(ring.color, `${label} outline color resolves`).not.toBe('transparent');
}

/**
 * The inbox filter fields, by their label rather than by a literal id: the page mints its ids with
 * useId so two mounted copies cannot collide, which means no id here survives a render. Going
 * through the label exercises the htmlFor wiring that replaced them instead of routing around it.
 */
const inboxSearch = (page: Page): Locator => page.locator('.inbox-search').getByLabel('Search');
const inboxRepo = (page: Page): Locator => page.locator('.inbox-search').getByLabel('Repository');

test.describe('polish (issue 189)', () => {
    for (const theme of ['dark', 'light'] as const) {
        test(`the contrast matrix meets WCAG AA in the ${theme} theme`, async ({ page }) => {
            await page.goto('/');
            await setTheme(page, theme);
            const failures: string[] = [];
            for (const [pairs, threshold] of [
                [TEXT_PAIRS, TEXT_THRESHOLD],
                [BOUNDARY_PAIRS, BOUNDARY_THRESHOLD],
            ] as const) {
                for (const pair of pairs) {
                    const { ratio } = await measure(page, pair);
                    if (ratio < threshold) {
                        failures.push(`${pair[0]} on ${pair[1]} = ${ratio.toFixed(2)}:1, needs ${threshold}:1`);
                    }
                }
            }
            expect(failures, `${theme} theme contrast failures`).toEqual([]);
        });

        test(`focus rings stay visible on every control kind in the ${theme} theme`, async ({ page }) => {
            await page.goto('/');
            await setTheme(page, theme);
            await assertRing(page.locator('.sidenav-link').first(), 'sidenav link');
            await assertRing(page.locator('#range-select'), 'range dropdown trigger');
            await page.goto('/tasks');
            await setTheme(page, theme);
            await assertRing(inboxSearch(page), 'inbox search input');
            await assertRing(inboxRepo(page), 'inbox repository select');
            await assertRing(page.locator('.inbox-tab').first(), 'inbox tab');
        });
    }

    test('reduced motion stills the lamp and keeps the state text', async ({ page }) => {
        // Default motion first: the lamp is the one ambient animation, so it must be running.
        await page.goto('/tasks');
        expect(await (await runningDot(page)).evaluate((el) => getComputedStyle(el).animationName)).toBe('lamp');

        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto('/tasks');
        expect(await (await runningDot(page)).evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
        // The stilling keeps the textual state: the sidenav count line reads the live sections.
        await expect(page.locator('.sidenav-section').first()).toBeVisible();
    });

    test('controls clear 44px at 390px', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 800 });
        await page.goto('/tasks');
        for (const [label, target] of [
            ['app bar trigger', page.locator('.appbar-trigger')],
            ['inbox tab', page.locator('.inbox-tab').first()],
            ['inbox search input', inboxSearch(page)],
            ['inbox repository select', inboxRepo(page)],
            ['inbox filter button', page.locator('.inbox-search button')],
        ] as const) {
            const box = await target.boundingBox();
            expect(box?.height ?? 0, `${label} touch target`).toBeGreaterThanOrEqual(44);
        }
        await page.goto('/');
        const rangeTriggerBox = await page.locator('#range-select').boundingBox();
        expect(rangeTriggerBox?.height ?? 0, 'range dropdown touch target').toBeGreaterThanOrEqual(44);
    });

    test('forced colors keep keyboard focus visible', async ({ page }) => {
        await page.emulateMedia({ forcedColors: 'active' });
        await page.goto('/');
        // The system repaint recolors the tokens; the ring is pinned to the system highlight so
        // it survives, and the control kinds the shared rule serves keep an outline.
        await assertRing(page.locator('#range-select'), 'range dropdown trigger');
        await page.goto('/tasks');
        await assertRing(inboxRepo(page), 'inbox repository select');
    });
});
