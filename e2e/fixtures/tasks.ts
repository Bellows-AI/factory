import type { Page } from '@playwright/test';

const LONG = 'refactor-'.repeat(20);

/** Rewrite the first two inbox rows the real board answers with an unbroken title and repository;
 *  every other field, and every other row, stays the seed's. */
export async function routeLongTasks(page: Page): Promise<void> {
    await page.route('**/api/tasks*', async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { page: { items: Array<{ command: string; repo: string }> } };
        for (const item of body.page.items.slice(0, 2)) {
            item.command = `${LONG}${LONG}`;
            item.repo = `acme/${LONG}`;
        }
        await route.fulfill({ response, json: body });
    });
}
