import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The Workspace page, the left nav, and the one failure that shows up only in production.
 *
 * On the `auth` project, because every route here needs a signed-in member — and because the
 * `chromium` project is the visual regression check for the dashboard and should not churn over
 * this.
 *
 * The auth server runs with a real ORG_WORKSPACE_ROOT under artifacts/, so this drives real
 * provisioning: a directory is created on disk by the sign-in callback. It does NOT drive a clone —
 * the server here is the offline entry, with no GitHub App credential, so the picker reports an
 * empty installation, which is itself a state worth pinning.
 */

const SHOTS = 'artifacts/ui';

const cards = (page: Page) => page.locator('.cards').first().locator('.card');
const signIn = (page: Page) => page.getByRole('link', { name: 'Sign in with GitHub' });

async function signedIn(page: Page) {
    await page.goto('/');
    await signIn(page).click();
    await expect(cards(page)).toHaveCount(6, { timeout: 60_000 });
}

/**
 * Opens the Workspace page and dismisses the picker it offers.
 *
 * The dialog opens by itself the first time, because nothing is selected — that is the onboarding,
 * and it is genuinely modal, so anything behind it is unclickable until it is closed. A test that
 * wants the page rather than the dialog has to say so.
 */
async function workspacePage(page: Page) {
    await page.goto('/workspace');
    const dialog = page.locator('dialog[aria-labelledby="picker-title"]');
    await expect(dialog).toBeVisible();
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toBeHidden();
}

test('the left nav is there and moves between sections', async ({ page }) => {
    await signedIn(page);

    const nav = page.locator('.sidenav');
    await expect(nav).toBeVisible();

    await nav.getByRole('link', { name: 'Workspace' }).click();
    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

    // The picker opens over it, and it is modal — the nav underneath is genuinely unclickable
    // until it is dismissed, which is the whole reason for using a native <dialog>.
    await page.getByRole('button', { name: 'Not now' }).click();

    await nav.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(cards(page)).toHaveCount(6);
});

test('reloading /workspace directly serves the app rather than a 404', async ({ page }) => {
    /*
     * THE reason this file exists.
     *
     * A client-side route only breaks on a real server: Vite has its own history fallback, so this
     * would pass in `npm run dev` and fail in the baked image, where the API serves the SPA. The
     * document must also be open — the wall is on /api/*, never on index.html — which is why the
     * status is asserted before anything renders.
     */
    await signedIn(page);

    const response = await page.goto('/workspace');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    await expect(page.locator('.sidenav')).toBeVisible();
});

test('a signed-out visitor deep-linking to /workspace gets the gate, not a 404', async ({ page }) => {
    await page.request.post('/api/auth/logout');

    const response = await page.goto('/workspace');
    expect(response?.status()).toBe(200);
    await expect(page.locator('.login-gate')).toBeVisible();
});

test('the picker opens by itself when nothing is selected, and is genuinely modal', async ({ page }) => {
    await signedIn(page);
    await page.goto('/workspace');

    const dialog = page.locator('dialog[aria-labelledby="picker-title"]');
    await expect(dialog).toBeVisible();

    /*
     * The offline entry runs with no GitHub App credential, so there is no installation to ask —
     * and the repo source falls back to the repositories the seeded database already holds rows
     * for. That fallback is what keeps a credential-less run usable at all, and this is where it
     * is visible: the picker offers exactly what the dashboard is reporting on.
     */
    await expect(dialog).toContainText('Bellows-AI/bellows.ai');

    // `:modal` is the property renderToStaticMarkup cannot reach, and the one that everything else
    // about the dialog depends on — focus trapping, Escape, the backdrop, and the inertness the nav
    // test relies on. It is true only because showModal() was called, never from `<dialog open>`.
    expect(await dialog.evaluate((node: HTMLDialogElement) => node.matches(':modal'))).toBe(true);

    // A passing assertion says the DOM was right; only the image says the layout was.
    await page.screenshot({ path: `${SHOTS}/workspace-picker.png` });
});

test('Escape closes the picker and the page stays usable', async ({ page }) => {
    // The browser closes a native dialog on Escape without telling React. Without the `close`
    // listener the parent still believes it is open and will not reopen it — so this also proves
    // the button below works afterwards.
    await signedIn(page);
    await page.goto('/workspace');

    const dialog = page.locator('dialog[aria-labelledby="picker-title"]');
    await expect(dialog).toBeVisible();

    // Escape is the browser's, not this component's — but it closes the element without telling
    // React, which is what the `close` listener exists to catch.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Select repositories' }).click();
    await expect(dialog).toBeVisible();
});

test('an executor is added through the dialog, with bad JSON refused in place', async ({ page }) => {
    await signedIn(page);
    await workspacePage(page);

    await page.getByRole('button', { name: 'Add executor' }).click();
    const dialog = page.locator('dialog[aria-labelledby="executor-title"]');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((node: HTMLDialogElement) => node.matches(':modal'))).toBe(true);

    // Not valid JSON: the message appears under the field, and Save stays disabled.
    await dialog.getByPlaceholder('main').fill('main');
    await dialog.locator('textarea').fill('{ model: }');
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled();

    await dialog.locator('textarea').fill('{ "model": "sonnet" }');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog).toBeHidden();

    // The row comes back through the poll, with its type — and the panel no longer says none.
    const panel = page.locator('section.panel', { has: page.getByRole('heading', { name: 'Executors' }) });
    await expect(panel.getByText('main')).toBeVisible();
    await expect(panel.locator('.pill')).toHaveText('claude-code');
    await expect(panel).not.toContainText('No executors configured');

    await page.screenshot({ path: `${SHOTS}/workspace-executors.png`, fullPage: true });
});

test('the workspace page renders nothing malformed', async ({ page }) => {
    // The null-not-zero contract, in the browser this time: a repo with no checkout must render an
    // em dash and never a placeholder that leaked out of a formatter.
    const errors: string[] = [];
    page.on('console', (message) => {
        // The 401 from /api/auth/me before signing in is not a fault: being the thing that reports
        // "nobody is signed in" is that route's whole purpose, and the browser logs every 401 as a
        // console error regardless. Anything else is a real one.
        if (message.type() === 'error' && !message.text().includes('401')) errors.push(message.text());
    });

    await signedIn(page);
    await workspacePage(page);

    const text = (await page.locator('main').innerText()) || '';
    for (const token of ['NaN', 'undefined', 'Infinity', '[object Object]']) {
        expect(text, token).not.toContain(token);
    }
    expect(errors).toEqual([]);

    await page.screenshot({ path: `${SHOTS}/workspace.png`, fullPage: true });
});
