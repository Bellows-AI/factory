import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

const SHOTS = 'artifacts/ui';

/**
 * The states the Environment page can be in, one interaction per state, a screenshot per state.
 * `npm test` renders the panel with react-dom/server and proves it does not throw; only a browser
 * proves the inputs accept typing and Save writes.
 */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

function watchConsole(page: Page): string[] {
    const problems: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
        if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
    return problems;
}

/** The Core (organization) scope's panel — the first editor on the page. */
function corePanel(page: Page) {
    return page.locator('section.panel', { has: page.getByRole('heading', { name: 'Core (organization)' }) });
}

/** The raw toggle. `exact` — a substring match also hits every `Remove …RAW…` row button. */
function rawToggle(page: Page) {
    return corePanel(page).getByRole('button', { name: 'raw', exact: true });
}

async function open(page: Page) {
    await page.goto('/env');
    await expect(page.getByRole('heading', { name: 'Core (organization)' })).toBeVisible({ timeout: 60_000 });
}

test.describe('environment page', () => {
    test('renders the three scope editors cleanly', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);

        await expect(page.getByRole('heading', { name: 'My workspace' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Per repository' })).toBeVisible();
        const text = await page.locator('main').innerText();
        for (const token of FORBIDDEN) expect(text, `env page contains ${token}`).not.toContain(token);

        await page.screenshot({ path: `${SHOTS}/env-page.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });

    test('a variable can be added by row, edited, and saved', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);

        const core = corePanel(page);
        // Rows stored by an earlier run (the seed leaves env_var alone) would make the locators
        // below ambiguous and the save a duplicate — clear them through the page's own buttons.
        const removeButtons = core.getByRole('button', { name: /^Remove/ });
        while ((await removeButtons.count()) > 0) {
            await removeButtons.first().click();
        }
        await expect(core.getByText('No variables configured.')).toBeVisible();

        await expect(rawToggle(page)).toBeEnabled();
        await core.getByRole('button', { name: 'Add variable' }).click();
        await core.getByLabel('Variable name').fill('E2E_PROBE_VAR');
        await core.getByLabel('Value', { exact: true }).fill('probe-value');
        await page.screenshot({ path: `${SHOTS}/env-row-edit.png`, fullPage: true });

        await core.getByRole('button', { name: 'Save' }).click();
        await expect(core.getByText('Saved.')).toBeVisible({ timeout: 15_000 });
        await page.screenshot({ path: `${SHOTS}/env-row-saved.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });

    test('a variable can be edited as raw text and saved', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);

        const core = corePanel(page);
        await rawToggle(page).click();
        const editor = core.getByLabel('Raw .env editor');
        await expect(editor).toBeVisible();
        await editor.fill('E2E_RAW_VAR=raw-value');
        await page.screenshot({ path: `${SHOTS}/env-raw-edit.png`, fullPage: true });

        // Toggling raw off parses the text into the draft; the row table returns.
        await rawToggle(page).click();
        await expect(core.getByLabel('Variable name')).toHaveValue('E2E_RAW_VAR');

        await core.getByRole('button', { name: 'Save' }).click();
        await expect(core.getByText('Saved.')).toBeVisible({ timeout: 15_000 });
        await page.screenshot({ path: `${SHOTS}/env-raw-saved.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });
});
