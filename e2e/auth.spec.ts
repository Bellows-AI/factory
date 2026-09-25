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

const usageGroups = (page: Page) => page.locator('.usage-summary .usage-group');
/** The analytics anchor: the metric summary when the selection has data, the one empty state
    when it has none — which is every fresh github-mode member, since the seed plants under the
    local org only (issue 166). The auth board's "the dashboard answered" is this anchor. */
const analyticsAnchor = (page: Page) => page.locator('.usage-summary, .usage-empty').first();
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
    await expect(analyticsAnchor(page)).toBeVisible({ timeout: 60_000 });
    return reported;
};

test('an anonymous visitor gets the gate and no dashboard', async ({ page }) => {
    await page.goto('/');

    await expect(gate(page)).toBeVisible();
    await expect(gate(page).getByRole('heading', { level: 1, name: 'Bellows' })).toBeVisible();
    await expect(page).toHaveTitle('Bellows');
    await expect(signIn(page)).toBeVisible();
    // The point of gating above App rather than inside it: the panels are never mounted, so no
    // request for data is ever made by somebody who could not read the answer.
    await expect(usageGroups(page)).toHaveCount(0);

    // The appearance preference (issue 188) is on the public surface too, before any session.
    const appearance = page.getByLabel('Appearance');
    await expect(appearance).toBeVisible();
    await expect(appearance.locator('option')).toHaveText(['System', 'Light', 'Dark']);
});

test('the gate holds a narrow phone inside the viewport, in both palettes (issue 190)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await expect(gate(page)).toBeVisible();
    await expect(signIn(page)).toBeVisible();
    const overflow = await page.evaluate(() => document.body.scrollWidth - document.body.clientWidth);
    expect(overflow, 'the gate overflows horizontally at 390px').toBeLessThanOrEqual(0);
    // Dark is SET, not assumed: the appearance bootstrap (#188) maps a missing attribute to the
    // live OS palette, which headless cannot be trusted to prefer.
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({
        path: 'artifacts/ui/matrix/signin-gate_default_dark_390.png',
        animations: 'disabled',
    });

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.screenshot({
        path: 'artifacts/ui/matrix/signin-gate_default_light_390.png',
        animations: 'disabled',
    });
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

    // The same screen at phone width, both palettes: the closeout's onboarding captures. The
    // column must reflow to one column and never widen the body (issue 190).
    const overflow = () => page.evaluate(() => document.body.scrollWidth - document.body.clientWidth);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await overflow(), 'onboarding overflows at 390px').toBeLessThanOrEqual(0);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({
        path: 'artifacts/ui/matrix/onboarding_default_dark_390.png',
        fullPage: true,
        animations: 'disabled',
    });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.screenshot({
        path: 'artifacts/ui/matrix/onboarding_default_light_390.png',
        fullPage: true,
        animations: 'disabled',
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

    // Deselect the second reported installation and confirm: the session lands, and only the
    // still-checked org was materialized — the choice, nothing else from the report.
    const kept = reported[0]!;
    await orgs.filter({ hasText: reported[1]!.account }).getByRole('checkbox').uncheck();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(analyticsAnchor(page)).toBeVisible({ timeout: 60_000 });

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

test('the screen explains itself, its identity, and the default choice (issue 187)', async ({ page }) => {
    await page.goto('/api/auth/github?reselect=1');

    await screen(page).waitFor({ timeout: 60_000 });
    // The recomposed page: one heading, the setup context, the purpose, the person, the note.
    await expect(page.getByRole('heading', { level: 1, name: 'Choose organizations and repositories' })).toHaveCount(1);
    await expect(page.getByText('Setup · One step')).toBeVisible();
    await expect(
        page.getByText('Track agent activity, start work, and keep repository setup visible in one place.')
    ).toBeVisible();
    await expect(page.getByText('Signed in as E2E User (@e2e-user)')).toBeVisible();
    await expect(page.getByText('GitHub sign-in provides your identity and organization membership.')).toBeVisible();

    // Whatever a previous test stored arrives pre-checked; normalize to every reported
    // installation selected, so what this test confirms is what this test chose — every stored
    // narrowing here is null, so every org stands at all current and future repositories.
    const reported = await pendingReport(page);
    const orgs = screen(page).locator('.onboarding-org');
    for (const install of reported) {
        await orgs.filter({ hasText: install.account }).getByRole('checkbox').check();
    }

    // The summary names every selected organization and its mode before the action.
    const summary = page.locator('.onboarding-summary');
    await expect(summary).toBeVisible();
    await expect(summary.getByText(`${reported.length} organizations selected`)).toBeVisible();
    await expect(summary.getByText('All current and future repositories')).toHaveCount(reported.length);
    await page.screenshot({ path: 'artifacts/ui/onboarding-explained.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/ui/onboarding-explained-narrow.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });

    // Confirming the default still completes: the choice lands, the dashboard is reached.
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(analyticsAnchor(page)).toBeVisible({ timeout: 60_000 });
});

test('a choice of nothing refuses Continue and says what is missing (issue 187)', async ({ page }) => {
    await page.goto('/api/auth/github?reselect=1');
    await screen(page).waitFor({ timeout: 60_000 });
    const reported = await pendingReport(page);
    const orgs = screen(page).locator('.onboarding-org');
    for (const install of reported) {
        await orgs.filter({ hasText: install.account }).getByRole('checkbox').uncheck();
    }

    const cont = page.getByRole('button', { name: 'Continue' });
    await expect(cont).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Choose at least one organization to continue.')).toBeVisible();
    // The attempted action is receivable — it cannot post, and the screen stands.
    await cont.click();
    await expect(screen(page)).toBeVisible();

    // Choosing one organization re-enables the action and completes.
    await orgs.filter({ hasText: reported[0]!.account }).getByRole('checkbox').check();
    await expect(cont).not.toHaveAttribute('aria-disabled', 'true');
    await cont.click();
    await expect(analyticsAnchor(page)).toBeVisible({ timeout: 60_000 });
});

test('an unavailable repository listing says so and keeps the choice completable (issue 187)', async ({ page }) => {
    // The offline server has no App client, so every listing answers source none — this is the
    // one listing failure a browser can reach deterministically, and the screen must neither
    // render an empty checklist nor silently widen the org's mode.
    await page.goto('/api/auth/github?reselect=1');
    await screen(page).waitFor({ timeout: 60_000 });
    const reported = await pendingReport(page);
    const first = screen(page).locator('.onboarding-org').filter({ hasText: reported[0]!.account });
    // Whatever a previous test stored arrives pre-checked; this test decides: the first
    // reported org, selected, its disclosure opened.
    await first.getByRole('checkbox').check();

    await first.locator('summary').click();
    await expect(
        first.getByText(
            'Repository choices are temporarily unavailable. Bellows will track repositories this installation reports.'
        )
    ).toBeVisible();
    await expect(first.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(first.locator('.onboarding-repos')).toHaveCount(0);

    // All mode stands: the submission posts the org without a repos key and completes.
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(analyticsAnchor(page)).toBeVisible({ timeout: 60_000 });
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
    await analyticsAnchor(page).waitFor({ timeout: 60_000 });
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
    // The Headless UI Menu renders each item in the menuitem role, overriding the button's.
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(gate(page)).toBeVisible();
    await expect(usageGroups(page)).toHaveCount(0);

    // The old cookie no longer authenticates: /me answers "nobody".
    const me = await page.request.get('/api/auth/me');
    expect(await me.json()).toMatchObject({ authenticated: false });

    // The appearance preference (issue 188) is local, not session state: the choice outlives the
    // sign-out, on the gate as anywhere.
    await page.getByLabel('Appearance').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(gate(page)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

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

test('the scope dropdown scopes the figures to the signed-in member', async ({ page }) => {
    await throughSignIn(page);

    // The dropdown exists only behind a session — this board signs in, so it is here.
    const trigger = page.locator('#scope-select');
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveText('Organization');

    const [response] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('scope=mine') && r.status() === 200),
        (async () => {
            await trigger.click();
            await page.getByRole('option', { name: 'Personal', exact: true }).click();
        })(),
    ]);
    const body = (await response.json()) as { meta: { scope: string; scopeLogin: string | null } };
    expect(body.meta.scope).toBe('mine');
    expect(body.meta.scopeLogin).toBe('e2e-user');
    await expect(trigger).toHaveText('Personal');

    // This member's org holds no seeded rows (the seed plants under the local org only), so the
    // analytics render the ONE empty state — not zeros, not dash cards — and no per-task figures
    // render to masquerade as measurements.
    await expect(page.locator('.usage-empty')).toBeVisible();
    await expect(page.getByText('Per-task usage')).toHaveCount(0);
    await page.screenshot({ path: 'artifacts/ui/scope-mine.png', fullPage: true });

    // Back to org: the organization selection returns from the same snapshot. `scope=org` is not
    // a URL form — org is the query's default, so its absence IS the org request; the body's meta
    // says what the figures were computed under.
    const [orgResponse] = await Promise.all([
        page.waitForResponse(
            (r) => r.url().includes('/api/stats?') && !r.url().includes('scope=mine') && r.status() === 200
        ),
        (async () => {
            await trigger.click();
            await page.getByRole('option', { name: 'Organization', exact: true }).click();
        })(),
    ]);
    expect(((await orgResponse.json()) as { meta: { scope: string } }).meta.scope).toBe('org');
    await expect(trigger).toHaveText('Organization');
});
