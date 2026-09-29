import { expect, type Page } from '@playwright/test';

/** The elements allowed to scroll horizontally, by the design system's own account of them:
    the table wrap, the chart frame, the log wells, and text entry. Anything
    else an audit catches is an unnamed scroll region — a defect, not a fact of the page. */
export const NAMED_SCROLL_REGIONS = '.table-wrap, .chart-wrap, .chat-output, .run-well';

/** How far the page reaches past its viewport, in px: positive is page-level horizontal scroll.
    `inner` is the issue-287 contract (`scrollWidth <= innerWidth`); the client-width pair is the
    older sentinel, which a visible scrollbar would make the stricter one. */
export async function pageOverflow(page: Page): Promise<{ inner: number; document: number; body: number }> {
    return await page.evaluate(() => ({
        inner: document.documentElement.scrollWidth - window.innerWidth,
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
    }));
}

/** No page renders wider than its own viewport — shared by every spec that walks narrow widths,
    so a fix to the check applies everywhere at once instead of drifting between copies. */
export async function noHorizontalOverflow(page: Page): Promise<void> {
    const overflow = await pageOverflow(page);
    expect(overflow.inner, 'document is wider than the viewport').toBeLessThanOrEqual(0);
    expect(overflow.document, 'document overflows horizontally').toBeLessThanOrEqual(0);
    expect(overflow.body, 'body overflows horizontally').toBeLessThanOrEqual(0);
}

/** Every rendered control that sits outside the viewport. Content inside a named scroll region is
    exempt — a scrolled-off table column is the design, a scrolled-off action is not. */
export async function controlsOutsideViewport(page: Page, width: number): Promise<string[]> {
    return await page.evaluate(
        ({ vw, regions }) => {
            const out: string[] = [];
            for (const el of document.querySelectorAll<HTMLElement>(
                'main button, main a, main input, main select, main textarea, .appbar button, .appbar a'
            )) {
                if (el.offsetWidth === 0) continue;
                if (el.closest(regions)) continue;
                const box = el.getBoundingClientRect();
                if (box.left < -1 || box.right > vw + 1) {
                    out.push(
                        `${el.tagName.toLowerCase()}.${el.className} at ${Math.round(box.left)}..${Math.round(box.right)}`
                    );
                }
            }
            return out;
        },
        { vw: width, regions: NAMED_SCROLL_REGIONS }
    );
}
