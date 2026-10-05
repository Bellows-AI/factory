import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockExecutors } from './executor.js';
import { ADVANCED_LABEL, CONFIG_JSON_LABEL, FORMAT_JSON_LABEL } from '../web/src/workspace/executors.js';

const SHOTS = 'artifacts/ui/json-editor';
const sample =
    '{\n  "model": "sonnet",\n  "description": "the quick brown fox jumps over the lazy dog",\n  "count": 12345,\n  "enabled": true\n}';
const longConfig = JSON.stringify(
    Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`setting_${i}`, `${'abcdefghij'.repeat(18)}_${i}`])),
    null,
    2
);

async function openEditor(page: Page) {
    await mockExecutors(page, []);
    await page.goto('/settings/executors');
    await page.getByRole('button', { name: 'Add executor' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add executor' });
    await dialog.getByLabel('Name', { exact: true }).fill('caret-test');
    await dialog.getByText(ADVANCED_LABEL, { exact: true }).click();
    const input = dialog.getByRole('textbox', { name: CONFIG_JSON_LABEL });
    await input.scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    return { dialog, input };
}

/** Locate the visible glyph, independently of the textarea's font and padding. */
async function paintPoint(input: Locator, offset: number) {
    return input.evaluate((element, position) => {
        const paint = element.parentElement!.querySelector('code')!;
        const walker = document.createTreeWalker(paint, NodeFilter.SHOW_TEXT);
        let remaining = position;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const length = node.textContent?.length ?? 0;
            if (remaining < length) {
                const range = document.createRange();
                range.setStart(node, remaining);
                range.setEnd(node, remaining + 1);
                const box = range.getBoundingClientRect();
                return { x: box.left + 0.5, y: box.top + box.height / 2 };
            }
            remaining -= length;
        }
        throw new Error(`No painted glyph at ${position}`);
    }, offset);
}

async function clickPaint(page: Page, input: Locator, offset: number) {
    const point = await paintPoint(input, offset);
    const bounds = await input.boundingBox();
    expect(bounds).not.toBeNull();
    expect(point.x).toBeGreaterThan(bounds!.x);
    expect(point.x).toBeLessThan(bounds!.x + bounds!.width);
    expect(point.y).toBeGreaterThan(bounds!.y);
    expect(point.y).toBeLessThan(bounds!.y + bounds!.height);
    await page.mouse.click(point.x, point.y);
    await expect(input).toBeFocused();
    await expect.poll(() => input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(offset);
}

async function expectScrollAligned(input: Locator) {
    await expect
        .poll(() =>
            input.evaluate((el: HTMLTextAreaElement) => {
                const paint = el.parentElement!.querySelector('pre')!;
                const gutter = el.closest('.json-editor')!.querySelector('.json-editor-gutter')!;
                return {
                    paintTop: paint.scrollTop - el.scrollTop,
                    paintLeft: paint.scrollLeft - el.scrollLeft,
                    gutterTop: gutter.scrollTop - el.scrollTop,
                };
            })
        )
        .toEqual({ paintTop: 0, paintLeft: 0, gutterTop: 0 });
}

for (const width of [1440, 390]) {
    for (const theme of ['dark', 'light']) {
        test.describe(`${theme} ${width}px`, () => {
            test.beforeEach(async ({ page }) => {
                await page.setViewportSize({ width, height: 1000 });
                await page.addInitScript((nextTheme) => localStorage.setItem('factory.theme', nextTheme), theme);
            });

            test('clicks land on painted characters across tokens and lines', async ({ page }) => {
                const { input } = await openEditor(page);
                await input.fill(sample);
                await input.scrollIntoViewIfNeeded();
                const metrics = await input.evaluate((el) => {
                    const paint = el.parentElement!.querySelector('code')!;
                    const properties = [
                        'font-family',
                        'font-size',
                        'font-weight',
                        'font-style',
                        'line-height',
                        'letter-spacing',
                        'tab-size',
                        'white-space',
                    ];
                    const read = (node: Element) =>
                        properties.map((property) => getComputedStyle(node).getPropertyValue(property));
                    return { input: read(el), paint: read(paint) };
                });
                expect(metrics.paint).toEqual(metrics.input);
                for (const offset of [0, 4, 12, 18, 26, 40, 48, 60, 95, 112, sample.length - 1]) {
                    // Long lines on a phone are covered after horizontal scrolling below.
                    const point = await paintPoint(input, offset);
                    const box = await input.boundingBox();
                    if (point.x >= box!.x + box!.width - 12) continue;
                    await clickPaint(page, input, offset);
                }
                mkdirSync(SHOTS, { recursive: true });
                await page.screenshot({ path: `${SHOTS}/caret-${theme}-${width}.png` });
            });

            test('native selection, replacement, Enter and undo keep text and caret', async ({ page }) => {
                const { input, dialog } = await openEditor(page);
                await input.fill('{\n  "value": "abcdef"\n}');
                await clickPaint(page, input, 15);
                await page.keyboard.press('Shift+ArrowRight');
                await page.keyboard.press('Shift+ArrowRight');
                await page.keyboard.press('Shift+ArrowRight');
                expect(
                    await input.evaluate((el: HTMLTextAreaElement) =>
                        el.value.slice(el.selectionStart, el.selectionEnd)
                    )
                ).toBe('bcd');
                await page.keyboard.insertText('XYZ');
                await expect(input).toHaveValue('{\n  "value": "aXYZef"\n}');
                await page.keyboard.press('ControlOrMeta+z');
                await expect(input).toHaveValue('{\n  "value": "abcdef"\n}');
                await page.keyboard.press('ControlOrMeta+Shift+z');
                await expect(input).toHaveValue('{\n  "value": "aXYZef"\n}');
                await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(23, 23));
                await page.keyboard.press('Enter');
                await expect(input).toHaveValue('{\n  "value": "aXYZef"\n}\n');
                await page.keyboard.press('ControlOrMeta+z');
                await expect(input).toHaveValue('{\n  "value": "aXYZef"\n}');
                await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(22, 22));
                await page.keyboard.press('Enter');
                await expect(input).toHaveValue('{\n  "value": "aXYZef"\n\n}');
                await input.fill('{\n  "value": 1\n}');
                await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(14, 14));
                await page.keyboard.press('Enter');
                await expect(input).toHaveValue('{\n  "value": 1\n  \n}');
                expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(17);
                await page.keyboard.press('Tab');
                await expect(dialog.getByRole('button', { name: FORMAT_JSON_LABEL })).toBeFocused();
            });

            test('select-all and partial selections keep the painted text readable under the highlight', async ({
                page,
                context,
            }) => {
                const { input } = await openEditor(page);
                await context.grantPermissions(['clipboard-read', 'clipboard-write']);
                await input.fill(sample);
                await input.focus();
                const selection = () =>
                    input.evaluate((el: HTMLTextAreaElement) => {
                        const wash = getComputedStyle(el, '::selection').backgroundColor;
                        const paint = getComputedStyle(el.parentElement!.querySelector('code')!);
                        return { wash, ink: paint.color, hidden: paint.visibility === 'hidden' };
                    });
                const alpha = (color: string) => {
                    const channels = /\/\s*([\d.]+)\s*\)|,\s*([\d.]+)\s*\)$/.exec(color);
                    return channels ? Number(channels[1] ?? channels[2]) : 1;
                };
                mkdirSync(SHOTS, { recursive: true });

                await input.press('ControlOrMeta+a');
                const full = await selection();
                // An opaque wash over the transparent textarea text would cover the glyphs painted
                // beneath it; the selection must stay see-through.
                expect(alpha(full.wash)).toBeGreaterThan(0);
                expect(alpha(full.wash)).toBeLessThan(0.6);
                expect(full.hidden).toBe(false);
                await page.screenshot({ path: `${SHOTS}/select-all-${theme}-${width}.png` });
                await expect(input).toHaveValue(sample);
                await page.evaluate(() => navigator.clipboard.writeText(''));
                await input.press('ControlOrMeta+c');
                expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sample);
                await expect(input).toHaveValue(sample);

                await clickPaint(page, input, 4);
                for (let step = 0; step < 6; step++) await page.keyboard.press('Shift+ArrowRight');
                expect(
                    await input.evaluate((el: HTMLTextAreaElement) =>
                        el.value.slice(el.selectionStart, el.selectionEnd)
                    )
                ).toBe('"model');
                await page.screenshot({ path: `${SHOTS}/select-partial-${theme}-${width}.png` });

                await input.press('ControlOrMeta+a');
                await page.keyboard.insertText('{}');
                await expect(input).toHaveValue('{}');
                await input.press('ControlOrMeta+z');
                await expect(input).toHaveValue(sample);
                await clickPaint(page, input, 4);
                await expect(page.locator('.json-editor-highlight code')).toHaveText(`${sample}\n `);
            });

            test('scrolling to all edges and replacing a scrolled draft keeps paint aligned', async ({ page }) => {
                const { input, dialog } = await openEditor(page);
                await input.fill(longConfig);
                await input.evaluate((el: HTMLTextAreaElement) => {
                    el.scrollTop = el.scrollHeight;
                    el.scrollLeft = el.scrollWidth;
                });
                await expectScrollAligned(input);
                const offset = longConfig.lastIndexOf('_59');
                await clickPaint(page, input, offset);
                await page.keyboard.type('X');
                await expect(input).toHaveValue(`${longConfig.slice(0, offset)}X${longConfig.slice(offset)}`);
                await expectScrollAligned(input);
                await input.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
                expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(0);
                await expectScrollAligned(input);
                await clickPaint(page, input, 4);
                await input.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
                await expectScrollAligned(input);
                await dialog.getByLabel('Agent', { exact: true }).selectOption({ label: 'OpenCode' });
                await expect(input).toHaveValue('{}');
                await expectScrollAligned(input);
                await dialog.getByLabel('Agent', { exact: true }).selectOption({ label: 'Claude Code' });
                await expect(input).toHaveValue(`${longConfig.slice(0, offset)}X${longConfig.slice(offset)}`);
                await expectScrollAligned(input);
                await input.fill('{"x":1}');
                await dialog.getByRole('button', { name: FORMAT_JSON_LABEL }).click();
                await expect(input).toHaveValue('{\n  "x": 1\n}');
                await expectScrollAligned(input);
                await clickPaint(page, input, 4);
            });

            test('mouse dragging selects the painted substring and double click selects a word', async ({ page }) => {
                const { input } = await openEditor(page);
                const text = '{\n  "x": "alpha beta"\n}';
                await input.fill(text);
                const start = text.indexOf('alpha');
                const from = await paintPoint(input, start);
                const to = await paintPoint(input, start + 5);
                await page.mouse.move(from.x, from.y);
                await page.mouse.down();
                await page.mouse.move(to.x, to.y, { steps: 8 });
                await page.mouse.up();
                expect(
                    await input.evaluate((el: HTMLTextAreaElement) =>
                        el.value.slice(el.selectionStart, el.selectionEnd)
                    )
                ).toBe('alpha');
                await page.keyboard.insertText('gamma');
                await expect(input).toHaveValue(text.replace('alpha', 'gamma'));
                const word = await paintPoint(input, text.indexOf('beta') + 1);
                await page.mouse.dblclick(word.x, word.y);
                expect(
                    await input.evaluate((el: HTMLTextAreaElement) =>
                        el.value.slice(el.selectionStart, el.selectionEnd)
                    )
                ).toBe('beta');
            });

            test('clipboard paste, Unicode, tabs, empty text and trailing newlines stay lossless', async ({
                page,
                context,
            }) => {
                const { input } = await openEditor(page);
                await context.grantPermissions(['clipboard-read', 'clipboard-write']);
                const pasted = '{\n\t"text": "café 漢字 🙂",\n\t"n": 42\n}\n';
                await input.fill('');
                await expect(page.locator('.json-editor-gutter')).toHaveText('1');
                await input.focus();
                await page.evaluate((text) => navigator.clipboard.writeText(text), pasted);
                await input.press('ControlOrMeta+v');
                await expect(input).toHaveValue(pasted);
                expect(await page.locator('.json-editor-gutter > span').count()).toBe(5);
                await clickPaint(page, input, pasted.indexOf('café'));
                await clickPaint(page, input, pasted.indexOf('漢字'));
                await clickPaint(page, input, pasted.indexOf('42'));
                await page.keyboard.insertText('7');
                await expect(input).toHaveValue(pasted.replace('42', '742'));
                await input.press('ControlOrMeta+z');
                await expect(input).toHaveValue(pasted);
            });

            test('Enter fallback restores selection and composing Enter is left to the browser', async ({ page }) => {
                const { input } = await openEditor(page);
                const text = '{\n  "x": 12\n}';
                await input.fill(text);
                await input.evaluate((el: HTMLTextAreaElement) => {
                    el.setSelectionRange(9, 11);
                    document.execCommand = () => false;
                });
                await input.press('Enter');
                await expect(input).toHaveValue('{\n  "x": \n  \n}');
                expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(12);
                await page.keyboard.insertText('3');
                await expect(input).toHaveValue('{\n  "x": \n  3\n}');
                const composing = await input.evaluate((el) => {
                    const event = new KeyboardEvent('keydown', {
                        key: 'Enter',
                        bubbles: true,
                        cancelable: true,
                        isComposing: true,
                    });
                    el.dispatchEvent(event);
                    return event.defaultPrevented;
                });
                expect(composing).toBe(false);
                await expect(input).toHaveValue('{\n  "x": \n  3\n}');
            });

            test('forced colors keep one readable editable layer and keyboard focus', async ({ page }) => {
                const { input } = await openEditor(page);
                await input.fill(sample);
                await page.emulateMedia({ forcedColors: 'active' });
                await expect(page.locator('.json-editor-highlight')).toBeHidden();
                const colors = await input.evaluate((el) => {
                    const css = getComputedStyle(el);
                    return { text: css.color, caret: css.caretColor, background: css.backgroundColor };
                });
                expect(colors.text).not.toBe('rgba(0, 0, 0, 0)');
                expect(colors.caret).not.toBe(colors.background);
                await input.focus();
                await input.press('ControlOrMeta+a');
                await page.keyboard.insertText('{"n":2}');
                await expect(input).toHaveValue('{"n":2}');
                mkdirSync(SHOTS, { recursive: true });
                await page.screenshot({ path: `${SHOTS}/forced-colors-${theme}-${width}.png` });
            });

            test('seeded gremlins click painted text, edit, navigate and delete without losing characters', async ({
                page,
            }) => {
                test.setTimeout(60_000);
                const { input } = await openEditor(page);
                let expected = '{\n  "value": "abcdefghijklmnop",\n  "n": 123\n}';
                await input.fill(expected);
                let seed = 387;
                const actions = [0, 0, 0, 0];
                const random = () => {
                    seed ^= seed << 13;
                    seed ^= seed >>> 17;
                    seed ^= seed << 5;
                    return seed >>> 0;
                };
                for (let step = 0; step < 80; step++) {
                    const offset = random() % expected.length;
                    if (expected[offset] === '\n') continue;
                    await input.evaluate((el: HTMLTextAreaElement) => {
                        el.scrollLeft = 0;
                        el.scrollTop = 0;
                    });
                    await expectScrollAligned(input);
                    const point = await paintPoint(input, offset);
                    const box = await input.boundingBox();
                    if (point.x >= box!.x + box!.width - 12 || point.y >= box!.y + box!.height - 12) continue;
                    await clickPaint(page, input, offset);
                    if (step % 5 === 0) {
                        await input.press('ArrowRight');
                        await input.press('ArrowLeft');
                        expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(offset);
                    }
                    const action = random() % 4;
                    actions[action]!++;
                    if (action === 0 && offset > 0) {
                        await page.keyboard.press('Backspace');
                        expected = expected.slice(0, offset - 1) + expected.slice(offset);
                    } else if (action === 1) {
                        await page.keyboard.press('Delete');
                        expected = expected.slice(0, offset) + expected.slice(offset + 1);
                    } else if (action === 2) {
                        await page.keyboard.press('Shift+ArrowRight');
                        await page.keyboard.type('q');
                        expected = `${expected.slice(0, offset)}q${expected.slice(offset + 1)}`;
                    } else {
                        await page.keyboard.type('z');
                        expected = `${expected.slice(0, offset)}z${expected.slice(offset)}`;
                    }
                    await expect(input, `seed 387, step ${step}, action ${action}`).toHaveValue(expected);
                    await expectScrollAligned(input);
                }
                expect(actions.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(35);
                expect(actions.every((count) => count > 0)).toBe(true);
                console.log(`gremlins seed=387 theme=${theme} width=${width} actions=${JSON.stringify(actions)}`);
            });
        });
    }
}
