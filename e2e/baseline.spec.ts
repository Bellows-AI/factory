import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { AUTH_PORT } from '../playwright.config.js';
import { withExecutor } from './executor.js';
import {
    agentFailedThread,
    doneThread,
    failedGateThread,
    followUpOverWaitThread,
    followUpThread,
    missingSummaryThread,
    multiFollowUpThread,
    nullAuthorThread,
    otherAuthorThread,
    parkedReviewWaitDoneThread,
    parkedReviewWaitThread,
    publishedThread,
    queuedThread,
    routeThread,
    runningThread,
    sessionlessThread,
    stoppedThread,
    stoppingThread,
    type ThreadJob,
    wokenContinuationThread,
} from './fixtures/threads.js';
import { THEMES, type Theme, VIEWPORTS } from './screenshot-matrix.js';
import { finishSignIn } from './signin.js';

/**
 * The "before" half of every redesign before/after comparison (issue 271): every route family ×
 * {dark, light} × {1440, 390}, one full-page shot each, named `<route>_<state>_<theme>_<width>.png`.
 *
 * It asserts nothing about the design — it exists to be run in a tree pinned to the pre-redesign
 * commit, so the images show the old UI. `afterAll` writes `manifest.json` beside the images: one
 * entry per shot, and the commit the UI came from — `git rev-parse HEAD`, or `BASELINE_COMMIT` in a
 * `git archive` export, which has no repository to ask.
 *
 * Opt-in (`BASELINE=1`), so `verify:ui` does not pay for it. Sign-in, onboarding and the account page need a github-mode board, so they are shot on the auth
 * board by absolute URL; everything else is the open board and its seed.
 */

const OUT = 'artifacts/ui/baseline';
const AUTH_BASE = `http://127.0.0.1:${AUTH_PORT}`;
/** The seeded board's cold stats fetch, and a sign-in round trip, can both take a while. */
const SLOW = 60_000;

interface Shot {
    /** The route family — the filename's first segment. */
    route: string;
    /** The state shown — the second segment; `default` where the route has one. */
    state: string;
    /** What the page rendered from: a `fixtures/threads.ts` export, or the board itself. */
    fixture: string;
    /** Navigate, and return the element whose presence means the page has rendered. */
    open: (page: Page) => Promise<Locator>;
}

const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });

const onOpenBoard = (route: string, path: string, name: string): Shot => ({
    route,
    state: 'default',
    fixture: 'seed',
    open: async (page) => {
        await page.goto(path);
        return heading(page, name);
    },
});

/** Every thread state `fixtures/threads.ts` builds (issue 270), rendered through the detail page. */
const THREADS: [state: string, fixture: string, jobs: readonly ThreadJob[]][] = [
    ['queued', 'queuedThread', queuedThread],
    ['running', 'runningThread', runningThread],
    ['stopping', 'stoppingThread', stoppingThread],
    ['stopped', 'stoppedThread', stoppedThread],
    ['parked-review-wait', 'parkedReviewWaitThread', parkedReviewWaitThread],
    ['parked-review-wait-done', 'parkedReviewWaitDoneThread', parkedReviewWaitDoneThread],
    ['woken-continuation', 'wokenContinuationThread', wokenContinuationThread],
    ['follow-up-over-wait', 'followUpOverWaitThread', followUpOverWaitThread],
    ['failed-gate', 'failedGateThread', failedGateThread],
    ['agent-failed', 'agentFailedThread', agentFailedThread],
    ['published', 'publishedThread', publishedThread],
    ['done', 'doneThread', doneThread],
    ['follow-up', 'followUpThread', followUpThread],
    ['multi-follow-up', 'multiFollowUpThread', multiFollowUpThread],
    ['missing-summary', 'missingSummaryThread', missingSummaryThread],
    ['sessionless', 'sessionlessThread', sessionlessThread],
    ['other-author', 'otherAuthorThread', otherAuthorThread],
    ['null-author', 'nullAuthorThread', nullAuthorThread],
];

const SHOTS: Shot[] = [
    {
        route: 'dashboard',
        state: 'default',
        fixture: 'seed',
        open: async (page) => {
            await page.goto('/');
            return page.locator('.usage-summary, .usage-empty').first();
        },
    },
    {
        route: 'inbox',
        state: 'default',
        fixture: 'seed',
        open: async (page) => {
            await page.goto('/tasks');
            return page.locator('.inbox-tabs');
        },
    },
    {
        route: 'composer',
        state: 'default',
        fixture: 'seed + e2e/executor.ts',
        open: async (page) => {
            await withExecutor(page);
            await page.goto('/tasks/new');
            return heading(page, 'New task');
        },
    },
    ...THREADS.map(
        ([state, fixture, jobs]): Shot => ({
            route: 'task-detail',
            state,
            fixture,
            open: async (page) => {
                await routeThread(page, jobs);
                await page.goto(`/tasks/${jobs[0]!.id}`);
                return page.locator('.task-layout');
            },
        })
    ),
    onOpenBoard('settings-overview', '/settings', 'Configuration overview'),
    onOpenBoard('settings-organization', '/settings/organization', 'Organization'),
    onOpenBoard('settings-workspace', '/settings/workspace', 'Workspace'),
    onOpenBoard('settings-repos', '/settings/repos', 'Repositories'),
    onOpenBoard('settings-executors', '/settings/executors', 'Executors'),
    onOpenBoard('settings-workflows', '/settings/workflows', 'Workflows'),
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

const fileOf = (shot: Shot, theme: Theme, width: number) => `${shot.route}_${shot.state}_${theme}_${width}.png`;

test.describe('baseline gallery', () => {
    test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

    // Rebuilt from the plan and the disk, not from a list the tests append to: a worker restarted
    // after a failure starts with an empty module, and the last afterAll must still see every shot.
    test.afterAll(() => {
        const shots = SHOTS.flatMap((shot) =>
            THEMES.flatMap((theme) =>
                VIEWPORTS.map((viewport) => ({ shot, theme, viewport, file: fileOf(shot, theme, viewport.width) }))
            )
        )
            .filter(({ file }) => existsSync(`${OUT}/${file}`))
            .map(({ shot, theme, viewport, file }) => ({
                file,
                route: shot.route,
                state: shot.state,
                theme,
                viewport: `${viewport.width}x${viewport.height}`,
                fixture: shot.fixture,
                timestamp: statSync(`${OUT}/${file}`).mtime.toISOString(),
            }));
        const commit =
            process.env.BASELINE_COMMIT ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        const manifest = { commit, shots };
        writeFileSync(`${OUT}/manifest.json`, `${JSON.stringify(manifest, null, 4)}\n`);
    });

    // biome-ignore lint/suspicious/noSkippedTests: a conditional opt-in, not a forgotten skip — a capture tool, not a check, so 120 shots would add minutes to every verify:ui for no assertion
    test.skip(!process.env.BASELINE, 'gallery capture — run with BASELINE=1');
    // Room for a SLOW wait plus the navigation and full-page shot around it; the 30 s default is less than one.
    test.describe.configure({ timeout: 2 * SLOW });

    for (const shot of SHOTS) {
        for (const theme of THEMES) {
            for (const viewport of VIEWPORTS) {
                const file = fileOf(shot, theme, viewport.width);
                test(file, async ({ page }) => {
                    await page.setViewportSize(viewport);
                    await page.emulateMedia({ colorScheme: theme });
                    await page.addInitScript((t) => localStorage.setItem('factory.theme', t), theme);

                    const ready = await shot.open(page);
                    await expect(ready).toBeVisible({ timeout: SLOW });
                    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
                    await page.waitForLoadState('networkidle');
                    await page.evaluate(() => document.fonts.ready);
                    await page.screenshot({ path: `${OUT}/${file}`, fullPage: true, animations: 'disabled' });
                });
            }
        }
    }
});
