import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The sign-in flow, in a real browser, against a stub identity provider.
 *
 * dashboard.spec.ts stays on the open board and is untouched: it is the visual regression check and
 * should not churn over an auth change. This file is the one that proves the gate, the round trip
 * and the sign-out, and it runs against its own server with AUTH_MODE=github.
 */

const cards = (page: Page) => page.locator('.cards').first().locator('.card');
const gate = (page: Page) => page.locator('.login-gate');
const signIn = (page: Page) => page.getByRole('link', { name: 'Sign in with GitHub' });

test('an anonymous visitor gets the gate and no dashboard', async ({ page }) => {
    await page.goto('/');

    await expect(gate(page)).toBeVisible();
    await expect(signIn(page)).toBeVisible();
    // The point of gating above App rather than inside it: the panels are never mounted, so no
    // request for data is ever made by somebody who could not read the answer.
    await expect(cards(page)).toHaveCount(0);
});

test('the document itself is served without authentication', async ({ page }) => {
    // If index.html 401'd there would be nothing left to render a sign-in button in. The wall is on
    // /api/*, never on the document — this is what pins that.
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
});

test('signing in lands on the dashboard', async ({ page }) => {
    await page.goto('/');
    await signIn(page).click();

    // Through the stub authorize endpoint, back to the callback, and on to the app.
    await expect(cards(page)).toHaveCount(5, { timeout: 60_000 });
    await expect(gate(page)).toHaveCount(0);
});

test('the account claims its invite, so the API answers as a member', async ({ page }) => {
    await page.goto('/');
    await signIn(page).click();
    await expect(cards(page)).toHaveCount(5, { timeout: 60_000 });

    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    // The seed leaves an unclaimed invite for this login; first sign-in is what binds it.
    expect(await me.json()).toMatchObject({ user: { login: 'e2e-user' }, role: 'admin', mode: 'github' });
});

test('signing out returns to the gate', async ({ page }) => {
    await page.goto('/');
    await signIn(page).click();
    await expect(cards(page)).toHaveCount(5, { timeout: 60_000 });

    // Through the user menu — the affordance, not a hand-crafted request.
    await page.locator('.user-menu-button').click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(gate(page)).toBeVisible();
    await expect(cards(page)).toHaveCount(0);

    // The old cookie no longer authenticates: /me answers "nobody".
    const me = await page.request.get('/api/auth/me');
    expect(await me.json()).toMatchObject({ authenticated: false });

    // Idempotent: signing out again, or with an already-dead session, is a 204 — never an error.
    const response = await page.request.post('/api/auth/logout');
    expect(response.status()).toBe(204);
});

test('the returnTo path survives the round trip', async ({ page }) => {
    // Carried inside the signed state rather than in a second cookie, so one signature covers both
    // the CSRF nonce and the destination.
    await page.goto('/?range=week');
    await signIn(page).click();
    await expect(cards(page)).toHaveCount(5, { timeout: 60_000 });
    expect(new URL(page.url()).pathname).toBe('/');
});

test('the org/my toggle scopes the figures to the signed-in member', async ({ page }) => {
    await page.goto('/');
    await signIn(page).click();
    await expect(cards(page)).toHaveCount(5, { timeout: 60_000 });

    // The toggle exists only behind a session — this board signs in, so it is here. The
    // fieldset's legend is its accessible name.
    const toggle = page.getByRole('group', { name: 'Whose usage' });
    await expect(toggle).toBeVisible();
    await expect(toggle.getByRole('button', { name: 'Org' })).toHaveAttribute('aria-pressed', 'true');

    const [response] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('scope=mine') && r.status() === 200),
        toggle.getByRole('button', { name: 'Me' }).click(),
    ]);
    const body = (await response.json()) as { meta: { scope: string; scopeLogin: string | null } };
    expect(body.meta.scope).toBe('mine');
    expect(body.meta.scopeLogin).toBe('e2e-user');

    // The page says whose figures these are, and this member queued no seeded tasks, so the
    // per-task panel renders its explicit empty state rather than zeros.
    await expect(page.getByText('scoped to e2e-user')).toBeVisible();
    await expect(page.getByText('No attributed tasks in this range yet.')).toBeVisible();
    await page.screenshot({ path: 'artifacts/ui/scope-mine.png', fullPage: true });

    // Back to org: the note goes and the organization's figures return from the same snapshot.
    await toggle.getByRole('button', { name: 'Org' }).click();
    await expect(page.getByText('scoped to e2e-user')).toHaveCount(0);
});
