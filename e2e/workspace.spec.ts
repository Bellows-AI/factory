import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { CLAUDE_CODE, OPENCODE } from '@factory-ai/core';
import { throughSignIn } from './signin.js';
// The copy under assertion, imported from the module the app renders it from — see the note on
// EXECUTOR_GUIDANCE in web/src/workspace/executors.ts for why these live in a React-free module.
import {
    ADD_LABEL,
    ADVANCED_LABEL,
    AGENT_HELP,
    CONFIG_JSON_LABEL,
    EXECUTOR_GUIDANCE,
    EXECUTOR_SCOPE,
    EXECUTOR_TYPE_META,
    executorSavedMessage,
    FORMAT_JSON_LABEL,
    INHERITED_NOTE,
    MODEL_BLOCKED_NOTE,
    MODEL_CUSTOM_LABEL,
    MODEL_DEFAULT_LABEL,
    NAME_HELP,
    NO_CHANGES_REASON,
    RUNNER_MANAGED_NOTE,
    SAVE_HINTS,
    SAVE_LABEL,
} from '../web/src/workspace/executors.js';

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
    await expect(page.getByRole('button', { name: 'Save selection' })).toBeVisible({ timeout: 60_000 });
    const checkbox = page.getByRole('checkbox', { name: 'Enable Bellows-AI/bellows.ai in my workspace' });
    await expect(checkbox).toBeVisible();
    // The four cards come from counts() (issue 282): Selected against the ceiling, then the three
    // checkout states of the chosen repositories.
    const selected = page.locator('.repo-card', { hasText: 'Selected' });
    await expect(selected.locator('.repo-card-value')).toHaveText('0');
    await expect(selected).toContainText('of 20 allowed');
    await expect(selected).toContainText('1 available');
    for (const label of ['Ready', 'Setting up', 'Failed']) {
        await expect(page.locator('.repo-card', { hasText: label }).locator('.repo-card-value')).toHaveText('0');
    }
    await expect(page.locator('.banner-warn')).toHaveCount(0);
    await expect(page.getByLabel('Search repositories')).toBeVisible();
    await expect(page.getByText('0 selected · Selection limited to 20 repositories.')).toBeVisible();

    // A toggle makes the whole-selection draft dirty, and leaving meets the area's ONE discard
    // confirmation (issue 182) — the selection is guarded like every other settings draft.
    await checkbox.click();
    await expect(page.getByText('Selection changed — save to update your workspace')).toBeVisible();
    await expect(page.getByText('1 selected · Selection limited to 20 repositories.')).toBeVisible();
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
    const detail = page.locator('.repo-detail');
    await expect(page.getByRole('heading', { name: 'Selected repository: Bellows-AI/bellows.ai' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Selected repository: Bellows-AI/bellows.ai' })).toBeFocused();
    await expect(detail.getByText('Repository · Bellows-AI/bellows.ai')).toBeVisible();
    // Nothing is checked out, so the checkout facts say so in words — never a zero or a bare dash.
    await expect(detail).toContainText('Not checked out');
    await expect(detail.getByText('Not available')).toHaveCount(3);
    await expect(page.locator('tr.repo-row-configured')).toHaveCount(1);
    await expect(page.getByText('Discard unsaved changes?')).toHaveCount(0);

    await page.screenshot({ path: `${SHOTS}/settings-repos.png`, fullPage: true });
});

test('the default-workflow footer shows Unsaved changes, and Cancel restores the stored switches', async ({ page }) => {
    await signedIn(page);
    await page.goto('/settings/workflows');
    const panel = page.locator('section.panel', { has: page.getByRole('heading', { name: 'Default workflow' }) });
    const footer = panel.locator('.settings-actions');
    const toggle = panel.getByRole('checkbox', { name: 'Repair merge conflicts' });
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    const stored = await toggle.isChecked();
    await expect(footer.getByText('Unsaved changes')).toHaveCount(0);

    await toggle.click();
    await expect(footer.getByText('Unsaved changes')).toBeVisible();
    await expect(footer.getByRole('button', { name: 'Save changes' })).toBeEnabled();

    await footer.getByRole('button', { name: 'Cancel' }).click();
    await expect(toggle).toBeChecked({ checked: stored });
    await expect(footer.getByText('Unsaved changes')).toHaveCount(0);
    await expect(footer.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    // Clean again: leaving asks nothing.
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('Discard unsaved changes?')).toHaveCount(0);
});

test('no settings action word wraps at 1024px', async ({ page }) => {
    // The acceptance (issue 282, PLAN §7.4): at a 1024px window, every button in the page region
    // keeps its label on one line — a wrapped "Config / ure" reads as two words and a broken row.
    await signedIn(page);
    await page.setViewportSize({ width: 1024, height: 800 });

    /** Labels whose text runs over more than one line box, among the visible buttons in main. */
    const wrapped = () =>
        page.locator('main').evaluate((main) =>
            [...main.querySelectorAll('button')]
                .filter((button) => button.offsetParent !== null && button.textContent?.trim())
                .filter((button) => {
                    const range = document.createRange();
                    range.selectNodeContents(button);
                    const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
                    return tops.size > 1;
                })
                .map((button) => button.textContent?.trim())
        );

    for (const [path, ready] of [
        ['/settings/organization', 'Core (organization)'],
        ['/settings/workspace', 'My workspace'],
        ['/settings/executors', 'My workspace'],
        ['/settings/workflows', 'Default workflow'],
    ] as const) {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: ready })).toBeVisible({ timeout: 60_000 });
        expect(await wrapped(), path).toEqual([]);
    }

    // The repositories page with its detail open: the table's Configure, the selection bar's
    // save and the repository editor's footer all share the narrowed width.
    await page.goto('/settings/repos');
    await page.getByRole('button', { name: 'Configure' }).click();
    await expect(page.getByRole('heading', { name: /^Selected repository:/ })).toBeVisible({ timeout: 60_000 });
    expect(await wrapped(), '/settings/repos').toEqual([]);
    await page.screenshot({ path: `${SHOTS}/settings-repos-1024.png`, fullPage: true });
});

/**
 * The executor dialog, named by its title through aria-labelledby rather than a literal id: the
 * dialog mints its ids with useId so two open dialogs cannot collide. Either title — the same
 * dialog is "Add executor" from the header and "Edit executor" from a row.
 */
const executorDialog = (page: Page) => page.getByRole('dialog', { name: /^(Add|Edit) executor$/ });

/** The paragraphs a field points at with aria-describedby — resolved live, since the ids are minted. */
async function describedBy(scope: Locator, field: Locator): Promise<Locator> {
    const ids = (await field.getAttribute('aria-describedby'))?.split(/\s+/).filter(Boolean) ?? [];
    expect(ids.length, 'the field names no describedby target').toBeGreaterThan(0);
    return scope.locator(ids.map((id) => `[id="${id}"]`).join(', '));
}

const executorsPanel = (page: Page) =>
    page.locator('section.panel', { has: page.getByRole('heading', { name: 'My workspace' }) });

/** One row's Edit, found by the row's name — other specs' rows may share the list. */
const editButton = (page: Page, name: string) =>
    executorsPanel(page).locator('tr').filter({ hasText: name }).getByRole('button', { name: 'Edit' });

test('an executor is added through guided setup, with no JSON typed', async ({ page }) => {
    await signedIn(page);
    await page.goto('/settings/executors');

    // The page's scope sentence and the panel's guidance, asserted against the constants they
    // render, not copies of them.
    await expect(page.locator('.page-header-description')).toHaveText(EXECUTOR_SCOPE);
    const panel = executorsPanel(page);
    await expect(panel).toContainText(EXECUTOR_GUIDANCE);

    const add = page.getByRole('button', { name: ADD_LABEL });
    await add.click();
    const dialog = executorDialog(page);
    await expect(dialog.locator('.picker')).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Guided order, visible labels, each help wired to its field.
    const name = dialog.getByLabel('Name', { exact: true });
    const agent = dialog.getByLabel('Agent', { exact: true });
    const modelGroup = dialog.getByRole('group', { name: 'Model' });
    await expect(await describedBy(dialog, name)).toContainText(NAME_HELP);
    await expect(await describedBy(dialog, agent)).toContainText(AGENT_HELP);
    await expect(modelGroup.getByRole('radio', { name: MODEL_DEFAULT_LABEL })).toBeChecked();
    await expect(dialog).toContainText(INHERITED_NOTE);
    // Advanced is collapsed: no JSON is in front of the member.
    await expect(dialog.getByRole('textbox', { name: CONFIG_JSON_LABEL })).toBeHidden();

    // Nothing typed yet: Save is unavailable, and the reason sits beside it.
    const save = dialog.getByRole('button', { name: ADD_LABEL });
    await expect(save).toBeDisabled();
    await expect(await describedBy(dialog, save)).toHaveText(SAVE_HINTS.name);
    await page.screenshot({ path: `${SHOTS}/settings-executor-guided.png` });

    await name.fill('main');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(dialog).toHaveCount(0);

    // Focus went back to the trigger, and the save was announced in the page's status region.
    await expect(add).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: executorSavedMessage('main', false) })).toBeVisible();
    await expect(panel.getByText('main')).toBeVisible();
    await expect(panel.locator('.pill')).toHaveText('Claude Code');
    await expect(panel.getByText('Selected first on new tasks')).toHaveCount(1);

    // A duplicate name is refused beside the Name field, before any save.
    await add.click();
    await name.fill('main');
    await expect(dialog.getByText('An executor named "main" already exists.')).toBeVisible();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(save).toBeDisabled();

    // Dirty dismissal asks first. Escape, then the safe answer, keeps every field.
    await page.keyboard.press('Escape');
    // The dialog role sits on the zero-height layer; its title is what is visible.
    const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
    await expect(confirm.getByRole('heading', { name: 'Discard unsaved changes?' })).toBeVisible();
    await confirm.getByRole('button', { name: 'Continue editing' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(name).toHaveValue('main');
    // Cancel asks too; Discard changes closes, and focus returns to the trigger.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await confirm.getByRole('button', { name: 'Discard changes' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(add).toBeFocused();

    // Edit: nothing changed, nothing to save.
    await editButton(page, 'main').click();
    const saveChanges = dialog.getByRole('button', { name: SAVE_LABEL });
    await expect(saveChanges).toBeDisabled();
    await expect(await describedBy(dialog, saveChanges)).toHaveText(NO_CHANGES_REASON);

    // A custom model through the guided control is the configuration's `model`.
    await modelGroup.getByRole('radio', { name: MODEL_CUSTOM_LABEL }).check();
    await expect(saveChanges).toBeDisabled();
    await modelGroup.getByRole('textbox', { name: MODEL_CUSTOM_LABEL }).fill('opus');
    await dialog.getByText(ADVANCED_LABEL).click();
    await expect(dialog.getByRole('textbox', { name: CONFIG_JSON_LABEL })).toHaveValue('{\n  "model": "opus"\n}');
    await saveChanges.click();
    await expect(dialog).toHaveCount(0);
    await expect(editButton(page, 'main')).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: executorSavedMessage('main', true) })).toBeVisible();

    // Reopened with identical settings; a pristine Escape closes without asking.
    await editButton(page, 'main').click();
    await expect(modelGroup.getByRole('radio', { name: MODEL_CUSTOM_LABEL })).toBeChecked();
    await expect(modelGroup.getByRole('textbox', { name: MODEL_CUSTOM_LABEL })).toHaveValue('opus');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.screenshot({ path: `${SHOTS}/settings-executors.png`, fullPage: true });
});

test('advanced editing is lossless, per agent, and survives a failed save', async ({ page }) => {
    await signedIn(page);
    await page.goto('/settings/executors');

    await page.getByRole('button', { name: ADD_LABEL }).click();
    const dialog = executorDialog(page);
    await dialog.getByLabel('Name', { exact: true }).fill('advanced');
    await dialog.getByText(ADVANCED_LABEL).click();
    const json = dialog.getByRole('textbox', { name: CONFIG_JSON_LABEL });
    const modelGroup = dialog.getByRole('group', { name: 'Model' });
    const save = dialog.getByRole('button', { name: ADD_LABEL });
    await expect(json).toHaveValue('{}');
    await expect(await describedBy(dialog, json)).toContainText(EXECUTOR_TYPE_META[CLAUDE_CODE].configHelp);

    // Enter carries the line's indent.
    await json.fill('{\n  "a": 1\n}');
    await json.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(10, 10));
    await page.keyboard.press('Enter');
    await expect(json).toHaveValue('{\n  "a": 1\n  \n}');

    // Invalid JSON: marked, located, kept, and the guided model waits for it instead of
    // overwriting it.
    await json.fill('{ model: }');
    await expect(json).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByText(/^Not valid JSON at line 1, column 3: /)).toBeVisible();
    await expect(json).toHaveValue('{ model: }');
    await expect(modelGroup.getByRole('radio', { name: MODEL_DEFAULT_LABEL })).toBeDisabled();
    await expect(modelGroup).toContainText(MODEL_BLOCKED_NOTE);
    await expect(save).toBeDisabled();
    await expect(await describedBy(dialog, save)).toHaveText(SAVE_HINTS.config);
    await page.screenshot({ path: `${SHOTS}/settings-executor-advanced-invalid.png` });

    // Tab leaves the editor rather than indenting inside it.
    await json.focus();
    await page.keyboard.press('Tab');
    await expect(json).not.toBeFocused();

    // Valid again: unknown keys stay, the runner-managed key is named, and the guided control
    // reads the model back.
    await json.fill('{"custom":1,"hooks":{},"model":"sonnet"}');
    await expect(json).not.toHaveAttribute('aria-invalid');
    await expect(dialog.locator('.picker-managed')).toContainText(RUNNER_MANAGED_NOTE);
    await expect(dialog.locator('.picker-managed')).toContainText('hooks');
    await expect(modelGroup.getByRole('textbox', { name: MODEL_CUSTOM_LABEL })).toHaveValue('sonnet');
    await dialog.getByRole('button', { name: FORMAT_JSON_LABEL }).click();
    await expect(json).toHaveValue('{\n  "custom": 1,\n  "hooks": {},\n  "model": "sonnet"\n}');
    await modelGroup.getByRole('textbox', { name: MODEL_CUSTOM_LABEL }).fill('opus');
    await expect(json).toHaveValue('{\n  "custom": 1,\n  "hooks": {},\n  "model": "opus"\n}');
    await page.screenshot({ path: `${SHOTS}/settings-executor-advanced.png` });

    // Each agent keeps its own draft: OpenCode starts inherited, and Claude Code's is waiting.
    const agent = dialog.getByLabel('Agent', { exact: true });
    await agent.selectOption({ label: 'OpenCode' });
    await expect(modelGroup.getByRole('radio', { name: MODEL_DEFAULT_LABEL })).toBeChecked();
    await expect(json).toHaveValue('{}');
    await expect(await describedBy(dialog, json)).toContainText(EXECUTOR_TYPE_META[OPENCODE].configHelp);
    await agent.selectOption({ label: 'Claude Code' });
    await expect(modelGroup.getByRole('textbox', { name: MODEL_CUSTOM_LABEL })).toHaveValue('opus');
    await expect(json).toHaveValue('{\n  "custom": 1,\n  "hooks": {},\n  "model": "opus"\n}');

    // A failed save keeps every field and allows a retry.
    let failNext = true;
    await page.route('**/api/workspace/executors', async (route) => {
        if (route.request().method() === 'PUT' && failNext) {
            failNext = false;
            await route.fulfill({ status: 500, json: { error: 'The board is unavailable' } });
            return;
        }
        await route.fallback();
    });
    await save.click();
    await expect(dialog.getByRole('alert')).toContainText('The board is unavailable');
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('advanced');
    await expect(json).toHaveValue('{\n  "custom": 1,\n  "hooks": {},\n  "model": "opus"\n}');
    const put = page.waitForRequest(
        (request) => request.method() === 'PUT' && request.url().endsWith('/api/workspace/executors')
    );
    await save.click();
    const sent = (await put).postDataJSON() as { executors: { name: string; config: object }[] };
    await expect(dialog).toHaveCount(0);
    expect(sent.executors.find((row) => row.name === 'advanced')).toMatchObject({
        config: { custom: 1, hooks: {}, model: 'opus' },
    });

    // Reopened, the unknown key round-tripped through the server — by value: jsonb keeps its own
    // key order, which is not a change.
    await editButton(page, 'advanced').click();
    await dialog.getByText(ADVANCED_LABEL).click();
    await expect.poll(async () => JSON.parse(await json.inputValue())).toEqual({ custom: 1, hooks: {}, model: 'opus' });
    await expect(dialog.getByRole('button', { name: SAVE_LABEL })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
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
