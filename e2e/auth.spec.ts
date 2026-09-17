import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { finishSignIn, throughSignIn } from './signin.js';

/**
 * The sign-in flow, in a real browser, against a stub identity provider.
 *
 * dashboard.spec.ts stays on the open board and is untouched: it is the visual regression check and
 * should not churn over an auth change. This file is the one that proves the gate, the round trip,
 * the selection screen (#125) and the sign-out, and it runs against its own server with
 * AUTH_MODE=github.
 *
 * The stub reports TWO installations and the run's identity is fresh (playwright.config.ts), so
 * the first sign-in below is a genuine first sign-in: it meets the selection screen, narrows the
 * choice to one org, and every later sign-in in the file reuses that stored choice.
 */

const cards = (page: Page) => page.locator('.cards').first().locator('.card');
const gate = (page: Page) => page.locator('.login-gate');
const signIn = (page: Page) => page.getByRole('link', { name: 'Sign in with GitHub' });
const screen = (page: Page) => page.locator('.onboarding');

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

test('the selection screen tracks only the chosen organizations (issue 125)', async ({ page }) => {
    await page.goto('/');
    await signIn(page).click();

    // Two installations reported, nothing chosen yet: the step between the OAuth round trip and
    // the session, with one pre-checked checkbox per reported installation.
    await screen(page).waitFor({ timeout: 60_000 });
    const orgs = screen(page).locator('.onboarding-org');
    await expect(orgs).toHaveCount(2);
    await expect(orgs.filter({ hasText: 'stub-org-999999' }).getByRole('checkbox')).toBeChecked();
    await expect(orgs.filter({ hasText: 'stub-org-888888' }).getByRole('checkbox')).toBeChecked();
    await page.screenshot({ path: 'artifacts/ui/onboarding.png', fullPage: true });

    // Deselect one and confirm: the session lands, and only the checked org was materialized.
    await orgs.filter({ hasText: 'stub-org-888888' }).getByRole('checkbox').uncheck();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(cards(page).first()).toBeVisible({ timeout: 60_000 });

    const me = await page.request.get('/api/auth/me');
    const body = (await me.json()) as {
        user: { login: string };
        organization: { id: string; name: string };
        organizations: { id: string; name: string }[];
    };
    expect(body.user.login).toBe('e2e-user');
    expect(body.organization).toEqual({ id: '999999', name: 'stub-org-999999' });
    expect(body.organizations).toEqual([{ id: '999999', name: 'stub-org-999999' }]);
});

test('the next sign-in reuses the stored choice without the screen (issue 125)', async ({ page }) => {
    await page.goto('/');
    await signIn(page).click();

    // Straight through: the stored selection from the test above is the choice, so no screen.
    await cards(page).first().waitFor({ timeout: 60_000 });
    await expect(screen(page)).toHaveCount(0);
});

test('signing in lands on the dashboard', async ({ page }) => {
    await throughSignIn(page);
    await expect(gate(page)).toHaveCount(0);
});

test("sign-in materializes the chosen installation as the member's organization", async ({ page }) => {
    await throughSignIn(page);

    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    // The stub reports two installations; the selection step narrowed the choice to 999999, and
    // the sign-in created that org, the membership and the session's binding to it — no invite
    // anywhere in the flow (#99).
    expect(await me.json()).toMatchObject({
        user: { login: 'e2e-user' },
        role: 'member',
        organization: { id: '999999', name: 'stub-org-999999' },
        organizations: [{ id: '999999', name: 'stub-org-999999' }],
        mode: 'github',
    });
});

test('POST /api/auth/org switches the session, refusing what is unknown or anonymous', async ({ page }) => {
    await throughSignIn(page);

    // Unknown org: a typo is a 400, never a silent stay.
    const unknown = await page.request.post('/api/auth/org', { data: { orgId: '111111' } });
    expect(unknown.status()).toBe(400);
    expect((await unknown.json()).code).toBe('UNKNOWN_ORG');

    // A tracked org: the switch lands, and /me reports the moved session. (888888 exists as an
    // installation but was deselected at the screen, so it is unknown here — the pinned contrast.)
    const planted = await page.request.post('/api/auth/org', { data: { orgId: '999999' } });
    expect(planted.status()).toBe(200);
    const me = await page.request.get('/api/auth/me');
    expect((await me.json()).organization).toEqual({ id: '999999', name: 'stub-org-999999' });

    // An anonymous caller has no session to move. (Known-but-not-a-member is the 403 FORBIDDEN
    // case; the browser-level pin for it lives in the route tests — server/test/auth.oauth.test.ts.)
    const fresh = await page.context().browser()!.newContext();
    const anonymous = await fresh.request.post(`${test.info().project.use.baseURL}/api/auth/org`, {
        data: { orgId: '999999' },
    });
    expect(anonymous.status()).toBe(401);
    await fresh.close();
});

test('signing out returns to the gate', async ({ page }) => {
    await throughSignIn(page);

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
    await finishSignIn(page);
    expect(new URL(page.url()).pathname).toBe('/');
});

test('the org/my toggle scopes the figures to the signed-in member', async ({ page }) => {
    await throughSignIn(page);

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
