import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { throughSignIn } from './signin.js';

/**
 * The workspace section of Settings, the left nav, and the one failure that shows up only in
 * production.
 *
 * On the `auth` project, because every route here needs a signed-in member — and because the
 * `chromium` project is the visual regression check for the dashboard and should not churn over
 * this.
 *
 * The auth server runs with a real ORG_WORKSPACE_ROOT under artifacts/, so this drives real
 * provisioning: a directory is created on disk by the sign-in callback. It does NOT drive a clone —
 * the server here is the offline entry, with no GitHub App credential, and the stored fallback is
 * scoped to the caller's org (stored-repos.ts) while the seed plants rows only under the local org.
 * This member's installation org holds no repos, so the picker pins its explicit empty state.
 */

const SHOTS = 'artifacts/ui';

const usageGroups = (page: Page) => page.locator('.usage-summary .usage-group');

async function signedIn(page: Page) {
    // The shared helper: through the selection screen on the run's first sign-in, straight in
    // after it (the stored choice is the choice).
    await throughSignIn(page);
}

/**
 * Opens the workspace section of Settings and dismisses the picker it offers.
 *
 * The dialog opens by itself the first time, because nothing is selected — that is the onboarding,
 * and it is genuinely modal, so anything behind it is unclickable until it is closed. A test that
 * wants the page rather than the dialog has to say so.
 */
async function workspacePage(page: Page) {
    await page.goto('/settings/workspace');
    const dialog = page.locator('[role="dialog"][aria-labelledby="picker-title"]');
    await expect(dialog).toBeVisible();
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toBeHidden();
}

test('the left nav is there and moves between sections', async ({ page }) => {
    await signedIn(page);

    const nav = page.locator('.sidenav');
    await expect(nav).toBeVisible();

    // The Settings item opens the org-level tree; its index route lands on the workspace section,
    // the area's default pane, with the four section links visible under the item (#150).
    await nav.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings\/workspace$/);

    // Nothing is selected yet, so the picker opens over the section on arrival — modal, so the
    // heading and the tree under the nav item are asserted after it is dismissed.
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Repositories' })).toBeVisible();

    await nav.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(usageGroups(page)).toHaveCount(4);
});

test('reloading /settings/workspace directly serves the app rather than a 404', async ({ page }) => {
    /*
     * THE reason this file exists.
     *
     * A client-side route only breaks on a real server: Vite has its own history fallback, so this
     * would pass in `npm run dev` and fail in the baked image, where the API serves the SPA. The
     * document must also be open — the wall is on /api/*, never on index.html — which is why the
     * status is asserted before anything renders.
     */
    await signedIn(page);

    const response = await page.goto('/settings/workspace');
    expect(response?.status()).toBe(200);
    // The first visit with nothing selected opens the picker over the section; dismiss it and the
    // section is assertable. The 200 + shell is the deep-link contract; the heading proves the
    // route resolved to the workspace section and not the catch-all.
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    await expect(page.locator('.sidenav')).toBeVisible();
});

test('a signed-out visitor deep-linking to the settings tree gets the gate, not a 404', async ({ page }) => {
    await page.request.post('/api/auth/logout');

    const response = await page.goto('/settings/workspace');
    expect(response?.status()).toBe(200);
    await expect(page.locator('.login-gate')).toBeVisible();
});

test('the picker opens by itself when nothing is selected, and is genuinely modal', async ({ page }) => {
    await signedIn(page);
    await page.goto('/settings/workspace');

    const dialog = page.locator('[role="dialog"][aria-labelledby="picker-title"]');
    await expect(dialog).toBeVisible();

    /*
     * The offline entry runs with no GitHub App credential, and the stored fallback is scoped to
     * the caller's organization (stored-repos.ts). The seed deliberately plants rows only under
     * the local org — a github-mode board materializes its own installation org at sign-in (#99)
     * — so this member's org has no repos to offer and the picker renders its empty state. That
     * is the honest reading of a credential-less org with no stored rows, not a failure to list.
     */
    await expect(dialog).toContainText('This GitHub App is not installed on any repositories yet');

    // `aria-modal` and the rest of the page going inert are what renderToStaticMarkup cannot
    // reach, and what everything else about the dialog depends on — focus trapping, Escape, the
    // backdrop. A click on the nav must land nowhere while the dialog is up. Headless marks the
    // application root (the main tree beside its portal), not each descendant, so the assertion
    // is on the one inert root that contains the nav, not on the nav itself.
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    const nav = page.locator('.sidenav');
    const inertRoot = page.locator('[inert][aria-hidden="true"]', { has: nav });
    await expect(inertRoot).toHaveCount(1);

    // The CSP sends form-action 'none', so no submitting form may ever appear in here — the same
    // trap that makes LoginGate an anchor rather than a form.
    expect(await dialog.locator('form').count()).toBe(0);

    // A passing assertion says the DOM was right; only the image says the layout was.
    await page.screenshot({ path: `${SHOTS}/workspace-picker.png` });
});

test('Escape closes the picker and the page stays usable', async ({ page }) => {
    // Escape closes the Dialog — Headless hands it to `onClose`, so the parent's state moves with
    // it and the button below can reopen it. Under the native dialog this was the desync trap the
    // `close` listener existed to catch; here a missed sync would fail this test.
    await signedIn(page);
    await page.goto('/settings/workspace');

    const dialog = page.locator('[role="dialog"][aria-labelledby="picker-title"]');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Select repositories' }).click();
    await expect(dialog).toBeVisible();
});

test('an executor is added through the dialog, with bad JSON refused in place', async ({ page }) => {
    await signedIn(page);
    await page.goto('/settings/executors');

    await page.getByRole('button', { name: 'Add executor' }).click();
    const dialog = page.locator('[role="dialog"][aria-labelledby="executor-title"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Not valid JSON: the message appears under the field, and Save stays disabled.
    await dialog.getByPlaceholder('main').fill('main');
    await dialog.locator('textarea').fill('{ model: }');
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled();

    await dialog.locator('textarea').fill('{ "model": "sonnet" }');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog).toBeHidden();

    // Focus went back to the trigger the dialog opened from — the Dialog restores it on close,
    // and the next keystroke must land where the member left it.
    await expect(page.getByRole('button', { name: 'Add executor' })).toBeFocused();

    // The row comes back through the poll, with its type — and the panel no longer says none.
    const panel = page.locator('section.panel', { has: page.getByRole('heading', { name: 'Executors' }) });
    await expect(panel.getByText('main')).toBeVisible();
    await expect(panel.locator('.pill')).toHaveText('claude-code');
    await expect(panel).not.toContainText('No executors configured');

    await page.screenshot({ path: `${SHOTS}/settings-executors.png`, fullPage: true });
});

test('the workspace section renders nothing malformed', async ({ page }) => {
    // The null-not-zero contract, in the browser this time: a repo with no checkout must render an
    // em dash and never a placeholder that leaked out of a formatter.
    const errors: string[] = [];
    page.on('console', (message) => {
        // Nothing is exempt, including the pre-sign-in session probe: /api/auth/me answers
        // 200 {authenticated: false} for nobody precisely so the browser logs no error for it.
        if (message.type() === 'error') errors.push(message.text());
    });

    await signedIn(page);
    await workspacePage(page);

    const text = (await page.locator('main').innerText()) || '';
    for (const token of ['NaN', 'undefined', 'Infinity', '[object Object]']) {
        expect(text, token).not.toContain(token);
    }
    expect(errors).toEqual([]);

    await page.screenshot({ path: `${SHOTS}/settings-workspace.png`, fullPage: true });
});
