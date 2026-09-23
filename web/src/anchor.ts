import { autoUpdate, offset, shift, size, useFloating, type Middleware, type SizeOptions } from '@floating-ui/react';

/**
 * Anchors a dropdown panel directly below its trigger, never above it (issue 224).
 *
 * Headless UI's own `anchor` prop always adds a `flip` middleware with no way to turn it off
 * (`@headlessui/react/dist/internal/floating.js`), so a trigger near the bottom of the viewport
 * can have its panel open upward instead. This hook builds the floating-ui middleware stack by
 * hand, without `flip`: the panel always renders below the trigger, shifted to stay in view
 * horizontally, and capped to the height actually available so it scrolls instead of clipping.
 */

/** Gap between a trigger and its dropdown panel. */
export const ANCHOR_GAP_PX = 6;

/** Minimum clearance a panel keeps from the viewport edge. */
export const VIEWPORT_PADDING_PX = 8;

/** Caps the panel to the space actually below the trigger, so it scrolls instead of clipping. */
export function capToAvailableHeight({
    availableHeight,
    elements,
}: Parameters<NonNullable<SizeOptions['apply']>>[0]): void {
    elements.floating.style.maxHeight = `${availableHeight}px`;
}

/** The middleware stack behind `useDownwardAnchor` — no `flip`, unlike Headless UI's `anchor`. */
export function downwardMiddleware(): Middleware[] {
    return [
        offset(ANCHOR_GAP_PX),
        shift({ padding: VIEWPORT_PADDING_PX }),
        size({ padding: VIEWPORT_PADDING_PX, apply: capToAvailableHeight }),
    ];
}

export function useDownwardAnchor(align: 'start' | 'end') {
    const { refs, floatingStyles } = useFloating({
        placement: `bottom-${align}`,
        strategy: 'fixed',
        whileElementsMounted: autoUpdate,
        middleware: downwardMiddleware(),
    });
    return { setReference: refs.setReference, setFloating: refs.setFloating, floatingStyles };
}
