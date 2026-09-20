import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataTable } from '../src/components/DataTable.js';
import type { DataTableProps } from '../src/components/DataTable.js';

/**
 * The shared table's contract, pinned in markup because the suite has no DOM: sort controls are
 * real buttons, `aria-sort` names the one active column, sorting reads raw values rather than
 * rendered strings, nulls sink in both directions, and rows carry caller-chosen stable keys.
 */

interface Row {
    id: string;
    name: string;
    size: number | null;
}

const row = (id: string, name: string, size: number | null): Row => ({ id, name, size });

const columns = [
    { key: 'name', label: 'Name' },
    { key: 'size', label: 'Size', numeric: true, render: (r: Row) => `${r.size} B` },
] as const;

afterEach(() => {
    vi.restoreAllMocks();
});

describe('DataTable', () => {
    it('renders sortable headers as real buttons', () => {
        const html = renderToStaticMarkup(
            <DataTable
                columns={[...columns]}
                rows={[row('a', 'alpha', 1)]}
                rowKey={(r) => r.id}
                ariaLabel="Sizes"
                sortable
            />
        );
        expect(html).toMatch(/<th[^>]*><button type="button"[^>]*>Name<\/button><\/th>/);
        expect(html).toMatch(/<th[^>]*><button type="button"[^>]*>Size<\/button><\/th>/);
    });

    it('marks only the active column aria-sort, from the initial sort', () => {
        const html = renderToStaticMarkup(
            <DataTable
                columns={[...columns]}
                rows={[row('a', 'alpha', 1)]}
                rowKey={(r) => r.id}
                ariaLabel="Sizes"
                sortable
                initialSort={{ key: 'size', descending: true }}
            />
        );
        expect(html).toMatch(/<th[^>]*aria-sort="descending"[^>]*><button[^>]*>Size<\/button>/);
        expect(html).not.toContain('aria-sort="ascending"');
        // Non-active columns carry no aria-sort at all — the attribute follows the active column.
        expect(html.match(/aria-sort/g)).toHaveLength(1);
    });

    it('sorts by raw values, never the rendered string', () => {
        // Rendered sizes are "9 B" and "10 B": a string sort would put "10 B" first descending
        // ("1" < "9"). The raw numbers must decide, so 10 renders first.
        const html = renderToStaticMarkup(
            <DataTable
                columns={[...columns]}
                rows={[row('a', 'nine', 9), row('b', 'ten', 10)]}
                rowKey={(r) => r.id}
                ariaLabel="Sizes"
                sortable
                initialSort={{ key: 'size', descending: true }}
            />
        );
        expect(html.indexOf('ten')).toBeLessThan(html.indexOf('nine'));
    });

    it('sinks nulls last in both directions', () => {
        // The unmeasured row comes FIRST in the input, so insertion order can never pass this
        // by accident: sorting must actually move it.
        const rows = [row('b', 'unmeasured', null), row('a', 'measured', 5)];
        const asc = renderToStaticMarkup(
            <DataTable
                columns={[...columns]}
                rows={rows}
                rowKey={(r) => r.id}
                ariaLabel="Sizes"
                sortable
                initialSort={{ key: 'size', descending: false }}
            />
        );
        expect(asc.indexOf('measured')).toBeLessThan(asc.indexOf('unmeasured'));
        const desc = renderToStaticMarkup(
            <DataTable
                columns={[...columns]}
                rows={rows}
                rowKey={(r) => r.id}
                ariaLabel="Sizes"
                sortable
                initialSort={{ key: 'size', descending: true }}
            />
        );
        expect(desc.indexOf('measured')).toBeLessThan(desc.indexOf('unmeasured'));
    });

    it('sorts by the column accessor when one is given, not the field', () => {
        const accessored = [{ key: 'name', label: 'Name', sort: (r: Row) => r.size }] as DataTableProps<Row>['columns'];
        const html = renderToStaticMarkup(
            <DataTable
                columns={accessored}
                rows={[row('b', 'small', 2), row('a', 'big', 100)]}
                rowKey={(r) => r.id}
                ariaLabel="Sizes"
                sortable
                initialSort={{ key: 'name', descending: true }}
            />
        );
        expect(html.indexOf('big')).toBeLessThan(html.indexOf('small'));
    });

    it('keys rows by the caller-chosen row key', () => {
        const key = vi.fn((r: Row) => r.id);
        renderToStaticMarkup(
            <DataTable
                columns={[...columns]}
                rows={[row('a', 'alpha', 1), row('b', 'beta', 2)]}
                rowKey={key}
                ariaLabel="Sizes"
            />
        );
        expect(key.mock.calls.map(([r]) => r.id)).toEqual(['a', 'b']);
    });

    it('right-aligns numeric columns in header and cells', () => {
        const html = renderToStaticMarkup(
            <DataTable
                columns={[...columns]}
                rows={[row('a', 'alpha', 1)]}
                rowKey={(r) => r.id}
                ariaLabel="Sizes"
                sortable
            />
        );
        expect(html).toMatch(/<th[^>]*class="[^"]*num[^"]*"[^>]*><button[^>]*>Size<\/button>/);
        expect(html).toMatch(/<td class="num"/);
        expect(html).not.toMatch(/<th[^>]*class="[^"]*num[^"]*"[^>]*><button[^>]*>Name<\/button>/);
    });

    it('labels the focusable scroll region', () => {
        const html = renderToStaticMarkup(
            <DataTable columns={[...columns]} rows={[row('a', 'alpha', 1)]} rowKey={(r) => r.id} ariaLabel="Sizes" />
        );
        // A named <section> carries the region role implicitly; tabIndex makes it reachable.
        expect(html).toMatch(/<section class="table-wrap" aria-label="Sizes" tabindex="0">/);
    });

    it('renders the empty state instead of a table when there are no rows', () => {
        const html = renderToStaticMarkup(
            <DataTable
                columns={[...columns]}
                rows={[]}
                rowKey={(r) => r.id}
                ariaLabel="Sizes"
                empty={<p>No sizes yet.</p>}
            />
        );
        expect(html).toContain('No sizes yet.');
        expect(html).not.toContain('<table');
    });

    it('renders a named cell for the screen reader when the accessor gives one', () => {
        const named = [
            { key: 'size', label: 'Size', name: (r: Row) => `${r.size} bytes measured` },
        ] as DataTableProps<Row>['columns'];
        const html = renderToStaticMarkup(
            <DataTable columns={named} rows={[row('a', 'alpha', 4096)]} rowKey={(r) => r.id} ariaLabel="Sizes" />
        );
        expect(html).toContain('4096 bytes measured');
    });
});
