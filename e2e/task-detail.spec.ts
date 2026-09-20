import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * The task detail page against real board rows. Two state tiers, stated plainly:
 *
 * - DB tier: threads inserted here, mirroring the seed's insert shape, into the same disposable
 *   factory_e2e the chromium project boots against. Every durable state a reader meets — a
 *   finished run with a summary, a run without one, a sessionless run, a closed task — seeds
 *   cleanly because terminal rows never change again.
 * - Route tier: `running` cannot be seeded (nothing executes here, and a seeded running row's
 *   poll would chase a driver that does not exist), so the transient states are served by
 *   intercepting the thread read — the same JSON the board serves, held still.
 */
const SHOTS = 'artifacts/ui';
const DB_HOST = process.env.E2E_DB_HOST ?? '127.0.0.1';
/** A literal 'NaN' or 'undefined' is what a missing null guard looks like to a reader. */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

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
                ${run.gates ? sql.json(run.gates) : null},
                ${run.runtime ? sql.json(run.runtime) : null},
                ${run.wallClockMs ?? null}, ${run.doneAt ?? null},
                ${at}, ${at}, ${at})
        on conflict (org_id, id) do nothing
    `;
}

function watchConsole(page: Page): string[] {
    const problems: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
        if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    return problems;
}

test.describe('the task detail page', () => {
    const ROOT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
    const FOLLOW_ID = 'aaaaaaaa-0000-4000-8000-000000000002';

    test('a finished thread reads request, response, checks, published work, metadata', async ({ page }) => {
        const problems = watchConsole(page);
        await seedRun(orgId, {
            id: ROOT_ID,
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
        await page.goto(`/tasks/${ROOT_ID}`);

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
        await expect(page.locator('.task-outcome')).toContainText('Open pull request');
        await expect(page.locator('.task-outcome')).toContainText('Open issue #177');
        for (const token of FORBIDDEN) expect(await page.locator('body').innerText(), token).not.toContain(token);

        // The outcome's checks link lands focus on the run's own verification region.
        await page.getByRole('link', { name: 'View checks in run 1' }).click();
        await expect(page.locator('#run-1-checks')).toBeFocused();

        expect(problems).toEqual([]);
        await page.screenshot({ path: `${SHOTS}/task-detail-rich.png`, fullPage: true });
    });

    test('a follow-up thread labels its runs and attaches work to each', async ({ page }) => {
        await seedRun(orgId, {
            id: ROOT_ID,
            command: 'root command',
            sessionId: 'bbbbbbbb-0000-4000-8000-000000000001',
            exitCode: 0,
            summary: 'First pass done.',
            output: '[driver] published fix/1 — https://github.com/acme/widgets/pull/1',
        }, '2026-09-01T12:00:00Z');
        await seedRun(orgId, {
            id: FOLLOW_ID,
            parentJobId: ROOT_ID,
            command: 'follow-up command',
            sessionId: 'bbbbbbbb-0000-4000-8000-000000000002',
            exitCode: 0,
            summary: 'Adjustment applied.',
            gates: [{ name: 'lint', status: 'failed', exitCode: 1, output: 'nope' }],
        }, '2026-09-01T12:30:00Z');
        await page.goto(`/tasks/${FOLLOW_ID}`);

        const conversation = page.locator('.task-conversation');
        await expect(conversation.getByText('Request', { exact: true })).toBeVisible();
        await expect(conversation.getByText('Follow-up', { exact: true })).toBeVisible();
        // Gates ride the run that produced them: lint failed on run 2, not run 1.
        await expect(page.locator('#run-2-checks')).toContainText('lint');
        await expect(page.locator('#run-1-checks')).toContainText('Open pull request');
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
                output: 'step one ok\nstep two ok\nstep three running',
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
                remoteSessionId: null,
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
        await expect(page.locator('.task-conversation pre')).toContainText('step three running');
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
