import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import postgres from 'postgres';
import { ADMIN_ROLE, MEMBER_ROLE } from '@factory-ai/core';
import { AUTH_DATABASE_URL, E2E_LOGIN } from '../playwright.config.js';
import { throughSignIn } from './signin.js';
import { ORG_CONNECTION_SCOPE } from '../web/src/api/connections.js';
import {
    ADD_CONNECTION_LABEL,
    DEFAULT_CONNECTION_CAPTION,
    SCOPED_TOKEN_HINT,
} from '../web/src/panels/JiraConnectionsPanel.js';

/**
 * The Jira connection panels on the Organization and Workspace settings pages (#567).
 *
 * On the `auth` project: the connection routes need a signed-in caller whose role is real. The
 * offline board cannot reach Atlassian, so a connection is seeded straight into the table (the
 * `setRole` idiom of org-executors.spec.ts) and the add path is exercised to the refusal the board
 * gives when the site's cloud id cannot be resolved — surfaced as sent. The token is never read
 * back anywhere, and the page must not carry the seeded one.
 */

const SHOTS = 'artifacts/ui';
const SITE = 'e2e-seeded-site.atlassian.net';
const SECRET = 'e2e-secret-token-must-never-render';
const UNRESOLVABLE_SITE = 'e2e-no-such-site-567.atlassian.net';

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const sql = postgres(AUTH_DATABASE_URL, { max: 1 });
    try {
        return await run(sql);
    } finally {
        await sql.end();
    }
}

const setRole = (role: string) =>
    withSql((sql) => sql`update org_membership set role = ${role} where github_login = ${E2E_LOGIN}`);

/** One org-wide connection in the signed-in member's organization. */
const seedOrgConnection = () =>
    withSql(
        (sql) => sql`
            insert into connector_connection (org_id, owner_user_id, kind, site, cloud_id, email, api_token, access)
            select org_id, null, 'jira', ${SITE}, 'cloud-e2e', 'bot@example.com', ${SECRET}, 'read'
            from org_membership where github_login = ${E2E_LOGIN} limit 1
        `
    );

const clearConnections = () => withSql((sql) => sql`delete from connector_connection where site = ${SITE}`);

const panel = (page: Page) => page.getByRole('region', { name: 'Organization Jira connections' });

test.afterEach(async () => {
    await clearConnections();
    await setRole(ADMIN_ROLE);
});

test('an admin sees the default marker and the scoped-token hint, meets the route refusal, and deletes', async ({
    page,
}) => {
    await seedOrgConnection();
    await throughSignIn(page);
    await setRole(ADMIN_ROLE);
    await page.goto('/settings/organization');

    const row = panel(page).getByRole('row').filter({ hasText: SITE });
    await expect(row).toContainText(DEFAULT_CONNECTION_CAPTION);
    await expect(row).toContainText('bot@example.com');
    await expect(panel(page)).toContainText(SCOPED_TOKEN_HINT);
    await expect(page.locator('body')).not.toContainText(SECRET);

    // The offline board cannot resolve a cloud id: the 502 message lands as the route sent it.
    await panel(page).getByLabel('Jira site').fill(UNRESOLVABLE_SITE);
    await panel(page).getByLabel('Jira email').fill('bot@example.com');
    await panel(page).getByLabel('Jira API token').fill('typed-token-never-echoed');
    await panel(page).getByRole('button', { name: ADD_CONNECTION_LABEL }).click();
    await expect(page.locator('.status')).toContainText(`Could not resolve the Jira cloud id of ${UNRESOLVABLE_SITE}`);
    await page.screenshot({ path: `${SHOTS}/settings-jira-connections-admin.png`, fullPage: true });

    await row.getByRole('button', { name: /^Delete/ }).click();
    await expect(row).toHaveCount(0);
});

test('a member reads the list with no controls, and a forced org create is a 403', async ({ page }) => {
    await seedOrgConnection();
    await throughSignIn(page);
    await setRole(MEMBER_ROLE);
    await page.goto('/settings/organization');

    await expect(panel(page).getByRole('row').filter({ hasText: SITE })).toBeVisible();
    await expect(panel(page).getByRole('button')).toHaveCount(0);
    await expect(panel(page).getByRole('textbox')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/settings-jira-connections-member.png`, fullPage: true });

    const forced = await page.request.post('/api/connections', {
        data: { scope: ORG_CONNECTION_SCOPE, site: SITE, email: 'x@example.com', apiToken: 'x' },
    });
    expect(forced.status()).toBe(403);
});

test('the workspace page carries the personal panel and its override note', async ({ page }) => {
    await throughSignIn(page);
    await page.goto('/settings/workspace');
    const personal = page.getByRole('region', { name: 'Personal Jira connections' });
    await expect(personal).toContainText('overrides the organization');
    await expect(personal.getByRole('button', { name: ADD_CONNECTION_LABEL })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/settings-jira-connections-personal.png`, fullPage: true });
});
