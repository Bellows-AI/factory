import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';
import postgres from 'postgres';

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
    /**
     * The state matrix, driven through the board's own routes: every not-terminal state offers
     * Stop run; the request in flight and the request landed both read Stopping…; a terminal
     * open task offers Mark done as the one primary; Remove task lives only behind More task
     * actions and vanishes while any member of the thread is running.
     */
    test('Stop run spans queued, running and stopping; Mark done waits behind them', async ({
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

    test('the remove dialog contains itself and restores its trigger at a narrow phone width', async ({
        page,
    }) => {
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

        const overflow = await page.evaluate(
            () => document.body.scrollWidth - document.body.clientWidth
        );
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

const DB_HOST = process.env.E2E_DB_HOST ?? '127.0.0.1';

const sql = postgres(`postgres://factory:factory@${DB_HOST}:5432/factory_e2e`, { max: 1 });

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

interface SeedRun {
    id: string;
    command: string;
    parentJobId?: string;
    status?: 'succeeded' | 'failed' | 'running';
    exitCode?: number | null;
    output?: string | null;
    summary?: string | null;
    sessionId?: string | null;
    repo?: string | null;
    executor?: string | null;
    workflowNode?: string | null;
    gates?: unknown;
    runtime?: unknown;
    wallClockMs?: number | null;
    doneAt?: string | null;
}

/** Insert one run of a thread, the seed's shape plus the finished-run columns the detail reads. */
async function seedRun(orgIdLocal: string, run: SeedRun, at: string) {
    await sql`
        insert into job (org_id, id, root_job_id, parent_job_id, command, status, session_id,
                         repo, executor, workflow_node, exit_code, output, summary, gates, runtime,
                         wall_clock_ms, done_at, created_at, started_at, finished_at)
        values (${orgIdLocal}, ${run.id}, ${run.parentJobId ? run.parentJobId : run.id},
                ${run.parentJobId ?? null}, ${run.command}, ${run.status ?? 'succeeded'},
                ${run.sessionId ?? null}, ${run.repo ?? null}, ${run.executor ?? null},
                ${run.workflowNode ?? null}, ${run.exitCode ?? null}, ${run.output ?? null},
                ${run.summary ?? null},
                ${run.gates ? sql.json(run.gates as never) : null},
                ${run.runtime ? sql.json(run.runtime as never) : null},
                ${run.wallClockMs ?? null}, ${run.doneAt ?? null},
                ${at}, ${at}, ${at})
        on conflict (org_id, id) do nothing
    `;
}

test.describe('the task detail page', () => {
    test('a finished thread reads request, response, checks, published work, metadata', async ({ page }) => {
        const problems = watchConsole(page);
        await seedRun(orgId, {
            id: 'aaaaaaaa-0000-4000-8000-000000000001',
            command: 'fix #177 please',
            repo: 'acme/widgets',
            executor: 'main',
            exitCode: 0,
            summary: 'Rebuilt the task detail layout and outcome summary.',
            output: 'hunk 1 applied\n[driver] published fix/177 — https://github.com/acme/widgets/pull/9',
            sessionId: 'bbbbbbbb-0000-4000-8000-000000000001',
            gates: [{ name: 'test', status: 'passed', exitCode: 0, output: 'all green' }],
            runtime: {
                cpuPercent: null,
                memUsedMb: null,
                memPercent: null,
                activity: null,
                sampledAt: '2026-09-01T12:02:00.000Z',
                contextTokens: 30_433,
                costUsd: 0.01,
            },
            wallClockMs: 1_800_000,
        }, '2026-09-01T12:00:00Z');
        await page.goto('/tasks/aaaaaaaa-0000-4000-8000-000000000001');

        // The reading order the page exists for: request, then response, then the run's work.
        const conversation = page.locator('.task-conversation');
        await expect(conversation.getByText('Request', { exact: true })).toBeVisible();
        await expect(conversation.getByText('Agent response', { exact: true })).toBeVisible();
        await expect(conversation.getByText('Checks and published work', { exact: true })).toBeVisible();
        await expect(conversation.getByText('fix #177 please')).toBeVisible();
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
        await expect(conversation).toContainText('Pull request #9');
        for (const token of FORBIDDEN) expect(await page.locator('body').innerText(), token).not.toContain(token);

        // The outcome's checks link lands focus on the run's own verification region.
        await page.getByRole('link', { name: 'View checks in run 1' }).click();
        await expect(page.locator('#run-1-checks')).toBeFocused();

        expect(problems).toEqual([]);
        await page.screenshot({ path: `${SHOTS}/task-detail-rich.png`, fullPage: true });
    });

    test('a follow-up thread labels its runs and attaches work to each', async ({ page }) => {
        await seedRun(orgId, {
            id: 'aaaaaaaa-0000-4000-8000-000000000011',
            command: 'root command',
            sessionId: 'bbbbbbbb-0000-4000-8000-000000000011',
            exitCode: 0,
            summary: 'First pass done.',
            output: '[driver] published fix/1 — https://github.com/acme/widgets/pull/1',
        }, '2026-09-01T12:00:00Z');
        await seedRun(orgId, {
            id: 'aaaaaaaa-0000-4000-8000-000000000012',
            parentJobId: 'aaaaaaaa-0000-4000-8000-000000000011',
            command: 'follow-up command',
            sessionId: 'bbbbbbbb-0000-4000-8000-000000000012',
            exitCode: 0,
            summary: 'Adjustment applied.',
            gates: [{ name: 'lint', status: 'failed', exitCode: 1, output: 'nope' }],
        }, '2026-09-01T12:30:00Z');
        await page.goto('/tasks/aaaaaaaa-0000-4000-8000-000000000012');

        const conversation = page.locator('.task-conversation');
        await expect(conversation.getByText('Request', { exact: true })).toBeVisible();
        await expect(conversation.getByText('Follow-up', { exact: true })).toBeVisible();
        // Gates ride the run that produced them: lint failed on run 2, not run 1.
        await expect(page.locator('#run-2-checks')).toContainText('lint');
        // The run's publication line has no label of its own, so the link says what it is.
        await expect(page.locator('#run-1-checks')).toContainText('Pull request #1');
        await expect(page.getByRole('link', { name: 'View checks in run 2' })).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/task-detail-thread.png`, fullPage: true });
    });

    test('a finished task without a captured response says so, and offers the composer', async ({ page }) => {
        await seedRun(orgId, {
            id: 'aaaaaaaa-0000-4000-8000-000000000003',
            command: 'seed task',
            sessionId: 'bbbbbbbb-0000-4000-8000-000000000003',
            exitCode: 0,
        }, '2026-09-01T12:00:00Z');
        await page.goto('/tasks/aaaaaaaa-0000-4000-8000-000000000003');
        await expect(page.getByText('finished without a captured agent response')).toBeVisible();
        await expect(page.getByText('Ask for a follow-up')).toBeVisible();
    });

    test('a sessionless terminal run links to a new task, and a closed one renders no composer', async ({ page }) => {
        await seedRun(orgId, {
            id: 'aaaaaaaa-0000-4000-8000-000000000004',
            command: 'sessionless task',
            sessionId: null,
            exitCode: 0,
        }, '2026-09-01T12:00:00Z');
        await page.goto('/tasks/aaaaaaaa-0000-4000-8000-000000000004');
        const link = page.getByRole('link', { name: 'Start a new task' });
        await expect(link).toBeVisible();
        await link.click();
        await expect(page).toHaveURL(/\/tasks\/new$/);

        await seedRun(orgId, {
            id: 'aaaaaaaa-0000-4000-8000-000000000005',
            command: 'closed task',
            sessionId: 'bbbbbbbb-0000-4000-8000-000000000005',
            exitCode: 0,
            doneAt: '2026-09-01T13:00:00Z',
        }, '2026-09-01T12:00:00Z');
        await page.goto('/tasks/aaaaaaaa-0000-4000-8000-000000000005');
        await expect(page.getByText('Ask for a follow-up')).not.toBeVisible();
    });

    test('a failed send preserves the draft', async ({ page }) => {
        await seedRun(orgId, {
            id: 'aaaaaaaa-0000-4000-8000-000000000006',
            command: 'draft task',
            sessionId: 'bbbbbbbb-0000-4000-8000-000000000006',
            exitCode: 0,
        }, '2026-09-01T12:00:00Z');
        await page.route('**/api/jobs/*/follow-up', (route) => route.abort());
        await page.goto('/tasks/aaaaaaaa-0000-4000-8000-000000000006');
        const box = page.getByLabel('Ask for a follow-up');
        await box.fill('try again tomorrow');
        await page.getByRole('button', { name: 'Send follow-up' }).click();
        await expect(page.locator('.status')).toBeVisible();
        await expect(box).toHaveValue('try again tomorrow');
    });

    test('a running run shows its activity and a bounded live output', async ({ page }) => {
        const runningJobs = [
            {
                id: 'aaaaaaaa-0000-4000-8000-000000000007',
                command: 'watch me run',
                status: 'running',
                attempts: 1,
                author: null,
                stoppedBy: null,
                doneBy: null,
                exitCode: null,
                output: `${Array.from({ length: 80 }, (_, i) => `step ${i + 1} ok`).join('\n')}\nstep 81 running`,
                summary: null,
                repo: null,
                executor: 'main',
                workflowName: null,
                workflowNode: null,
                followUpTo: null,
                rootJobId: 'aaaaaaaa-0000-4000-8000-000000000007',
                doneAt: null,
                cancelRequestedAt: null,
                workspacePath: null,
                createdAt: '2026-09-01T12:00:00Z',
                startedAt: '2026-09-01T12:00:01Z',
                finishedAt: null,
                wallClockMs: null,
                taskWallClockMs: null,
                sessionId: 'bbbbbbbb-0000-4000-8000-000000000007',
                gates: null,
                runtime: {
                    cpuPercent: 12,
                    memUsedMb: 300,
                    memPercent: 2,
                    activity: '→ Bash npm test',
                    sampledAt: '2026-09-01T12:02:00Z',
                },
            },
        ];
        await page.route('**/api/jobs/*/thread*', (route) =>
            route.fulfill({ json: { jobs: runningJobs } }),
        );
        const problems = watchConsole(page);
        await page.goto('/tasks/aaaaaaaa-0000-4000-8000-000000000007');
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
        await expect
            .poll(() => output.evaluate((el) => el.scrollTop), { timeout: 2_000 })
            .toBeLessThan(before);
        expect(problems).toEqual([]);
    });

    test('the detail renders at every target width without overflow', async ({ page }) => {
        test.setTimeout(60_000);
        await seedRun(orgId, {
            id: 'aaaaaaaa-0000-4000-8000-000000000008',
            command: 'responsive task with a fairly long command line to exercise wrapping',
            repo: 'acme/widgets',
            executor: 'main',
            exitCode: 0,
            summary: 'Done, responsively.',
            output: '[driver] published fix/9 — https://github.com/acme/widgets/pull/9',
            sessionId: 'bbbbbbbb-0000-4000-8000-000000000008',
            gates: [{ name: 'test', status: 'passed', exitCode: 0, output: 'ok' }],
            runtime: {
                cpuPercent: null,
                memUsedMb: null,
                memPercent: null,
                activity: null,
                sampledAt: '2026-09-01T12:02:00.000Z',
                contextTokens: 30_433,
                costUsd: 0.01,
            },
            wallClockMs: 1_800_000,
        }, '2026-09-01T12:00:00Z');

        for (const width of [360, 768, 1024, 1440]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.goto('/tasks/aaaaaaaa-0000-4000-8000-000000000008');
            await expect(page.locator('.task-outcome')).toBeVisible();
            const overflow = await page.evaluate(
                () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow, `${width}px overflows by ${overflow}px`).toBeLessThanOrEqual(0);

            const outcome = await page.locator('.task-outcome').boundingBox();
            const conversation = await page.locator('.task-conversation').boundingBox();
            if (width < 1024) {
                // The outcome sits above the conversation, one column, disclosure first.
                expect(outcome!.y + outcome!.height).toBeLessThanOrEqual(conversation!.y + 1);
            } else {
                // The conversation owns the left column and stays the wider one; the outcome
                // is bounded (its column is fixed, the conversation takes the rest).
                expect(conversation!.x).toBeLessThan(outcome!.x);
                expect(conversation!.width).toBeGreaterThan(outcome!.width!);
                expect(outcome!.width!).toBeLessThan(400);
            }
            await page.screenshot({ path: `${SHOTS}/task-detail-${width}.png`, fullPage: true });
        }
    });
});
