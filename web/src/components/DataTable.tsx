import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export interface Column<T> {
    key: keyof T & string;
    label: string;
    /** Cell content; the default renders the raw field, an em dash for null/undefined. */
    render?: (row: T) => ReactNode;
    /** Right-aligns header and cells: a numeric column, figures aligned by digit. */
    numeric?: boolean;
    /** What sorting reads — always a raw value, never the rendered string. Default: the field. */
    sort?: (row: T) => number | string | null;
    /** The cell's accessible name when the visible text is compact, e.g. an exact figure. */
    name?: (row: T) => string | undefined;
}

export interface DataTableProps<T> {
    columns: Column<T>[];
    rows: T[];
    sortable?: boolean;
    /** Stable React keys — an index key scrambles when the sort reorders the rows. */
    rowKey: (row: T) => string;
    /** Applied before the first user click; a click then overrides it. Default: given order. */
    initialSort?: { key: keyof T & string; descending?: boolean };
    /** The scroll region's accessible name — the table scrolls rather than shrinking. */
    ariaLabel: string;
    /** Rendered instead of the table when `rows` is empty: one region-level empty state. */
    empty?: ReactNode;
}

interface SortState<T> {
    key: keyof T & string;
    descending: boolean;
}

export function DataTable<T extends object>({
    columns,
    rows,
    sortable = false,
    rowKey,
    initialSort,
    ariaLabel,
    empty,
}: DataTableProps<T>) {
    const [sort, setSort] = useState<SortState<T> | null>(
        initialSort ? { key: initialSort.key, descending: initialSort.descending ?? true } : null
    );

    const sorted = useMemo(() => {
        if (!sort) return rows;
        const column = columns.find((c) => c.key === sort.key);
        if (!column) return rows;
        const read = (row: T): number | string | null =>
            column.sort ? column.sort(row) : (row[sort.key] as number | string | null);
        const { key, descending } = sort;
        return [...rows].sort((a, b) => {
            const x = read(a);
            const y = read(b);
            // Nulls sink to the bottom in BOTH directions — an unmeasured value is not a very
            // small one, and it must not surface because the sort flipped.
            if (x === null && y === null) return 0;
            if (x === null) return 1;
            if (y === null) return -1;
            const cmp = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
            return descending ? -cmp : cmp;
        });
    }, [rows, columns, sort]);

    const toggle = (key: keyof T & string) =>
        setSort((current) =>
            current?.key === key ? { key, descending: !current.descending } : { key, descending: true }
        );

    return (
        // Scroll rather than spill: cells are nowrap, so the table is as wide as its content
        // needs. Repo-qualified PR labels widened it past the panel, and the columns at the far
        // right — attribution among them — were silently clipped. The region (a named <section>,
        // which carries the region role implicitly) is keyboard-focusable so a pointerless
        // reader can still reach a scrolled-off column — the intentional exception
        // noNoninteractiveTabindex exists for scrollable regions.
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard focusable (WCAG 2.1 focusable-scrollable-region)
        <section className="table-wrap" aria-label={ariaLabel} tabIndex={0}>
            {rows.length === 0 && empty !== undefined ? (
                empty
            ) : (
                <table className="data">
                    <thead>
                        <tr>
                            {columns.map((column) => {
                                const active = sort?.key === column.key;
                                const header = sortable ? (
                                    <button type="button" onClick={() => toggle(column.key)}>
                                        {column.label}
                                    </button>
                                ) : (
                                    column.label
                                );
                                return (
                                    <th
                                        key={column.key}
                                        scope="col"
                                        className={[
                                            column.numeric ? 'num' : '',
                                            active && sort ? (sort.descending ? 'desc' : 'asc') : '',
                                        ]
                                            .filter(Boolean)
                                            .join(' ')}
                                        // `aria-sort` follows the active column: present there, absent
                                        // everywhere else.
                                        aria-sort={
                                            active && sort ? (sort.descending ? 'descending' : 'ascending') : undefined
                                        }
                                    >
                                        {header}
                                    </th>
                                );
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((row) => (
                            <tr key={rowKey(row)}>
                                {columns.map((column) => {
                                    const raw = row[column.key] as unknown;
                                    // A raw field renders as itself — string, number, or a caller's node.
                                    const value = column.render ? column.render(row) : (raw as ReactNode);
                                    const name = column.name?.(row);
                                    return (
                                        <td
                                            key={column.key}
                                            className={column.numeric ? 'num' : undefined}
                                            aria-label={name}
                                        >
                                            {value === null || value === undefined ? '—' : value}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
}
