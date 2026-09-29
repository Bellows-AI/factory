import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { mockExecutors, withExecutor } from './executor.js';
import { routeLongTasks } from './fixtures/tasks.js';
import { failedGateThread, longContentThread, publishedThread, runningThread } from './fixtures/threads.js';
import {
    COMPOSER_SHOT,
    DASHBOARD_SHOT,
    ENTRY_SHOTS,
    heading,
    INBOX_SHOT,
    onOpenBoard,
    SETTINGS_SHOTS,
    SLOW,
    type Shot,
    seededTaskId,
    shotFile,
    threadShot,
} from './routes.js';
import { MATRIX_VIEWPORTS, THEMES, type Theme } from './screenshot-matrix.js';
import { controlsOutsideViewport, pageOverflow } from './viewport.js';

/**
 * The responsive and accessibility matrix (issue 287, plan §8): every route family × the five
 * validation widths × both themes, with the page-level overflow contract asserted in every cell,
 * then the assistive passes — accessible names, live regions, keyboard-only reach, compact
 * targets, reduced motion, rendered text contrast, and dialog focus containment and return.
 *
 * Every check is soft within its test, so one failing cell never hides the rest, and every test
 * records what it saw under artifacts/ui/matrix/. `afterAll` rebuilds MATRIX.md from those records
 * — the report the PR carries, copied into docs/plans/bellows-redesign-2026-09-26/MATRIX.md.
 *
 * 200% zoom is navigation.spec.ts's zoom test (720 CSS px plus root zoom 2, a 360px budget that is
 * strictly harder than the real thing); the 320 column is WCAG reflow's 320 CSS px. The token-pair
 * contrast matrix is polish.spec.ts's; the rendered sampler here measures real pages on top of it.
 */

const OUT = 'artifacts/ui/matrix';
const CELLS = `${OUT}/cells`;
const CHECKS = `${OUT}/checks`;
/** Its own folder: auth.spec.ts writes a few `<route>_<state>_<theme>_<width>.png` of its own into
 *  artifacts/ui/matrix, and the two must not overwrite each other. */
const SHOTS = `${OUT}/shots`;

/**
 * This run's id, stamped on every record so the report reads only what this run measured —
 * never a verdict an earlier run left on disk. Set in the runner process, which loads the spec
 * before forking any worker, so every worker (a restarted one included) inherits the same id.
 */
process.env.MATRIX_RUN ??= String(Date.now());
const RUN = process.env.MATRIX_RUN;

/** The compact-shell breakpoint (docs/design-system.md): at or under it, the drawer is the navigation. */
const COMPACT_SHELL_MAX = 900;

/** The seeded detail page, by a live id: the seed mints its ids, so none is written down here. */
const SEEDED_DETAIL: Shot = {
    route: 'task-detail',
    state: 'seeded',
    fixture: 'seed',
    open: async (page) => {
        await page.goto(`/tasks/${await seededTaskId(page)}`);
        return page.locator('.task-layout');
    },
};

const LONG_INBOX: Shot = {
    route: 'inbox',
    state: 'long-content',
    fixture: 'seed + e2e/fixtures/tasks.ts',
    open: async (page) => {
        await routeLongTasks(page);
        await page.goto('/tasks');
        await expect(page.locator('.inbox-row').first()).toContainText('refactor-');
        return page.locator('.inbox-tabs');
    },
};

/** The open board's families: everything but the entry pages, which need a github-mode board. */
const OPEN_BOARD: readonly Shot[] = [
    DASHBOARD_SHOT,
    INBOX_SHOT,
    LONG_INBOX,
    COMPOSER_SHOT,
    SEEDED_DETAIL,
    threadShot('failed-gate', 'failedGateThread', failedGateThread),
    threadShot('published', 'publishedThread', publishedThread),
    threadShot('long-content', 'longContentThread', longContentThread),
    ...SETTINGS_SHOTS,
    { ...onOpenBoard('account', '/account', 'Account'), state: 'open-board' },
];

const FAMILIES: readonly Shot[] = [...OPEN_BOARD, ...ENTRY_SHOTS];

/** The anonymous entry pages: no sign-in round trip, so the per-page passes can afford them. */
const ANONYMOUS_ENTRY = ENTRY_SHOTS.filter((shot) => shot.route !== 'account');

const SETTLED = { timeout: SLOW };

const label = (shot: Shot) => `${shot.route}/${shot.state}`;

/** Both theme mechanisms the bootstrap reads — the stored preference and the OS scheme — so the
 *  real before-paint path picks the theme on both origins and across every navigation. */
async function useTheme(page: Page, theme: Theme): Promise<void> {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => localStorage.setItem('factory.theme', t), theme);
}

/** Navigate, wait for the route's data anchor and the fonts, and confirm the theme took. Every
 *  family runs in the same page, so the previous family's mocked routes are dropped first — a
 *  cell marked `seed` must render the seed, not the last fixture's answer. */
async function openSettled(page: Page, shot: Shot, theme: Theme): Promise<void> {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const ready = await shot.open(page);
    await expect(ready).toBeVisible(SETTLED);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.evaluate(() => document.fonts.ready);
}

/** Playwright colors its messages; the report is plain markdown. Built from the code point so the
 *  source carries no control character. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** One failure, for the report: the assertion's label, then each offending item it received. */
const failureLines = (message: string) => {
    const lines = message.replace(ANSI, '').split('\n');
    const received = lines.filter((line) => /^\s*\+\s+"/.test(line)).map((line) => line.trim().slice(1).trim());
    return [lines[0]!, ...received].join(' · ');
};

const CHECK = 'matrix-check';
const NOTE = 'matrix-note';

/** Name the assistive check a test performs; `afterEach` writes its verdict, so a test that fails
 *  hard — a timeout, a missing anchor — still lands in the report as a FAIL. */
function describeCheck(check: string, scope: string): void {
    test.info().annotations.push({ type: CHECK, description: JSON.stringify({ check, scope }) });
}

function note(line: string): void {
    test.info().annotations.push({ type: NOTE, description: line });
}

/** One test's verdict, for the report: pass only when nothing soft or hard failed in it. */
function record(info: TestInfo): void {
    const described = info.annotations.find((annotation) => annotation.type === CHECK);
    if (!described) return;
    mkdirSync(CHECKS, { recursive: true });
    const { check, scope } = JSON.parse(described.description!) as { check: string; scope: string };
    const failures = info.errors.map((error) => failureLines(error.message ?? ''));
    if (info.status !== info.expectedStatus && failures.length === 0) failures.push(`test ${info.status}`);
    const notes = info.annotations.filter((annotation) => annotation.type === NOTE).map((a) => a.description!);
    const result = failures.length === 0 ? 'pass' : 'FAIL';
    const file = `${CHECKS}/${info.title.replace(/[^\w-]+/g, '_')}.json`;
    writeFileSync(file, JSON.stringify({ run: RUN, check, scope, result, failures, notes }));
}

test.describe('responsive and accessibility matrix (issue 287)', () => {
    // Never emptied: a worker restarted after a failure runs beforeAll again, and the records the
    // earlier tests wrote must survive into the report. The run id is what keeps old ones out.
    test.beforeAll(() => {
        mkdirSync(CELLS, { recursive: true });
        mkdirSync(SHOTS, { recursive: true });
    });
    test.afterEach(() => record(test.info()));
    test.afterAll(writeReport);

    for (const viewport of MATRIX_VIEWPORTS) {
        for (const theme of THEMES) {
            test(`no page-level horizontal overflow — ${theme} at ${viewport.width}`, async ({ page }) => {
                test.setTimeout(FAMILIES.length * SLOW);
                await page.setViewportSize(viewport);
                await useTheme(page, theme);
                for (const shot of FAMILIES) {
                    await openSettled(page, shot, theme);
                    // Polled, not slept: the claim is about the settled layout. The poll's own
                    // failure is swallowed — the soft assertion below reports the settled value.
                    await expect
                        .poll(async () => Math.max(...Object.values(await pageOverflow(page))))
                        .toBeLessThanOrEqual(0)
                        .catch(() => undefined);
                    const overflow = await pageOverflow(page);
                    const outside = await controlsOutsideViewport(page, viewport.width);
                    const cell = `${label(shot)} ${theme} ${viewport.width}`;
                    expect.soft(overflow.inner, `${cell}: scrollWidth <= innerWidth`).toBeLessThanOrEqual(0);
                    expect.soft(overflow.body, `${cell}: body overflow`).toBeLessThanOrEqual(0);
                    expect.soft(outside, `${cell}: controls outside the viewport`).toEqual([]);
                    const file = shotFile(shot, theme, viewport.width);
                    writeFileSync(
                        `${CELLS}/${file.replace(/\.png$/, '.json')}`,
                        JSON.stringify({ ...shot, run: RUN, theme, width: viewport.width, overflow, outside })
                    );
                    await page.screenshot({ path: `${SHOTS}/${file}`, fullPage: true, animations: 'disabled' });
                }
            });
        }
    }

    for (const width of [1440, 390] as const) {
        test(`every control is named and polled counts stay out of live regions at ${width}`, async ({ page }) => {
            describeCheck('names, labels and live regions', `every family at ${width}, drawer open too at ${width}`);
            test.setTimeout(FAMILIES.length * SLOW);
            await page.setViewportSize({ width, height: 900 });
            await useTheme(page, 'dark');
            for (const shot of FAMILIES) {
                await openSettled(page, shot, 'dark');
                expect.soft(await unnamedControls(page), `${label(shot)} at ${width}: unnamed controls`).toEqual([]);
                expect.soft(await polledInLiveRegions(page), `${label(shot)} at ${width}: polled in live`).toEqual([]);
                if (width <= COMPACT_SHELL_MAX && shot.route !== 'signin' && shot.route !== 'onboarding') {
                    // The drawer carries the section counts at this width: the same rule inside it.
                    await page.locator('.appbar-trigger').click();
                    await expect(page.locator('.mobile-nav')).toBeVisible();
                    expect.soft(await unnamedControls(page), `${label(shot)} drawer: unnamed controls`).toEqual([]);
                    expect.soft(await polledInLiveRegions(page), `${label(shot)} drawer: polled in live`).toEqual([]);
                    await page.keyboard.press('Escape');
                    await expect(page.locator('.mobile-nav')).toHaveCount(0);
                }
            }
        });
    }

    for (const [width, forcedColors] of [
        [1440, false],
        [390, false],
        [1440, true],
    ] as const) {
        const mode = forcedColors ? ' under forced colors' : '';
        test(`keyboard alone reaches every control and shows focus at ${width}${mode}`, async ({ page }) => {
            describeCheck('keyboard-only', `open board + sign-in/onboarding at ${width}${mode}`);
            test.setTimeout(FAMILIES.length * SLOW);
            await page.setViewportSize({ width, height: 900 });
            await useTheme(page, 'dark');
            if (forcedColors) await page.emulateMedia({ forcedColors: 'active' });
            for (const shot of [...OPEN_BOARD, ...ANONYMOUS_ENTRY]) {
                await openSettled(page, shot, 'dark');
                const walk = await tabWalk(page);
                const where = `${label(shot)} at ${width}${mode}`;
                expect.soft(walk.stops, `${where}: Tab reaches the page at all`).toBeGreaterThan(1);
                expect.soft(walk.trapped, `${where}: Tab never leaves the page`).toBe(false);
                expect.soft(walk.ringless, `${where}: focus without a ring`).toEqual([]);
                expect.soft(walk.unreached, `${where}: tabbable but never reached`).toEqual([]);
            }
        });
    }

    for (const width of [768, 390] as const) {
        test(`compact targets clear 44px at ${width}`, async ({ page }) => {
            describeCheck('compact targets ≥ 44px', `every family at ${width}`);
            test.setTimeout(FAMILIES.length * SLOW);
            await page.setViewportSize({ width, height: 900 });
            await useTheme(page, 'dark');
            for (const shot of FAMILIES) {
                await openSettled(page, shot, 'dark');
                expect.soft(await shortTargets(page), `${label(shot)} at ${width}: under 44px`).toEqual([]);
            }
        });
    }

    test('nothing animates under reduced motion', async ({ page }) => {
        describeCheck('reduced motion', 'open board + sign-in/onboarding + running detail at 1440');
        test.setTimeout(FAMILIES.length * SLOW);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await useTheme(page, 'dark');
        for (const shot of [...OPEN_BOARD, ...ANONYMOUS_ENTRY, threadShot('running', 'runningThread', runningThread)]) {
            await openSettled(page, shot, 'dark');
            expect.soft(await runningAnimations(page), `${label(shot)}: running animations`).toEqual([]);
        }
    });

    for (const theme of THEMES) {
        test(`rendered text clears AA — ${theme} at 1440`, async ({ page }) => {
            describeCheck('rendered text contrast', `open board + sign-in/onboarding, ${theme} at 1440`);
            test.setTimeout(FAMILIES.length * SLOW);
            await useTheme(page, theme);
            for (const shot of [...OPEN_BOARD, ...ANONYMOUS_ENTRY]) {
                await openSettled(page, shot, theme);
                const sample = await textContrast(page);
                expect.soft(sample.failures, `${label(shot)} ${theme}: text under AA`).toEqual([]);
                note(`${label(shot)}: ${sample.measured} text runs measured, ${sample.skipped} skipped`);
            }
        });
    }

    for (const width of [1440, 390] as const) {
        test(`every dialog contains focus and returns it at ${width}`, async ({ page }) => {
            describeCheck('dialog focus containment and return', `range, remove, discard, add executor at ${width}`);
            test.setTimeout(4 * SLOW);
            await page.setViewportSize({ width, height: 900 });
            await useTheme(page, 'dark');

            // Each panel by its class: the `dialog` role sits on Headless UI's zero-height
            // positioning layer, which has no box to be visible.
            await openSettled(page, DASHBOARD_SHOT, 'dark');
            const range = page.locator('#range-select');
            await containsAndReturns(page, {
                name: 'range: custom',
                trigger: range,
                panel: page.locator('.range-dialog'),
                open: async () => {
                    await range.click();
                    await page.getByRole('option', { name: /^Custom( ✓)?$/ }).click();
                },
            });

            await openSettled(page, SEEDED_DETAIL, 'dark');
            const more = page.locator('.page-header-actions').getByRole('button', { name: 'More task actions' });
            await containsAndReturns(page, {
                name: 'task: remove',
                trigger: more,
                panel: page.locator('.task-remove'),
                open: async () => {
                    await more.click();
                    await page.getByRole('menuitem', { name: 'Remove task' }).click();
                },
            });

            await withExecutor(page);
            await page.goto('/tasks/new');
            await expect(heading(page, 'New task')).toBeVisible(SETTLED);
            await page.getByLabel('What should the agent do?').fill('a draft worth keeping');
            const discard = page.locator('.composer').getByRole('button', { name: 'Discard draft' });
            await containsAndReturns(page, {
                name: 'composer: discard',
                trigger: discard,
                panel: page.locator('.unsaved'),
                open: () => discard.click(),
            });

            await page.unrouteAll({ behavior: 'ignoreErrors' });
            await mockExecutors(page, []);
            await page.goto('/settings/executors');
            const add = page.getByRole('button', { name: 'Add executor' });
            await containsAndReturns(page, {
                name: 'executors: add',
                trigger: add,
                panel: page.locator('.dialog.picker'),
                open: () => add.click(),
            });
        });
    }

    test('each detector catches the defect it looks for', async ({ page }) => {
        // The negative control: every pass above reports [] on a clean page, which is also what a
        // detector that never matches would report. One planted defect per detector proves each
        // one can see what it is looking for.
        await page.setViewportSize({ width: 390, height: 844 });
        await useTheme(page, 'dark');
        await openSettled(page, SETTINGS_SHOTS[0]!, 'dark');
        await page.evaluate(() => {
            // Styled through the CSSOM: the board's CSP refuses inline `style` attributes, so markup
            // carrying them would plant nothing and the control would prove nothing.
            const plant = (tag: string, className: string, text: string, style: Partial<CSSStyleDeclaration>) => {
                const el = document.createElement(tag);
                el.className = className;
                el.textContent = text;
                Object.assign(el.style, style);
                document.querySelector('main')!.prepend(el);
                return el;
            };
            plant('button', 'probe-unnamed', '', {});
            plant('div', '', '', {}).setAttribute('role', 'status');
            document.querySelector('main [role="status"]')!.append(plant('span', 'sidenav-count', '3', {}));
            plant('span', 'probe-faint', 'faint', { color: 'rgb(120, 120, 120)', background: 'rgb(136, 136, 136)' });
            plant('div', 'probe-ringless', 'ringless', { outline: 'none' }).tabIndex = 0;
            plant('button', 'probe-short', 'short', { height: '20px', minHeight: '0' });
            plant('div', 'probe-wide', 'wide', { width: '2000px' });
            plant('button', 'probe-offscreen', 'offscreen', { position: 'relative', left: '-600px' });
            plant('div', 'probe-moving', 'moving', {}).animate([{ opacity: 0 }, { opacity: 1 }], 60_000);
        });
        expect((await pageOverflow(page)).inner, 'overflow').toBeGreaterThan(0);
        expect(await controlsOutsideViewport(page, 390), 'off-screen').toContainEqual(
            expect.stringContaining('probe-offscreen')
        );
        expect(await runningAnimations(page), 'motion').toEqual(['script animation']);
        expect(await unnamedControls(page), 'names').toEqual([expect.stringMatching(/^- button\b/)]);
        expect(await polledInLiveRegions(page), 'live regions').toEqual([expect.stringContaining('sidenav-count')]);
        expect(await shortTargets(page), 'targets').toContainEqual(expect.stringContaining('probe-short'));
        expect((await textContrast(page)).failures, 'contrast').toContainEqual(expect.stringContaining('probe-faint'));
        expect((await tabWalk(page)).ringless, 'focus ring').toContainEqual(expect.stringContaining('probe-ringless'));
    });
});

/** Every animation running on the page, by the name that finds its source: a CSS animation's
 *  keyframes, a transition's property, or a script-driven one. */
async function runningAnimations(page: Page): Promise<string[]> {
    return await page.evaluate(() =>
        document
            .getAnimations()
            .filter((animation) => animation.playState === 'running')
            .map((animation) => {
                if (animation instanceof CSSAnimation) return `animation ${animation.animationName}`;
                if (animation instanceof CSSTransition) return `transition ${animation.transitionProperty}`;
                return 'script animation';
            })
    );
}

/** Open a dialog, prove Tab and Shift+Tab never leave it, close it with Escape, and prove focus
 *  lands back on the control that opened it. */
interface DialogCase {
    name: string;
    trigger: Locator;
    panel: Locator;
    open: () => Promise<void>;
}

async function containsAndReturns(page: Page, { name, trigger, panel, open }: DialogCase): Promise<void> {
    await open();
    await expect(panel).toBeVisible();
    const insideDialog = () => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
    await expect.poll(insideDialog, `${name}: focus moves into the dialog`).toBe(true);
    const stops = await panel.evaluate(
        (el) => el.querySelectorAll('a[href], button:not(:disabled), input:not([type=hidden]), select, textarea').length
    );
    for (const key of ['Tab', 'Shift+Tab']) {
        for (let press = 0; press < stops + 2; press++) {
            await page.keyboard.press(key);
            expect.soft(await insideDialog(), `${name}: ${key} ${press + 1} stays inside`).toBe(true);
        }
    }
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect.soft(trigger, `${name}: focus returns to the trigger`).toBeFocused();
}

/** The roles a person operates, whose accessible name is how assistive technology announces them. */
const CONTROL_ROLES =
    'button|link|textbox|searchbox|combobox|listbox|checkbox|radio|switch|spinbutton|slider|tab|menuitem|option';

/** Every control in the accessibility tree without an accessible name. The aria snapshot quotes a
 *  name after the role (`- button "Open navigation"`); a control line with no quote has none. */
async function unnamedControls(page: Page): Promise<string[]> {
    const tree = await page.locator('body').ariaSnapshot();
    const unnamed = new RegExp(`^\\s*- (?:${CONTROL_ROLES})(?![\\w-])(?!\\s+")`);
    const lines = tree.split('\n');
    return lines.flatMap((line, i) => (unnamed.test(line) ? [`${line.trim()} (after: ${lines[i - 1]?.trim()})`] : []));
}

/** Elements that re-render on a poll. None may sit inside a live region, or every poll would be
 *  announced; the user-triggered results that do live in one are not on this list. */
const POLLED = [
    '.sidenav-section',
    '.sidenav-count',
    '.mobile-nav-count',
    '.inbox-cards',
    '.inbox-footer',
    '.updated-at',
    '.usage-groups',
    '.toolbar-coverage',
    '.repo-toolbar-count',
    '.task-verification-counts',
    '.chat-runtime',
    '.task-clock',
].join(', ');

const LIVE =
    '[aria-live]:not([aria-live="off"]), [role=status], [role=alert], [role=log], [role=timer], [role=marquee]';

async function polledInLiveRegions(page: Page): Promise<string[]> {
    return await page.evaluate(
        ({ polled, live }) =>
            [...document.querySelectorAll(polled)].flatMap((el) => {
                const region = el.closest(live);
                return region ? [`${el.className} inside ${region.tagName.toLowerCase()}.${region.className}`] : [];
            }),
        { polled: POLLED, live: LIVE }
    );
}

/** The most Tab presses one page may take before the walk calls it a trap. */
const MAX_TAB_STOPS = 400;

/**
 * Tab through the page from the top until focus leaves it or wraps to the first stop, then compare
 * what was reached with every element the page presents as tabbable. Each stop must paint a ring —
 * the chart's `.bucket-hit` paints its own stroke instead (docs/design-system.md, "Focus").
 */
async function tabWalk(
    page: Page
): Promise<{ stops: number; trapped: boolean; ringless: string[]; unreached: string[] }> {
    await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        const w = window as unknown as { __reached: WeakSet<Element>; __first: Element | null };
        w.__reached = new WeakSet();
        w.__first = null;
    });
    const ringless: string[] = [];
    let trapped = true;
    let stops = 0;
    for (let press = 0; press < MAX_TAB_STOPS; press++) {
        await page.keyboard.press('Tab');
        const stop = await page.evaluate(() => {
            const w = window as unknown as { __reached: WeakSet<Element>; __first: Element | null };
            const el = document.activeElement;
            if (!el || el === document.body) return { done: true, ring: true, name: '' };
            if (el === w.__first) return { done: true, ring: true, name: '' };
            w.__first ??= el;
            w.__reached.add(el);
            const style = getComputedStyle(el);
            const ring =
                el.classList.contains('bucket-hit') || (style.outlineStyle !== 'none' && style.outlineWidth !== '0px');
            return { done: false, ring, name: `${el.tagName.toLowerCase()}.${el.className}` };
        });
        if (stop.done) {
            trapped = false;
            break;
        }
        stops++;
        if (!stop.ring) ringless.push(stop.name);
    }
    const unreached = await page.evaluate(() => {
        const w = window as unknown as { __reached: WeakSet<Element> };
        const candidates = document.querySelectorAll<HTMLElement>(
            'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])'
        );
        return [...candidates].flatMap((el) => {
            if (w.__reached.has(el) || el.tabIndex < 0 || el.matches(':disabled')) return [];
            if (!el.checkVisibility({ visibilityProperty: true })) return [];
            const box = el.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) return [];
            if (el.closest('[inert], [aria-hidden="true"]')) return [];
            if (el instanceof HTMLInputElement && el.type === 'radio' && !el.checked) {
                // One stop per radio group: the checked member, when there is one.
                const group = el.form?.elements.namedItem(el.name);
                if (group instanceof RadioNodeList && group.value !== '') return [];
            }
            return [`${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? '').trim().slice(0, 40)}"`];
        });
    });
    return { stops, trapped, ringless: [...new Set(ringless)], unreached };
}

/** Every visible control under the 44px compact target, by the design system's own list:
 *  links, checkboxes and radios, `.toolbar-value` and chart content are exempt ("Control sizes"). */
async function shortTargets(page: Page): Promise<string[]> {
    return await page.evaluate(() =>
        [
            ...document.querySelectorAll<HTMLElement>(
                'button, input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, summary, [role=tab]'
            ),
        ].flatMap((el) => {
            if (!el.checkVisibility({ visibilityProperty: true })) return [];
            if (el.closest('.chart-wrap') || el.classList.contains('toolbar-value')) return [];
            const box = el.getBoundingClientRect();
            if (box.width <= 1 || box.height <= 1 || box.height >= 44) return [];
            const text = (el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30);
            return [`${el.tagName.toLowerCase()}.${el.className} "${text}" ${Math.round(box.height)}px`];
        })
    );
}

/**
 * WCAG 2.2 contrast for every visible run of text on the page, computed in the page: each text
 * color is composited over the stack of backgrounds behind it — translucent washes included — up
 * to the first opaque one, through a one-pixel canvas (the browser's own sRGB conversion, as in
 * polish.spec.ts). Large text (24px, or 18.66px bold) needs 3:1, everything else 4.5:1. Disabled
 * controls are exempt by WCAG; text over an image or gradient, inside SVG (the chart, whose pairs
 * polish.spec.ts measures by token), or under partial opacity cannot be read this way and is
 * counted as skipped rather than guessed at.
 */
async function textContrast(page: Page): Promise<{ failures: string[]; measured: number; skipped: number }> {
    return await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        const rgba = (css: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = css;
            context.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
            return { rgb: [r!, g!, b!], alpha: a! / 255 };
        };
        const over = (bottom: number[], top: { rgb: number[]; alpha: number }) =>
            top.rgb.map((channel, i) => top.alpha * channel + (1 - top.alpha) * bottom[i]!);
        const luminance = (rgb: number[]) => {
            const [r, g, b] = rgb.map((channel) => {
                const s = channel / 255;
                // The WCAG sRGB linearization cutoff.
                return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        const rootStyle = getComputedStyle(document.documentElement);
        const page = rgba(rootStyle.getPropertyValue('--surface'));

        /** The opaque color behind `el`, or null when something behind it is not a flat fill. */
        const backdrop = (el: Element): number[] | null => {
            const layers: { rgb: number[]; alpha: number }[] = [];
            for (let node: Element | null = el; node; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (style.backgroundImage !== 'none' || Number(style.opacity) < 1) return null;
                const fill = rgba(style.backgroundColor);
                if (fill.alpha > 0) layers.push(fill);
                if (fill.alpha >= 1) break;
            }
            let background = page.rgb;
            for (const layer of layers.reverse()) background = over(background, layer);
            return background;
        };

        const failures: string[] = [];
        let measured = 0;
        let skipped = 0;
        for (const el of document.querySelectorAll<HTMLElement>('body *')) {
            const text = [...el.childNodes]
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .map((node) => node.textContent ?? '')
                .join('')
                .trim();
            if (text === '') continue;
            if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
            const box = el.getBoundingClientRect();
            if (box.width <= 1 || box.height <= 1) continue;
            if (el.closest('[aria-hidden="true"], :disabled, [aria-disabled="true"]')) continue;
            const background = el.closest('svg') ? null : backdrop(el);
            if (!background) {
                skipped++;
                continue;
            }
            const style = getComputedStyle(el);
            const foreground = over(background, rgba(style.color));
            const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
            const ratio = (hi! + 0.05) / (lo! + 0.05);
            const size = Number.parseFloat(style.fontSize);
            const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
            const need = large ? 3 : 4.5;
            measured++;
            if (ratio < need) {
                failures.push(
                    `${el.tagName.toLowerCase()}.${el.className} "${text.slice(0, 30)}" ${ratio.toFixed(2)}:1 < ${need}:1`
                );
            }
        }
        return { failures: [...new Set(failures)], measured, skipped };
    });
}

interface Cell {
    route: string;
    state: string;
    fixture: string;
    theme: Theme;
    width: number;
    overflow: { inner: number; document: number; body: number };
    outside: string[];
}

interface Check {
    check: string;
    scope: string;
    result: string;
    failures: string[];
    notes: string[];
}

const readAll = <T>(dir: string): T[] =>
    existsSync(dir)
        ? readdirSync(dir)
              .filter((file) => file.endsWith('.json'))
              .sort()
              .map((file) => JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as T & { run: string })
              .filter((record) => record.run === RUN)
        : [];

/** MATRIX.md, rebuilt from the records on disk: a worker restarted after a failure starts with an
 *  empty module, and the last afterAll must still see every cell. */
function writeReport(): void {
    const cells = readAll<Cell>(CELLS);
    const checks = readAll<Check>(CHECKS);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const widths = MATRIX_VIEWPORTS.map((viewport) => viewport.width);
    const lines = [
        '# Responsive and accessibility matrix (issue 287)',
        '',
        `Generated by \`e2e/matrix.spec.ts\` at commit \`${commit}\`. A cell reads \`pass\` when the page`,
        'is no wider than the viewport (`scrollWidth <= innerWidth`, and the body does not overflow) and',
        'every control outside a named scroll region sits inside it; otherwise the overflow in px.',
        '',
    ];
    for (const theme of THEMES) {
        lines.push(`## Page-level overflow — ${theme}`, '', `| family / state | ${widths.join(' | ')} |`);
        lines.push(`| --- | ${widths.map(() => '---').join(' | ')} |`);
        for (const shot of FAMILIES) {
            const row = widths.map((width) => {
                const cell = cells.find(
                    (c) => c.route === shot.route && c.state === shot.state && c.theme === theme && c.width === width
                );
                if (!cell) return 'not run';
                const worst = Math.max(cell.overflow.inner, cell.overflow.body);
                if (worst > 0) return `FAIL (+${worst}px)`;
                return cell.outside.length > 0 ? `FAIL (${cell.outside.length} controls off-screen)` : 'pass';
            });
            lines.push(`| ${label(shot)} | ${row.join(' | ')} |`);
        }
        lines.push('');
    }
    lines.push('## Assistive checks', '', '| check | scope | result |', '| --- | --- | --- |');
    for (const check of checks) lines.push(`| ${check.check} | ${check.scope} | ${check.result} |`);
    for (const check of checks.filter((c) => c.failures.length > 0 || c.notes.length > 0)) {
        lines.push('', `### ${check.check} — ${check.scope}`, '');
        for (const line of [...check.failures, ...check.notes]) lines.push(`- ${line}`);
    }
    writeFileSync(`${OUT}/MATRIX.md`, `${lines.join('\n')}\n`);
}
