import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const SHOTS = 'artifacts/ui';

/**
 * The responsive shell's browser verification (issue 160): the four widths, the drawer's focus
 * management, the skip link, and the shapes every routed page must agree on. Runs on the open
 * board (AUTH_MODE=none, seeded offline server) like the dashboard check beside it.
 *
 * The closeout audit (issue 190) lives here too: the overflow sentinel now walks every primary
 * route at every supported width, narrow-phone toolbar wrap and named scroll regions are pinned,
 * 200% zoom gets the same sentinel, and the route/state/theme/width screenshot matrix is
 * captured for inspection.
 *
 * What the issue's checklist assigns to the task inbox — filters, sort, Load more, a task older
 * than the former newest-50 window — lands with the inbox itself and is not pretended here.
 */

/** Every page the shell routes to, with the name its screenshot carries. */
const PAGES: ReadonlyArray<[string, string]> = [
    ['/', 'page-dashboard'],
    ['/tasks', 'page-inbox'],
    ['/tasks/new', 'page-composer'],
    ['/settings', 'page-settings-overview'],
    ['/settings/workspace', 'page-settings-workspace'],
    ['/settings/repos', 'page-settings-repos'],
    ['/settings/executors', 'page-settings-executors'],
    ['/settings/organization', 'page-settings-organization'],
    ['/account', 'page-account'],
];

/** The routes the overflow matrix walks: every shell page plus, at run time, a task detail. */
const MATRIX_ROUTES: ReadonlyArray<string> = PAGES.map(([path]) => path);

/** The widths the closeout matrix captures. 1024 has no unique shell state, so it stays
    sentinel-only. */
const MATRIX_WIDTHS = [1440, 768, 390, 320] as const;

/** The elements allowed to scroll horizontally, by the design system's own account of them:
    the table wrap, the chart frame, the log wells, the picker list, and text entry. Anything
    else the audit catches is an unnamed scroll region — a defect, not a fact of the page. */
const NAMED_SCROLL_REGIONS = '.table-wrap, .chart-wrap, .chat-output, .run-well, .picker-list';

/** Waits for the route's data anchor, so a measurement reads the settled layout and not the
    shell the SPA paints first. */
async function settle(page: Page, path: string): Promise<void> {
    if (path === '/') {
        // The dashboard answers 202 while the first read runs (dashboard.spec.ts's open()).
        await page.locator('.usage-summary, .usage-empty').first().waitFor({ timeout: 60_000 });
        return;
    }
    await page.locator('main#main-content').waitFor();
}

/** The matrix's route list with a live task detail appended. */
async function matrixRoutes(page: Page): Promise<string[]> {
    return [...MATRIX_ROUTES, `/tasks/${await someTaskId(page)}`];
}

async function someTaskId(page: Page): Promise<string> {
    // Any thread root: the detail route is the same view whatever the id.
    const body = (await page.request.get('/api/jobs?limit=200').then((r) => r.json())) as {
        jobs: Array<{ id: string; followUpTo: string | null }>;
    };
    const roots = body.jobs.filter((job) => job.followUpTo === null);
    expect(roots.length, 'the seed leaves at least one task').toBeGreaterThan(0);
    return roots[0]!.id;
}

async function noHorizontalOverflow(page: Page): Promise<void> {
    const overflow = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
    }));
    expect(overflow.document, 'document overflows horizontally').toBeLessThanOrEqual(0);
    expect(overflow.body, 'body overflows horizontally').toBeLessThanOrEqual(0);
}

/** Every rendered control sits inside the viewport. Content inside a named scroll region is
    exempt — a scrolled-off table column is the design, a scrolled-off action is not. */
async function controlsInsideViewport(page: Page, width: number): Promise<void> {
    const outside = await page.evaluate(
        ({ vw, regions }) => {
            const out: string[] = [];
            for (const el of document.querySelectorAll<HTMLElement>(
                'main button, main a, main input, main select, main textarea, .appbar button, .appbar a',
            )) {
                if (el.offsetWidth === 0) continue;
                if (el.closest(regions)) continue;
                const box = el.getBoundingClientRect();
                if (box.left < -1 || box.right > vw + 1) {
                    out.push(`${el.tagName.toLowerCase()}.${el.className} at ${Math.round(box.left)}..${Math.round(box.right)}`);
                }
            }
            return out;
        },
        { vw: width, regions: NAMED_SCROLL_REGIONS },
    );
    expect(outside, 'controls pushed outside the viewport').toEqual([]);
}

test.describe('the desktop shell', () => {
    test('the seeded board holds at least a hundred tasks', async ({ page }) => {
        const body = (await page.request.get('/api/jobs?limit=200').then((r) => r.json())) as {
            jobs: Array<{ followUpTo: string | null }>;
        };
        const roots = body.jobs.filter((job) => job.followUpTo === null);
        // The five-row preview cap below means nothing unless the board has far more tasks than
        // the cap — the seed's fixed generator produces about 105-110 roots per run.
        expect(roots.length).toBeGreaterThanOrEqual(100);
    });

    test('every routed page answers with one main region and at most one h1', async ({ page }) => {
        const id = await someTaskId(page);
        for (const [path, name] of [...PAGES, [`/tasks/${id}`, 'page-task-detail'] as [string, string]]) {
            await page.goto(path);
            await expect(page.locator('main#main-content'), path).toHaveCount(1);
            // The dashboard's PageHeader owns the page's one h1; other routes keep the
            // at-most-one check because several render h2 section headings without a page title.
            if (path === '/') {
                expect(await page.locator('main h1').count(), `${path} h1 count`).toBe(1);
            } else {
                expect(await page.locator('main h1').count(), `${path} h1 count`).toBeLessThanOrEqual(1);
            }
            await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
        }
    });

    test('the persistent nav holds 240px and the app bar sticks without an h1', async ({ page }) => {
        await page.goto('/');
        const nav = page.locator('nav[aria-label="Primary"]');
        await expect(nav).toBeVisible();
        expect((await nav.boundingBox())?.width).toBe(240);

        const bar = page.locator('.appbar');
        await expect(bar).toBeVisible();
        expect(await bar.locator('h1').count()).toBe(0);

        // Scroll the tallest page to the bottom: the bar must still sit at the top edge.
        await page.mouse.wheel(0, 20_000);
        await expect
            .poll(async () => (await bar.boundingBox())?.y ?? Number.POSITIVE_INFINITY, 'app bar stuck to the top')
            .toBeLessThanOrEqual(2);
        await page.screenshot({ path: `${SHOTS}/shell-desktop-1440.png`, fullPage: true });
    });

    test('dashboard telemetry lives only on the dashboard', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
        // The freshness stamp — relative copy with the precise timestamp on reveal — rides the
        // dashboard, not the chrome.
        await expect(page.locator('.updated-at')).toBeVisible();

        for (const path of ['/tasks', '/settings/workspace']) {
            await page.goto(path);
            await expect(page.getByRole('button', { name: 'Refresh' })).toHaveCount(0);
            await expect(page.locator('.updated-at')).toHaveCount(0);
        }
    });

    test('the sidenav preview never exceeds five rows per section', async ({ page }) => {
        await page.goto('/tasks');
        // All three sections' rows together, however the seed sorted them.
        const rows = await page.locator('.sidenav-task').count();
        expect(rows, 'preview rows across all sections').toBeLessThanOrEqual(15);

        // The cap only means something if it actually bit: with the board at 100+ tasks, some
        // section's header must be speaking a count no preview could render. (The counts
        // themselves are the 50-run poll window's — org-wide counts are the task-summary API's
        // job, part 2 of the slice.)
        const headers = await page.locator('.sidenav-section').allInnerTexts();
        const counts = headers.map((text) => Number(/\((\d+)\)/.exec(text)?.[1]) || 0);
        expect(counts.some((count) => count > 5), `one section counts past the cap: ${headers.join(', ')}`).toBe(true);
    });
});

test.describe('the responsive shell', () => {
    for (const width of [320, 360, 768, 1024, 1440]) {
        test(`no page-level horizontal overflow at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 1000 });
            for (const path of await matrixRoutes(page)) {
                await page.goto(path);
                await settle(page, path);
                // Polled, not slept: the claim is about the settled layout.
                await expect
                    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
                    .toBeLessThanOrEqual(0);
                await expect
                    .poll(() => page.evaluate(() => document.body.scrollWidth - document.body.clientWidth))
                    .toBeLessThanOrEqual(0);
            }
            if (width === 360 || width === 768) {
                await page.screenshot({ path: `${SHOTS}/responsive-${width}.png`, fullPage: true });
            }
        });
    }

    test('the skip link is the first stop and never steals focus', async ({ page }) => {
        await page.goto('/');
        const skip = page.locator('.skip-link');
        // The gate mounts the app only once the session check answers; Tab before that lands on
        // the sign-in screen and the assertion races the swap.
        await skip.waitFor({ state: 'attached' });

        await page.keyboard.press('Tab');
        await expect(skip).toBeFocused();
        await expect(skip).toBeVisible();
        // The reveal is a transform; capture once it has actually slid in.
        await expect
            .poll(() => page.evaluate(() => getComputedStyle(document.activeElement!).transform))
            .toBe('none');
        await page.screenshot({ path: `${SHOTS}/skip-link-focus.png` });

        await page.keyboard.press('Enter');
        const landed = await page.evaluate(() => document.activeElement?.id);
        expect(landed).toBe('main-content');

        // Ordinary navigation: focus follows the click and nothing pulls it to the main region
        // behind the user's back. A DIFFERENT route must actually be crossed — the first link on
        // `/` is the active Dashboard link, and clicking it navigates nowhere.
        await page.locator('.sidenav-link', { hasText: 'Tasks' }).click();
        await expect(page).toHaveURL('/tasks');
        const after = await page.evaluate(() => document.activeElement?.id ?? 'none');
        expect(after, 'client-side navigation did not move focus to the main region').not.toBe('main-content');
    });

    test('keyboard focus paints the accent ring on navigation and controls, in both themes', async ({
        page,
    }) => {
        // The :focus-visible rule is CSS, invisible to the render suites; this pins the contract
        // where it lands: a keyboard-focused link and button carry a solid two-pixel ring, and
        // the rule colors it via var(--accent) — asserted per theme, since a reflow can wrap the
        // control and no theme may drop the ring (issue 190).
        await page.goto('/');
        await page.locator('.skip-link').waitFor({ state: 'attached' });

        for (const theme of [null, 'light'] as const) {
            await page.evaluate((t) => {
                if (t) document.documentElement.setAttribute('data-theme', t);
                else document.documentElement.removeAttribute('data-theme');
            }, theme);
            for (const target of [page.locator('.sidenav-link').first(), page.getByRole('button', { name: 'Refresh' })]) {
                await target.focus();
                const outline = await target.evaluate((el) => {
                    const style = getComputedStyle(el);
                    return { style: style.outlineStyle, width: style.outlineWidth };
                });
                expect(outline.style, `focused control shows its focus ring (${theme ?? 'dark'})`).toBe('solid');
                expect(parseInt(outline.width, 10), `focus ring is two pixels (${theme ?? 'dark'})`).toBe(2);
            }
        }
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
        await page.screenshot({ path: `${SHOTS}/focus-ring-light.png` });
        await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    });

    for (const [width, height] of [
        [768, 1000],
        [390, 844],
        [360, 844],
    ] as const) {
        test(`the drawer manages focus at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await page.goto('/tasks');

            // The persistent column is gone from the layout, not stacked above the content.
            await expect(page.locator('.sidenav')).not.toBeVisible();
            await noHorizontalOverflow(page);

            // The trigger is located by class: while the modal is open Headless UI marks the
            // page behind it aria-hidden, and role queries do not see into that tree.
            const trigger = page.locator('.appbar-trigger');
            await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(1);
            await expect(trigger).toBeVisible();
            await expect(trigger).toHaveAttribute('aria-expanded', 'false');
            await expect(trigger).toHaveAttribute('aria-controls', 'mobile-nav');

            await trigger.click();
            // Visibility asserts on the PANEL, not the dialog container: `.dialog-layer` is a
            // zero-height positioning shell over the viewport — its backdrop and positioner are
            // `position: fixed` — so the container has no box to measure.
            const dialog = page.getByRole('dialog', { name: 'Navigation' });
            const panel = page.locator('.mobile-nav');
            await expect(dialog).toHaveCount(1);
            await expect(panel).toBeVisible();
            await expect(trigger).toHaveAttribute('aria-expanded', 'true');
            await page.screenshot({ path: `${SHOTS}/drawer-${width}-open.png` });

            // Focus moved into the drawer, and repeated Tab cannot leave it.
            const focusInside = () =>
                page.evaluate(() => (document.activeElement?.closest('.dialog-layer') ? 'inside' : 'outside'));
            expect(await focusInside()).toBe('inside');
            for (let i = 0; i < 6; i += 1) {
                await page.keyboard.press('Tab');
                expect(await focusInside(), `Tab ${i + 1} stayed in the drawer`).toBe('inside');
            }

            // Escape closes, and focus returns to the trigger that opened it.
            await page.keyboard.press('Escape');
            await expect(panel).toHaveCount(0);
            await expect(trigger).toBeFocused();

            // A click on the dimmed page closes it too: the positioner spans the viewport, and
            // Headless UI closes whenever the click lands outside the panel.
            await trigger.click();
            await expect(panel).toBeVisible();
            await page.mouse.click(10, 10);
            await expect(panel).toHaveCount(0);

            // Navigation closes it, and the drawer carries counts and the composer link but no
            // task preview rows — and the organization selector moves in with it.
            await trigger.click();
            await expect(panel).toBeVisible();
            expect(await panel.locator('.sidenav-task').count()).toBe(0);
            await expect(panel.getByText(/\d+ running tasks?/)).toBeVisible();
            await expect(panel.getByText(/\d+ tasks? need/)).toBeVisible();
            await expect(panel.locator('.sidenav-newtask')).toBeVisible();
            await expect(panel.locator('.org-select')).toBeVisible();

            // Touch targets: the compact shell's controls all clear 44px.
            const targets: Array<[ReturnType<typeof page.locator>, string]> = [
                [trigger, 'nav trigger'],
                [panel.getByRole('button', { name: 'Close navigation' }), 'close control'],
                [panel.locator('.sidenav-link').first(), 'nav link'],
                [panel.locator('.org-select'), 'organization selector'],
                [page.locator('.appbar .user-menu-button'), 'account menu'],
            ];
            for (const [target, name] of targets) {
                expect((await target.boundingBox())?.height, `${name} touch target`).toBeGreaterThanOrEqual(44);
            }

            await panel.locator('.sidenav-link', { hasText: 'Dashboard' }).click();
            await expect(panel).toHaveCount(0);
            await expect(page).toHaveURL('/');
        });
    }

    for (const width of [360, 390]) {
        test(`toolbar groups wrap and every action stays reachable at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 844 });

            await page.goto('/');
            await settle(page, '/');
            const controls = page.locator('.dashboard-controls');
            await expect(controls).toBeVisible();
            // Groups wrap as units: the wrap is the mechanism that keeps actions on-screen,
            // so it is asserted where the reachability below could otherwise pass by luck.
            await expect(controls).toHaveCSS('flex-wrap', 'wrap');
            await controlsInsideViewport(page, width);

            await page.goto('/tasks');
            await settle(page, '/tasks');
            const filters = page.locator('.inbox-filters');
            await expect(filters).toBeVisible();
            await expect(filters).toHaveCSS('flex-wrap', 'wrap');
            await controlsInsideViewport(page, width);
        });
    }

    test('horizontal scrolling lives only in named regions on a narrow phone', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        for (const path of await matrixRoutes(page)) {
            await page.goto(path);
            await settle(page, path);
            const offenders = await page.evaluate(
                (allowed) => {
                    const out: string[] = [];
                    for (const el of document.querySelectorAll<HTMLElement>('main *')) {
                        if (el.scrollWidth - el.clientWidth <= 1) continue;
                        const style = getComputedStyle(el);
                        if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') continue;
                        if (el.closest(allowed)) continue;
                        out.push(`${el.tagName.toLowerCase()}.${el.className}`);
                    }
                    return out;
                },
                NAMED_SCROLL_REGIONS,
            );
            expect(offenders, `${path} scrolls somewhere without a named region`).toEqual([]);
        }
    });

    test('200% zoom keeps every primary route free of page-level overflow', async ({ page }) => {
        // Browser-zoom semantics with a mechanism a test can own: zoom on the root scales every
        // px dimension the stylesheet writes, so the 1440 viewport lays out at 720 CSS px — the
        // shell's drawer regime, which is exactly the stress "everything reachable at 200%" asks
        // for. Both projects run Chromium, where `zoom` is standardized.
        await page.addInitScript(() => {
            document.documentElement.style.setProperty('zoom', '2');
        });
        await page.setViewportSize({ width: 1440, height: 1000 });
        for (const path of await matrixRoutes(page)) {
            await page.goto(path);
            await settle(page, path);
            await expect
                .poll(() => page.evaluate(() => document.body.scrollWidth - document.body.clientWidth))
                .toBeLessThanOrEqual(0);
        }
        await page.goto('/');
        await settle(page, '/');
        await page.screenshot({ path: `${SHOTS}/zoom-200-dashboard.png`, fullPage: true });
    });

    test('the account menu opens inside the viewport and restores its trigger on a narrow phone', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/');
        await page.locator('.skip-link').waitFor({ state: 'attached' });

        const trigger = page.locator('.appbar .user-menu-button');
        await trigger.click();
        const panel = page.locator('.user-menu-panel');
        await expect(panel).toBeVisible();
        const box = (await panel.boundingBox())!;
        expect(box.x, 'account menu left edge').toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, 'account menu right edge').toBeLessThanOrEqual(391);
        await page.screenshot({ path: `${SHOTS}/user-menu-390-open.png` });

        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
        await expect(trigger).toBeFocused();
    });
});

test.describe('the visual regression matrix', () => {
    // Issue 190's deterministic captures: route × theme × width, named so a reviewer can find
    // any cell. Not a full Cartesian product — one state per route here, the overlay states
    // below — and animations are disabled, because the one ambient motion would otherwise make
    // two runs of the same page two different pictures. Light theme is the data-theme attribute
    // until the appearance control lands (#188); these are palette captures, not feature checks.
    const themeAttr = (page: Page, theme: 'dark' | 'light') =>
        page.evaluate((t) => {
            if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
            else document.documentElement.removeAttribute('data-theme');
        }, theme);

    const shotName = (path: string, theme: string, width: number) => {
        const slug = path === '/' ? 'dashboard' : path.slice(1).replaceAll('/', '-');
        return `${SHOTS}/matrix/${slug}_default_${theme}_${width}.png`;
    };

    for (const width of MATRIX_WIDTHS) {
        for (const theme of ['dark', 'light'] as const) {
            test(`captures every primary route — ${theme} at ${width}`, async ({ page }) => {
                test.slow();
                await page.setViewportSize({ width, height: width <= 390 ? 844 : 1000 });
                for (const path of await matrixRoutes(page)) {
                    await page.goto(path);
                    await settle(page, path);
                    await themeAttr(page, theme);
                    await page.screenshot({
                        path: shotName(path, theme, width),
                        fullPage: true,
                        animations: 'disabled',
                    });
                }
            });
        }
    }

    test('captures the drawer open on a narrow phone', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/tasks');
        await settle(page, '/tasks');
        await page.locator('.appbar-trigger').click();
        await expect(page.locator('.mobile-nav')).toBeVisible();
        await page.screenshot({
            path: `${SHOTS}/matrix/inbox_drawer-open_dark_390.png`,
            animations: 'disabled',
        });
    });

    test('captures the account menu and the range popover open', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto('/');
        await settle(page, '/');
        await page.locator('.appbar .user-menu-button').click();
        await expect(page.locator('.user-menu-panel')).toBeVisible();
        await page.screenshot({
            path: `${SHOTS}/matrix/dashboard_user-menu-open_dark_1440.png`,
            animations: 'disabled',
        });
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Custom', exact: true }).click();
        await expect(page.locator('.range-popover')).toBeVisible();
        await page.screenshot({
            path: `${SHOTS}/matrix/dashboard_range-popover-open_dark_1440.png`,
            animations: 'disabled',
        });
    });

    test('captures the remove dialog open on a narrow phone', async ({ page }) => {
        const taskId = await someTaskId(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`/tasks/${taskId}`);
        await settle(page, `/tasks/${taskId}`);
        await page.locator('.page-header-actions').getByRole('button', { name: 'More task actions' }).click();
        await page.getByRole('menuitem', { name: 'Remove task' }).click();
        await expect(page.locator('.task-remove')).toBeVisible();
        await page.screenshot({
            path: `${SHOTS}/matrix/task-detail_remove-dialog-open_dark_390.png`,
            animations: 'disabled',
        });
    });
});
