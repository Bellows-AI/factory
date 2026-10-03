/**
 * The foundation's whole glyph set (redesign plan §1.6), drawn on a 24px grid for a 1.75px round
 * stroke. Hand-drawn in the Lucide idiom rather than imported: no dependency, and the set is
 * frozen — a lane that needs a glyph asks the foundation for it, it does not add one here.
 */
const GLYPHS = {
    home: ['M3 10.5 12 3l9 7.5', 'M5 9v11h5v-6h4v6h5V9'],
    list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
    settings: [
        'M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
        'M5 12a7 7 0 1 0 14 0a7 7 0 1 0 -14 0',
        'M12 2v3',
        'M12 19v3',
        'M2 12h3',
        'M19 12h3',
        'M4.93 4.93l2.12 2.12',
        'M16.95 16.95l2.12 2.12',
        'M4.93 19.07l2.12-2.12',
        'M16.95 7.05l2.12-2.12',
    ],
    plus: ['M12 5v14', 'M5 12h14'],
    search: ['M4 11a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', 'M20 20l-4-4'],
    'chevron-down': ['M6 9l6 6 6-6'],
    'chevron-right': ['M9 6l6 6-6 6'],
    'arrow-left': ['M19 12H5', 'M12 19l-7-7 7-7'],
    'arrow-right': ['M5 12h14', 'M12 5l7 7-7 7'],
    x: ['M18 6 6 18', 'M6 6l12 12'],
    check: ['M20 6 9 17l-5-5'],
    'check-circle': ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M8.5 12l2.5 2.5 5-5'],
    'alert-circle': ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M12 8v4', 'M12 16h.01'],
    'alert-triangle': [
        'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
        'M12 9v4',
        'M12 17h.01',
    ],
    info: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M12 16v-4', 'M12 8h.01'],
    clock: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M12 7v5l3 2'],
    'circle-dot': ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'],
    'minus-circle': ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M8 12h8'],
    refresh: ['M21 12a9 9 0 1 1-2.64-6.36L21 8', 'M21 3v5h-5'],
    'external-link': ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
    copy: [
        'M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z',
        'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
    ],
    'git-branch': [
        'M6 3v12',
        'M15 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
        'M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
        'M18 9a9 9 0 0 1-9 9',
    ],
    'git-pull-request': [
        'M3 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
        'M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
        'M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
        'M6 9v6',
        'M18 15V8a2 2 0 0 0-2-2h-5',
        'M14 3l-3 3 3 3',
    ],
    repo: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z', 'M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5'],
    user: ['M8 8a4 4 0 1 0 8 0a4 4 0 1 0 -8 0', 'M4 21a8 8 0 0 1 16 0'],
    users: [
        'M5 8a4 4 0 1 0 8 0a4 4 0 1 0 -8 0',
        'M2 21a7 7 0 0 1 14 0',
        'M16 4.13a4 4 0 0 1 0 7.75',
        'M22 21a7 7 0 0 0-4-6.3',
    ],
    layers: ['M12 2l10 5-10 5L2 7z', 'M2 12l10 5 10-5', 'M2 17l10 5 10-5'],
    sparkles: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'M19 15v4', 'M17 17h4', 'M5 3v4', 'M3 5h4'],
    terminal: ['M4 17l6-6-6-6', 'M12 19h8'],
    file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
    sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
    menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
    'more-horizontal': ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
    calendar: [
        'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
        'M16 2v4',
        'M8 2v4',
        'M3 10h18',
    ],
} satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof GLYPHS;

export const ICON_NAMES = Object.keys(GLYPHS) as IconName[];

/**
 * One glyph in the text color (`currentColor`), so a pill, banner or button tints it by setting
 * its own `color`. Decorative by default — `aria-hidden`, because the text beside it carries the
 * meaning; pass `label` only when the icon stands alone, and it becomes a named image.
 */
export function Icon({ name, size = 16, label }: { name: IconName; size?: number; label?: string }) {
    return (
        <svg
            className="icon"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            role={label ? 'img' : undefined}
            aria-label={label}
            aria-hidden={label ? undefined : true}
        >
            {GLYPHS[name].map((d) => (
                <path key={d} d={d} />
            ))}
        </svg>
    );
}
