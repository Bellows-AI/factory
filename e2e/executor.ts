import { CLAUDE_CODE } from '@factory-ai/core';
import { expect, type Page } from '@playwright/test';
import { ADD_LABEL } from '../web/src/workspace/executors.js';

/** The one executor the composer specs start tasks with. No driver runs here, so nothing resolves it. */
export const E2E_EXECUTOR = {
    name: 'e2e-executor',
    type: CLAUDE_CODE,
    createdAt: '2026-01-01T00:00:00.000Z',
    isDefault: true,
};

/**
 * Give the page one configured executor.
 *
 * A task cannot start without one (docs/workspace.md), and the open board deliberately has no
 * ORG_WORKSPACE_ROOT — which is what keeps a picker out of the visual check — so its
 * `/api/workspace` always answers `executors: []` and Start stays dark behind "Configure an
 * executor". Only the list is replaced: the rest of the answer is the real server's. The board
 * validates a task's executor label by shape alone, so the queued task is real.
 */
export async function withExecutor(page: Page): Promise<void> {
    await page.route('**/api/workspace', async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, executors: [E2E_EXECUTOR] } });
    });
}

/** One executor profile as the mocked workspace holds it — the config-bearing list row. */
export interface MockExecutor {
    name: string;
    type: string;
    createdAt: string;
    isDefault: boolean;
    /** The gate-repair budget the dialog's config read requires on every row it opens with. */
    gateFixRounds?: number;
    config: object;
}

/**
 * A workspace whose executor list the test owns. The open board has no ORG_WORKSPACE_ROOT, so its
 * executor routes refuse and the settings page offers no Add — which is exactly the page the
 * round trip must drive. This stands in a root and a mutable list, served to the poll, the
 * dialog's config read and its whole-list PUT alike; everything else is the real server's answer.
 */
export async function mockExecutors(
    page: Page,
    initial: MockExecutor[],
    repos: { owner: string; name: string }[] = []
): Promise<{ executors: MockExecutor[] }> {
    const held = { executors: initial };
    const selected = repos.map((repo) => ({
        ...repo,
        status: 'ready',
        error: null,
        selectedAt: E2E_EXECUTOR.createdAt,
        readyAt: E2E_EXECUTOR.createdAt,
        branch: null,
        lastCommit: null,
        sizeBytes: null,
    }));
    await page.route('**/api/workspace', async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        const executors = held.executors.map(({ config: _config, ...row }) => row);
        const withRepos = repos.length > 0 ? { repos: selected } : {};
        await route.fulfill({ response, json: { ...body, root: '/e2e/workspace', executors, ...withRepos } });
    });
    await page.route('**/api/workspace/executors', async (route) => {
        if (route.request().method() === 'PUT') {
            const { executors } = route.request().postDataJSON() as { executors: Omit<MockExecutor, 'createdAt'>[] };
            held.executors = executors.map((row) => ({ ...row, createdAt: E2E_EXECUTOR.createdAt }));
        }
        await route.fulfill({ json: { executors: held.executors } });
    });
    return held;
}

/** Every `POST /api/jobs` the page sends — the round trip must launch exactly once. */
export function countLaunches(page: Page): { bodies: unknown[] } {
    const seen = { bodies: [] as unknown[] };
    page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') {
            seen.bodies.push(request.postDataJSON());
        }
    });
    return seen;
}

/**
 * Add an executor the way a member does with no JSON at all (issue 261): open the dialog from the
 * page header, type a name, keep the default agent and the runner's default model, and save —
 * which saves the inherited configuration, `{}`.
 */
export async function addExecutorViaDialog(page: Page, name: string): Promise<void> {
    await page.getByRole('button', { name: ADD_LABEL }).click();
    const dialog = page.getByRole('dialog', { name: ADD_LABEL });
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: ADD_LABEL }).click();
    await expect(dialog).toHaveCount(0);
}
