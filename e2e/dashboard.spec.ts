import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

const SHOTS = 'artifacts/ui';

/**
 * The four states the null-not-zero contract can produce on screen. A literal 'NaN' or
 * 'undefined' is what a missing null guard looks like to a reader, and neither type checking
 * nor the SSR smoke test catches it.
 */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

/**
 * The analytics anchor: the metric summary when the selection is ready, the one empty state
 * when it is not. Every state of the null-not-zero contract renders exactly one of these —
 * never a row of dash cards — so the anchor is what "the dashboard has answered" looks like.
 */
function analyticsAnchor(page: Page) {
    return page.locator('.usage-summary, .usage-empty').first();
}

function watchConsole(page: Page): string[] {
    const problems: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
        if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
    return problems;
}

/** The dashboard answers 202 while the first read runs, so wait for the anchor, not for load. */
async function open(page: Page) {
    await page.goto('/');
    await expect(analyticsAnchor(page)).toBeVisible({ timeout: 60_000 });
}

/**
 * A preset that resolves to the query already on screen does not refetch — the hook keys on the
 * query string, not on the click. So the wait is for the specific range, and callers that expect
 * no request say so.
 */
async function selectPreset(page: Page, label: string, preset: string) {
    const [response] = await Promise.all([
        page.waitForResponse((r) => r.url().includes(`range=${preset}`) && r.status() === 200),
        (async () => {
            await page.locator('#range-select').click();
            await page.getByRole('option', { name: label, exact: true }).click();
        })(),
    ]);
    const body = (await response.json()) as {
        meta: { range: { preset: string; from: string | null; to: string | null } };
    };
    return { url: new URL(response.url()), range: body.meta.range };
}

async function assertRendersCleanly(page: Page, name: string) {
    await expect(analyticsAnchor(page)).toBeVisible();
    // A ready selection stands on its panels; the empty selection is the one empty state.
    if (await page.locator('.usage-summary').count()) {
        expect(await page.locator('section.panel').count()).toBeGreaterThan(2);
    }

    const text = await page.locator('main').innerText();
    for (const token of FORBIDDEN) expect(text, `${name} contains ${token}`).not.toContain(token);

    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test.describe('date range selector', () => {
    test('every preset re-renders the whole dashboard cleanly', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);

        // 'All time' is the default, so it is selected last: clicking it first would change no
        // query and fire no request.
        await expect(page.locator('#range-select')).toHaveText('All time');

        for (const [label, preset] of [
            ['Today', 'day'],
            ['7 days', 'week'],
            ['14 days', '2w'],
            ['30 days', 'month'],
            ['All time', 'all'],
        ] as const) {
            const { url, range } = await selectPreset(page, label, preset);
            expect(url.searchParams.get('range'), label).toBe(preset);
            expect(range.preset, label).toBe(preset);
            await expect(page.locator('#range-select')).toHaveText(label);
            await assertRendersCleanly(page, preset);
        }

        expect(problems.join('\n')).toBe('');
    });

    test('a narrowed range changes the numbers', async ({ page }) => {
        await open(page);

        // All time is what the page opens on, so no click is needed to read the baseline.
        const allTime = await page.locator('.usage-summary strong').allInnerTexts();

        await selectPreset(page, 'Today', 'day');
        // A sparse day may render the one empty state instead of the summary — that is a
        // different screen, not the same numbers, and both satisfy "changed". The poll rides
        // out the gap between the response reaching the test and React committing the payload.
        await expect.poll(async () => page.locator('.usage-summary strong').allInnerTexts()).not.toEqual(allTime);
    });

    test('the custom picker commits once through Apply, and a draft never requests', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);

        const requests: string[] = [];
        page.on('request', (r) => {
            if (r.url().includes('/api/stats?')) requests.push(r.url());
        });

        const openCustom = async () => {
            await page.locator('#range-select').click();
            await page.getByRole('option', { name: 'Custom', exact: true }).click();
        };

        // Custom opens the dialog; opening it is not a selection and issues no request.
        await openCustom();
        const from = page.locator('.range-draft input').first();
        const to = page.locator('.range-draft input').last();
        await expect(from).toHaveValue('');
        await from.fill('2026-07-01');
        // Typing is a draft: no stats request may fire for it. Cancel discards the draft.
        expect(requests.filter((u) => u.includes('range=custom'))).toEqual([]);
        await page.getByRole('button', { name: 'Cancel' }).click();
        await expect(page.locator('.range-dialog')).toHaveCount(0);
        expect(requests.filter((u) => u.includes('range=custom'))).toEqual([]);
        await expect(page.locator('#range-select')).toHaveText('All time');

        // Reopening starts from the committed values — all time here — not the abandoned draft.
        // Escape discards a draft exactly like Cancel does.
        await openCustom();
        await expect(from).toHaveValue('');
        await from.fill('2026-07-15');
        await page.keyboard.press('Escape');
        await expect(page.locator('.range-dialog')).toHaveCount(0);
        expect(requests.filter((u) => u.includes('range=custom'))).toEqual([]);

        // Apply commits both bounds exactly once.
        await openCustom();
        await from.fill('2026-07-01');
        await to.fill('2026-08-01');
        const [response] = await Promise.all([
            page.waitForResponse((r) => r.url().includes('range=custom') && r.status() === 200),
            page.getByRole('button', { name: 'Apply range' }).click(),
        ]);
        const body = (await response.json()) as { meta: { range: { from: string; to: string } } };
        expect(body.meta.range.from).toBe('2026-07-01T00:00:00.000Z');
        // `to` is exclusive, so the picked day is widened to the start of the next one.
        expect(body.meta.range.to).toBe('2026-08-02T00:00:00.000Z');
        await expect(page.locator('#range-select')).toHaveText('Jul 1 – Aug 1');

        // Clear returns to All time from the same dialog.
        await openCustom();
        const [cleared] = await Promise.all([
            page.waitForResponse((r) => r.url().includes('range=all') && r.status() === 200),
            page.getByRole('button', { name: 'Clear' }).click(),
        ]);
        expect(new URL(cleared.url()).searchParams.get('range')).toBe('all');
        await expect(page.locator('#range-select')).toHaveText('All time');

        await assertRendersCleanly(page, 'custom-jul');
        expect(problems.join('\n')).toBe('');
    });

    test('the custom range dialog stays inside the viewport and restores focus to the trigger on a narrow phone', async ({
        page,
    }) => {
        await open(page);
        await page.setViewportSize({ width: 360, height: 844 });

        // The dialog centers over the dimmed page rather than anchoring to the trigger, so it
        // never has to flip or clip — the containment the closeout audit (issue 190) demands of
        // every floating surface still holds, just by a different mechanism.
        await page.locator('#range-select').click();
        await page.getByRole('option', { name: 'Custom', exact: true }).click();
        const dialog = page.locator('.range-dialog');
        await expect(dialog).toBeVisible();
        const box = (await dialog.boundingBox())!;
        expect(box.x, 'range dialog left edge').toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, 'range dialog right edge').toBeLessThanOrEqual(361);
        await page.screenshot({ path: `${SHOTS}/matrix/dashboard_range-dialog-open_dark_360.png` });

        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(page.locator('#range-select'), 'escape hands focus back to the Range trigger').toBeFocused();
    });

    test('the chart tooltip stays inside the viewport when a bucket is focused', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await open(page);

        // The last bucket of the all-time chart: the readout clamps inside the SVG, but the SVG
        // rides the chart wrap's horizontal scroll — focusing the far end must still leave the
        // tooltip inside what the reader can see.
        const bucket = page.locator('.bucket-hit').last();
        await bucket.focus();
        const tooltip = page.locator('.chart-tooltip').last();
        await expect(tooltip).toBeVisible();
        const box = (await tooltip.boundingBox())!;
        expect(box.x, 'chart tooltip left edge').toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, 'chart tooltip right edge').toBeLessThanOrEqual(1441);
    });

    test('a range with almost no data renders empty or ready, never broken', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        await selectPreset(page, 'Today', 'day');

        // Whether the fixture's last day holds a session or not, the page stands: the summary
        // renders its figures, or the one empty state replaces them — never dash cards, and a
        // metric with no basis must read as unavailable rather than as a measured zero.
        await expect(analyticsAnchor(page)).toBeVisible();
        const summary = page.locator('.usage-summary');
        if (await summary.count()) {
            await expect(summary.locator('strong').first()).not.toHaveText('');
        }
        const text = await page.locator('main').innerText();
        for (const token of FORBIDDEN) expect(text).not.toContain(token);
        await page.screenshot({ path: `${SHOTS}/today-sparse.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });

    test('the page carries no pull-request vocabulary', async ({ page }) => {
        await open(page);
        const text = (await page.locator('main').innerText()) + (await page.locator('.appbar').innerText());
        expect(text).not.toMatch(/pull requests?/i);
        expect(text).not.toMatch(/revert rate/i);
        expect(text).not.toMatch(/merged into/i);
    });

    test('month buckets daily, all-time falls back to weeks, and the per-task figures render', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);

        // The month preset spans 30 days: day buckets, and the caption says so.
        await selectPreset(page, '30 days', 'month');
        await expect(page.getByText('Input and output tokens by day')).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/daily-month.png`, fullPage: true });

        // All-time spans the seeded half-year: the weekly fallback, named as such — in the
        // caption, and by the calculation disclosure once it is opened.
        await selectPreset(page, 'All time', 'all');
        await expect(page.getByText('Input and output tokens by ISO week')).toBeVisible();
        await page.locator('section.panel', { hasText: 'AI token usage' }).locator('.chart-disclosure summary').click();
        await expect(page.getByText('longer windows render ISO weeks')).toBeVisible();

        // The per-task panel: one table now, every row labeled with its kind, each figure under
        // its Average/Median/P95 header with its measured count beside it.
        const panel = page.locator('section.panel', { hasText: 'Per-task usage' });
        await expect(panel).toBeVisible();
        for (const label of ['Average', 'Median', 'P95', 'Measured tasks']) {
            await expect(panel.getByRole('button', { name: label })).toBeVisible();
        }
        for (const label of ['Tokens per task', 'Runs per task', 'Agent turns per task']) {
            await expect(panel.getByText(label)).toBeVisible();
        }
        await page.screenshot({ path: `${SHOTS}/per-task.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });
});

test.describe('the supporting tables and the task board', () => {
    test('a supporting table sorts from the keyboard and announces the active column', async ({ page }) => {
        await open(page);

        const header = page.getByRole('button', { name: 'New tokens' });
        const th = page.locator('th', { has: header });
        // The by-user table opens sorted by New tokens, largest first.
        await expect(th).toHaveAttribute('aria-sort', 'descending');
        await header.focus();
        await page.keyboard.press('Enter');
        await expect(th).toHaveAttribute('aria-sort', 'ascending');
        await page.screenshot({ path: `${SHOTS}/by-user-sorted.png`, fullPage: true });
    });

    test('a recent task title opens the task page', async ({ page }) => {
        await open(page);

        const link = page.locator('.task-title').first();
        await expect(link).toBeVisible();
        const href = await link.getAttribute('href');
        expect(href).toMatch(/^\/tasks\//);
        await link.click();
        await expect(page).toHaveURL(new RegExp(`${href!.replaceAll('/', '\\/')}$`));
    });

    test('View all tasks opens the task list', async ({ page }) => {
        await open(page);

        await page.getByRole('link', { name: 'View all tasks' }).click();
        await expect(page).toHaveURL(/\/tasks$/);
    });

    test('a board read failure keeps the last good rows while the telemetry stays', async ({ page }) => {
        test.slow();
        await open(page);
        const lastGood = await page.locator('.task-title').first().innerText();

        // Every poll after this point fails: the alert must appear at the next tick (~30s) and
        // the section must keep its rows — a board failure must not blank a section that was
        // answering a moment ago, nor take the telemetry down with it.
        await page.route('**/api/jobs**', (route) =>
            route.fulfill({ status: 500, body: JSON.stringify({ error: 'board offline' }) })
        );
        await expect(page.getByText('The board could not be read — board offline')).toBeVisible({
            timeout: 60_000,
        });
        await expect(page.locator('.task-title').first()).toHaveText(lastGood);
        await expect(page.locator('section.panel', { hasText: 'Per-task usage' })).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/board-degraded.png`, fullPage: true });
    });

    test('a cold board failure shows the error in place', async ({ page }) => {
        await page.route('**/api/jobs**', (route) =>
            route.fulfill({ status: 503, body: JSON.stringify({ error: 'board unreachable' }) })
        );
        await page.goto('/');
        await expect(page.getByText('The board could not be read — board unreachable')).toBeVisible({
            timeout: 60_000,
        });
        await expect(page.locator('.task-title')).toHaveCount(0);
    });

    test('the page never overflows horizontally at the target widths', async ({ page }) => {
        await open(page);

        for (const width of [360, 768, 1024, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            const overflow = await page.evaluate(() => document.body.scrollWidth - document.body.clientWidth);
            expect(overflow, `${width}px: body wider than the viewport`).toBeLessThanOrEqual(0);
            await page.screenshot({ path: `${SHOTS}/width-${width}.png`, fullPage: true });
        }
    });

    test('the primary content begins in the first viewport', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/');
        // Measured once the analytics have landed, not at whatever the first paint happened to be.
        // The board panels mount before the telemetry read resolves, so for a moment the first
        // `main section` is a task panel a screen and a half down; `.first()` resolves against that
        // DOM and the assertion then describes a page that no longer exists. It is the same anchor
        // navigation.spec.ts and workspace.spec.ts wait on for "the dashboard is loaded".
        //
        // This raced from the day it was written and passed on timing alone — a front-end change
        // that moved hydration by a few milliseconds flipped it to failing 2 runs in 6, with the
        // settled layout byte-identical before and after. What it means to assert is where the
        // content SETTLES, which is what it now measures.
        await expect(page.locator('.usage-summary, .usage-empty').first()).toBeVisible();
        const box = await page.locator('main section').first().boundingBox();
        expect(box).not.toBeNull();
        expect(box!.y).toBeLessThan(900);
    });
});

test.describe('the organization selector', () => {
    // Its own case because assertRendersCleanly only scans `main`, and the app bar is outside it.
    test('names the organization and is inert', async ({ page }) => {
        await open(page);

        const select = page.locator('.org-select');
        await expect(select).toBeDisabled();
        // AUTH_MODE=none has exactly one organization, the local one — its id and name are the
        // same string, and the ORG_ID env that used to rename it here is gone (#121). The
        // Listbox trigger carries the name in text and in its aria-label; the one option it
        // would offer is a client-side concern.
        await expect(select).toHaveText('default');
        await expect(select).toHaveAttribute('aria-label', 'Organization: default');

        // Fitting on one line with the account menu is a layout fact no assertion covers.
        await page.locator('.appbar').screenshot({ path: `${SHOTS}/appbar-org.png` });
    });
});

test.describe('the user menu', () => {
    // The Headless UI Menu renders the panel client-side only, so the render suite cannot see it;
    // this open board is AUTH_MODE=none, which makes it the one place the sign-out negative lives.
    test('offers the way to the account page but no sign out where there is no session to end', async ({ page }) => {
        await open(page);

        await page.locator('.user-menu-button').click();
        // The mode ignores every credential, so a sign-out item could never work — absent, not
        // disabled, like the account page's token sections under the same mode.
        await expect(page.getByRole('menuitem', { name: 'Sign out' })).toHaveCount(0);
        await expect(page.getByRole('menuitem', { name: 'Account' })).toBeVisible();

        await page.keyboard.press('Escape');
        await page.locator('.appbar').screenshot({ path: `${SHOTS}/appbar-user-menu.png` });
    });
});
