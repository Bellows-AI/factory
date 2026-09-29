import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addExecutorViaDialog, countLaunches, mockExecutors } from './executor.js';
import {
    authoredBy,
    failedGateFollowUpThread,
    failedGateThread,
    mockedActivityOf,
    otherAuthorThread,
    parkedReviewWaitMarkedDoneThread,
    parkedReviewWaitRunningThread,
    parkedReviewWaitThread,
    sessionAuthor,
    type ThreadJob,
    taskSummaryOf,
} from './fixtures/threads.js';
import { THEMES, type Theme, VIEWPORTS } from './screenshot-matrix.js';

/**
 * The whole task journey across the merged lanes (#286, F1), in both themes: configure an executor
 * from the composer's blocker and launch once, then the three ways a finished run hands back —
 * (a) a parked review wait closed with Mark done, (b) a failed gate answered with another pass,
 * (c) another author's task, which offers no composer. No executor runs on the open board, so the
 * launch is real and the later states are the #270 fixtures, each branch following one task id.
 */

const SHOTS = 'artifacts/ui/journeys';

// The matrix's desktop width, not the Desktop Chrome device's 1280.
test.use({ viewport: VIEWPORTS[0] });

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

/** Every page of the journey in `theme`: the stored preference and the OS agree, so either wins. */
async function atTheme(page: Page, theme: Theme): Promise<void> {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => localStorage.setItem('factory.theme', t), theme);
}

/** One step of one journey, named `<journey>_<step>_<theme>_<width>` like the baseline gallery. */
async function shoot(page: Page, journey: string, step: string, theme: Theme): Promise<void> {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const width = page.viewportSize()!.width;
    // A full-page shot taken scrolled (focusing the composer scrolls it into view) paints the fixed
    // shell at the scroll offset, mid-image. Scrolling does not move focus, so the step still shows.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
        path: `${SHOTS}/${journey}_${step}_${theme}_${width}.png`,
        fullPage: true,
        animations: 'disabled',
    });
}

/**
 * Serve one task's thread and the task list from the same held jobs, so the detail page, the
 * sidebar and the inbox all read one state and a test moves the task on by reassigning `jobs`.
 * The bucket is the board's own rule (server/src/db/task-summary.ts): a run neither terminal nor
 * parked on an open wait is running; otherwise it is review until marked done, then past.
 */
async function routeTask(page: Page, held: { jobs: ThreadJob[] }): Promise<void> {
    await page.route('**/api/jobs/*/thread*', (route) => route.fulfill({ json: { jobs: held.jobs } }));
    // The page's run-activity hook (issue #339) fetches beside the thread poll; a mocked thread
    // answers it too, or the real board 404s a task id the fixture only names.
    await page.route('**/api/jobs/*/activity', (route) => route.fulfill({ json: mockedActivityOf(held.jobs) }));
    await page.route(/\/api\/tasks(\?|$)/, (route) => {
        const row = taskSummaryOf(held.jobs);
        const terminal =
            ['succeeded', 'failed', 'dead', 'stopped'].includes(row.status) ||
            (row.waitReason !== null && row.waitTerminalReason === null);
        const bucket = terminal ? (row.doneAt === null ? 'review' : 'past') : 'running';
        return route.fulfill({
            json: {
                navigation: {
                    counts: { running: 0, review: 0, past: 0, [bucket]: 1 },
                    running: bucket === 'running' ? [row] : [],
                    review: bucket === 'review' ? [row] : [],
                },
                page: { items: [row], nextCursor: null },
            },
        });
    });
}

const header = (page: Page) => page.locator('.page-header-actions');
const meta = (page: Page) => page.locator('.page-header-meta');
const sidebarRow = (page: Page, id: string) =>
    page.locator(`nav[aria-label="Primary"] .sidenav-task[href="/tasks/${id}"]`);

for (const theme of THEMES) {
    test(`configure an executor from the composer's blocker, return to the draft, and launch once (${theme})`, async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await atTheme(page, theme);
        await mockExecutors(page, []);
        const launches = countLaunches(page);
        const command = `journey: tidy the retry helper (${theme})`;
        const prompt = page.getByLabel('What should the agent do?');
        await page.goto('/tasks/new');

        const composer = page.locator('.composer');
        await prompt.fill(command);
        const banner = composer.locator('.banner-bad');
        await expect(banner).toContainText('No executor configured');
        await shoot(page, 'configure', 'blocked', theme);

        await banner.getByRole('link', { name: 'Add an executor in Settings' }).click();
        await expect(page).toHaveURL(/\/settings\/executors\?return=\/tasks\/new$/);
        await expect(page.getByText('You have a task draft in progress.')).toBeVisible();
        await addExecutorViaDialog(page, 'journey-executor');
        await shoot(page, 'configure', 'settings-return', theme);

        await page.getByRole('link', { name: 'Back to new task' }).click();
        await expect(prompt).toHaveValue(command);
        await expect(page.getByLabel('Executor')).toHaveText('journey-executor');
        await expect(composer.locator('.banner-bad')).toHaveCount(0);
        expect(launches.bodies).toHaveLength(0);
        await shoot(page, 'configure', 'draft-restored', theme);

        await page.getByRole('button', { name: 'Start task' }).click();
        await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
        await expect(meta(page)).toContainText('Queued');
        expect(launches.bodies).toHaveLength(1);
        expect(launches.bodies[0]).toMatchObject({ command, executor: 'journey-executor' });
        await shoot(page, 'configure', 'launched', theme);

        // Leave no claimable task behind: task-detail.spec.ts claims against this same board.
        await header(page).getByRole('button', { name: 'Stop run' }).click();
        await expect(meta(page)).toContainText(/stopped/i, { timeout: 10_000 });
        expect(launches.bodies).toHaveLength(1);
        expect(problems.join('\n')).toBe('');
    });

    test(`running → parked review wait → Mark done reads Done everywhere, with no follow-up offered (${theme})`, async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await atTheme(page, theme);
        const me = await sessionAuthor(page);
        const id = parkedReviewWaitThread[0]!.id;
        const held = { jobs: authoredBy(parkedReviewWaitRunningThread, me) };
        await routeTask(page, held);
        let doneRequests = 0;
        await page.route('**/api/jobs/*/done', (route) => {
            doneRequests += 1;
            held.jobs = authoredBy(parkedReviewWaitMarkedDoneThread, me);
            return route.fulfill({ status: 200, json: {} });
        });
        await page.goto(`/tasks/${id}`);

        await expect(meta(page)).toContainText('Running');
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toBeVisible();
        await expect(sidebarRow(page, id).locator('.sidenav-dot-running')).toBeVisible();
        await shoot(page, 'wait', 'running', theme);

        // The run finishes, publishes and parks on its review wait; the next polls carry it.
        held.jobs = authoredBy(parkedReviewWaitThread, me);
        await expect(meta(page)).toContainText('Waiting for review', { timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toHaveCount(0);
        await expect(header(page)).toContainText('No executor is running. The workflow is waiting for review.');
        await expect(sidebarRow(page, id).locator('.sidenav-dot-paused')).toBeVisible({ timeout: 10_000 });
        await shoot(page, 'wait', 'parked', theme);

        await header(page).getByRole('button', { name: 'Mark done' }).click();
        // Header.
        await expect(meta(page)).toContainText('Done', { timeout: 10_000 });
        await expect(meta(page)).not.toContainText('Waiting for review');
        await expect(header(page)).toContainText(`Closed by ${me.login}`);
        // Rail.
        await expect(page.locator('.task-outcome')).toContainText('Done');
        await expect(page.locator('.task-outcome')).not.toContainText('Waiting for review');
        // Sidebar: a closed task leaves the preview, and nothing else is open.
        await expect(sidebarRow(page, id)).toHaveCount(0, { timeout: 10_000 });
        await expect(page.locator('nav[aria-label="Primary"] summary.sidenav-section')).toHaveText('All caught up');
        // No follow-up offered.
        await expect(page.locator('.task-follow-up')).toHaveCount(0);
        await expect(page.locator('textarea')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Ask for another pass' })).toHaveCount(0);
        expect(doneRequests).toBe(1);
        await shoot(page, 'wait', 'done', theme);

        // Inbox row: the closed task is past, reads Done and wears the done dot.
        await page.goto('/tasks?state=past');
        const row = page.locator('.inbox-row', { hasText: parkedReviewWaitThread[0]!.command });
        await expect(row.locator('.inbox-state .pill')).toHaveText('Done');
        await expect(row.locator('.sidenav-dot-done')).toBeVisible();
        await expect(row).not.toContainText('Waiting for review');
        await shoot(page, 'wait', 'inbox-done', theme);
        expect(problems.join('\n')).toBe('');
    });

    test(`a failed gate opens expanded, Ask for another pass focuses the composer, and the follow-up is sent (${theme})`, async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await atTheme(page, theme);
        const me = await sessionAuthor(page);
        const followUp = failedGateFollowUpThread[1]!;
        const held = { jobs: authoredBy(failedGateThread, me) };
        await routeTask(page, held);
        const sent: unknown[] = [];
        await page.route('**/api/jobs/*/follow-up', (route) => {
            sent.push(route.request().postDataJSON());
            held.jobs = authoredBy(failedGateFollowUpThread, me);
            return route.fulfill({ status: 201, json: { id: followUp.id } });
        });
        await page.goto(`/tasks/${failedGateThread[0]!.id}`);

        await expect(meta(page)).toContainText('Failed · Needs review');
        await expect(meta(page)).toContainText('Verification failed');
        const verification = page.locator('#task-verification');
        await expect(verification.locator('details', { hasText: 'lint' })).toHaveAttribute('open', '');
        await expect(verification.locator('details', { hasText: 'build' })).not.toHaveAttribute('open');
        await shoot(page, 'failed-gate', 'expanded', theme);

        await header(page).getByRole('button', { name: 'Ask for another pass' }).click();
        const box = page.getByLabel('Ask for a follow-up');
        await expect(box).toBeFocused();
        expect(sent).toEqual([]);
        await shoot(page, 'failed-gate', 'composer-focused', theme);

        // Typed, not filled: the keystrokes land only if the caret really is in the composer.
        await page.keyboard.type(followUp.command);
        await expect(box).toHaveValue(followUp.command);
        await page.getByRole('button', { name: 'Send follow-up' }).click();

        await expect(page.locator('.task-conversation')).toContainText(followUp.command, { timeout: 10_000 });
        await expect(page.locator('.task-conversation').getByText('Follow-up', { exact: true })).toBeVisible();
        await expect(meta(page)).toContainText('Queued');
        // The head is queued now, so there is nothing to follow up yet.
        await expect(box).toHaveCount(0);
        expect(sent).toEqual([{ command: followUp.command }]);
        await shoot(page, 'failed-gate', 'follow-up-sent', theme);
        expect(problems.join('\n')).toBe('');
    });

    test(`another author's task explains the refusal and renders no composer (${theme})`, async ({ page }) => {
        const problems = watchConsole(page);
        await atTheme(page, theme);
        await routeTask(page, { jobs: otherAuthorThread });
        await page.goto(`/tasks/${otherAuthorThread[0]!.id}`);

        await expect(
            page.getByText('Only octo-reviewer can continue this session. You can still mark it done.')
        ).toBeVisible();
        await expect(page.locator('textarea')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Send follow-up' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Ask for another pass' })).toHaveCount(0);
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeVisible();
        await shoot(page, 'other-author', 'refusal', theme);
        expect(problems.join('\n')).toBe('');
    });
}
