import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const SHOTS = 'artifacts/ui';
const WIDTHS = [360, 768, 1024, 1440];

/** A literal 'NaN' or 'undefined' is what a missing null guard looks like to a reader. */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity'];

/** Console errors, page errors and failed requests are all failures — collected, asserted once. */
function watchConsole(page: Page): string[] {
    const problems: string[] = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
    return problems;
}

/** Queue a task through the real composer and land on its detail page. */
async function queueTask(page: Page, command: string): Promise<string> {
    await page.goto('/tasks/new');
    await page.getByPlaceholder('Describe the task…').fill(command);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
    return /\/tasks\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
}

/**
 * The board claim, driven the way the driver drives it — the offline board's worker routes are
 * open (AUTH_MODE=none), so the spec can move its own queued task through running and standby
 * the same hands a real worker would.
 */
async function claimQueued(page: Page, taskId: string): Promise<string> {
    const response = await page.request.post('/api/jobs/claim', {
        data: { worker: 'e2e-task-detail', leaseSeconds: 300 },
    });
    expect(response.status(), 'the spec\u2019s own queued task is the only one claimable').toBe(200);
    const body = (await response.json()) as { id: string; leaseToken: string };
    expect(body.id).toBe(taskId);
    return body.leaseToken;
}

/** A seeded task — terminal, never marked done — from the summary read model. The seed's
 * command is 'seed task'; the spec's own queued tasks must never be mistaken for one. */
async function seededTaskId(page: Page, not?: string): Promise<string> {
    const response = await page.request.get('/api/tasks');
    const body = (await response.json()) as {
        page: { items: { id: string; command: string; doneAt: string | null }[] };
    };
    const open = body.page.items.find(
        (task) => task.doneAt === null && task.command === 'seed task' && task.id !== not
    );
    expect(open, 'the seed leaves succeeded tasks open').toBeTruthy();
    return open!.id;
}

/** The task's whole chain, the way the dialog counts it. */
async function threadLength(page: Page, taskId: string): Promise<number> {
    const response = await page.request.get(`/api/jobs/${taskId}/thread`);
    return ((await response.json()) as { jobs: unknown[] }).jobs.length;
}

const header = (page: Page) => page.locator('.page-header-actions');

test.describe('the task detail actions', () => {
    /**
     * The state matrix, driven through the board's own routes: every not-terminal state offers
     * Stop run; the request in flight and the request landed both read Stopping…; a terminal
     * open task offers Mark done as the one primary; Remove task lives only behind More task
     * actions and vanishes while any member of the thread is running.
     */
    test('Stop run spans queued, running, stopping and standby; Mark done waits behind them', async ({
        page,
    }) => {
        const problems = watchConsole(page);

        // Queued: Stop run and the overflow both offered — the board lands queued stops directly.
        const queuedId = await queueTask(page, 'e2e — stop a queued task');
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toBeVisible();
        await expect(header(page).getByRole('button', { name: 'More task actions' })).toBeVisible();
        await expect(page.locator('.page-header-meta')).toContainText('queued');
        await page.screenshot({ path: `${SHOTS}/task-detail-queued.png`, fullPage: true });

        await header(page).getByRole('button', { name: 'Stop run' }).click();
        await expect(page.locator('.page-header-meta')).toContainText('stopped', { timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeVisible();

        // Running: claimed the way a driver claims. The overflow is gone — a running member
        // hides Remove — and stopping reads as a status, never a control.
        const runningId = await queueTask(page, 'e2e — stop a running task');
        const leaseToken = await claimQueued(page, runningId);
        await expect(page.locator('.page-header-meta')).toContainText('running', { timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toBeVisible();
        await expect(header(page).getByRole('button', { name: 'More task actions' })).toBeHidden();
        await page.screenshot({ path: `${SHOTS}/task-detail-running.png`, fullPage: true });

        await header(page).getByRole('button', { name: 'Stop run' }).click();
        await expect(header(page).getByText('Stopping…')).toBeVisible({ timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toBeHidden();
        await page.screenshot({ path: `${SHOTS}/task-detail-stopping.png`, fullPage: true });

        // The park still has to land: the worker's suspend carries the stop stamp home.
        const parked = await page.request.post(`/api/jobs/${runningId}/suspend`, { data: { leaseToken } });
        expect(parked.status()).toBe(200);
        expect(((await parked.json()) as { status: string }).status).toBe('stopped');
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeVisible({ timeout: 10_000 });

        // Standby: a park nobody asked for. Stop run is offered for it too, and lands directly.
        const standbyId = await queueTask(page, 'e2e — stop a standby task');
        const idleLease = await claimQueued(page, standbyId);
        const idled = await page.request.post(`/api/jobs/${standbyId}/suspend`, { data: { leaseToken: idleLease } });
        expect(((await idled.json()) as { status: string }).status).toBe('standby');
        await expect(page.locator('.page-header-meta')).toContainText('standby', { timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toBeVisible();
        await expect(header(page).getByRole('button', { name: 'More task actions' })).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/task-detail-standby.png`, fullPage: true });

        await header(page).getByRole('button', { name: 'Stop run' }).click();
        await expect(page.locator('.page-header-meta')).toContainText('stopped', { timeout: 10_000 });

        for (const token of FORBIDDEN) expect(problems.join('\n'), token).not.toContain(token);
        expect(problems.join('\n')).toBe('');
    });

    test('Mark done closes a task, and the closure reads as attribution, not a disabled control', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await page.goto(`/tasks/${await seededTaskId(page)}`);

        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeVisible();
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toHaveClass(/primary/);
        await page.screenshot({ path: `${SHOTS}/task-detail-open.png`, fullPage: true });

        await header(page).getByRole('button', { name: 'Mark done' }).click();
        // The stand-in account AUTH_MODE=none attributes every action to.
        await expect(header(page).getByText('Done by __local__')).toBeVisible({ timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeHidden();
        await expect(header(page).locator('button[disabled]')).toHaveCount(0);
        await page.screenshot({ path: `${SHOTS}/task-detail-done.png`, fullPage: true });

        for (const token of FORBIDDEN) expect(problems.join('\n'), token).not.toContain(token);
        expect(problems.join('\n')).toBe('');
    });

    test('the remove dialog: keyboard path, initial focus, focus restoration, refusal, and the route out', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        const taskId = await seededTaskId(page);
        await page.goto(`/tasks/${taskId}`);

        const trigger = header(page).getByRole('button', { name: 'More task actions' });
        // The dialog's layer wrapper is a zero-height positioning context — visibility reads on
        // the panel that floats inside it.
        const dialog = page.locator('.task-remove');

        // Keyboard open, exactly one destructive item, no Remove anywhere in the action row.
        await trigger.click();
        const item = page.getByRole('menuitem', { name: 'Remove task' });
        await expect(item).toBeVisible();
        expect(await header(page).getByRole('button', { name: 'Remove task' }).count()).toBe(0);

        // Escape closes the menu and hands focus back to its trigger.
        await page.keyboard.press('Escape');
        await expect(item).toBeHidden();
        await expect(trigger).toBeFocused();

        await trigger.click();
        await item.click();

        // The dialog names the task and every consequence — with the thread's REAL run count —
        // and Cancel holds the initial focus, so the destructive answer is never the first
        // thing a keypress reaches.
        const runs = await threadLength(page, taskId);
        await expect(dialog).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Remove \u201Cseed task\u201D?' })).toBeVisible();
        await expect(dialog.getByText(new RegExp(`This permanently deletes all ${runs} runs`))).toBeVisible();
        await expect(dialog.getByText(/their transcript from Factory/)).toBeVisible();
        await expect(dialog.getByText(/worktree will be queued for deletion/)).toBeVisible();
        await expect(dialog.getByText(/Published branches and pull requests are not deleted/)).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
        await page.screenshot({ path: `${SHOTS}/task-remove-dialog.png`, fullPage: true });

        // The backdrop closes it too, focus landing on the trigger.
        await page.mouse.click(10, 500);
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();

        // Escape and Cancel each close it, focus landing on the trigger both times.
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();

        await trigger.click();
        await page.getByRole('menuitem', { name: 'Remove task' }).click();
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
        await expect(page).toHaveURL(new RegExp(`${taskId}$`));

        // The board's refusal stays authoritative: fed a 409, the dialog holds its place, the
        // reason is announced once as an alert, and the page stays usable.
        await page.route(`**/api/jobs/${taskId}/remove`, (route) =>
            route.fulfill({
                status: 409,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'Task is running', code: 'TASK_RUNNING' }),
            })
        );
        await trigger.click();
        await page.getByRole('menuitem', { name: 'Remove task' }).click();
        await dialog.getByRole('button', { name: 'Remove task' }).click();
        await expect(dialog.getByRole('alert')).toContainText('Task is running');
        await expect(dialog).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/task-remove-refused.png`, fullPage: true });
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
        await page.unroute(`**/api/jobs/${taskId}/remove`);

        // A route-id change is a different conversation: a refusal earned on one task must not
        // haunt the next one's dialog. The modal holds the page while open, so the jump happens
        // after Cancel — the reset the page's id effect performs is what the fresh dialog proves.
        await page.getByRole('link', { name: 'View all tasks' }).click();
        await page.waitForURL(/\/tasks$/);
        await page.locator('.inbox-row a').first().click();
        await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
        await trigger.click();
        await page.getByRole('menuitem', { name: 'Remove task' }).click();
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('alert')).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: 'Remove task' })).toBeEnabled();
        await dialog.getByRole('button', { name: 'Cancel' }).click();

        // The real removal: in flight the dialog cannot be dismissed — Escape included — and
        // the inbox is where the route ends.
        const currentId = /\/tasks\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
        await page.route(`**/api/jobs/${currentId}/remove`, async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            await route.continue();
        });
        await trigger.click();
        await page.getByRole('menuitem', { name: 'Remove task' }).click();
        await dialog.getByRole('button', { name: 'Remove task' }).click();
        await expect(dialog.getByRole('button', { name: 'Removing\u2026' })).toBeDisabled();
        await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeVisible();
        await page.mouse.click(10, 500);
        await expect(dialog).toBeVisible();
        await expect(page).toHaveURL(/\/tasks$/, { timeout: 10_000 });
        await page.screenshot({ path: `${SHOTS}/task-removed-inbox.png`, fullPage: true });

        for (const token of FORBIDDEN) expect(problems.join('\n'), token).not.toContain(token);
        // The 409 the spec feeds the remove request is the test's own doing — the browser logs
        // the refused status itself, and the app's handling of it is what the assertions above
        // verified. It is the one console line this flow may produce.
        const real = problems.filter(
            (p) => p !== 'console: Failed to load resource: the server responded with a status of 409 (Conflict)'
        );
        expect(real.join('\n')).toBe('');
    });

    test('no page-level horizontal overflow at any target width', async ({ page }) => {
        const problems = watchConsole(page);
        const detail = `/tasks/${await seededTaskId(page)}`;

        for (const width of WIDTHS) {
            await page.setViewportSize({ width, height: 1000 });
            for (const path of [detail, '/tasks/new']) {
                await page.goto(path);
                await expect(page.locator('.page-header')).toBeVisible();
                const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
                const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
                expect(scrollWidth, `${path} overflows at ${width}px`).toBeLessThanOrEqual(clientWidth);
                const slug = path === detail ? 'detail' : 'composer';
                await page.screenshot({ path: `${SHOTS}/width-${width}-${slug}.png`, fullPage: true });
            }
        }

        for (const token of FORBIDDEN) expect(problems.join('\n'), token).not.toContain(token);
        expect(problems.join('\n')).toBe('');
    });
});
