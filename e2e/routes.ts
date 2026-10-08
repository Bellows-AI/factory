import { expect, type Locator, type Page } from '@playwright/test';
import { AUTH_PORT } from '../playwright.config.js';
import { withExecutor } from './executor.js';
import type { ThreadJob } from './fixtures/threads.js';
import { routeThread } from './fixtures/threads.js';
import type { Theme } from './screenshot-matrix.js';
import { finishSignIn } from './signin.js';

/**
 * The redesign's route families, shared by the "before" gallery (baseline.spec.ts) and the
 * responsive/accessibility matrix (matrix.spec.ts), so both walk the same pages and name each
 * shot the same `<route>_<state>_<theme>_<width>.png`. Sign-in, onboarding and the signed-in
 * account page need a github-mode board, so they are opened on the auth board by absolute URL;
 * everything else is the open board and its seed.
 */

export const AUTH_BASE = `http://127.0.0.1:${AUTH_PORT}`;
/** The seeded board's cold stats fetch, and a sign-in round trip, can both take a while. */
export const SLOW = 60_000;

export interface Shot {
    /** The route family — the filename's first segment. */
    route: string;
    /** The state shown — the second segment; `default` where the route has one. */
    state: string;
    /** What the page rendered from: a `fixtures/threads.ts` export, or the board itself. */
    fixture: string;
    /** Navigate, and return the element whose presence means the page has rendered. */
    open: (page: Page) => Promise<Locator>;
}

/** The shot's file name: `<route>_<state>_<theme>_<width>.png`. */
export const shotFile = (shot: Shot, theme: Theme, width: number) =>
    `${shot.route}_${shot.state}_${theme}_${width}.png`;

/** Any seeded thread root, by a live id: the seed mints its ids, so none is ever written down. */
export async function seededTaskId(page: Page): Promise<string> {
    const body = (await page.request.get('/api/jobs?limit=200').then((r) => r.json())) as {
        jobs: Array<{ id: string; followUpTo: string | null }>;
    };
    const root = body.jobs.find((job) => job.followUpTo === null);
    expect(root, 'the seed leaves at least one task').toBeDefined();
    return root!.id;
}

export const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });

export const onOpenBoard = (route: string, path: string, name: string): Shot => ({
    route,
    state: 'default',
    fixture: 'seed',
    open: async (page) => {
        await page.goto(path);
        return heading(page, name);
    },
});

/** One thread state, rendered through the detail page from a `fixtures/threads.ts` export. */
export const threadShot = (state: string, fixture: string, jobs: readonly ThreadJob[]): Shot => ({
    route: 'task-detail',
    state,
    fixture,
    open: async (page) => {
        await routeThread(page, jobs);
        await page.goto(`/tasks/${jobs[0]!.id}`);
        return page.locator('.task-layout');
    },
});

export const DASHBOARD_SHOT: Shot = {
    route: 'dashboard',
    state: 'default',
    fixture: 'seed',
    open: async (page) => {
        await page.goto('/');
        return page.locator('.usage-summary, .usage-empty').first();
    },
};

export const INBOX_SHOT: Shot = {
    route: 'inbox',
    state: 'default',
    fixture: 'seed',
    open: async (page) => {
        await page.goto('/tasks');
        return page.locator('.inbox-tabs');
    },
};

export const COMPOSER_SHOT: Shot = {
    route: 'composer',
    state: 'default',
    fixture: 'seed + e2e/executor.ts',
    open: async (page) => {
        await withExecutor(page);
        await page.goto('/tasks/new');
        return heading(page, 'New task');
    },
};

export const SETTINGS_SHOTS: readonly Shot[] = [
    onOpenBoard('settings-overview', '/settings', 'Configuration overview'),
    onOpenBoard('settings-organization', '/settings/organization', 'Organization'),
    onOpenBoard('settings-workspace', '/settings/workspace', 'Workspace'),
    onOpenBoard('settings-repos', '/settings/repos', 'Repositories'),
    onOpenBoard('settings-executors', '/settings/executors', 'Executors'),
];

export const ENTRY_SHOTS: readonly Shot[] = [
    {
        route: 'signin',
        state: 'default',
        fixture: 'auth board, anonymous',
        open: async (page) => {
            await page.goto(`${AUTH_BASE}/`);
            return page.locator('.login-gate');
        },
    },
    {
        route: 'onboarding',
        state: 'default',
        fixture: 'auth board, stub IdP (reselect)',
        open: async (page) => {
            await page.goto(`${AUTH_BASE}/api/auth/github?reselect=1`);
            return page.locator('.onboarding');
        },
    },
    {
        route: 'account',
        state: 'default',
        fixture: 'auth board, stub IdP (signed in)',
        open: async (page) => {
            await page.goto(`${AUTH_BASE}/`);
            await page.getByRole('link', { name: 'Sign in with GitHub' }).click();
            await finishSignIn(page);
            await page.goto(`${AUTH_BASE}/account`);
            return heading(page, 'Account');
        },
    },
];
