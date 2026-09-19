import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const SHOTS = 'artifacts/ui';

/**
 * The responsive shell's browser verification (issue 160): the four widths, the drawer's focus
 * management, the skip link, and the shapes every routed page must agree on. Runs on the open
 * board (AUTH_MODE=none, seeded offline server) like the dashboard check beside it.
 *
 * What the issue's checklist assigns to the task inbox — filters, sort, Load more, a task older
 * than the former newest-50 window — lands with the inbox itself and is not pretended here.
 */

/** Every page the shell routes to, with the name its screenshot carries. */
const PAGES: ReadonlyArray<[string, string]> = [
    ['/', 'page-dashboard'],
    ['/tasks', 'page-composer'],
    ['/settings/workspace', 'page-settings-workspace'],
    ['/settings/repos', 'page-settings-repos'],
    ['/settings/executors', 'page-settings-executors'],
    ['/settings/organization', 'page-settings-organization'],
    ['/account', 'page-account'],
];

/** The routes the overflow matrix walks. */
const OVERFLOW_ROUTES = ['/', '/tasks', '/settings/workspace', '/account'] as const;

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
            expect(await page.locator('main h1').count(), `${path} h1 count`).toBeLessThanOrEqual(1);
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
        await expect(page.getByText(/data as of/)).toBeVisible();

        for (const path of ['/tasks', '/settings/workspace']) {
            await page.goto(path);
            await expect(page.getByRole('button', { name: 'Refresh' })).toHaveCount(0);
            await expect(page.getByText(/data as of/)).toHaveCount(0);
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
            for (const path of OVERFLOW_ROUTES) {
                await page.goto(path);
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
        // behind the user's back.
        await page.locator('.sidenav-link').first().click();
        const after = await page.evaluate(() => document.activeElement?.id ?? 'none');
        expect(after, 'client-side navigation did not move focus to the main region').not.toBe('main-content');
    });

    test('keyboard focus paints the accent ring on navigation and controls', async ({ page }) => {
        // The :focus-visible rule is CSS, invisible to the render suites; this pins the contract
        // where it lands: a keyboard-focused link and button carry a solid two-pixel ring in the
        // default theme — the rule colors it via var(--accent), so both themes follow.
        await page.goto('/');
        await page.locator('.skip-link').waitFor({ state: 'attached' });

        for (const target of [page.locator('.sidenav-link').first(), page.getByRole('button', { name: 'Refresh' })]) {
            await target.focus();
            const outline = await target.evaluate((el) => {
                const style = getComputedStyle(el);
                return { style: style.outlineStyle, width: style.outlineWidth };
            });
            expect(outline.style, 'focused control shows its focus ring').toBe('solid');
            expect(parseInt(outline.width, 10), 'focus ring is two pixels').toBe(2);
        }
    });

    for (const width of [768, 360]) {
        test(`the drawer manages focus at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 1000 });
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
});
