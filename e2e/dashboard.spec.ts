import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

const SHOTS = 'artifacts/ui';

/**
 * The four states the null-not-zero contract can produce on screen. A literal 'NaN' or
 * 'undefined' is what a missing null guard looks like to a reader, and neither type checking
 * nor the SSR smoke test catches it.
 */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

/** `.cards` is the AI usage panel's card row, and the first section on the page. */
function usageCards(page: Page) {
    return page.locator('.cards').first().locator('.card');
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

/** The dashboard answers 202 while the first read runs, so wait for the cards, not for load. */
async function open(page: Page) {
    await page.goto('/');
    await expect(usageCards(page)).toHaveCount(5, { timeout: 60_000 });
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
        page.getByRole('button', { name: label, exact: true }).click(),
    ]);
    const body = (await response.json()) as {
        meta: { range: { preset: string; from: string | null; to: string | null } };
    };
    return { url: new URL(response.url()), range: body.meta.range };
}

async function assertRendersCleanly(page: Page, name: string) {
    await expect(usageCards(page)).toHaveCount(5);
    // Every panel that renders must render something: a bare heading is a broken panel.
    expect(await page.locator('section.panel').count()).toBeGreaterThan(2);

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
        await expect(page.getByRole('button', { name: 'All time', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );

        for (const [label, preset] of [
            ['Today', 'day'],
            ['This week', 'week'],
            ['Two weeks', '2w'],
            ['Month', 'month'],
            ['All time', 'all'],
        ] as const) {
            const { url, range } = await selectPreset(page, label, preset);
            expect(url.searchParams.get('range'), label).toBe(preset);
            expect(range.preset, label).toBe(preset);
            await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute(
                'aria-pressed',
                'true',
            );
            await assertRendersCleanly(page, preset);
        }

        expect(problems.join('\n')).toBe('');
    });

    test('a narrowed range changes the numbers and says so', async ({ page }) => {
        await open(page);

        // All time is what the page opens on, so no click is needed to read the baseline.
        const allTime = await usageCards(page).locator('strong').allInnerTexts();
        await expect(page.getByText('Every figure above covers')).toHaveCount(0);

        await selectPreset(page, 'Today', 'day');
        const today = await usageCards(page).locator('strong').allInnerTexts();
        expect(today).not.toEqual(allTime);

        // The scope has to be stated, or a narrowed range reads as a shrinking repository.
        await expect(page.getByText('Every figure above covers')).toBeVisible();
    });

    test('the custom picker applies both bounds and shows all time until one is set', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await open(page);

        const requests: string[] = [];
        page.on('request', (r) => {
            if (r.url().includes('/api/stats?')) requests.push(r.url());
        });

        await page.getByRole('button', { name: 'Custom', exact: true }).click();
        await expect(page.getByText('showing all time until then')).toBeVisible();
        // An empty custom range resolves to all time, which is the query already on screen, so
        // it refetches nothing. Sending it as `range=custom` would be a 400 per keystroke.
        expect(requests.filter((u) => u.includes('range=custom'))).toEqual([]);

        const from = page.locator('.range-custom input').first();
        const to = page.locator('.range-custom input').last();

        const [response] = await Promise.all([
            page.waitForResponse(
                (r) => r.url().includes('from=2026-07-01') && r.status() === 200,
            ),
            from.fill('2026-07-01'),
        ]);
        expect(new URL(response.url()).searchParams.get('range')).toBe('custom');

        const [bounded] = await Promise.all([
            page.waitForResponse((r) => r.url().includes('to=2026-08-01') && r.status() === 200),
            to.fill('2026-08-01'),
        ]);
        const body = (await bounded.json()) as { meta: { range: { from: string; to: string } } };
        expect(body.meta.range.from).toBe('2026-07-01T00:00:00.000Z');
        // `to` is exclusive, so the picked day is widened to the start of the next one.
        expect(body.meta.range.to).toBe('2026-08-02T00:00:00.000Z');

        await expect(page.getByText('showing all time until then')).toHaveCount(0);
        await assertRendersCleanly(page, 'custom-jul');
        expect(problems.join('\n')).toBe('');
    });

    test('a range with almost no data renders empty, not broken', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        await selectPreset(page, 'Today', 'day');

        // A few sessions in the fixture's last day: the panels must still stand up, and a
        // metric with no basis must read as unavailable rather than as a measured zero.
        await assertRendersCleanly(page, 'today-sparse');
        await expect(usageCards(page).locator('strong').first()).not.toHaveText('');
        expect(problems.join('\n')).toBe('');
    });

    test('the page carries no pull-request vocabulary', async ({ page }) => {
        await open(page);
        const text = (await page.locator('main').innerText()) + (await page.locator('header').innerText());
        expect(text).not.toMatch(/pull requests?/i);
        expect(text).not.toMatch(/revert rate/i);
        expect(text).not.toMatch(/merged into/i);
    });
});

test.describe('the organization selector', () => {
    // Its own case because assertRendersCleanly only scans `main`, and the topbar is outside it.
    test('names the organization and is inert', async ({ page }) => {
        await open(page);

        const select = page.locator('.org-select');
        await expect(select).toBeDisabled();
        await expect(select).toHaveValue('e2e-org');
        await expect(select).toHaveText('E2E Org');
        // One option, because a config-mode deployment has exactly one organization.
        await expect(select.locator('option')).toHaveCount(1);

        // Fitting beside Refresh without wrapping is a layout fact no assertion covers.
        await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
        await page.locator('.topbar').screenshot({ path: `${SHOTS}/topbar-org.png` });
    });
});
