import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';
import { noHorizontalOverflow } from './viewport.js';

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

test.describe('the guided task composer', () => {
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

    test('a workflow that declares parameters asks for them in words before Start', async ({ page }) => {
        const problems = watchConsole(page);
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        await expect(composer.getByText('What should the agent do?')).toBeVisible();
        await expect(composer.getByLabel('Repository')).toBeVisible();
        await expect(composer.getByLabel('Executor')).toBeVisible();
        await expect(composer.getByLabel('Reusable workflow')).toBeVisible();

        // The board's own process is offered by name: the Listbox opens on the trigger click and
        // its options render in the anchored listbox.
        await page.getByLabel('Reusable workflow').click();
        await page.getByRole('option', { name: 'fix-issue' }).click();

        // Selecting it surfaces one labelled input per declared parameter, with the field's
        // label spoken in words, not the raw identifier.
        const issue = composer.getByRole('textbox', { name: 'Issue' });
        await expect(issue).toBeVisible();

        await page.getByLabel('What should the agent do?').fill('fix the login crash');
        await issue.fill('not an issue reference');
        await issue.blur();

        // The refusal speaks the declaration's own words first — the seeded `issue` param
        // describes the shape it wants — and never the regex source: the raw rule lives only
        // under the field's Format details.
        await expect(
            composer.locator('.composer-param-error', { hasText: 'Enter an issue reference' })
        ).toBeVisible();
        await expect(composer.getByText('Format details')).toBeVisible();
        const visible = await composer.innerText();
        expect(visible).not.toContain('#\\d+');
        for (const token of FORBIDDEN) expect(visible, token).not.toContain(token);

        // A value the declaration refuses keeps Start dark, and the blocker says what is missing.
        const start = page.getByRole('button', { name: 'Start task' });
        await expect(start).toBeDisabled();
        await expect(composer.getByText('Complete the required workflow details to continue.')).toBeVisible();

        // A value the declaration accepts lights Start and the preflight speaks the actual choices.
        await issue.fill('#12');
        await expect(start).toBeEnabled();
        await expect(composer.getByText(/, with the fix-issue workflow\./)).toBeVisible();

        await page.screenshot({ path: `${SHOTS}/composer-guided.png`, fullPage: true });
        await page.setViewportSize({ width: 360, height: 800 });
        await noHorizontalOverflow(page);
        await page.screenshot({ path: `${SHOTS}/composer-360.png`, fullPage: true });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.screenshot({ path: `${SHOTS}/composer-1440.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });

    test('the compact context row stays content-sized, and the optional steps sit behind a closed disclosure', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        const context = composer.locator('.composer-context');
        await expect(context).toBeVisible();

        // Each trigger is a compact, content-sized control — none of them stretches to the
        // composer's own width, unlike the old full-width grid columns.
        const composerBox = await composer.boundingBox();
        for (const label of ['Repository', 'Executor', 'Reusable workflow']) {
            const box = await page.getByLabel(label).boundingBox();
            expect(box).not.toBeNull();
            expect(box!.width).toBeLessThan(composerBox!.width * 0.6);
        }

        // The two default-workflow steps (#208) are collapsed behind a summary that names how
        // many are on, not two persistent rows.
        const steps = composer.locator('.composer-steps');
        const summary = steps.locator('summary');
        await expect(summary).toHaveText(/Optional steps \(\d of 2 on\)/);
        const reviewToggle = composer.getByRole('checkbox', { name: 'Iterate on PR review comments' });
        await expect(reviewToggle).toBeHidden();

        // Opening it reveals both switches; toggling one updates the summary's count and the
        // preflight sentence together.
        await summary.click();
        await expect(reviewToggle).toBeVisible();
        const beforeText = await summary.textContent();
        await reviewToggle.click();
        await expect(summary).not.toHaveText(beforeText ?? '');
        await expect(composer.getByText(/Default workflow selected:/)).toBeVisible();

        // The keyboard path opens it too: a focused summary responds to Enter like any disclosure.
        await summary.click();
        await expect(reviewToggle).toBeHidden();
        await summary.focus();
        await page.keyboard.press('Enter');
        await expect(reviewToggle).toBeVisible();

        await page.screenshot({ path: `${SHOTS}/composer-steps-open.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });

    test('renders correctly in dark theme at desktop and mobile widths', async ({ page }) => {
        const problems = watchConsole(page);
        await page.addInitScript(() => localStorage.setItem('factory.theme', 'dark'));
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

        const composer = page.locator('.composer');
        await expect(composer.getByText('What should the agent do?')).toBeVisible();

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.screenshot({ path: `${SHOTS}/composer-1440-dark.png`, fullPage: true });
        await page.setViewportSize({ width: 360, height: 800 });
        await noHorizontalOverflow(page);
        // Every context trigger still clears the compact-shell touch-target floor in dark theme,
        // the same as light — the theme swaps color tokens only.
        for (const label of ['Repository', 'Executor', 'Reusable workflow']) {
            const box = await page.getByLabel(label).boundingBox();
            expect(box).not.toBeNull();
            expect(box!.height).toBeGreaterThanOrEqual(44);
        }
        await page.screenshot({ path: `${SHOTS}/composer-360-dark.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });

    test('an unchosen workflow runs the raw prompt, and an empty prompt explains the dark Start', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        await expect(page.getByLabel('Reusable workflow')).toHaveText('Default workflow');

        // Fresh page, empty prompt: Start is dark by design and says so.
        const start = page.getByRole('button', { name: 'Start task' });
        await expect(start).toBeDisabled();
        await expect(composer.getByText('Describe the task to continue.')).toBeVisible();
        await expect(composer.locator('.composer-param-error')).toHaveCount(0);

        // The prompt is the only requirement: no process chosen, the member's words are the
        // whole command, and the preflight says exactly that.
        await page.getByLabel('What should the agent do?').fill('fix the login crash');
        await expect(start).toBeEnabled();
        await expect(composer.getByText(/Default workflow selected: prompt, gates, publish/)).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/composer-unchosen-raw-prompt.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });

    test('the keyboard path shares the button validation: marks, focuses, and never queues', async ({ page }) => {
        const problems = watchConsole(page);
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        await page.getByLabel('Reusable workflow').click();
        await page.getByRole('option', { name: 'fix-issue' }).click();
        await page.getByLabel('What should the agent do?').fill('fix the login crash');

        const issue = composer.getByRole('textbox', { name: 'Issue' });
        await issue.fill('not an issue reference');

        // The shortcut is the button, never a bypass: the invalid submission marks the field,
        // focuses it, and sends nothing — the member is still on the composer.
        await issue.press('ControlOrMeta+Enter');
        await expect(
            composer.locator('.composer-param-error', { hasText: 'Enter an issue reference' })
        ).toBeVisible();
        await expect(issue).toBeFocused();
        expect(page.url()).toContain('/tasks/new');

        // A valid value lets the same shortcut queue: the board answers 201 and the page walks
        // straight to the new task.
        await issue.fill('#12');
        await issue.press('ControlOrMeta+Enter');
        await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}/);
        expect(problems.join('\n')).toBe('');

        // Leave no claimable task behind: the task-detail spec claims against the same seeded
        // board and its "own queued task is the only one claimable" invariant is what keeps that
        // deterministic. Stop this one — the page's own primary action for a queued task.
        await page.locator('.page-header-actions').getByRole('button', { name: 'Stop run' }).click();
        await expect(page.locator('.page-header-meta')).toContainText('stopped', { timeout: 10_000 });
    });
});
