import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

const SHOTS = 'artifacts/ui';

/** A literal 'NaN' or 'undefined' is what a missing null guard looks like to a reader. */
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

test.describe('the task composer', () => {
    // The board owns the base workflow's row and refreshes it at boot; that refresh races the
    // page's first list fetch. A reload re-reads the list, and toPass bounds the retry — a
    // reload that never helps is a real failure, not a race.
    async function selectWorkflowAndSettle(page: Page, name: string) {
        const workflow = page.getByLabel('Workflow');
        await expect(async () => {
            await page.reload();
            await expect(workflow).toBeVisible();
            await workflow.selectOption(name);
            await expect(workflow).toHaveValue(name);
        }).toPass({ timeout: 15_000 });
    }

    test('a workflow that declares parameters asks for them before Send', async ({ page }) => {
        const problems = watchConsole(page);
        await page.goto('/tasks');

        const composer = page.locator('.composer');
        await expect(composer.getByLabel('Repository')).toBeVisible();
        await expect(composer.getByLabel('Executor')).toBeVisible();
        await expect(composer.getByLabel('Workflow')).toBeVisible();

        // The board's own process is offered by name.
        await expect(page.getByLabel('Workflow').locator('option', { hasText: 'fix-issue' })).toBeAttached();

        // Selecting it must surface one labelled input per declared parameter: the launch
        // refuses without them, so a select without a form is a task that cannot start.
        await selectWorkflowAndSettle(page, 'fix-issue');
        const issue = composer.getByRole('textbox', { name: 'issue' });
        await expect(issue).toBeVisible();

        // The parameter is required: a value the declaration refuses keeps Send dark.
        await page.getByPlaceholder('Describe the task…').fill('fix the login crash');
        await issue.fill('not an issue reference');
        await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();

        // A value the declaration accepts lights it.
        await issue.fill('#12');
        await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();

        const text = await composer.innerText();
        for (const token of FORBIDDEN) expect(text, `composer contains ${token}`).not.toContain(token);

        await page.screenshot({ path: `${SHOTS}/composer-params.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });
});
