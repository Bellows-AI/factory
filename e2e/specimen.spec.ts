import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { THEMES, VIEWPORTS } from './screenshot-matrix.js';
import { COLUMNS, cellId, OPEN_SELECTOR_ORG, ROWS } from './specimen/matrix.js';
import type { Column, Row } from './specimen/matrix.js';
import { noHorizontalOverflow } from './viewport.js';

/**
 * The component-state specimen (issue 275, redesign plan §1.7): the reference sheet R2–R7 match.
 * One full-page shot per theme × width, `artifacts/ui/specimen-{theme}-{width}.png` — copied by
 * hand into docs/plans/bellows-redesign-2026-09-26/specimen/ when the primitives change — plus
 * element shots of the interactive primitives under a real pointer hover and a real keyboard
 * focus, because those states are never faked with a class on the page.
 */

const OUT = 'artifacts/ui';
const STATES_OUT = `${OUT}/specimen-states`;
/** More than the page's tab stops, so a target that is never reached fails instead of looping. */
const MAX_TABS = 200;

const cell = (page: Page, row: Row, column: Column) => page.locator(`[data-cell="${cellId(row, column)}"]`);

interface Target {
    /** The element-shot file stem. */
    name: string;
    row: Row;
    /** The element the pointer rests on, inside the row's Default cell. */
    hover: (cell: Locator) => Locator;
    /** Whether Tab reaches it — a table row is hovered, never focused. */
    focusable: boolean;
    /** Whether holding the pointer down on it has a skin of its own (issue 265). */
    pressable?: boolean;
}

const TARGETS: Target[] = [
    { name: 'selector', row: 'Selector (closed)', hover: (c) => c.getByRole('button'), focusable: true },
    {
        name: 'primary-button',
        row: 'Primary button',
        hover: (c) => c.getByRole('button'),
        focusable: true,
        pressable: true,
    },
    {
        name: 'secondary-button',
        row: 'Secondary button',
        hover: (c) => c.getByRole('button'),
        focusable: true,
        pressable: true,
    },
    {
        name: 'destructive-button',
        row: 'Destructive button',
        hover: (c) => c.getByRole('button'),
        focusable: true,
        pressable: true,
    },
    { name: 'field', row: 'Text field', hover: (c) => c.getByRole('textbox'), focusable: true },
    { name: 'textarea', row: 'Textarea', hover: (c) => c.getByRole('textbox'), focusable: true },
    { name: 'checkbox', row: 'Checkbox', hover: (c) => c.getByRole('checkbox'), focusable: true },
    { name: 'chip-remove', row: 'Filter chip', hover: (c) => c.getByRole('button'), focusable: true },
    { name: 'disclosure', row: 'Disclosure (closed)', hover: (c) => c.locator('summary'), focusable: true },
    { name: 'table-row', row: 'Table row', hover: (c) => c.getByRole('row'), focusable: false },
];

/** The Default cell the keyboard focus sits in, or null — one read per Tab press. */
const focusedCell = (page: Page) =>
    page.evaluate(() => document.activeElement?.closest<HTMLElement>('[data-cell]')?.dataset.cell ?? null);

test.describe('component-state specimen', () => {
    // A keyboard walk over every tab stop plus ~20 element shots: seconds on an idle machine, but
    // past the 30 s default beside the two boards verify:ui runs alongside it.
    test.describe.configure({ timeout: 120_000 });

    for (const theme of THEMES) {
        for (const viewport of VIEWPORTS) {
            const shot = `specimen-${theme}-${viewport.width}`;
            test(shot, async ({ page }) => {
                await page.setViewportSize(viewport);
                await page.goto('/');
                await page.evaluate((t) => {
                    document.documentElement.dataset.theme = t;
                }, theme);
                await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
                await expect(page.getByRole('heading', { level: 1, name: 'Component states' })).toBeVisible();
                await page.evaluate(() => document.fonts.ready);

                // Every row is on the page; the column headers too, except where the narrow
                // reflow labels each cell instead.
                for (const row of ROWS) {
                    await expect(page.locator('tbody th', { hasText: row })).toBeVisible();
                }
                for (const column of COLUMNS) {
                    await expect(page.locator('thead th', { hasText: column })).toBeAttached();
                }
                await noHorizontalOverflow(page);

                for (const target of TARGETS) {
                    const home = cell(page, target.row, 'Default');
                    await target.hover(home).hover();
                    await home.screenshot({
                        path: `${STATES_OUT}/${target.name}-hover-${theme}-${viewport.width}.png`,
                    });
                    // Held down (issue 265), with the button actually under the pointer: :active is
                    // the browser's own, never a class, so the shot has to keep the press open.
                    if (target.pressable === true) {
                        await page.mouse.down();
                        await home.screenshot({
                            path: `${STATES_OUT}/${target.name}-pressed-${theme}-${viewport.width}.png`,
                        });
                        await page.mouse.up();
                    }
                }
                await page.mouse.move(0, 0);

                // One keyboard pass from the top of the page: each target is shot the moment Tab
                // lands in it, so focus-visible is the browser's own, not a class.
                const pending = new Map(
                    TARGETS.filter((target) => target.focusable).map((target) => [
                        cellId(target.row, 'Default'),
                        target,
                    ])
                );
                for (let press = 0; press < MAX_TABS && pending.size > 0; press++) {
                    await page.keyboard.press('Tab');
                    const id = await focusedCell(page);
                    const target = id === null ? undefined : pending.get(id);
                    if (!target) continue;
                    pending.delete(id!);
                    await cell(page, target.row, 'Default').screenshot({
                        path: `${STATES_OUT}/${target.name}-focus-${theme}-${viewport.width}.png`,
                    });
                }
                expect([...pending.keys()], 'targets Tab never reached').toEqual([]);
                await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

                // The open selector is part of the sheet, so the full-page shot waits for it.
                await page.getByRole('button', { name: `Organization: ${OPEN_SELECTOR_ORG}` }).click();
                await expect(page.getByRole('listbox')).toBeVisible();
                await page.screenshot({ path: `${OUT}/${shot}.png`, fullPage: true, animations: 'disabled' });
                await page.keyboard.press('Escape');
                await expect(page.getByRole('listbox')).toHaveCount(0);
            });
        }
    }
});
