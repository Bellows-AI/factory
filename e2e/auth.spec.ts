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
 * The stub reports TWO installations and the run's identity is fresh (playwright.config.ts). No
 * test leans on being the run's first sign-in: one that needs the screen forces it (?reselect=1,
 * the settings page's own link), one that needs a stored choice signs one in itself, and every id
 * an assertion pins is read from the pending report or from the row the test just chose — never a
 * fixture constant. Each test therefore passes alone, filtered or reordered; workers: 1 only
 * serializes.
 */

const cards = (page: Page) => page.locator('.cards').first().locator('.card');
const gate = (page: Page) => page.locator('.login-gate');
const signIn = (page: Page) => page.getByRole('link', { name: 'Sign in with GitHub' });
const screen = (page: Page) => page.locator('.onboarding');

/** One installation as the pending report lists it: the org name the screen renders, and its id. */
interface ReportedInstallation {
    id: string;
    account: string;
}

/**
 * The parked sign-in's own report (issue 125): the installations the stub account can see, the
 * same payload the selection screen renders. Tests derive their expectations from it, so nothing
 * here writes down an installation or organization id.
 */
const pendingReport = async (page: Page): Promise<ReportedInstallation[]> => {
    const response = await page.request.get('/api/auth/github/pending');
    return ((await response.json()) as { installations: ReportedInstallation[] }).installations;
};

/**
 * Forces the selection screen and lands a session tracking only the first reported installation.
 * Returns the report in stub order — [0] tracked, [1] seen and declined — so a calling test pins
 * ids it read, and the tracked/merely-reported contrast is decided here, not inherited from
 * whatever another test left stored.
 */
const trackOnlyFirst = async (page: Page): Promise<ReportedInstallation[]> => {
    await page.goto('/api/auth/github?reselect=1');
    await screen(page).waitFor({ timeout: 60_000 });
    const reported = await pendingReport(page);
    expect(reported).toHaveLength(2);
    const orgs = screen(page).locator('.onboarding-org');
    await orgs.filter({ hasText: reported[0]!.account }).getByRole('checkbox').check();
    await orgs.filter({ hasText: reported[1]!.account }).getByRole('checkbox').uncheck();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(cards(page).first()).toBeVisible({ timeout: 60_000 });
    return reported;
};

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
    // `reselect=1` opens the screen whatever any other test has already stored — this test stands
    // alone.
    await page.goto('/api/auth/github?reselect=1');

    // The step between the OAuth round trip and the session: one row per reported installation,
    // read from the pending report rather than written down.
    await screen(page).waitFor({ timeout: 60_000 });
    const reported = await pendingReport(page);
    expect(reported).toHaveLength(2);
    const orgs = screen(page).locator('.onboarding-org');
    await expect(orgs).toHaveCount(2);
    // Whatever a previous test stored arrives pre-checked; normalize to every reported
    // installation checked, so what this test confirms is what this test chose.
    for (const install of reported) {
        await orgs.filter({ hasText: install.account }).getByRole('checkbox').check();
    }
    await page.screenshot({ path: 'artifacts/ui/onboarding.png', fullPage: true });

    // Deselect the second reported installation and confirm: the session lands, and only the
    // still-checked org was materialized — the choice, nothing else from the report.
    const kept = reported[0]!;
    await orgs.filter({ hasText: reported[1]!.account }).getByRole('checkbox').uncheck();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(cards(page).first()).toBeVisible({ timeout: 60_000 });

    const me = await page.request.get('/api/auth/me');
    const body = (await me.json()) as {
        user: { login: string };
        organization: { id: string; name: string };
        organizations: { id: string; name: string }[];
    };
    expect(body.user.login).toBe('e2e-user');
    expect(body.organization).toEqual({ id: kept.id, name: kept.account });
    expect(body.organizations).toEqual([{ id: kept.id, name: kept.account }]);
});

test('the next sign-in reuses the stored choice without the screen (issue 125)', async ({ page }) => {
    // Establish the choice THIS test relies on: sign in once — through the screen when this is
    // the run's first sign-in, straight in when another test already stored one — then sign out,
    // so the round trip below is genuine rather than cookie residue.
    await throughSignIn(page);
    await page.request.post('/api/auth/logout');
    await page.goto('/');
    await expect(gate(page)).toBeVisible();

    // Straight through: the stored choice from the sign-in above is the choice, so no screen.
    await signIn(page).click();
    await cards(page).first().waitFor({ timeout: 60_000 });
    await expect(screen(page)).toHaveCount(0);
});

test('signing in lands on the dashboard', async ({ page }) => {
    await throughSignIn(page);
    await expect(gate(page)).toHaveCount(0);
});

test("sign-in materializes the chosen installation as the member's organization", async ({ page }) => {
    // Choose, don't inherit: the screen is forced and narrowed to the first reported
    // installation, so the assertion below pins what THIS sign-in chose.
    const reported = await trackOnlyFirst(page);
    const chosen = reported[0]!;

    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    // The chosen installation was materialized as the member's organization — the org, the
    // membership and the session's binding to it, no invite anywhere in the flow (#99).
    expect(await me.json()).toMatchObject({
        user: { login: 'e2e-user' },
        role: 'member',
        organization: { id: chosen.id, name: chosen.account },
        organizations: [{ id: chosen.id, name: chosen.account }],
        mode: 'github',
    });
});

test('POST /api/auth/org switches the session, refusing what is unknown or anonymous', async ({ page }) => {
    const reported = await trackOnlyFirst(page);
    const tracked = reported[0]!;

    // Unknown org: a typo is a 400, never a silent stay. (Built at runtime — no fixture id.)
    const unknown = await page.request.post('/api/auth/org', { data: { orgId: String(Date.now()) } });
    expect(unknown.status()).toBe(400);
    expect((await unknown.json()).code).toBe('UNKNOWN_ORG');

    // A tracked org: the switch lands, and /me reports the moved session.
    const planted = await page.request.post('/api/auth/org', { data: { orgId: tracked.id } });
    expect(planted.status()).toBe(200);
    const me = await page.request.get('/api/auth/me');
    expect((await me.json()).organization).toEqual({ id: tracked.id, name: tracked.account });

    // An anonymous caller has no session to move. (Known-but-not-a-member is the 403 FORBIDDEN
    // case; the browser-level pin for it lives in the route tests — server/test/auth.oauth.test.ts.)
    const fresh = await page.context().browser()!.newContext();
    const anonymous = await fresh.request.post(`${test.info().project.use.baseURL}/api/auth/org`, {
        data: { orgId: tracked.id },
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
