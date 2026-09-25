import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { CLAUDE_CODE, OPENCODE } from '@factory-ai/core';
import { throughSignIn } from './signin.js';
// The copy under assertion, imported from the module the app renders it from — see the note on
// EXECUTOR_GUIDANCE in web/src/workspace/executors.ts for why these live in a React-free module.
import { EXECUTOR_GUIDANCE, EXECUTOR_TYPE_META, TYPE_CONFIG_NOTE } from '../web/src/workspace/executors.js';

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
 * the server here is the offline entry, with no GitHub App credential; the stored fallback reports
 * the seed's one repository (SEED_REPO, scoped to the caller's org) but nothing is selected, so
 * the repositories page pins its offered-but-disabled nothing-enabled state and the workspace
 * page its empty-checkout sentence. Cloning, checkout statuses and the dirty-detail switch
 * dialog need a credential or a second seeded repository, and stay with a credentialed run.
 */

const SHOTS = 'artifacts/ui';

async function signedIn(page: Page) {
    // The shared helper: through the selection screen on the run's first sign-in, straight in
    // after it (the stored choice is the choice).
    await throughSignIn(page);
}

test('the left nav is there and moves between sections', async ({ page }) => {
    await signedIn(page);

    const nav = page.locator('.sidenav');
    await expect(nav).toBeVisible();

    // The Settings item opens the tree at the configuration overview, the area's index (#180);
    // the workspace section is one click below it, with the four section links under the item
    // (#150).
    await nav.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: 'Configuration overview' })).toBeVisible();
    await nav.getByRole('link', { name: 'Workspace' }).click();
    await expect(page).toHaveURL(/\/settings\/workspace$/);
    await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Repositories' })).toBeVisible();

    await nav.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/$/);
    // The analytics anchor, not a group count: this member's org holds no seeded rows, so the
    // dashboard truthfully answers with the one empty state rather than four figures.
    await expect(page.locator('.usage-summary, .usage-empty').first()).toBeVisible();
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
    // workspace section and not the catch-all. exact: the section's own h2 ("My workspace")
    // would otherwise match alongside the page h1 (issue 190).
    await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
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

test('the repositories page carries the selection surface, and its draft meets the guard', async ({ page }) => {
    await signedIn(page);
    await page.goto('/settings/repos');

    /*
     * The seed plants one stored repository for this org (the offline entry's stored fallback)
     * and the workspace poll answers with no checkouts: one row, offered, nothing enabled — and
     * only once both answered does the enabled count state its zero.
     */
    await expect(page.getByRole('heading', { name: 'Repository list' })).toBeVisible({ timeout: 60_000 });
    const checkbox = page.getByRole('checkbox', { name: 'Enable Bellows-AI/bellows.ai in my workspace' });
    await expect(checkbox).toBeVisible();
    await expect(page.getByText('0 of 1 repositories enabled')).toBeVisible();
    await expect(page.getByLabel('Search repositories')).toBeVisible();
    await expect(page.getByText('Selections are limited to 20 repositories.')).toBeVisible();

    // A toggle makes the whole-selection draft dirty, and leaving meets the area's ONE discard
    // confirmation (issue 182) — the selection is guarded like every other settings draft.
    await checkbox.click();
    await expect(page.getByText('Selection changed — save to update your workspace')).toBeVisible();
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
    await expect(page.getByText('Your changes to the repository selection have not been saved.')).toBeVisible();

    // The safe answer unblocks nothing: we are still here, and the draft survived.
    await page.getByRole('button', { name: 'Continue editing' }).click();
    await expect(page).toHaveURL(/\/settings\/repos$/);
    await expect(checkbox).toBeChecked();

    // Discard reverts the draft to the server's answer and resumes the navigation.
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.goto('/settings/repos');
    await expect(
        page.getByRole('checkbox', { name: 'Enable Bellows-AI/bellows.ai in my workspace' })
    ).not.toBeChecked();

    // Configuration is independent of personal checkout enablement: the editor mounts behind
    // Configure with the checkbox still off, and a clean area raises no dialog.
    await page.getByRole('button', { name: 'Configure' }).click();
    await expect(page.getByRole('heading', { name: 'Environment for Bellows-AI/bellows.ai' })).toBeVisible();
    await expect(page.getByText('Repository · Bellows-AI/bellows.ai')).toBeVisible();
    await expect(page.getByText('Discard unsaved changes?')).toHaveCount(0);

    await page.screenshot({ path: `${SHOTS}/settings-repos.png`, fullPage: true });
});

test('an executor is added through the dialog, with bad JSON refused in place', async ({ page }) => {
    await signedIn(page);
    await page.goto('/settings/executors');

    // The panel is scoped by its scope heading now — "My workspace" — with the guidance sentence
    // that says what an executor decides for a task (#183). Asserted against the constant the
    // panel renders, not a copy of it: this assertion held a sentence the product had stopped
    // saying, and nothing noticed, because verify:ui needs Playwright and two databases to run.
    const panel = page.locator('section.panel', { has: page.getByRole('heading', { name: 'My workspace' }) });
    await expect(panel).toContainText(EXECUTOR_GUIDANCE);

    await page.getByRole('button', { name: 'Add executor' }).click();
    // Named by its title through aria-labelledby, not by a literal id: the dialog mints its ids
    // with useId so two open dialogs cannot collide, which means no id here is stable across a
    // render. The accessible name and the describedby links are the contract worth selecting on —
    // they are what a screen reader follows.
    // Either title: the same dialog is "Add executor" opened from the panel and "Edit executor"
    // opened from a row, and this spec drives both. The id-based selector this replaced matched
    // them without saying so, which is how naming only the Add case slipped through.
    const dialog = page.getByRole('dialog', { name: /^(Add|Edit) executor$/ });
    const dialogPanel = dialog.locator('.picker');
    await expect(dialogPanel).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    /**
     * The help a field points at with aria-describedby — resolved live, since the id is minted.
     * The config textarea names two targets once its JSON fails to parse (help, then error), and
     * the help is always first, so `.first()` is the help in both states.
     */
    const describedBy = async (field: Locator) => {
        const ids = (await field.getAttribute('aria-describedby'))?.split(/\s+/).filter(Boolean) ?? [];
        expect(ids.length, 'the field names no describedby target').toBeGreaterThan(0);
        return dialog.locator(ids.map((id) => `[id="${id}"]`).join(', ')).first();
    };

    const typeField = dialog.getByRole('combobox');
    const configField = dialog.getByRole('textbox', { name: /config/i });

    // Each field's help is the constant the dialog renders. What is under test here is the WIRING
    // — that aria-describedby reaches the right paragraph, and that switching type swaps the
    // config help — not the wording, which belongs to whoever edits the constant.
    await expect(await describedBy(typeField)).toContainText(TYPE_CONFIG_NOTE);
    await expect(await describedBy(configField)).toContainText(EXECUTOR_TYPE_META[CLAUDE_CODE].configHelp);
    await page.screenshot({ path: `${SHOTS}/settings-executor-help.png` });

    // Switching type swaps the help for the OpenCode one — the swap is the behavior under test,
    // so the two helps must also differ, or this would still pass if the select stopped driving it.
    await typeField.selectOption({ label: 'OpenCode' });
    await expect(await describedBy(configField)).toContainText(EXECUTOR_TYPE_META[OPENCODE].configHelp);
    expect(EXECUTOR_TYPE_META[OPENCODE].configHelp).not.toBe(EXECUTOR_TYPE_META[CLAUDE_CODE].configHelp);
    await typeField.selectOption({ label: 'Claude Code' });

    // Not valid JSON: the message appears under the field, Save stays disabled, and what was
    // typed is still there — an error never costs the member their paste.
    await dialog.getByPlaceholder('main').fill('main');
    await dialog.locator('textarea').fill('{ model: }');
    await expect(dialog.getByRole('button', { name: 'Add executor' })).toBeDisabled();
    await expect(dialog.locator('textarea')).toHaveValue('{ model: }');
    await expect(dialog.locator('textarea')).toHaveAttribute('aria-invalid', 'true');

    // A name problem is not a config problem: with parseable JSON but no name, Save stays
    // disabled and the textarea announces nothing — the error belongs to the name field.
    await dialog.getByPlaceholder('main').fill('');
    await dialog.locator('textarea').fill('{}');
    await expect(dialog.getByRole('button', { name: 'Add executor' })).toBeDisabled();
    await expect(dialog.locator('textarea')).not.toHaveAttribute('aria-invalid');

    await dialog.getByPlaceholder('main').fill('main');
    await dialog.getByRole('button', { name: 'Add executor' }).click();
    await expect(dialog).toHaveCount(0);

    // Focus went back to the trigger the dialog opened from — the Dialog restores it on close,
    // and the next keystroke must land where the member left it.
    await expect(page.getByRole('button', { name: 'Add executor' })).toBeFocused();

    // The row comes back through the poll, under its human label — and the first row is marked
    // as the one the composer picks first: a fact about the draft, not a stored default.
    await expect(panel.getByText('main')).toBeVisible();
    await expect(panel.locator('.pill')).toHaveText('Claude Code');
    await expect(panel).not.toContainText('No personal executors configured');
    await expect(panel.getByText('Selected first on new tasks')).toHaveCount(1);

    // Editing is its own round trip: the save action reads "Save executor", and focus lands back
    // on the row's Edit button, not wherever the DOM happens to leave it.
    await panel.getByRole('button', { name: 'Edit' }).click();
    await expect(dialogPanel).toBeVisible();
    await dialog.locator('textarea').fill('{ "model": "opus" }');
    await dialog.getByRole('button', { name: 'Save executor' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Edit' })).toBeFocused();

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
    await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();

    const text = (await page.locator('main').innerText()) || '';
    for (const token of ['NaN', 'undefined', 'Infinity', '[object Object]']) {
        expect(text, token).not.toContain(token);
    }
    expect(errors).toEqual([]);

    await page.screenshot({ path: `${SHOTS}/settings-workspace-env.png`, fullPage: true });
});
