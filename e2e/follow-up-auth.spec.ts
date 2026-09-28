import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
    authoredBy,
    missingSummaryThread,
    OTHER_AUTHOR,
    routeThread,
    sessionAuthor,
    type ThreadUser,
} from './fixtures/threads.js';
import { throughSignIn } from './signin.js';

/**
 * Who may continue a task (#281, F3), against a real sign-in: the board refuses a follow-up from
 * anyone but the account that queued the row it is posted to, so the page offers the composer to
 * that account alone. The session is the stub IdP's real one, read back from `/api/auth/me` — never
 * a fixture id — and the thread is routed with its author set to self, to another member, or to
 * nobody.
 */

const task = missingSummaryThread[0]!.id;

async function openAs(page: Page, author: ThreadUser | null): Promise<void> {
    await routeThread(page, authoredBy(missingSummaryThread, author));
    await page.goto(`/tasks/${task}`);
    await expect(page.locator('.page-header h1')).toHaveText('seed task');
}

let me: ThreadUser;

test.beforeEach(async ({ page }) => {
    await throughSignIn(page);
    me = await sessionAuthor(page);
});

test('your own task offers the composer', async ({ page }) => {
    await openAs(page, me);
    await expect(page.getByLabel('Ask for a follow-up')).toBeVisible();
    await expect(page.getByText('can continue this session')).toHaveCount(0);
});

test("another member's task says who can continue, and still offers Mark done", async ({ page }) => {
    await openAs(page, OTHER_AUTHOR);
    await expect(
        page.getByText(`Only ${OTHER_AUTHOR.login} can continue this session. You can still mark it done.`)
    ).toBeVisible();
    await expect(page.locator('textarea')).toHaveCount(0);
    await expect(page.locator('.page-header-actions').getByRole('button', { name: 'Mark done' })).toBeVisible();
    await page.screenshot({ path: 'artifacts/ui/follow-up-not-author.png', fullPage: true });
});

test('a task with no recorded author is nobody’s to continue for a signed-in member', async ({ page }) => {
    await openAs(page, null);
    await expect(page.getByText('Only the task author can continue this session.')).toBeVisible();
    await expect(page.locator('textarea')).toHaveCount(0);
});

test("the board's 403 renders inside the composer and keeps the draft", async ({ page }) => {
    const refusal = 'Only the account that queued the task can follow it up';
    await page.route('**/api/jobs/*/follow-up', (route) =>
        route.fulfill({ status: 403, json: { error: refusal, code: 'FORBIDDEN' } })
    );
    await openAs(page, me);
    const box = page.getByLabel('Ask for a follow-up');
    await box.fill('one more pass');
    await page.getByRole('button', { name: 'Send follow-up' }).click();
    await expect(page.locator('.composer')).toContainText(refusal);
    await expect(box).toHaveValue('one more pass');
});
