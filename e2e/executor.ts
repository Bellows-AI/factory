import { CLAUDE_CODE } from '@factory-ai/core';
import type { Page } from '@playwright/test';

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
