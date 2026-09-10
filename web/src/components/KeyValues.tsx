import type { ReactNode } from 'react';

/**
 * A label/value list. Values are nodes, not just strings: a row may carry a link (the sidebar's
 * PR row), and a second component per shape would be ceremony, not structure. Labels stay
 * strings — they are the stable keys the reader scans for.
 */
export function KeyValues({ pairs }: { pairs: [string, ReactNode][] }) {
    return (
        <dl className="kv">
            {pairs.map(([label, value]) => (
                <div key={label} style={{ display: 'contents' }}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                </div>
            ))}
        </dl>
    );
}
