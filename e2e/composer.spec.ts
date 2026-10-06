import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';
import { ADD_LABEL } from '../web/src/workspace/executors.js';
import {
    addExecutorViaDialog,
    countLaunches,
    E2E_EXECUTOR,
    E2E_EXECUTOR_ROW,
    E2E_REPO,
    mockExecutors,
    stubLaunch,
    withExecutor,
} from './executor.js';
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
    page.on('requestfailed', (r) => {
        // A poll the app cancelled itself reports net::ERR_ABORTED: leaving a settings route
        // unmounts its pollers, and `useWorkspace` aborts their fetches through an AbortSignal.
        // That is the cleanup working, not something a member would ever see. The reason is
        // carried on every other failure so the next one reads as itself rather than a bare URL.
        const reason = r.failure()?.errorText ?? 'unknown';
        if (reason === 'net::ERR_ABORTED') return;
        problems.push(`requestfailed: ${r.url()} (${reason})`);
    });
    return problems;
}

/**
 * The board owns the base workflow's row and refreshes it at boot — seedBase fires without being
 * awaited (orgs.ts), so the first list read can still serve a stale pre-parameter definition. The
 * refresh must land BEFORE the page loads: the visit is the one a member gets, and a test takes no
 * second one. toPass bounds the wait — a refresh that never lands is a real failure, not a race
 * to hide.
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

/**
 * Open one of the execution-context selectors the way a member on a short screen does: scroll it
 * up first. The four-section page puts section 2 near the bottom of a 720px viewport, and the
 * menu is downward-only (issue 224) and fixed-positioned, so opened there it lands below the fold.
 */
async function openSelector(page: Page, label: string) {
    const trigger = page.getByLabel(label);
    await trigger.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await trigger.click();
}

test.describe('the guided task composer', () => {
    test.beforeEach(({ page }) => withExecutor(page));

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
        await openSelector(page, 'Reusable workflow');
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
        await expect(composer.locator('.composer-param-error', { hasText: 'Enter an issue reference' })).toBeVisible();
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

    test('the execution context is three columns on a wide screen, and the optional steps sit behind a closed disclosure', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        const context = composer.locator('.composer-context');
        await expect(context).toBeVisible();

        // At 1440 the three selectors share one row, a column each (plan §2.3): same top, left to
        // right, none wider than a third of the section.
        const contextBox = await context.boundingBox();
        const boxes: { x: number; y: number }[] = [];
        for (const label of ['Repository', 'Executor', 'Reusable workflow']) {
            const box = await page.getByLabel(label).boundingBox();
            expect(box).not.toBeNull();
            expect(box!.width).toBeLessThan(contextBox!.width / 3);
            boxes.push(box!);
        }
        expect(boxes[1]!.y).toBeCloseTo(boxes[0]!.y, 0);
        expect(boxes[2]!.y).toBeCloseTo(boxes[0]!.y, 0);
        expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
        expect(boxes[1]!.x).toBeLessThan(boxes[2]!.x);

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

    test('an unchosen workflow runs the raw prompt, and an empty prompt explains the dark Start', async ({ page }) => {
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
        await stubLaunch(page);
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        await openSelector(page, 'Reusable workflow');
        await page.getByRole('option', { name: 'fix-issue' }).click();
        await page.getByLabel('What should the agent do?').fill('fix the login crash');

        const issue = composer.getByRole('textbox', { name: 'Issue' });
        await issue.fill('not an issue reference');

        // The shortcut is the button, never a bypass: the invalid submission marks the field,
        // focuses it, and sends nothing — the member is still on the composer.
        await issue.press('ControlOrMeta+Enter');
        await expect(composer.locator('.composer-param-error', { hasText: 'Enter an issue reference' })).toBeVisible();
        await expect(issue).toBeFocused();
        expect(page.url()).toContain('/tasks/new');

        // A valid value lets the same shortcut queue: the board answers 201 and the page walks
        // straight to the new task.
        await issue.fill('#12');
        await issue.press('ControlOrMeta+Enter');
        await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}/);
        expect(problems.join('\n')).toBe('');
    });

    // The synced-repository requirement (issue 263). The poll is mocked, so `repos` is whatever
    // the test says; no launch reaches the board unless the test stubs it.
    test('with nothing synced, both launch triggers open the dialog, queue nothing, and Cancel keeps the draft', async ({
        page,
    }) => {
        await page.unroute('**/api/workspace');
        await mockExecutors(page, [E2E_EXECUTOR_ROW], [{ ...E2E_REPO, status: 'cloning' }]);
        const launches = countLaunches(page);
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');

        const prompt = page.getByLabel('What should the agent do?');
        await prompt.fill('fix the login crash');
        const start = page.getByRole('button', { name: 'Start task' });
        await expect(start).toBeEnabled();
        await expect(page.locator('.composer .banner-bad')).toContainText('No repos synced');

        await start.click();
        const dialog = page.getByRole('dialog', { name: 'No repos synced' });
        await expect(dialog).toContainText(
            'Go to the Repositories page to select and sync a repository before running a task.'
        );
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(start).toBeFocused();
        await expect(prompt).toHaveValue('fix the login crash');

        await prompt.press('ControlOrMeta+Enter');
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(prompt).toBeFocused();
        expect(launches.bodies).toHaveLength(0);
    });

    test('Go to Repositories carries the draft there and back', async ({ page }) => {
        await page.unroute('**/api/workspace');
        await mockExecutors(page, [E2E_EXECUTOR_ROW], []);
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');

        const prompt = page.getByLabel('What should the agent do?');
        await prompt.fill('fix the login crash');
        await page.getByRole('button', { name: 'Start task' }).click();
        await page
            .getByRole('dialog', { name: 'No repos synced' })
            .getByRole('button', { name: 'Go to Repositories' })
            .click();
        await expect(page).toHaveURL(/\/settings\/repos\?return=\/tasks\/new$/);
        await page.getByRole('link', { name: 'Back to new task' }).click();
        await expect(prompt).toHaveValue('fix the login crash');
    });

    test('a chosen repository that is not ready blocks launch even though another is ready', async ({ page }) => {
        await page.unroute('**/api/workspace');
        await mockExecutors(
            page,
            [E2E_EXECUTOR_ROW],
            [
                { ...E2E_REPO, status: 'ready' },
                { owner: 'acme', name: 'api', status: 'cloning' },
            ]
        );
        const launches = countLaunches(page);
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');

        await page.getByLabel('What should the agent do?').fill('fix the login crash');
        await openSelector(page, 'Repository');
        await page.getByRole('option', { name: 'acme/api' }).click();
        await expect(page.locator('.composer .banner-bad')).toContainText('Repository not synced');
        await expect(page.getByRole('button', { name: 'Start task' })).toBeDisabled();
        await page.getByLabel('What should the agent do?').press('ControlOrMeta+Enter');
        expect(launches.bodies).toHaveLength(0);
    });

    test('a fresh composer opens without a red banner, counts the request, and blocks it past the limit', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        const start = page.getByRole('button', { name: 'Start task' });
        await expect(composer.getByText('0 / 16,384')).toBeVisible();
        await expect(composer.locator('.banner-bad')).toHaveCount(0);
        await expect(start).toHaveAttribute('aria-describedby', 'composer-blocker');

        // The example is offered only while there is nothing to type over.
        const example = composer.getByRole('button', { name: 'Try an example' });
        await example.click();
        await expect(page.getByLabel('What should the agent do?')).toHaveValue(/^Fix issue #123/);
        await expect(example).toBeDisabled();
        await expect(start).toBeEnabled();

        await page.getByLabel('What should the agent do?').fill('x'.repeat(16_385));
        await expect(composer.locator('.composer-counter.is-over')).toHaveText('16,385 / 16,384');
        await expect(composer.locator('.banner-bad')).toContainText('Request too long');
        await expect(start).toBeDisabled();
        await expect(start).toHaveAttribute('aria-describedby', 'composer-readiness');
        await page.screenshot({ path: `${SHOTS}/composer-too-long.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });

    test("the board's refusal keeps the draft, and Discard empties it only after asking", async ({ page }) => {
        await awaitSeedRefresh(page);
        await page.route('**/api/jobs', (route) =>
            route.request().method() === 'POST'
                ? route.fulfill({ status: 503, json: { error: 'The board is unavailable' } })
                : route.fallback()
        );
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        const prompt = page.getByLabel('What should the agent do?');
        await prompt.fill('fix the login crash');
        await page.getByRole('button', { name: 'Start task' }).click();
        await expect(composer.getByRole('alert')).toBeVisible();
        await expect(prompt).toHaveValue('fix the login crash');
        expect(page.url()).toContain('/tasks/new');

        // Typed words are not thrown away on one click: the settings area's dialog asks first.
        await composer.getByRole('button', { name: 'Discard draft' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByText('Discard unsaved changes?')).toBeVisible();
        // The launch shortcut belongs to the form, not to a question about throwing it away: the
        // dialog renders in a portal, but React events still bubble to the composer beneath.
        const launches = countLaunches(page);
        await page.keyboard.press('ControlOrMeta+Enter');
        await expect(dialog.getByText('Discard unsaved changes?')).toBeVisible();
        expect(launches.bodies).toHaveLength(0);
        await dialog.getByRole('button', { name: 'Continue editing' }).click();
        await expect(prompt).toHaveValue('fix the login crash');

        await composer.getByRole('button', { name: 'Discard draft' }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Discard changes' }).click();
        await expect(prompt).toHaveValue('');
        await expect(composer.getByRole('button', { name: 'Discard draft' })).toHaveCount(0);
    });
});

test.describe('the draft survives the configuration detour (F1)', () => {
    const prompt = (page: Page) => page.getByLabel('What should the agent do?');

    test('add an executor in Settings, come back, and launch once with everything restored', async ({ page }) => {
        const problems = watchConsole(page);
        const held = await mockExecutors(page, [], [E2E_REPO]);
        const launches = countLaunches(page);
        await stubLaunch(page);
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        await prompt(page).fill('fix the login crash');
        await openSelector(page, 'Reusable workflow');
        await page.getByRole('option', { name: 'fix-issue' }).click();
        await composer.getByRole('textbox', { name: 'Issue' }).fill('#12');

        // No executor: the one red banner, with the way to fix it.
        const banner = composer.locator('.banner-bad');
        await expect(banner).toContainText('No executor configured');
        await page.screenshot({ path: `${SHOTS}/composer-missing-executor.png`, fullPage: true });
        await banner.getByRole('link', { name: 'Add an executor in Settings' }).click();

        await expect(page).toHaveURL(/\/settings\/executors\?return=\/tasks\/new$/);
        await expect(page.getByText('You have a task draft in progress.')).toBeVisible();
        // Guided setup: a name alone saves the inherited configuration — no JSON typed (issue 261).
        await addExecutorViaDialog(page, 'fresh-executor');
        expect(held.executors).toEqual([expect.objectContaining({ name: 'fresh-executor', config: {} })]);
        await expect(page.getByText('You have a task draft in progress.')).toBeVisible();
        await page.getByRole('link', { name: 'Back to new task' }).click();

        // Everything as it was left, and the new executor chosen by the composer's own autoselect.
        await expect(prompt(page)).toHaveValue('fix the login crash');
        await expect(page.getByLabel('Reusable workflow')).toHaveText('fix-issue');
        await expect(composer.getByRole('textbox', { name: 'Issue' })).toHaveValue('#12');
        await expect(page.getByLabel('Executor')).toHaveText('fresh-executor');
        await expect(composer.locator('.banner-bad')).toHaveCount(0);
        // Nothing launches on its own: the return only restores.
        expect(launches.bodies).toHaveLength(0);

        await page.getByRole('button', { name: 'Start task' }).click();
        await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}/);
        expect(launches.bodies).toHaveLength(1);
        expect(launches.bodies[0]).toMatchObject({
            command: 'fix the login crash',
            executor: 'fresh-executor',
            repo: `${E2E_REPO.owner}/${E2E_REPO.name}`,
            workflow: 'fix-issue',
            workflowParams: { issue: '#12' },
        });
        expect(problems.join('\n')).toBe('');
    });

    test('Cancel in Settings comes back to the same draft, optional-step override included', async ({ page }) => {
        await mockExecutors(page, []);
        const launches = countLaunches(page);
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        await prompt(page).fill('tidy the changelog');
        const summary = composer.locator('.composer-steps summary');
        await summary.click();
        await composer.getByRole('checkbox', { name: 'Repair merge conflicts' }).click();
        const count = await summary.textContent();

        await composer.getByRole('link', { name: 'Add an executor in Settings' }).click();
        await page.getByRole('button', { name: 'Add executor' }).click();
        await page.getByRole('dialog', { name: 'Add executor' }).getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('link', { name: 'Back to new task' }).click();

        await expect(prompt(page)).toHaveValue('tidy the changelog');
        await expect(composer.locator('.composer-steps summary')).toHaveText(count ?? '');
        await expect(composer.locator('.banner-bad')).toContainText('No executor configured');
        expect(launches.bodies).toHaveLength(0);
    });

    test('adding an executor from the composer detour keeps the existing default', async ({ page }) => {
        // Creation alone never moves the default (issue 261): the whole-list PUT carries the
        // flagged row through unchanged, and the new row arrives unflagged.
        // The dialog's config read validates each row's shape, gate-repair budget included.
        const held = await mockExecutors(page, [
            { ...E2E_EXECUTOR, gateFixRounds: 3, config: { model: 'sonnet', keep: 1 } },
        ]);
        await page.goto('/settings/executors?return=/tasks/new');
        await addExecutorViaDialog(page, 'second');
        expect(held.executors).toEqual([
            expect.objectContaining({ name: E2E_EXECUTOR.name, config: { model: 'sonnet', keep: 1 } }),
            expect.objectContaining({ name: 'second', config: {} }),
        ]);
        await expect(page.getByText('You have a task draft in progress.')).toBeVisible();
        await page.getByRole('link', { name: 'Back to new task' }).click();
        await expect(page.getByLabel('Executor')).toHaveText(E2E_EXECUTOR.name);
    });

    test('the executor dialog’s credentials detour asks before dropping typing, and keeps the way back', async ({
        page,
    }) => {
        await mockExecutors(page, []);
        await page.goto('/settings/executors?return=/tasks/new');
        await page.getByRole('button', { name: ADD_LABEL }).click();
        const dialog = page.getByRole('dialog', { name: 'Add executor' });
        const link = dialog.getByRole('link', { name: 'Workspace settings' });
        await expect(link).toHaveAttribute('href', '/settings/workspace?return=/tasks/new');

        // Typing makes the dialog dirty: the backdrop asks first, and so does the link.
        await dialog.getByLabel('Name', { exact: true }).fill('half-typed');
        await page.mouse.click(5, 5);
        const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
        await expect(confirm.getByRole('heading', { name: 'Discard unsaved changes?' })).toBeVisible();
        await confirm.getByRole('button', { name: 'Continue editing' }).click();
        await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('half-typed');
        await link.click();
        await expect(page).toHaveURL(/\/settings\/executors\?return=\/tasks\/new$/);
        await confirm.getByRole('button', { name: 'Discard changes' }).click();

        await expect(page).toHaveURL(/\/settings\/workspace\?return=\/tasks\/new$/);
        await expect(page.getByText('You have a task draft in progress.')).toBeVisible();
    });

    test('an executor deleted while away is named in a notice, and the request text is kept', async ({ page }) => {
        const problems = watchConsole(page);
        const held = await mockExecutors(page, [
            { ...E2E_EXECUTOR, config: {} },
            {
                name: 'doomed',
                type: E2E_EXECUTOR.type,
                createdAt: E2E_EXECUTOR.createdAt,
                config: {},
            },
        ]);
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');

        await prompt(page).fill('fix the login crash');
        await openSelector(page, 'Executor');
        await page.getByRole('option', { name: 'doomed' }).click();

        // Away and back through the app's own navigation — a reload is a fresh start by design —
        // with the chosen profile deleted in between.
        await page.locator('.sidenav-link', { hasText: 'Settings' }).click();
        await expect(page).toHaveURL(/\/settings$/);
        held.executors = held.executors.filter((row) => row.name !== 'doomed');
        // The clamp, and the notice that names it, are driven by the workspace answer — not by the
        // return itself. Wait for the answer that has actually dropped the profile: on a slower
        // board the first one back can still carry it, and asserting before it lands races (#289).
        const withoutDoomed = page.waitForResponse(async (response) => {
            if (new URL(response.url()).pathname !== '/api/workspace') return false;
            const body = (await response.json().catch(() => null)) as { executors?: { name: string }[] } | null;
            return body !== null && (body.executors ?? []).every((row) => row.name !== 'doomed');
        });
        await page.goBack();
        await withoutDoomed;

        const notice = page.locator('.composer-notices');
        await expect(notice).toContainText(`Executor ‘doomed’ is no longer available — ${E2E_EXECUTOR.name} selected.`);
        await expect(prompt(page)).toHaveValue('fix the login crash');
        await expect(page.getByLabel('Executor')).toHaveText(E2E_EXECUTOR.name);
        await page.screenshot({ path: `${SHOTS}/composer-restored-notice.png`, fullPage: true });
        await notice.getByRole('button', { name: 'Dismiss' }).click();
        await expect(notice).toHaveCount(0);
        await expect(prompt(page)).toHaveValue('fix the login crash');
        expect(problems.join('\n')).toBe('');
    });

    test('a chosen executor and repository come back as chosen, before the workspace poll answers', async ({
        page,
    }) => {
        // The two choices a fresh composer would pick differently: a non-default executor and the
        // second repository. The return remounts the tasks area, so the workspace poll starts over
        // — while it is pending the page hands in an empty executor list, which must not clamp the
        // held choice away, and the workflow list must be asked for the held repository's context.
        const problems = watchConsole(page);
        await mockExecutors(
            page,
            [
                { ...E2E_EXECUTOR, config: {} },
                {
                    name: 'heavy',
                    type: E2E_EXECUTOR.type,
                    createdAt: E2E_EXECUTOR.createdAt,
                    config: {},
                },
            ],
            [
                { owner: 'acme', name: 'web' },
                { owner: 'acme', name: 'api' },
            ]
        );
        await awaitSeedRefresh(page);
        await page.goto('/tasks/new');

        await prompt(page).fill('fix the login crash');
        await openSelector(page, 'Executor');
        await page.getByRole('option', { name: 'heavy' }).click();
        await openSelector(page, 'Repository');
        await page.getByRole('option', { name: 'acme/api' }).click();
        await expect(page.getByLabel('Repository')).toHaveText('acme/api');

        await page.locator('.sidenav-link', { hasText: 'Settings' }).click();
        await expect(page).toHaveURL(/\/settings$/);
        // Hold the workspace poll back on return, so the pending window is real rather than a race.
        let releasePoll: () => void = () => {};
        const pollHeld = new Promise<void>((resolve) => {
            releasePoll = resolve;
        });
        await page.route('**/api/workspace', async (route) => {
            await pollHeld;
            await route.fallback();
        });
        const workflowContexts: (string | null)[] = [];
        page.on('request', (request) => {
            const url = new URL(request.url());
            if (url.pathname === '/api/workflows') workflowContexts.push(url.searchParams.get('repo'));
        });
        // The pending window only exists once the remounted poll has actually asked. Waiting for
        // the request — which the route above holds — is what makes it deterministic; asserting
        // the text straight after the return races a board that answers sooner (#289).
        const polled = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/workspace');
        await page.goBack();
        await polled;
        await expect(page.getByText('Loading your workspace…')).toBeVisible();
        releasePoll();

        await expect(prompt(page)).toHaveValue('fix the login crash');
        await expect(page.getByLabel('Executor')).toHaveText('heavy');
        await expect(page.getByLabel('Repository')).toHaveText('acme/api');
        await expect(page.locator('.composer-notices')).toHaveCount(0);
        expect(workflowContexts[0]).toBe('acme/api');
        expect(problems.join('\n')).toBe('');
    });

    test('a return link to anywhere but the composer is ignored', async ({ page }) => {
        await page.goto('/settings/executors?return=https://evil.example');
        await expect(page.getByRole('heading', { name: 'Executors' })).toBeVisible();
        await expect(page.getByText('You have a task draft in progress.')).toHaveCount(0);
    });
});
