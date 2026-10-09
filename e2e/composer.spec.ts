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
 * Open one of the execution-context selectors the way a member on a short screen does: scroll it
 * up first. The three-section page puts section 2 near the bottom of a 720px viewport, and the
 * menu is downward-only (issue 224) and fixed-positioned, so opened there it lands below the fold.
 */
async function openSelector(page: Page, label: string) {
    const trigger = page.getByLabel(label);
    await trigger.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await trigger.click();
}

test.describe('the guided task composer', () => {
    test.beforeEach(({ page }) => withExecutor(page));

    test('workflows are dormant: no selector, no details step, and the prompt runs as written', async ({ page }) => {
        const problems = watchConsole(page);
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        await expect(composer.getByText('What should the agent do?')).toBeVisible();
        await expect(composer.getByLabel('Repository')).toBeVisible();
        await expect(composer.getByLabel('Executor')).toBeVisible();
        await expect(composer.getByLabel('Reusable workflow')).toHaveCount(0);
        await expect(composer.getByRole('heading', { name: 'Workflow details' })).toHaveCount(0);

        // Readiness takes the workflow details' place as step 3.
        await expect(composer.locator('.composer-section').last()).toContainText('3');
        await expect(composer.locator('.composer-section').last()).toContainText('Readiness');

        await page.getByLabel('What should the agent do?').fill('fix the login crash');
        await expect(page.getByRole('button', { name: 'Start task' })).toBeEnabled();
        await expect(composer.getByText(/Your prompt will run as written\./)).toBeVisible();
        const visible = await composer.innerText();
        for (const token of FORBIDDEN) expect(visible, token).not.toContain(token);

        await page.screenshot({ path: `${SHOTS}/composer-guided.png`, fullPage: true });
        await page.setViewportSize({ width: 360, height: 800 });
        await noHorizontalOverflow(page);
        await page.screenshot({ path: `${SHOTS}/composer-360.png`, fullPage: true });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.screenshot({ path: `${SHOTS}/composer-1440.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });

    test('the execution context shares one row on a wide screen, with no workflow step controls', async ({ page }) => {
        const problems = watchConsole(page);
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        const context = composer.locator('.composer-context');
        await expect(context).toBeVisible();

        // At 1440 the selectors share one row, a column each (plan §2.3): same top, left to right,
        // none wider than a third of the section.
        const contextBox = await context.boundingBox();
        const boxes: { x: number; y: number }[] = [];
        for (const label of ['Repository', 'Executor']) {
            const box = await page.getByLabel(label).boundingBox();
            expect(box).not.toBeNull();
            expect(box!.width).toBeLessThan(contextBox!.width / 3);
            boxes.push(box!);
        }
        expect(boxes[1]!.y).toBeCloseTo(boxes[0]!.y, 0);
        expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);

        // No workflow step controls exist (issue 543): objective mode has nothing to configure.
        await expect(composer.locator('.composer-steps')).toHaveCount(0);
        await expect(composer.getByRole('checkbox')).toHaveCount(0);

        expect(problems.join('\n')).toBe('');
    });

    test('renders correctly in dark theme at desktop and mobile widths', async ({ page }) => {
        const problems = watchConsole(page);
        await page.addInitScript(() => localStorage.setItem('factory.theme', 'dark'));
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
        for (const label of ['Repository', 'Executor']) {
            const box = await page.getByLabel(label).boundingBox();
            expect(box).not.toBeNull();
            expect(box!.height).toBeGreaterThanOrEqual(44);
        }
        await page.screenshot({ path: `${SHOTS}/composer-360-dark.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });

    test('the raw prompt runs as written, and an empty prompt explains the dark Start', async ({ page }) => {
        const problems = watchConsole(page);
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');

        // Fresh page, empty prompt: Start is dark by design and says so.
        const start = page.getByRole('button', { name: 'Start task' });
        await expect(start).toBeDisabled();
        await expect(composer.getByText('Describe the task to continue.')).toBeVisible();
        await expect(composer.locator('.composer-param-error')).toHaveCount(0);

        // The prompt is the only requirement: no process chosen, the member's words are the
        // whole command, and the preflight says exactly that.
        await page.getByLabel('What should the agent do?').fill('fix the login crash');
        await expect(start).toBeEnabled();
        await expect(composer.getByText(/Your prompt will run as written\./)).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/composer-unchosen-raw-prompt.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });

    test('the keyboard path shares the button validation: an empty prompt never queues', async ({ page }) => {
        const problems = watchConsole(page);
        await stubLaunch(page);
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        const request = page.getByLabel('What should the agent do?');

        // The shortcut is the button, never a bypass: an empty prompt sends nothing and says why.
        await request.press('ControlOrMeta+Enter');
        await expect(composer.getByText('Describe the task to continue.')).toBeVisible();
        expect(page.url()).toContain('/tasks/new');

        // A prompt lets the same shortcut queue: the board answers 201 and the page walks
        // straight to the new task.
        await request.fill('fix the login crash');
        await request.press('ControlOrMeta+Enter');
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
        // The panel, not the container: `.dialog-layer` is a zero-height shell with no box to measure.
        await expect(dialog.locator('.dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(prompt).toBeFocused();
        expect(launches.bodies).toHaveLength(0);
    });

    test('Go to Repositories carries the draft there and back', async ({ page }) => {
        await page.unroute('**/api/workspace');
        await mockExecutors(page, [E2E_EXECUTOR_ROW], []);
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
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        await prompt(page).fill('fix the login crash');

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
        });
        expect(launches.bodies[0]).toMatchObject({ workflow: null });
        expect(problems.join('\n')).toBe('');
    });

    test('Cancel in Settings comes back to the same draft', async ({ page }) => {
        await mockExecutors(page, []);
        const launches = countLaunches(page);
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        await prompt(page).fill('tidy the changelog');

        await composer.getByRole('link', { name: 'Add an executor in Settings' }).click();
        await page.getByRole('button', { name: 'Add executor' }).click();
        await page.getByRole('dialog', { name: 'Add executor' }).getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('link', { name: 'Back to new task' }).click();

        await expect(prompt(page)).toHaveValue('tidy the changelog');
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
        // held choice away. Workflows are dormant, so no workflow list is asked for at all.
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
        const workflowReads: string[] = [];
        page.on('request', (request) => {
            const url = new URL(request.url());
            if (url.pathname === '/api/workflows') workflowReads.push(url.search);
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
        expect(workflowReads).toEqual([]);
        expect(problems.join('\n')).toBe('');
    });

    test('a return link to anywhere but the composer is ignored', async ({ page }) => {
        await page.goto('/settings/executors?return=https://evil.example');
        await expect(page.getByRole('heading', { name: 'Executors' })).toBeVisible();
        await expect(page.getByText('You have a task draft in progress.')).toHaveCount(0);
    });
});
