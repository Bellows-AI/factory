import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import postgres from 'postgres';
import { E2E_DATABASE_URL } from '../playwright.config.js';

/**
 * An agent's question in the task conversation, against the real board: seeded through the
 * database like the other task-detail specs, answered through the real answer route as the
 * AUTH_MODE=none stand-in member, `Local`. Every state is screenshotted in both themes.
 */

const SHOTS = 'artifacts/ui';
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

const sql = postgres(E2E_DATABASE_URL, { max: 1 });
let orgId: string;

test.beforeAll(async () => {
    const [row] = await sql<{ orgId: string }[]>`select org_id as "orgId" from job limit 1`;
    orgId = row!.orgId;
});

test.afterAll(async () => {
    await sql.end();
});

const DATABASE = {
    question: 'Which database should the cache use?',
    header: 'Database',
    multiSelect: false,
    options: [
        { label: 'Postgres', description: 'Already running beside the board' },
        { label: 'SQLite', description: 'One file, no server' },
    ],
};

interface Seed {
    /** The job's status: `running` holds the lease the question was asked under. */
    status: 'running' | 'succeeded';
    state?: 'pending' | 'expired';
}

/**
 * One task with one question. A running job's lease never expires inside the run, so nothing
 * claims it; a succeeded job's pending question is the board's `closed`. Ids are fresh per seed.
 */
async function seedQuestion({ status, state = 'pending' }: Seed): Promise<string> {
    const id = crypto.randomUUID();
    const lease = crypto.randomUUID();
    const running = status === 'running';
    await sql`
        insert into job (org_id, id, root_job_id, command, status, attempts, lease_token, lease_expires_at,
                         started_at, finished_at, exit_code, summary)
        values (${orgId}, ${id}, ${id}, ${`pick a cache database ${id.slice(0, 8)}`}, ${status}, 1,
                ${running ? lease : null}, now() + interval '1 day', now(),
                ${running ? null : sql`now()`}, ${running ? null : 0},
                ${running ? null : 'Went with the default.'})
    `;
    await sql`
        insert into job_question (org_id, job_id, question_id, attempt, lease_token, questions, state)
        values (${orgId}, ${id}, ${`toolu_${id.slice(0, 8)}`}, 1, ${lease}, ${sql.json([DATABASE] as never)},
                ${state})
    `;
    return id;
}

async function open(page: Page, id: string, theme: Theme = 'light'): Promise<Locator> {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => localStorage.setItem('factory.theme', t), theme);
    await page.goto(`/tasks/${id}`);
    const question = page.locator('.question');
    await expect(question).toBeVisible();
    return question;
}

const shoot = (question: Locator, state: string, theme: Theme) =>
    question.locator('xpath=ancestor::article').screenshot({ path: `${SHOTS}/task-question-${state}-${theme}.png` });

const status = (question: Locator) => question.locator('[aria-live="polite"]');

test.describe('answering an agent question', () => {
    for (const theme of THEMES) {
        test(`answers a pending single-select question → Answered by the member (${theme})`, async ({ page }) => {
            const question = await open(page, await seedQuestion({ status: 'running' }), theme);
            await expect(status(question)).toHaveText('Claude is waiting for your answer');
            await expect(page.locator('.page-header-meta')).toContainText('Needs answer');
            const submit = question.getByRole('button', { name: 'Submit' });
            await expect(submit).toBeDisabled();
            await shoot(question, 'waiting', theme);

            await question.getByRole('radio', { name: /SQLite/ }).check();
            // Hold the answer in flight long enough to see the busy form.
            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            await page.route('**/questions/*/answer', async (route) => {
                await held;
                await route.continue();
            });
            await submit.click();
            await expect(question.getByRole('button', { name: 'Sending…' })).toBeDisabled();
            await expect(question.getByRole('radio', { name: /SQLite/ })).toBeDisabled();
            await shoot(question, 'submitting', theme);
            release();

            await expect(status(question)).toContainText('Answered by Local');
            await expect(question.locator('dd')).toHaveText('SQLite');
            await expect(question.locator('input')).toHaveCount(0);
            await shoot(question, 'answered', theme);
        });

        test(`a failed answer keeps the choice and offers a retry (${theme})`, async ({ page }) => {
            const question = await open(page, await seedQuestion({ status: 'running' }), theme);
            await question.getByRole('radio', { name: /Postgres/ }).check();
            await page.route('**/questions/*/answer', (route) =>
                route.fulfill({ status: 500, json: { error: 'The board could not store the answer' } })
            );
            await question.getByRole('button', { name: 'Submit' }).click();
            const error = question.locator('.question-error');
            await expect(error).toContainText('The board could not store the answer');
            await expect(question.locator('form')).toHaveAttribute(
                'aria-describedby',
                (await error.getAttribute('id'))!
            );
            await expect(question.getByRole('radio', { name: /Postgres/ })).toBeChecked();
            await expect(question.getByRole('button', { name: 'Try again' })).toBeEnabled();
            await shoot(question, 'failed', theme);
        });

        test(`an expired question renders read-only (${theme})`, async ({ page }) => {
            const question = await open(page, await seedQuestion({ status: 'running', state: 'expired' }), theme);
            await expect(status(question)).toHaveText('Expired unanswered after 1 hour');
            await expect(question.locator('input')).toHaveCount(0);
            await shoot(question, 'expired', theme);
        });

        test(`a closed question renders read-only (${theme})`, async ({ page }) => {
            const question = await open(page, await seedQuestion({ status: 'succeeded' }), theme);
            await expect(status(question)).toHaveText('Run ended before an answer');
            await expect(question).toContainText(DATABASE.question);
            await expect(question.locator('input')).toHaveCount(0);
            await shoot(question, 'closed', theme);
        });
    }

    test('answers with Other text', async ({ page }) => {
        const question = await open(page, await seedQuestion({ status: 'running' }));
        await expect(question.locator('.question-other')).toHaveCount(0);
        await question.getByRole('radio', { name: 'Other' }).check();
        await question.getByRole('textbox', { name: /Other answer/ }).fill('  Redis  ');
        await question.getByRole('button', { name: 'Submit' }).click();
        await expect(status(question)).toContainText('Answered by Local');
        await expect(question.locator('dd')).toHaveText('Redis');
    });

    test('a second browser answering the same question sees it Answered (409)', async ({ browser, page }) => {
        const id = await seedQuestion({ status: 'running' });
        const first = await open(page, id);

        // The second member's thread stays on the pre-answer snapshot, so their Submit is what
        // learns about the first answer — the 409 — rather than the next poll.
        const other = await browser.newContext();
        const second = await other.newPage();
        const snapshot = await (await page.request.get(`/api/jobs/${id}/thread`)).json();
        await second.route('**/api/jobs/*/thread', (route) => route.fulfill({ json: snapshot }));
        const late = await open(second, id);
        await late.getByRole('radio', { name: /Postgres/ }).check();

        await first.getByRole('radio', { name: /SQLite/ }).check();
        await first.getByRole('button', { name: 'Submit' }).click();
        await expect(status(first)).toContainText('Answered by Local');

        const conflict = second.waitForResponse((response) => response.url().endsWith('/answer'));
        await late.getByRole('button', { name: 'Submit' }).click();
        expect((await conflict).status()).toBe(409);
        await expect(status(late)).toContainText('Answered by Local');
        await expect(late.locator('dd')).toHaveText('SQLite');
        await other.close();
    });
});
