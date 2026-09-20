import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { throughSignIn } from './signin.js';

/**
 * The workspace section of Settings, the repositories section its selection moved to (#181), the
 * left nav, and the one failure that shows up only in production.
 *
 * On the `auth` project, because every route here needs a signed-in member — and because the
 * `chromium` project is the visual regression check for the dashboard and should not churn over
 * this.
 *
 * The auth server runs with a real ORG_WORKSPACE_ROOT under artifacts/, so this drives real
 * provisioning: a directory is created on disk by the sign-in callback. It does NOT drive a clone —
 * the server here is the offline entry, with no GitHub App credential, and the stored fallback is
 * scoped to the caller's org (stored-repos.ts) while the seed plants rows only under the local org.
 * This member's installation org holds no repos, so the repositories page pins its explicit empty
 * state and the workspace page its empty-checkout sentence. Populated selection rows, checkout
 * statuses and the configuration detail need a credential to be honest, and stay with the e2e
 * suites of a credentialed run.
 */

const SHOTS = 'artifacts/ui';

const usageGroups = (page: Page) => page.locator('.usage-summary .usage-group');

async function signedIn(page: Page) {
    // The shared helper: through the selection screen on the run's first sign-in, straight in
    // after it (the stored choice is the choice).
    await throughSignIn(page);
}

test('the left nav is there and moves between sections', async ({ page }) => {
    await signedIn(page);

    const nav = page.locator('.sidenav');
    await expect(nav).toBeVisible();

    // The Settings item opens the org-level tree; its index route lands on the workspace section,
    // the area's default pane, with the four section links visible under the item (#150).
    await nav.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings\/workspace$/);
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
    // The 200 + shell is the deep-link contract; the heading proves the route resolved to the
    // workspace section and not the catch-all.
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    await expect(page.locator('.sidenav')).toBeVisible();
});

test('a signed-out visitor deep-linking to the settings tree gets the gate, not a 404', async ({ page }) => {
    await page.request.post('/api/auth/logout');

    const response = await page.goto('/settings/workspace');
    expect(response?.status()).toBe(200);
    await expect(page.locator('.login-gate')).toBeVisible();
});

test('the workspace page links to the repositories page for checkout management', async ({ page }) => {
    await signedIn(page);
    await page.goto('/settings/workspace');

    // Root provisioning happens at sign-in, so the management link is present — a deployment with
    // no ORG_WORKSPACE_ROOT drops it and states the operator copy instead, which the open board
    // renders in its screenshots.
    const link = page.getByRole('link', { name: 'Manage repository checkouts' });
    await expect(link).toBeVisible();
    await expect(page.getByText('Nothing checked out yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select repositories' })).toHaveCount(0);

    // The link IS the way in: selection lives on the repositories page now, not in a modal here.
    await link.click();
    await expect(page).toHaveURL(/\/settings\/repos$/);

    await page.screenshot({ path: `${SHOTS}/settings-workspace.png`, fullPage: true });
});

test('the repositories page carries the selection surface, its empty state named', async ({ page }) => {
    await signedIn(page);
    await page.goto('/settings/repos');

    /*
     * Both sources settle here: the installation reports nothing for this credential-less org
     * (the stored fallback is scoped to it), and the workspace poll answers with no checkouts.
     * The zero-list sentence is the honest reading of an org with no rows, not a failure to list
     * — and only once both answered does the enabled count state its zero.
     */
    await expect(page.getByText('This GitHub App is not installed on any repositories yet')).toBeVisible({
        timeout: 60_000,
    });
    await expect(page.getByText('0 of 0 repositories enabled')).toBeVisible();
    await expect(page.getByLabel('Search repositories')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save repository selection' })).toBeVisible();
    await expect(page.getByText('Selections are limited to 20 repositories.')).toBeVisible();

    await page.screenshot({ path: `${SHOTS}/settings-repos.png`, fullPage: true });
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
    await page.goto('/settings/workspace');
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

    const text = (await page.locator('main').innerText()) || '';
    for (const token of ['NaN', 'undefined', 'Infinity', '[object Object]']) {
        expect(text, token).not.toContain(token);
    }
    expect(errors).toEqual([]);

    await page.screenshot({ path: `${SHOTS}/settings-workspace-env.png`, fullPage: true });
});
