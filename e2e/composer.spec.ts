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
    /**
     * The board owns the base workflow's row and refreshes it at boot — seedBase fires without
     * being awaited (orgs.ts), so the first list read can still serve a stale pre-parameter
     * definition. The refresh must land BEFORE the page loads: the visit below is the one a
     * member gets, and the test takes no second one. toPass bounds the wait — a refresh that
     * never lands is a real failure, not a race to hide.
     */
    async function awaitSeedRefresh(page: Page) {
        await expect(async () => {
            const response = await page.request.get('/api/workflows');
            expect(response.ok()).toBe(true);
            const { workflows } = (await response.json()) as {
                workflows: { name: string; params: { name: string }[] }[];
            };
            const fixIssue = workflows.find((choice) => choice.name === 'fix-issue');
            expect(fixIssue?.params.map((param) => param.name)).toContain('issue');
        }).toPass({ timeout: 15_000 });
    }

    test('a workflow that declares parameters asks for them before Send', async ({ page }) => {
        const problems = watchConsole(page);
        await awaitSeedRefresh(page);
        await page.goto('/tasks');

        const composer = page.locator('.composer');
        await expect(composer.getByLabel('Repository')).toBeVisible();
        await expect(composer.getByLabel('Executor')).toBeVisible();
        await expect(composer.getByLabel('Workflow')).toBeVisible();

        // The board's own process is offered by name.
        await expect(page.getByLabel('Workflow').locator('option', { hasText: 'fix-issue' })).toBeAttached();

        // Selecting it must surface one labelled input per declared parameter: the launch
        // refuses without them, so a select without a form is a task that cannot start.
        const workflow = page.getByLabel('Workflow');
        await workflow.selectOption('fix-issue');
        await expect(workflow).toHaveValue('fix-issue');
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

    test('a dark Send names the parameter the default workflow still needs', async ({ page }) => {
        const problems = watchConsole(page);
        await awaitSeedRefresh(page);
        await page.goto('/tasks');

        const composer = page.locator('.composer');
        // Nothing chosen: the board's org default (fix-issue) resolves for the task and demands
        // its parameter. This is the state a member lands in — not the explicit choice above.
        await expect(page.getByLabel('Workflow')).toHaveValue('');
        await page.getByPlaceholder('Describe the task…').fill('fix the login crash');

        const send = page.getByRole('button', { name: 'Send' });
        await expect(send).toBeDisabled();
        // Send is dark by design, and the composer must say what it is waiting for — at the
        // field, in words, not in the declaration's regex source.
        await expect(composer.getByText('needs: issue')).toBeVisible();
        const issue = composer.getByRole('textbox', { name: 'issue' });
        await expect(issue).toHaveAttribute('placeholder', 'required');

        // A value the declaration refuses keeps Send dark and keeps the reason on screen.
        await issue.fill('not an issue reference');
        await expect(send).toBeDisabled();
        await expect(composer.getByText('needs: issue')).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/composer-send-dark-reason.png`, fullPage: true });

        // A value the declaration accepts lights Send and retires the reason.
        await issue.fill('#12');
        await expect(send).toBeEnabled();
        await expect(composer.getByText('needs: issue')).toBeHidden();

        await page.screenshot({ path: `${SHOTS}/composer-default-needs-param.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });
});
