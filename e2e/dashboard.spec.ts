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
        page.waitForResponse(
            (r) => r.url().includes(`range=${preset}`) && r.status() === 200,
        ),
        page.getByRole('radio', { name: label, exact: true }).click(),
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
        await expect(page.getByRole('radio', { name: 'All time', exact: true })).toHaveAttribute(
            'aria-checked',
            'true',
        );

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
            await expect(page.getByRole('radio', { name: label, exact: true })).toHaveAttribute(
                'aria-checked',
                'true',
            );
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
        // different screen, not the same numbers, and both satisfy "changed".
        const today = await page.locator('.usage-summary strong').allInnerTexts();
        expect(today).not.toEqual(allTime);
    });

    test('the custom picker commits once through Apply, and a draft never requests', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await open(page);

        const requests: string[] = [];
        page.on('request', (r) => {
            if (r.url().includes('/api/stats?')) requests.push(r.url());
        });

        // Custom opens the popover; opening it is not a selection and issues no request.
        await page.getByRole('button', { name: 'Custom', exact: true }).click();
        const from = page.locator('.range-draft input').first();
        const to = page.locator('.range-draft input').last();
        await expect(from).toHaveValue('');
        await from.fill('2026-07-01');
        // Typing is a draft: no stats request may fire for it. Escape discards the draft.
        expect(requests.filter((u) => u.includes('range=custom'))).toEqual([]);
        await page.keyboard.press('Escape');
        await expect(page.locator('.range-draft')).toHaveCount(0);
        expect(requests.filter((u) => u.includes('range=custom'))).toEqual([]);

        // Reopening starts from the committed values — all time here — not the abandoned draft.
        await page.getByRole('button', { name: 'Custom', exact: true }).click();
        await expect(from).toHaveValue('');

        // Apply commits both bounds exactly once.
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

        // Clear returns to All time from the same popover.
        await page.getByRole('button', { name: 'Custom', exact: true }).click();
        const [cleared] = await Promise.all([
            page.waitForResponse((r) => r.url().includes('range=all') && r.status() === 200),
            page.getByRole('button', { name: 'Clear' }).click(),
        ]);
        expect(new URL(cleared.url()).searchParams.get('range')).toBe('all');
        await expect(page.getByRole('radio', { name: 'All time', exact: true })).toHaveAttribute(
            'aria-checked',
            'true',
        );

        await assertRendersCleanly(page, 'custom-jul');
        expect(problems.join('\n')).toBe('');
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
        const text = (await page.locator('main').innerText()) + (await page.locator('header').innerText());
        expect(text).not.toMatch(/pull requests?/i);
        expect(text).not.toMatch(/revert rate/i);
        expect(text).not.toMatch(/merged into/i);
    });

    test('month buckets daily, all-time falls back to weeks, and the per-task figures render', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await open(page);

        // The month preset spans 30 days: day buckets, and the blurb says so.
        await selectPreset(page, '30 days', 'month');
        await expect(page.getByText('tokens per day')).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/daily-month.png`, fullPage: true });

        // All-time spans the seeded half-year: the weekly fallback, named as such.
        await selectPreset(page, 'All time', 'all');
        await expect(page.getByText('per ISO week')).toBeVisible();
        await expect(page.getByText('too long for daily bars')).toBeVisible();

        // The per-task panel: three figures, each labeled with its kind, each beside its count.
        const panel = page.locator('section.panel', { hasText: 'Per-task usage' });
        await expect(panel).toBeVisible();
        for (const label of ['Tokens per task', 'Runs per task', 'Agent turns per task']) {
            await expect(panel.getByText(label)).toBeVisible();
        }
        await expect(panel.getByText(/tasks? measured/).first()).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/per-task.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
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

        // Fitting on one line with the account menu is a layout fact no assertion covers; the
        // Refresh action itself lives on the dashboard now, not in the bar.
        await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
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
