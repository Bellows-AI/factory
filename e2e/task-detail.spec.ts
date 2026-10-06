import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import postgres from 'postgres';
import { E2E_DATABASE_URL } from '../playwright.config.js';
import { withExecutor } from './executor.js';
import {
    authoredBy,
    doneThread,
    failedGateThread,
    followUpThread,
    mockedActivityOf,
    missingSummaryThread,
    multiFollowUpThread,
    nullAuthorThread,
    otherAuthorThread,
    parkedReviewWaitDoneThread,
    parkedReviewWaitThread,
    publishedThread,
    routeThread,
    runningThread,
    sessionAuthor,
    sessionlessThread,
    taskSummaryOf,
    type ThreadJob,
    unsafePrUrlThread,
} from './fixtures/threads.js';

const SHOTS = 'artifacts/ui';
const WIDTHS = [360, 768, 1024, 1440];

/** A literal 'NaN' or 'undefined' is what a missing null guard looks like to a reader. */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

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
    // The guided composer (#176): the prompt is a labelled field, the action is Start task.
    await page.getByLabel('What should the agent do?').fill(command);
    await page.getByRole('button', { name: 'Start task' }).click();
    await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
    return /\/tasks\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
}

/**
 * The board claim, driven the way the driver drives it — the offline board's worker routes are
 * open (AUTH_MODE=none), so the spec can move its own queued task through running and stopped
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
    // queueTask starts through the real composer, which needs an executor to offer Start.
    test.beforeEach(({ page }) => withExecutor(page));

    /**
     * The state matrix, driven through the board's own routes: every not-terminal state offers
     * Stop run; the request in flight and the request landed both read Stopping…; a terminal
     * open task offers Mark done as the one primary; Remove task lives only behind More task
     * actions and vanishes while any member of the thread is running.
     */
    test('Stop run spans queued, running and stopping; Mark done waits behind them', async ({ page }) => {
        const problems = watchConsole(page);

        // Queued: Stop run and the overflow both offered — the board lands queued stops directly.
        await queueTask(page, 'e2e — stop a queued task');
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toBeVisible();
        await expect(header(page).getByRole('button', { name: 'More task actions' })).toBeVisible();
        await expect(page.locator('.page-header-meta')).toContainText('Queued');
        await page.screenshot({ path: `${SHOTS}/task-detail-queued.png`, fullPage: true });

        await header(page).getByRole('button', { name: 'Stop run' }).click();
        await expect(page.locator('.page-header-meta')).toContainText('Stopped · Needs review', { timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeVisible();

        // Running: claimed the way a driver claims. The overflow is gone — a running member
        // hides Remove — and stopping reads as a disabled, busy control.
        const runningId = await queueTask(page, 'e2e — stop a running task');
        const leaseToken = await claimQueued(page, runningId);
        await expect(page.locator('.page-header-meta')).toContainText('Running', { timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toBeVisible();
        await expect(header(page).getByRole('button', { name: 'More task actions' })).toBeHidden();
        await page.screenshot({ path: `${SHOTS}/task-detail-running.png`, fullPage: true });

        await header(page).getByRole('button', { name: 'Stop run' }).click();
        await expect(header(page).getByRole('button', { name: 'Stopping…' })).toBeDisabled({ timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toBeHidden();
        await page.screenshot({ path: `${SHOTS}/task-detail-stopping.png`, fullPage: true });

        // The park still has to land: the worker's suspend carries the stop stamp home.
        const parked = await page.request.post(`/api/jobs/${runningId}/suspend`, { data: { leaseToken } });
        expect(parked.status()).toBe(200);
        expect(((await parked.json()) as { status: string }).status).toBe('stopped');
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeVisible({ timeout: 10_000 });

        for (const token of FORBIDDEN) expect(problems.join('\n'), token).not.toContain(token);
        expect(problems.join('\n')).toBe('');
    });

    test('Mark done closes a task, and the closure reads as attribution, not a disabled control', async ({ page }) => {
        const problems = watchConsole(page);
        await page.goto(`/tasks/${await seededTaskId(page)}`);

        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeVisible();
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toHaveClass(/primary/);
        await page.screenshot({ path: `${SHOTS}/task-detail-open.png`, fullPage: true });

        await header(page).getByRole('button', { name: 'Mark done' }).click();
        // The stand-in account AUTH_MODE=none attributes every action to.
        await expect(header(page).getByText('Closed by __local__')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('.page-header-meta')).toContainText('Done');
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
        await expect(dialog.getByText(/their transcript from Bellows/)).toBeVisible();
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

    test('the remove dialog contains itself and restores its trigger at a narrow phone width', async ({ page }) => {
        const taskId = await seededTaskId(page);
        await page.setViewportSize({ width: 360, height: 844 });
        await page.goto(`/tasks/${taskId}`);

        const trigger = header(page).getByRole('button', { name: 'More task actions' });
        await trigger.click();
        await page.getByRole('menuitem', { name: 'Remove task' }).click();

        // The floating dialog must fit the phone viewport whole — clipped actions are the
        // failure the closeout audit (issue 190) is about — and the page behind it must not
        // grow a second scrollbar because a modal opened.
        const dialog = page.locator('.task-remove');
        await expect(dialog).toBeVisible();
        const box = (await dialog.boundingBox())!;
        expect(box.x, 'dialog left edge').toBeGreaterThanOrEqual(0);
        expect(box.y, 'dialog top edge').toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, 'dialog right edge').toBeLessThanOrEqual(361);
        expect(box.y + box.height, 'dialog bottom edge').toBeLessThanOrEqual(845);
        await page.screenshot({ path: `${SHOTS}/matrix/task-detail_remove-dialog-open_dark_360.png` });

        const overflow = await page.evaluate(() => document.body.scrollWidth - document.body.clientWidth);
        expect(overflow, 'page overflows while the dialog is open').toBeLessThanOrEqual(0);

        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
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

const sql = postgres(E2E_DATABASE_URL, { max: 1 });

/** The seeded org the board's own rows carry — the spec inserts beside them, never into core tables. */
let orgId: string;

test.beforeAll(async () => {
    const [row] = await sql<{ orgId: string }[]>`
        select org_id as "orgId" from job limit 1
    `;
    orgId = row!.orgId;
});

test.afterAll(async () => {
    await sql.end();
});

/** Insert a fixture thread into the real board — every job column the thread read serves back,
 *  except the actor ids (`created_by`, `stopped_by`, `done_by`): only an actor-free fixture
 *  seeds verbatim. */
async function seedThread(jobs: readonly ThreadJob[]) {
    for (const job of jobs) {
        await sql`
            insert into job (org_id, id, root_job_id, parent_job_id, command, status, attempts, max_attempts,
                             claimed_by, session_id, repo, executor, workflow_name, workflow_node, exit_code,
                             output, summary, gates, runtime, wall_clock_ms, done_at, cancel_requested_at,
                             created_at, started_at, finished_at)
            values (${orgId}, ${job.id}, ${job.rootJobId}, ${job.followUpTo}, ${job.command}, ${job.status},
                    ${job.attempts}, ${job.maxAttempts}, ${job.claimedBy}, ${job.sessionId}, ${job.repo},
                    ${job.executor}, ${job.workflowName}, ${job.workflowNode}, ${job.exitCode}, ${job.output},
                    ${job.summary}, ${job.gates ? sql.json(job.gates as never) : null},
                    ${job.runtime ? sql.json(job.runtime as never) : null}, ${job.wallClockMs}, ${job.doneAt},
                    ${job.cancelRequestedAt}, ${job.createdAt}, ${job.startedAt}, ${job.finishedAt})
            on conflict (org_id, id) do nothing
        `;
    }
}

test.describe('the task detail page', () => {
    // The rest of this describe renders the shared fixtures through a mocked thread route; this
    // is what holds them to the board: seeded for real, the thread read answers the fixture back.
    test('the shared thread fixtures are the board’s own payload', async ({ page }) => {
        await seedThread(nullAuthorThread);
        const response = await page.request.get(`/api/jobs/${nullAuthorThread[0]!.id}/thread`);
        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual({ jobs: nullAuthorThread });
    });

    test('a finished thread reads request, response, history, verification, published work', async ({ page }) => {
        const problems = watchConsole(page);
        await routeThread(page, authoredBy(publishedThread, await sessionAuthor(page)));
        await page.goto(`/tasks/${publishedThread[0]!.id}`);

        // The reading order the page exists for: request, then response, then the task's work.
        const conversation = page.locator('.task-conversation');
        const main = page.locator('.task-main');
        await expect(conversation.getByText('Request', { exact: true })).toBeVisible();
        await expect(main.getByRole('heading', { name: 'Run history' })).toBeVisible();
        await expect(main.getByRole('heading', { name: 'Verification' })).toBeVisible();
        await expect(main.getByRole('heading', { name: 'Published work' })).toBeVisible();
        await expect(conversation.getByText('fix #177 please')).toBeVisible();

        // Responses and run history start collapsed; each toggles on its own.
        const response = conversation.locator('.run-response').first();
        const history = page.locator('.run-history');
        await expect(response).not.toHaveAttribute('open', '');
        await expect(history).not.toHaveAttribute('open', '');
        await expect(conversation.getByText('Rebuilt the task detail layout and outcome summary.')).not.toBeVisible();
        await expect(page.locator('.task-history-item').first()).not.toBeVisible();
        await response.getByText(/Agent response/).click();
        await expect(history).not.toHaveAttribute('open', '');
        await history.getByRole('heading', { name: 'Run history' }).click();
        await expect(page.locator('.task-history-item').first()).toBeVisible();
        await expect(conversation.getByText('Rebuilt the task detail layout and outcome summary.')).toBeVisible();

        // The stored summary is the response; the raw output stays collapsed behind it.
        await expect(conversation.getByText('View raw output')).toBeVisible();
        await expect(page.locator('.run-output pre')).not.toBeVisible();

        // The outcome answers "what happened and where" without duplicating the gate output.
        await expect(page.locator('.task-outcome')).toContainText('Verification');
        await expect(page.locator('.task-outcome')).toContainText('1 passed');
        await expect(page.locator('.task-outcome').getByText('all green')).not.toBeVisible();
        // The links are references, not CTAs: the labeled rows carry just the numbers.
        await expect(page.locator('.task-outcome')).toContainText('#9');
        await expect(page.locator('.task-outcome')).toContainText('#177');
        await expect(page.locator('.task-published')).toContainText('Pull request #9');
        await expect(page.locator('.task-published')).toContainText('fix/177');
        for (const token of FORBIDDEN) expect(await page.locator('body').innerText(), token).not.toContain(token);

        // The outcome's checks link lands focus on the verification panel itself.
        await page.getByRole('link', { name: 'View checks' }).click();
        await expect(page.locator('#task-verification')).toBeFocused();

        expect(problems).toEqual([]);
        await page.screenshot({ path: `${SHOTS}/task-detail-rich.png`, fullPage: true });
    });

    test('a follow-up thread labels its runs, verifies the newest, and links the thread PR', async ({ page }) => {
        await routeThread(page, followUpThread);
        await page.goto(`/tasks/${followUpThread[1]!.id}`);

        const conversation = page.locator('.task-conversation');
        await expect(conversation.getByText('Request', { exact: true })).toBeVisible();
        await expect(conversation.getByText('Follow-up', { exact: true })).toBeVisible();
        // Verification is the newest run's: lint failed on run 2.
        await expect(page.locator('#task-verification')).toContainText('lint');
        // The thread's publication came from run 1; the link says what it is.
        await expect(page.locator('.task-published')).toContainText('Pull request #1');
        await expect(page.getByRole('link', { name: 'View checks' })).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/task-detail-thread.png`, fullPage: true });
    });

    test('a finished task without a captured response says so, and offers the composer', async ({ page }) => {
        await routeThread(page, authoredBy(missingSummaryThread, await sessionAuthor(page)));
        await page.goto(`/tasks/${missingSummaryThread[0]!.id}`);
        await expect(page.getByText('finished without a captured agent response')).toBeVisible();
        await expect(page.getByText('Ask for a follow-up')).toBeVisible();
    });

    test('a sessionless terminal run links to a new task, and a closed one renders no composer', async ({ page }) => {
        await routeThread(page, sessionlessThread);
        await page.goto(`/tasks/${sessionlessThread[0]!.id}`);
        const link = page.getByRole('link', { name: 'Start a new task' });
        await expect(link).toBeVisible();
        await link.click();
        await expect(page).toHaveURL(/\/tasks\/new$/);

        await routeThread(page, doneThread);
        await page.goto(`/tasks/${doneThread[0]!.id}`);
        await expect(page.getByText('Ask for a follow-up')).not.toBeVisible();
    });

    test('a failed send preserves the draft, and says why inside the composer', async ({ page }) => {
        await routeThread(page, authoredBy(missingSummaryThread, await sessionAuthor(page)));
        await page.route('**/api/jobs/*/follow-up', (route) => route.abort());
        await page.goto(`/tasks/${missingSummaryThread[0]!.id}`);
        const box = page.getByLabel('Ask for a follow-up');
        await box.fill('try again tomorrow');
        await page.getByRole('button', { name: 'Send follow-up' }).click();
        await expect(page.locator('.composer .status')).toBeVisible();
        await expect(box).toHaveValue('try again tomorrow');
    });

    test('a running run shows its activity and a bounded live output', async ({ page }) => {
        await routeThread(page, runningThread);
        const problems = watchConsole(page);
        await page.goto(`/tasks/${runningThread[0]!.id}`);
        await expect(page.getByText('Agent activity', { exact: true })).toBeVisible();
        await expect(page.locator('.task-conversation').getByText('→ Bash npm test')).toBeVisible();
        await expect(page.locator('.task-conversation pre')).toContainText('step 81 running');

        // The well is genuinely keyboard scrollable: the focusable element IS the scroller, so
        // arrows move the log and not the page. The fixture's output is tall enough to clip.
        const output = page.locator('.task-conversation pre.chat-output');
        await output.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
        });
        const before = await output.evaluate((el) => el.scrollTop);
        expect(before).toBeGreaterThan(0);
        await output.focus();
        await page.keyboard.press('ArrowUp');
        // The scroll animates, so poll rather than read on the keypress's heels.
        await expect.poll(() => output.evaluate((el) => el.scrollTop), { timeout: 2_000 }).toBeLessThan(before);
        expect(problems).toEqual([]);
    });

    test('the detail renders at every target width without overflow', async ({ page }) => {
        test.setTimeout(60_000);
        await routeThread(page, authoredBy(publishedThread, await sessionAuthor(page)));

        for (const width of [360, 768, 1024, 1440]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.goto(`/tasks/${publishedThread[0]!.id}`);
            await expect(page.locator('.task-outcome')).toBeVisible();
            const overflow = await page.evaluate(
                () => document.documentElement.scrollWidth - document.documentElement.clientWidth
            );
            expect(overflow, `${width}px overflows by ${overflow}px`).toBeLessThanOrEqual(0);

            const outcome = await page.locator('.task-outcome').boundingBox();
            const conversation = await page.locator('.task-conversation').boundingBox();
            const railColumns = await page
                .locator('.task-outcome-body')
                .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
            if (width < 1024) {
                // The outcome sits above the conversation, DOM order: a two-column summary, and
                // one column on a phone, where two key/value columns cannot hold a label.
                expect(outcome!.y + outcome!.height).toBeLessThanOrEqual(conversation!.y + 1);
                expect(railColumns, `${width}px rail columns`).toBe(width < 600 ? 1 : 2);
            } else {
                // The main column owns the left and stays the wider one; the rail is 320px.
                expect(conversation!.x).toBeLessThan(outcome!.x);
                expect(conversation!.width).toBeGreaterThan(outcome!.width!);
                expect(Math.round(outcome!.width!)).toBe(320);
                expect(railColumns, `${width}px rail columns`).toBe(1);
            }
            await page.screenshot({ path: `${SHOTS}/task-detail-${width}.png`, fullPage: true });
        }
    });

    test('a parked review wait offers Mark done, never Stop, and closing it reads Done everywhere', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        const me = await sessionAuthor(page);
        await routeThread(page, authoredBy(parkedReviewWaitThread, me));
        await page.goto(`/tasks/${parkedReviewWaitThread[0]!.id}`);

        await expect(page.locator('.page-header-meta')).toContainText('Waiting for review');
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toHaveCount(0);
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeVisible();
        await expect(header(page)).toContainText('No executor is running. The workflow is waiting for review.');
        await expect(header(page)).toContainText('Does not merge or close the pull request.');
        await page.screenshot({ path: `${SHOTS}/task-detail-review-wait.png`, fullPage: true });

        // The board stamps done and leaves the wait row open; the next poll carries both.
        const done = authoredBy(parkedReviewWaitDoneThread, me);
        await page.route('**/api/jobs/*/done', (route) => route.fulfill({ status: 200, json: {} }));
        await routeThread(page, done);
        await header(page).getByRole('button', { name: 'Mark done' }).click();

        await expect(page.locator('.page-header-meta')).toContainText('Done', { timeout: 10_000 });
        await expect(page.locator('.page-header-meta')).not.toContainText('Waiting for review');
        await expect(page.locator('.task-outcome')).toContainText('Done');
        await expect(page.locator('.task-outcome')).not.toContainText('Waiting for review');
        await expect(header(page)).toContainText('Closed by');
        await expect(page.locator('textarea')).toHaveCount(0);
        await expect(page.getByText('can continue this session')).toHaveCount(0);
        await page.screenshot({ path: `${SHOTS}/task-detail-review-wait-done.png`, fullPage: true });

        // The inbox row and the sidebar read the same precedence off the board's summary row.
        const row = taskSummaryOf(done);
        await page.route(/\/api\/tasks(\?|$)/, (route) =>
            route.fulfill({
                json: {
                    navigation: { counts: { running: 0, review: 0, past: 1 }, running: [], review: [] },
                    page: { items: [row], nextCursor: null },
                },
            })
        );
        await page.goto('/tasks?state=past');
        await expect(page.locator('.inbox-row').first()).toContainText('Done');
        await expect(page.locator('.inbox-row').first()).not.toContainText('Waiting for review');
        await expect(page.locator('.sidenav-task', { hasText: row.command })).toHaveCount(0);
        expect(problems.join('\n')).toBe('');
    });

    test('a failed gate opens only its own output, counts only what happened, and asks for another pass', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await routeThread(page, authoredBy(failedGateThread, await sessionAuthor(page)));
        const followUps: string[] = [];
        page.on('request', (request) => {
            if (request.url().endsWith('/follow-up')) followUps.push(request.url());
        });
        await page.goto(`/tasks/${failedGateThread[0]!.id}`);

        await expect(page.locator('.page-header-meta')).toContainText('Failed · Needs review');
        await expect(page.locator('.page-header-meta')).toContainText('Verification failed');

        const verification = page.locator('#task-verification');
        await expect(verification.locator('.task-verification-counts')).toHaveText('1 failed2 passed');
        await expect(verification.locator('details', { hasText: 'lint' })).toHaveAttribute('open', '');
        await expect(verification.locator('details', { hasText: 'build' })).not.toHaveAttribute('open');
        await expect(verification.locator('details', { hasText: 'test' }).first()).not.toHaveAttribute('open');

        // The one long unbroken line scrolls inside its own well, never the page.
        const well = verification.getByLabel('Output of lint').locator('pre');
        expect(await well.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
        await expect(verification.getByRole('button', { name: 'Copy output of lint' })).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/task-detail-gate-failed.png`, fullPage: true });

        // Ask for another pass lands the caret in the composer and sends nothing by itself — from
        // the header and from the rail's next action alike.
        await header(page).getByRole('button', { name: 'Ask for another pass' }).click();
        await expect(page.getByLabel('Ask for a follow-up')).toBeFocused();
        await page.locator('.task-outcome').getByRole('button', { name: 'Ask for another pass' }).click();
        await expect(page.getByLabel('Ask for a follow-up')).toBeFocused();
        expect(followUps).toEqual([]);

        // Mark done and Remove both wait in the overflow.
        await header(page).getByRole('button', { name: 'More task actions' }).click();
        await expect(page.getByRole('menuitem', { name: 'Mark done' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Remove task' })).toBeVisible();
        await page.keyboard.press('Escape');
        expect(problems.join('\n')).toBe('');
    });

    test("another member's task and a null-author task say who can continue, and keep Mark done", async ({ page }) => {
        await routeThread(page, otherAuthorThread);
        await page.goto(`/tasks/${otherAuthorThread[0]!.id}`);
        await expect(
            page.getByText('Only octo-reviewer can continue this session. You can still mark it done.')
        ).toBeVisible();
        await expect(page.locator('textarea')).toHaveCount(0);
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/task-detail-not-author.png`, fullPage: true });

        await routeThread(page, nullAuthorThread);
        await page.goto(`/tasks/${nullAuthorThread[0]!.id}`);
        await expect(page.getByText('Only the task author can continue this session.')).toBeVisible();
        await expect(page.locator('textarea')).toHaveCount(0);
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeVisible();
    });

    test('a multi-follow-up thread lists every recorded fact and links the newest PR', async ({ page }) => {
        await routeThread(page, multiFollowUpThread);
        await page.goto(`/tasks/${multiFollowUpThread[0]!.id}`);
        // Three runs, each created, started and finished — and nothing the board did not stamp.
        await expect(page.locator('.task-history-item')).toHaveCount(9);
        await expect(page.locator('.task-history')).not.toContainText('Implemented');
        await expect(page.locator('.task-history')).not.toContainText('Published');
        await expect(page.locator('.task-published')).toContainText('Pull request #21');
        await expect(page.locator('.task-published')).toContainText('feat/export');
        await page.screenshot({ path: `${SHOTS}/task-detail-multi-follow-up.png`, fullPage: true });
    });

    test('an unsafe PR url is never a link', async ({ page }) => {
        await routeThread(page, unsafePrUrlThread);
        await page.goto(`/tasks/${unsafePrUrlThread[0]!.id}`);
        await expect(page.locator('.task-published')).toContainText('fix/odd');
        await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
        await expect(page.locator('.task-published a')).toHaveCount(0);
    });

    test('an action that resolves after navigating to another task is ignored', async ({ page }) => {
        const problems = watchConsole(page);
        const first = publishedThread;
        const other = authoredBy(missingSummaryThread, await sessionAuthor(page));
        // Every thread but the first answers as a different task — the inbox row clicked below.
        await page.route('**/api/jobs/*/thread*', (route) =>
            route.fulfill({ json: { jobs: route.request().url().includes(first[0]!.id) ? first : other } })
        );
        // The page's run-activity hook (issue #339) fetches beside the thread poll; the mocked
        // thread answers it too, or the real board 404s a task id the fixture only names.
        await page.route('**/api/jobs/*/activity', (route) =>
            route.fulfill({
                json: mockedActivityOf(route.request().url().includes(first[0]!.id) ? first : other),
            })
        );
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.route(`**/api/jobs/${first[0]!.id}/done`, async (route) => {
            await held;
            await route.fulfill({ status: 409, json: { error: 'Task is running', code: 'TASK_RUNNING' } });
        });

        await page.goto(`/tasks/${first[0]!.id}`);
        await header(page).getByRole('button', { name: 'Mark done' }).click();
        await expect(header(page).getByRole('button', { name: 'Marking done…' })).toBeDisabled();

        // Client-side navigation, so the in-flight request outlives the task it was sent for.
        await page.getByRole('link', { name: 'View all tasks' }).click();
        await page.waitForURL(/\/tasks$/);
        await page.locator('.inbox-row a').first().click();
        await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
        await expect(page.getByRole('heading', { level: 1, name: 'seed task' })).toBeVisible();

        const refused = page.waitForResponse(`**/api/jobs/${first[0]!.id}/done`);
        release();
        await refused;
        await expect(page.getByText('Task is running')).toHaveCount(0);
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeEnabled();
        // The 409 is the spec's own doing; the browser logs the refused status itself.
        const real = problems.filter(
            (p) => p !== 'console: Failed to load resource: the server responded with a status of 409 (Conflict)'
        );
        expect(real.join('\n')).toBe('');
    });
});
