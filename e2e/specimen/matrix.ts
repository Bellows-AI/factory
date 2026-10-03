/**
 * The specimen grid's axes (redesign plan §1.7), spelled once: the page renders them as its row
 * and column headers, and the spec asserts every one is on screen, so a row cannot be dropped
 * from the page without the check noticing.
 */
export const COLUMNS = ['Default', 'Selected', 'Invalid', 'Disabled', 'Busy', 'Long content'] as const;

export type Column = (typeof COLUMNS)[number];

export const ROWS = [
    'Selector (closed)',
    'Selector (open)',
    'Primary button',
    'Secondary button',
    'Destructive button',
    'Text field',
    'Textarea',
    'Checkbox',
    'Pill',
    'Filter chip',
    'Banner (warn)',
    'Banner (bad)',
    'Banner (info)',
    'Dialog',
    'Disclosure (closed)',
    'Disclosure (open)',
    'Table row',
    'Row actions',
    'Avatar',
    'Kbd',
] as const;

export type Row = (typeof ROWS)[number];

/** A cell's `data-cell` id: the page stamps it, the spec finds its targets by it. */
export const cellId = (row: Row, column: Column) => `${row}/${column}`;

/** Sixty characters with no break opportunity: what a primitive does with a label it cannot wrap. */
export const LONG_LABEL = 'W'.repeat(60);

/** The organization the open-selector row's trigger names; the spec clicks it by this name. */
export const OPEN_SELECTOR_ORG = 'Acme Robotics';
