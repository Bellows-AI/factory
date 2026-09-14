import { useMemo, useState } from 'react';

export interface Column<T> {
    key: keyof T & string;
    label: string;
    format?: (row: T) => string;
}

export interface DataTableProps<T> {
    columns: Column<T>[];
    rows: T[];
    sortable?: boolean;
}

interface SortState<T> {
    key: keyof T & string;
    descending: boolean;
}

export function DataTable<T extends object>({ columns, rows, sortable = false }: DataTableProps<T>) {
    const [sort, setSort] = useState<SortState<T> | null>(null);

    const sorted = useMemo(() => {
        if (!sort) return rows;
        const { key, descending } = sort;
        return [...rows].sort((a, b) => {
            const x = a[key] as unknown;
            const y = b[key] as unknown;
            // Nulls sink to the bottom rather than sorting as zero.
            const cmp =
                typeof x === 'string'
                    ? x.localeCompare(y as string)
                    : ((x as number) ?? -Infinity) - ((y as number) ?? -Infinity);
            return descending ? -cmp : cmp;
        });
    }, [rows, sort]);

    const toggle = (key: keyof T & string) =>
        setSort((current) =>
            current?.key === key ? { key, descending: !current.descending } : { key, descending: true }
        );

    return (
        // Scroll rather than spill: cells are nowrap, so the table is as wide as its content
        // needs. Repo-qualified PR labels widened it past the panel, and the columns at the far
        // right — attribution among them — were silently clipped.
        <div className="table-wrap">
            <table className="data">
                <thead>
                    <tr>
                        {columns.map((column) => {
                            const active = sort?.key === column.key;
                            const direction = active ? (sort.descending ? 'desc' : 'asc') : '';
                            return (
                                <th
                                    key={column.key}
                                    className={sortable ? `sortable ${direction}`.trim() : undefined}
                                    aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
                                    onClick={sortable ? () => toggle(column.key) : undefined}
                                >
                                    {column.label}
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {sorted.map((row, i) => (
                        <tr key={i}>
                            {columns.map((column) => {
                                const value = column.format ? column.format(row) : (row[column.key] as unknown);
                                return (
                                    <td key={column.key}>
                                        {value === null || value === undefined ? '—' : String(value)}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
