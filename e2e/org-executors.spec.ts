import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import postgres from 'postgres';
import { ADMIN_ROLE } from '@factory-ai/core';
import { AUTH_DATABASE_URL, E2E_LOGIN } from '../playwright.config.js';
import { throughSignIn } from './signin.js';
import { ADD_LABEL } from '../web/src/workspace/executors.js';
import { DEMOTE_LABEL } from '../web/src/panels/OrgExecutorsPanel.js';
import {
    ALL_SUSPENDED_NOTE,
    MAKE_DEFAULT_LABEL,
    REMOVE_LABEL,
    RESUME_LABEL,
    SUSPEND_LABEL,
    SUSPENDED_LABEL,
} from '../web/src/panels/WorkspaceExecutorsPanel.js';
import { confirmLabel, confirmTitle } from '../web/src/panels/org-executor-confirm.js';

/**
 * The organization executor row's actions (issue 411): the overflow menu, and the confirmation that
 * now stands between a click and an org-wide, irreversible write.
 *
 * On the `auth` project, and it is the only board that can show this surface at all: the open board
 * deliberately has no ORG_WORKSPACE_ROOT, and `/api/workspace` answers a rootless deployment with
 * `orgExecutors: []`, so organization rows are invisible there however they got into the database.
 * The auth board has a real root — and its signed-in member is an admin, because the stub account
 * is the installation's FIRST member and the bootstrap rule lands admin (#410). The setRole below
 * is still test infrastructure — belt and braces over what sign-in now does, and the same
 * direct-SQL idiom as e2e/reset-db.mjs; the role is read per request through the session join, so
 * a reload is all it takes to see.
 *
 * Every profile this spec creates it also deletes, through the gate itself.
 */

const SHOTS = 'artifacts/ui';
const PROFILES = ['Main ORG', 'Reviewer'];
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** The org profile's delete route — the one request the gate must not let through unconfirmed. */
const deleteRequests = (page: Page): string[] => {
    const seen: string[] = [];
    page.on('request', (request) => {
        if (request.method() === 'DELETE' && /\/api\/org\/executors\//.test(request.url())) seen.push(request.url());
    });
    return seen;
};

const orgTable = (page: Page) => page.getByRole('region', { name: 'Organization executors' });
/** By row, not by an exact cell name: the resolved default's row carries its caption in that name. */
const row = (page: Page, name: string) => orgTable(page).getByRole('row').filter({ hasText: name });
const trigger = (page: Page, name: string) => page.getByRole('button', { name: `Actions for ${name}` });

/** Admin, so the management actions exist to collapse. Test infrastructure — see the header. */
async function setRole(role: string) {
    const sql = postgres(AUTH_DATABASE_URL, { max: 1 });
    try {
        // Only the stub member's own memberships: the local organization's seeded admin
        // (db/migrate.ts) is not this spec's to rewrite.
        await sql`update org_membership set role = ${role} where github_login = ${E2E_LOGIN}`;
    } finally {
        await sql.end();
    }
}

async function asAdmin(page: Page) {
    await throughSignIn(page);
    await setRole(ADMIN_ROLE);
    await page.goto('/settings/executors');
    await expect(page.getByRole('button', { name: 'Add organization executor' })).toBeVisible();
}

async function addProfile(page: Page, name: string) {
    await page.getByRole('button', { name: 'Add organization executor' }).click();
    const dialog = page.getByRole('dialog', { name: ADD_LABEL });
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: ADD_LABEL }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row(page, name)).toBeVisible();
}

/** Removes the row through the confirmation, which is also the cleanest assertion that it works. */
async function deleteProfile(page: Page, name: string) {
    await trigger(page, name).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: confirmLabel({ action: 'delete', name }) }).click();
    // The dialog first: an open Headless UI dialog marks the rest of the page inert, and a role
    // query outside it answers zero whatever the table still holds.
    await expect(dialog).toHaveCount(0);
    await expect(row(page, name)).toHaveCount(0);
}

test('the row actions collapse into one overflow menu named for the row, at both widths', async ({ page }) => {
    await asAdmin(page);
    for (const name of PROFILES) await addProfile(page, name);

    // One visible action per row; the rest are a trigger away, and the trigger carries the row —
    // a table of them is otherwise N identical "Actions" buttons to a screen reader.
    const first = row(page, PROFILES[0]!);
    await expect(first.getByRole('button', { name: 'Edit' })).toBeVisible();
    await expect(first.getByRole('button', { name: DEMOTE_LABEL })).toHaveCount(0);
    await expect(first.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    for (const name of PROFILES) await expect(trigger(page, name)).toBeVisible();

    // Scrolled to the end first: the row is in view at the fold, but the panel it opens is not, and
    // the screenshot would show a table with nothing happening in it.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await trigger(page, PROFILES[0]!).click();
    const menu = page.getByRole('menu');
    // Delete last, and `danger` — the destructive verb is fenced off behind the separator rather
    // than sitting among the routine ones. Asserted by position and not as a whole list: whether
    // the row also offers Make default depends on which profile the member's default resolves to,
    // which is not this spec's subject.
    const items = menu.getByRole('menuitem');
    await expect(items.last()).toHaveText('Delete');
    await expect(items.last()).toHaveClass(/\bdanger\b/);
    await expect(items.filter({ hasText: DEMOTE_LABEL })).toHaveCount(1);
    // The inline action never also appears in the overflow.
    await expect(items.filter({ hasText: 'Edit' })).toHaveCount(0);
    await expect(menu.locator('.popover-separator')).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/settings-executors-row-actions.png` });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // The cell at both widths. A passing assertion says the DOM was right; only the image says the
    // layout was — and the scroll check says the cell did not push the page off a phone.
    for (const [label, viewport] of [
        ['1440', DESKTOP],
        ['390', PHONE],
    ] as const) {
        await page.setViewportSize(viewport);
        await expect(trigger(page, PROFILES[0]!)).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/settings-executors-row-actions_${label}.png`, fullPage: true });
        const overflowing = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth
        );
        expect(overflowing, `settings-executors at ${label}: horizontal scroll`).toBe(false);
    }
    // Still a finger target in the compact shell (#189) — the cell's controls are new, and a 36px
    // icon button is exactly the kind that slips past the shared floor.
    for (const control of [first.getByRole('button', { name: 'Edit' }), trigger(page, PROFILES[0]!)]) {
        const box = (await control.boundingBox())!;
        expect(Math.min(box.width, box.height), 'row action under 44px at 390').toBeGreaterThanOrEqual(44);
    }
    await page.setViewportSize(DESKTOP);

    for (const name of PROFILES) await deleteProfile(page, name);
});

test('Delete asks first, and cancelling leaves the row untouched', async ({ page }) => {
    const deletes = deleteRequests(page);
    await asAdmin(page);
    const name = PROFILES[0]!;
    await addProfile(page, name);

    await trigger(page, name).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Delete' }).click();

    // The confirmation names the row, so a mis-aimed click is visible before it lands, and Cancel
    // is what a keypress reaches first.
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByRole('heading', { name: confirmTitle({ action: 'delete', name }) })).toBeVisible();
    await expect(confirm.getByText(/cannot be undone/)).toBeVisible();
    const cancel = confirm.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeFocused();
    await page.screenshot({ path: `${SHOTS}/settings-executors-delete-confirm.png` });

    await cancel.click();
    await expect(confirm).toHaveCount(0);
    await expect(row(page, name)).toBeVisible();
    expect(deletes).toEqual([]);

    // Confirmed, it goes — and exactly one request carries it.
    await trigger(page, name).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Delete' }).click();
    await confirm.getByRole('button', { name: confirmLabel({ action: 'delete', name }) }).click();
    await expect(confirm).toHaveCount(0);
    await expect.poll(() => deletes.length).toBe(1);
    await expect(row(page, name)).toHaveCount(0);
});

test('Make personal asks first, naming the profile and what every other member loses', async ({ page }) => {
    await asAdmin(page);
    const name = PROFILES[1]!;
    await addProfile(page, name);

    await trigger(page, name).click();
    await page.getByRole('menu').getByRole('menuitem', { name: DEMOTE_LABEL }).click();

    const confirm = page.getByRole('dialog');
    await expect(confirm.getByRole('heading', { name: confirmTitle({ action: 'demote', name }) })).toBeVisible();
    await expect(confirm.getByText(/stops being available/)).toBeVisible();
    await expect(confirm.getByRole('button', { name: confirmLabel({ action: 'demote', name }) })).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(row(page, name)).toBeVisible();

    // Confirming the demote is not driven here: `confirmedWrite`'s own suite pins which route each
    // answer calls; what only a browser can show is that the gate stands between the click and the
    // write.
    await deleteProfile(page, name);
});

/** The member's own list (issue 440): the table is named "Executors", the org's "Organization executors". */
const personalTable = (page: Page) => page.getByRole('region', { name: 'Executors', exact: true });
const personalRow = (page: Page, name: string) => personalTable(page).getByRole('row').filter({ hasText: name });

async function addPersonal(page: Page, name: string) {
    await page.getByRole('button', { name: ADD_LABEL }).click();
    const dialog = page.getByRole('dialog', { name: ADD_LABEL });
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: ADD_LABEL }).click();
    await expect(dialog).toHaveCount(0);
    await expect(personalRow(page, name)).toBeVisible();
}

async function removePersonal(page: Page, name: string) {
    await personalRow(page, name).getByRole('button', { name: REMOVE_LABEL }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: confirmLabel({ action: 'remove', name }) }).click();
    await expect(dialog).toHaveCount(0);
    await expect(personalRow(page, name)).toHaveCount(0);
}

test('Remove on a personal profile names it, asks first, and removes only that row', async ({ page }) => {
    const removals: string[] = [];
    page.on('request', (request) => {
        if (request.method() === 'DELETE' && /\/api\/workspace\/executors\//.test(request.url())) {
            removals.push(request.url());
        }
    });
    await asAdmin(page);
    for (const name of ['Scratch', 'Keeper']) await addPersonal(page, name);

    await personalRow(page, 'Scratch').getByRole('button', { name: REMOVE_LABEL }).click();
    const confirm = page.getByRole('dialog');
    await expect(
        confirm.getByRole('heading', { name: confirmTitle({ action: 'remove', name: 'Scratch' }) })
    ).toBeVisible();
    await expect(confirm.getByText(/personal executor/)).toBeVisible();
    await expect(confirm.getByText(/permanently deleted/)).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();

    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(personalRow(page, 'Scratch')).toBeVisible();
    expect(removals).toEqual([]);

    await removePersonal(page, 'Scratch');
    expect(removals).toHaveLength(1);
    await expect(personalRow(page, 'Keeper')).toBeVisible();
    await page.reload();
    await expect(personalRow(page, 'Scratch')).toHaveCount(0);
    await expect(personalRow(page, 'Keeper')).toBeVisible();

    await removePersonal(page, 'Keeper');
});

test('Suspend keeps a personal profile but withholds Make default and the composer, and Resume restores it', async ({
    page,
}) => {
    await asAdmin(page);
    for (const name of ['Alpha', 'Beta']) await addPersonal(page, name);
    await expect(personalRow(page, 'Alpha').getByText(/Default/)).toBeVisible();

    await personalRow(page, 'Alpha').getByRole('button', { name: SUSPEND_LABEL }).click();
    await expect(personalRow(page, 'Alpha').getByText(SUSPENDED_LABEL)).toBeVisible();
    await expect(personalRow(page, 'Alpha').getByRole('button', { name: MAKE_DEFAULT_LABEL })).toHaveCount(0);
    // The default falls to the first ACTIVE profile; the composer selects it and never offers Alpha.
    await expect(personalRow(page, 'Beta').getByText(/Default/)).toBeVisible();
    await page.goto('/tasks/new');
    await expect(page.getByLabel('Executor')).toHaveText('Beta');

    // Persists across a reload, configuration and row intact.
    await page.goto('/settings/executors');
    await expect(personalRow(page, 'Alpha').getByText(SUSPENDED_LABEL)).toBeVisible();
    await expect(personalRow(page, 'Alpha').getByRole('button', { name: 'Edit' })).toBeVisible();

    // Resumed, the stored preference (Alpha, by position) is restored.
    await personalRow(page, 'Alpha').getByRole('button', { name: RESUME_LABEL }).click();
    await expect(personalRow(page, 'Alpha').getByText(SUSPENDED_LABEL)).toHaveCount(0);
    await expect(personalRow(page, 'Alpha').getByText(/Default/)).toBeVisible();

    for (const name of ['Alpha', 'Beta']) await removePersonal(page, name);
});

test('suspending the last active personal profile says so, and an org profile can be suspended for everyone', async ({
    page,
}) => {
    await asAdmin(page);
    await addPersonal(page, 'Solo');
    await personalRow(page, 'Solo').getByRole('button', { name: SUSPEND_LABEL }).click();
    await expect(page.getByText(ALL_SUSPENDED_NOTE)).toBeVisible();
    await personalRow(page, 'Solo').getByRole('button', { name: RESUME_LABEL }).click();
    await expect(page.getByText(ALL_SUSPENDED_NOTE)).toHaveCount(0);
    await removePersonal(page, 'Solo');

    const name = PROFILES[0]!;
    await addProfile(page, name);
    await trigger(page, name).click();
    await page.getByRole('menu').getByRole('menuitem', { name: SUSPEND_LABEL }).click();
    await expect(row(page, name).getByText(SUSPENDED_LABEL)).toBeVisible();
    await page.reload();
    await expect(row(page, name).getByText(SUSPENDED_LABEL)).toBeVisible();
    await trigger(page, name).click();
    await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Make default' })).toHaveCount(0);
    await page.getByRole('menu').getByRole('menuitem', { name: RESUME_LABEL }).click();
    await expect(row(page, name).getByText(SUSPENDED_LABEL)).toHaveCount(0);

    await deleteProfile(page, name);
});
