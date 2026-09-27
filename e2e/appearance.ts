import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

export type AppearanceLabel = 'System' | 'Light' | 'Dark';

/**
 * The appearance control is a Headless UI Listbox, not a native `<select>` (issue 224): the
 * labelled element is the `select-trigger` button, its text is the chosen preference, and the
 * choices are `option`s in a portalled listbox that exists only while it is open.
 */
export const appearance = (page: Page): Locator => page.getByLabel('Appearance');

/** Choose a preference the way a member does: open the trigger, click the option. */
export async function chooseAppearance(page: Page, label: AppearanceLabel): Promise<void> {
    await appearance(page).click();
    // Not exact: the selected option's accessible name carries its checkmark ("Light ✓").
    await page.getByRole('listbox').getByRole('option', { name: label }).click();
}

/** The offered choices, in order — asserted on the open listbox (retrying while it mounts), then closed. */
export async function expectAppearanceOptions(page: Page, labels: AppearanceLabel[]): Promise<void> {
    await appearance(page).click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveText(labels);
    await page.keyboard.press('Escape');
}
