import { expect, type Page } from '@playwright/test';

/** No page renders wider than its own viewport — shared by every spec that walks narrow widths,
    so a fix to the check applies everywhere at once instead of drifting between copies. */
export async function noHorizontalOverflow(page: Page): Promise<void> {
    const overflow = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
    }));
    expect(overflow.document, 'document overflows horizontally').toBeLessThanOrEqual(0);
    expect(overflow.body, 'body overflows horizontally').toBeLessThanOrEqual(0);
}
