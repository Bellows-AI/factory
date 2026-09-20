import { useMemo, useState } from 'react';
import type { Key, ReactNode } from 'react';

/**
 * What a column orders by. null means the value was never measured, and always sorts last.
 * A column without a `sortValue` is not sortable at all.
 */
export type SortValue = string | number | null;

export type SortDirection = 'ascending' | 'descending';

export interface SortState {
    key: string;
    direction: SortDirection;
}

export interface DataTableColumn<T> {
    key: string;
    label: ReactNode;
    /** The cell's content, already formatted for reading — sorting never looks at it. */
    cell: (row: T) => ReactNode;
    sortValue?: (row: T) => SortValue;
    /** `end` right-aligns the column, for figures. */
    align?: 'start' | 'end';
}

export interface DataTableProps<T> {
    /**
     * The id of the element that names this table — usually the section heading — so the
     * scroll region below can carry a programmatic label.
     */
    labelledBy: string;
    rows: readonly T[];
    columns: readonly DataTableColumn<T>[];
    /** Stable domain keys (a session id, a login), never an array index. */
    rowKey: (row: T) => Key;
    initialSort?: SortState;
    empty: ReactNode;
}

/**
 * Ascending comparison of two sort values: strings locale-compare, numbers and numeric
 * timestamps sort numerically. Nulls rank after every real value — in both directions, so
 * callers flip the sign only around non-null pairs. Mixed kinds cannot arise from a
 * well-typed column, but the result stays a total order (numbers before strings) so the
 * sort can never see a NaN and reshuffle at random.
 */
export function compareValues(a: SortValue, b: SortValue): number {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return typeof a === 'number' ? -1 : 1;
}

/**
 * The direction a column's first activation opens in: figures and timestamps open descending
 * (biggest or most recent first), text opens ascending, and nothing measured opens ascending.
 * Classified from the column's first non-null sort value, so this stays a pure function.
 */
export function defaultDirectionFor<T>(
    rows: readonly T[],
    columns: readonly DataTableColumn<T>[],
    key: string
): SortDirection {
    const sortValueOf = columns.find((c) => c.key === key)?.sortValue;
    if (!sortValueOf) return 'ascending';
    for (const row of rows) {
        const value = sortValueOf(row);
        if (value !== null) return typeof value === 'string' ? 'ascending' : 'descending';
    }
    return 'ascending';
}

/**
 * Sorts a copy of `rows` by one column's sort values — never by the rendered cells, which are
 * formatted for reading ("1.2M", "4 min ago") and would order as text. Nulls stay last in both
 * directions, and equal values keep their original order through a source-index tie-breaker:
 * a stable sort is the only kind a table can promise, since rows re-render on every poll.
 */
export function sortRows<T>(rows: readonly T[], columns: readonly DataTableColumn<T>[], state: SortState): T[] {
    const sortValueOf = columns.find((c) => c.key === state.key)?.sortValue;
    if (!sortValueOf) return [...rows];
    const measured: { row: T; value: string | number; index: number }[] = [];
    const unmeasured: { row: T; index: number }[] = [];
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index] as T;
        const value = sortValueOf(row);
        if (value === null) unmeasured.push({ row, index });
        else measured.push({ row, value, index });
    }
    measured.sort((a, b) => {
        const ordered =
            state.direction === 'descending' ? -compareValues(a.value, b.value) : compareValues(a.value, b.value);
        return ordered !== 0 ? ordered : a.index - b.index;
    });
    return [...measured, ...unmeasured].map((entry) => entry.row);
}

/**
 * The shared sortable table: the whole header cell of a sortable column is a real button
 * (keyboard-reachable, unlike a click handler on the th), and `aria-sort` is owned only by
 * the column actually sorted. The wrapper is a labeled, focusable scroll region — a wide
 * table scrolls inside it, and the page never gains horizontal overflow.
 */
export function DataTable<T>({ labelledBy, rows, columns, rowKey, initialSort, empty }: DataTableProps<T>) {
    const [sort, setSort] = useState<SortState | null>(initialSort ?? null);

    const sorted = useMemo(() => (sort ? sortRows(rows, columns, sort) : [...rows]), [rows, columns, sort]);

    const activate = (column: DataTableColumn<T>) =>
        setSort((current) =>
            current?.key === column.key
                ? { key: column.key, direction: current.direction === 'ascending' ? 'descending' : 'ascending' }
                : { key: column.key, direction: defaultDirectionFor(rows, columns, column.key) }
        );

    return (
        // Scroll rather than spill: cells are nowrap, so the table is as wide as its content
        // needs. A named section is the region landmark; focusable so keyboard users can reach
        // the scrolled columns too (the WCAG focusable-scroll-area pattern).
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable or its overflow is unreachable
        <section className="table-wrap" aria-labelledby={labelledBy} tabIndex={0}>
            {rows.length === 0 ? (
                empty
            ) : (
                <table className="data">
                    <thead>
                        <tr>
                            {columns.map((column) => {
                                const active = sort !== null && sort.key === column.key;
                                const direction = active && sort ? sort.direction : null;
                                const align = column.align === 'end' ? ' align-end' : '';
                                const className = column.sortValue
                                    ? `sortable${direction ? (direction === 'ascending' ? ' asc' : ' desc') : ''}${align}`
                                    : align.trim();
                                return (
                                    <th
                                        key={column.key}
                                        scope="col"
                                        className={className || undefined}
                                        aria-sort={direction ?? undefined}
                                    >
                                        {column.sortValue ? (
                                            <button type="button" onClick={() => activate(column)}>
                                                {column.label}
                                            </button>
                                        ) : (
                                            column.label
                                        )}
                                    </th>
                                );
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((row) => (
                            <tr key={rowKey(row)}>
                                {columns.map((column) => (
                                    <td key={column.key} className={column.align === 'end' ? 'align-end' : undefined}>
                                        {column.cell(row)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
}
