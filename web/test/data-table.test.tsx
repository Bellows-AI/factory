import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
    compareValues,
    DataTable,
    defaultDirectionFor,
    sortRows,
    type DataTableColumn,
    type SortState,
} from '../src/components/DataTable.js';

/**
 * The table's sorting is pure and exported, so the ordering rules — nulls last in both
 * directions, stable ties, sort-by-value-not-by-rendered-text — are unit-tested directly.
 * The markup suite renders with react-dom/server, which sees state as rendered but not
 * events: the click behavior (default direction, toggle) lives in the pure helpers, and
 * React keys are not serialized, so row-key stability is enforced by the `rowKey` prop's
 * position in the contract rather than observed here.
 */

interface Row {
    id: string;
    name: string;
    size: number | null;
}

const row = (id: string, name: string, size: number | null): Row => ({ id, name, size });

const COLUMNS: DataTableColumn<Row>[] = [
    { key: 'name', label: 'Name', cell: (r) => r.name },
    { key: 'size', label: 'Size', cell: (r) => r.size, sortValue: (r) => r.size, align: 'end' },
];

describe('compareValues', () => {
    it('orders strings by locale and numbers numerically', () => {
        expect(compareValues('a', 'b')).toBeLessThan(0);
        expect(compareValues(2, 10)).toBeLessThan(0); // lexicographic would put '10' first
        expect(compareValues(10, 2)).toBeGreaterThan(0);
    });

    it('ranks null after every real value, in either argument position', () => {
        const MEASURED = 5;
        expect(compareValues(null, MEASURED)).toBeGreaterThan(0);
        expect(compareValues(MEASURED, null)).toBeLessThan(0);
        expect(compareValues(null, 'a')).toBeGreaterThan(0);
        expect(compareValues(null, null)).toBe(0);
    });

    it('keeps a total order over mixed kinds, never NaN', () => {
        const MEASURED = 5;
        const mixed = compareValues(MEASURED, 'a');
        expect(Number.isNaN(mixed)).toBe(false);
        expect(mixed).toBeLessThan(0); // numbers order before strings, deterministically
    });

    it('ranks a NaN like an unmeasured value, so one can never poison the order', () => {
        const MEASURED = 5;
        expect(compareValues(Number.NaN, MEASURED)).toBeGreaterThan(0);
        expect(compareValues(MEASURED, Number.NaN)).toBeLessThan(0);
        expect(Number.isNaN(compareValues(Number.NaN, Number.NaN))).toBe(false);
    });
});

describe('sortRows', () => {
    it('sorts numbers both directions', () => {
        const SIZE_A = 3;
        const SIZE_B = 1;
        const SIZE_C = 2;
        const rows = [row('a', 'a', SIZE_A), row('b', 'b', SIZE_B), row('c', 'c', SIZE_C)];
        const asc = sortRows(rows, COLUMNS, { key: 'size', direction: 'ascending' });
        expect(asc.map((r) => r.size)).toEqual([SIZE_B, SIZE_C, SIZE_A]);
        const desc = sortRows(rows, COLUMNS, { key: 'size', direction: 'descending' });
        expect(desc.map((r) => r.size)).toEqual([SIZE_A, SIZE_C, SIZE_B]);
    });

    it('sorts strings both directions', () => {
        const rows = [row('a', 'pear', 1), row('b', 'apple', 1), row('c', 'fig', 1)];
        const byName: DataTableColumn<Row>[] = [
            { key: 'name', label: 'Name', cell: (r) => r.name, sortValue: (r) => r.name },
        ];
        expect(sortRows(rows, byName, { key: 'name', direction: 'ascending' }).map((r) => r.name)).toEqual([
            'apple',
            'fig',
            'pear',
        ]);
        expect(sortRows(rows, byName, { key: 'name', direction: 'descending' }).map((r) => r.name)).toEqual([
            'pear',
            'fig',
            'apple',
        ]);
    });

    it('sorts numeric timestamps chronologically', () => {
        const TIMESTAMP_MID = 1_700_000_000;
        const TIMESTAMP_EARLY = 1_600_000_000;
        const TIMESTAMP_LATE = 1_800_000_000;
        const rows = [row('a', 'a', TIMESTAMP_MID), row('b', 'b', TIMESTAMP_EARLY), row('c', 'c', TIMESTAMP_LATE)];
        expect(sortRows(rows, COLUMNS, { key: 'size', direction: 'ascending' }).map((r) => r.id)).toEqual([
            'b',
            'a',
            'c',
        ]);
    });

    it('keeps nulls last in BOTH directions — never the -Infinity inversion', () => {
        const SIZE_B = 5;
        const rows = [row('a', 'a', null), row('b', 'b', SIZE_B), row('c', 'c', 1)];
        const asc = sortRows(rows, COLUMNS, { key: 'size', direction: 'ascending' });
        const desc = sortRows(rows, COLUMNS, { key: 'size', direction: 'descending' });
        expect(asc.map((r) => r.id)).toEqual(['c', 'b', 'a']);
        expect(desc.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    });

    it('partitions a NaN with the unmeasured, so descending cannot float it to the top', () => {
        const SIZE_B = 5;
        const rows = [row('a', 'a', Number.NaN), row('b', 'b', SIZE_B), row('c', 'c', 1)];
        const desc = sortRows(rows, COLUMNS, { key: 'size', direction: 'descending' });
        expect(desc.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    });

    it('breaks ties with the original order, so equal values are stable', () => {
        const rows = [row('a', 'first', 1), row('b', 'second', 1), row('c', 'third', 0)];
        const desc = sortRows(rows, COLUMNS, { key: 'size', direction: 'descending' });
        expect(desc.map((r) => r.name)).toEqual(['first', 'second', 'third']);
        const ties = [row('x', 'x', 1), row('y', 'y', 1), row('z', 'z', 1)];
        expect(sortRows(ties, COLUMNS, { key: 'size', direction: 'descending' }).map((r) => r.id)).toEqual([
            'x',
            'y',
            'z',
        ]);
        // And the same holds with nulls in the mix: nulls keep their own arrival order.
        const withNulls = [row('n1', 'n1', null), row('n2', 'n2', null)];
        expect(sortRows(withNulls, COLUMNS, { key: 'size', direction: 'ascending' }).map((r) => r.id)).toEqual([
            'n1',
            'n2',
        ]);
    });

    it('sorts by the sort value, never the rendered cell text', () => {
        // The cell renders the raw number; a formatted cell ('1.2M') would sort as text.
        const rows = [row('a', 'a', 10), row('b', 'b', 2)];
        const rendered: DataTableColumn<Row>[] = [
            { key: 'size', label: 'Size', cell: (r) => `${r.size}`, sortValue: (r) => r.size },
        ];
        expect(sortRows(rows, rendered, { key: 'size', direction: 'ascending' }).map((r) => r.size)).toEqual([2, 10]);
    });

    it('returns a copy and leaves the input untouched', () => {
        const SIZE_A = 3;
        const rows = [row('a', 'a', SIZE_A), row('b', 'b', 1)];
        const sorted = sortRows(rows, COLUMNS, { key: 'size', direction: 'ascending' });
        expect(sorted).not.toBe(rows);
        expect(rows.map((r) => r.size)).toEqual([SIZE_A, 1]);
    });

    it('falls back to the original order when the key names no sortable column', () => {
        const SIZE_A = 3;
        const rows = [row('a', 'a', SIZE_A), row('b', 'b', 1)];
        expect(sortRows(rows, COLUMNS, { key: 'missing', direction: 'ascending' }).map((r) => r.id)).toEqual([
            'a',
            'b',
        ]);
    });
});

describe('defaultDirectionFor', () => {
    it('opens numbers descending and text ascending', () => {
        const SIZE_A = 5;
        const rows = [row('a', 'alpha', SIZE_A), row('b', 'beta', null)];
        expect(defaultDirectionFor(rows, COLUMNS, 'size')).toBe('descending');
        expect(defaultDirectionFor(rows, COLUMNS, 'name')).toBe('ascending');
    });

    it('skips unmeasured values to classify the column, and opens ascending when nothing is measured', () => {
        const SIZE_C = 7;
        const rows = [row('a', 'a', null), row('b', 'b', null), row('c', 'c', SIZE_C)];
        expect(defaultDirectionFor(rows, COLUMNS, 'size')).toBe('descending');
        const empty: Row[] = [];
        expect(defaultDirectionFor(empty, COLUMNS, 'size')).toBe('ascending');
    });
});

describe('DataTable markup', () => {
    const SIZE_ALPHA = 10;
    const SIZE_BETA = 30;
    const SIZE_GAMMA = 20;
    const ROWS: Row[] = [row('r1', 'alpha', SIZE_ALPHA), row('r2', 'beta', SIZE_BETA), row('r3', 'gamma', SIZE_GAMMA)];

    const render = (props: {
        rows?: Row[];
        initialSort?: SortState;
        empty?: string;
        columns?: DataTableColumn<Row>[];
    }) =>
        renderToStaticMarkup(
            <DataTable
                labelledBy="table-heading"
                rows={props.rows ?? ROWS}
                columns={props.columns ?? COLUMNS}
                rowKey={(r) => r.id}
                initialSort={props.initialSort}
                empty={props.empty ?? 'nothing here'}
            />
        );

    it('renders sortable headers as real buttons inside the th', () => {
        const html = render({});
        expect(html).toContain('<button type="button"');
        expect(html).toContain('>Size</button>');
    });

    it('omits aria-sort when no column is active, and owns it only on the active one', () => {
        expect(render({})).not.toContain('aria-sort');
        const asc = render({ initialSort: { key: 'size', direction: 'ascending' } });
        expect(asc.match(/aria-sort="ascending"/g)).toHaveLength(1);
        expect(asc).not.toContain('aria-sort="descending"');
        const desc = render({ initialSort: { key: 'size', direction: 'descending' } });
        expect(desc.match(/aria-sort="descending"/g)).toHaveLength(1);
    });

    it('marks the active sort with a shape class, not color alone', () => {
        expect(render({ initialSort: { key: 'size', direction: 'ascending' } })).toContain('class="sortable asc');
        expect(render({ initialSort: { key: 'size', direction: 'descending' } })).toContain('class="sortable desc');
    });

    it('honors the initial sort in the rendered row order', () => {
        const html = render({ initialSort: { key: 'size', direction: 'descending' } });
        expect(html.indexOf('beta')).toBeLessThan(html.indexOf('gamma'));
        expect(html.indexOf('gamma')).toBeLessThan(html.indexOf('alpha'));
    });

    it('renders a labeled, keyboard-focusable scroll region', () => {
        const html = render({});
        expect(html).toContain('<section class="table-wrap"');
        expect(html).toContain('aria-labelledby="table-heading"');
        expect(html).toContain('tabindex="0"');
    });

    it('renders the empty node instead of a table when there are no rows', () => {
        const html = render({ rows: [], empty: 'no sessions measured' });
        expect(html).toContain('no sessions measured');
        expect(html).not.toContain('<table');
    });

    it('renders rich cells and aligns numeric columns end', () => {
        const columns: DataTableColumn<Row>[] = [
            { key: 'name', label: 'Name', cell: (r) => <strong>{r.name}</strong> },
            { key: 'size', label: 'Size', cell: (r) => r.size, sortValue: (r) => r.size, align: 'end' },
        ];
        const html = render({ columns });
        expect(html).toContain('<strong>alpha</strong>');
        expect(html.match(/class="[^"]*align-end"/g)?.length).toBe(ROWS.length + 1); // th + one per row
    });

    it('leaves non-sortable columns as plain header text', () => {
        const columns: DataTableColumn<Row>[] = [{ key: 'name', label: 'Name', cell: (r) => r.name }];
        const html = render({ columns });
        expect(html).not.toContain('<button');
        expect(html).not.toContain('sortable');
        expect(html).toContain('>Name</th>');
    });

    it('never marks a non-sortable column as the active sort, however bad the initialSort', () => {
        const columns: DataTableColumn<Row>[] = [{ key: 'name', label: 'Name', cell: (r) => r.name }];
        const html = render({ columns, initialSort: { key: 'name', direction: 'ascending' } });
        expect(html).not.toContain('aria-sort');
        expect(html).not.toContain('sortable');
    });

    it('names a compact cell for the screen reader when the column gives a name', () => {
        // "4k" on the page announces as the exact figure; a column without a name keeps its
        // text as the name.
        const columns: DataTableColumn<Row>[] = [
            {
                key: 'size',
                label: 'Size',
                cell: (r) => r.size,
                sortValue: (r) => r.size,
                align: 'end',
                name: (r) => (r.size === null ? undefined : `${r.size} bytes measured`),
            },
        ];
        const SIZE_BYTES = 4096;
        const html = render({ columns, rows: [row('r1', 'alpha', SIZE_BYTES)] });
        expect(html).toContain('aria-label="4096 bytes measured"');
        const unnamed: DataTableColumn<Row>[] = [{ key: 'name', label: 'Name', cell: (r) => r.name }];
        expect(render({ columns: unnamed, rows: [row('r1', 'alpha', 1)] })).not.toContain('aria-label=');
    });
});
