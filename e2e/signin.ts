import { expect, type Page } from '@playwright/test';

/**
 * Signs in through whatever the flow serves (issue 125): the selection screen when the signing-in
 * account has no stored choice yet, straight in when it does. Confirms the pre-checked default,
 * so both stub installations end up tracked — and waits for the dashboard either way.
 *
 * Shared by both auth-project spec files, which sign in fresh contexts against one server: the
 * FIRST sign-in of a run meets the screen, every later one skips it, and no caller should have to
 * know which it will get.
 */
export async function finishSignIn(page: Page): Promise<void> {
    // Either outcome of the callback: the selection screen, or the dashboard straight away.
    // The dashboard's answer is the analytics anchor — the metric summary when the selection
    // is ready, the one empty state when it is not (issue 166).
    await page.locator('.onboarding, .usage-summary, .usage-empty').first().waitFor({ timeout: 60_000 });
    if (await page.locator('.onboarding').isVisible()) {
        await page.getByRole('button', { name: 'Continue' }).click();
    }
    await expect(page.locator('.usage-summary, .usage-empty').first()).toBeVisible({ timeout: 60_000 });
}

export async function throughSignIn(page: Page): Promise<void> {
    await page.goto('/');
    await page.getByRole('link', { name: 'Sign in with GitHub' }).click();
    await finishSignIn(page);
}
