/**
 * The redesign's screenshot matrix: every reference shot is taken in both themes at the desktop
 * and phone widths the plan reviews (baseline gallery, specimen). One home, so the "before" and
 * the reference sheets cannot drift to different sizes.
 */
export const THEMES = ['dark', 'light'] as const;

export type Theme = (typeof THEMES)[number];

export const VIEWPORTS = [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
] as const;

/** The responsive/accessibility matrix's widths (issue 287): the narrowest supported phone, a
 * common phone, the compact shell, a narrow desktop, and the reference desktop. */
export const MATRIX_VIEWPORTS = [
    { width: 320, height: 844 },
    { width: 390, height: 844 },
    { width: 768, height: 1000 },
    { width: 1024, height: 1000 },
    { width: 1440, height: 1000 },
] as const;
