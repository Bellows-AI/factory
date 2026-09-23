import { describe, expect, it } from 'vitest';
import { ANCHOR_GAP_PX, VIEWPORT_PADDING_PX, capToAvailableHeight, downwardMiddleware } from '../src/anchor.js';

/**
 * `useDownwardAnchor` wraps `useFloating`, which needs real DOM elements to measure — out of
 * reach for this offline, DOM-less suite. What is testable without a browser, and what actually
 * proves the fix (issue 224), is the middleware stack itself: no `flip`, so the panel never
 * flips above its trigger, and the height-capping callback it hands to `size`.
 */
describe('the downward anchor (#224)', () => {
    it('never includes flip, so a panel near the bottom of the viewport still opens downward', () => {
        const names = downwardMiddleware().map((middleware) => middleware.name);
        expect(names).toEqual(['offset', 'shift', 'size']);
    });

    it('caps the panel to the space actually available below the trigger', () => {
        const style: Partial<CSSStyleDeclaration> = {};
        capToAvailableHeight({
            availableHeight: 240,
            elements: { floating: { style } as HTMLElement },
        } as Parameters<typeof capToAvailableHeight>[0]);
        expect(style.maxHeight).toBe('240px');
    });

    it('names the gap and padding instead of repeating magic numbers at each call site', () => {
        expect(ANCHOR_GAP_PX).toBeGreaterThan(0);
        expect(VIEWPORT_PADDING_PX).toBeGreaterThan(0);
    });
});
