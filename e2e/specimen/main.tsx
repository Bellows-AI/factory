import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { OrganizationMeta } from '@factory-ai/core';
import { Icon } from '../../web/src/components/Icon.js';
import { OrgSelector } from '../../web/src/components/OrgSelector.js';
import { PageHeader } from '../../web/src/components/PageHeader.js';
import { RowActions } from '../../web/src/components/RowActions.js';
import { COLUMNS, cellId, LONG_LABEL, OPEN_SELECTOR_ORG, ROWS } from './matrix.js';
import type { Column, Row } from './matrix.js';
import '../../web/src/styles.css';
import './specimen.css';

/**
 * The component-state specimen (redesign plan §1.7): every shared primitive in every state it has,
 * rendered from the app's real stylesheet and real components, in one grid. It is the reference
 * R2–R7 match, so it fakes nothing — no provider, no data, and no class that imitates hover or
 * focus; the spec reaches those states with the pointer and the keyboard.
 *
 * A cell a primitive has no state for is left out and renders as "—".
 */

const orgs = (mode: OrganizationMeta['mode'], name: string): OrganizationMeta => {
    const current = { id: 'org-current', name };
    const available = mode === 'config' ? [current] : [current, { id: 'org-other', name: 'Globex Research' }];
    return { mode, current, available };
};

const noop = () => undefined;

function Field({
    invalid,
    disabled,
    value,
    name,
}: {
    invalid?: boolean;
    disabled?: boolean;
    value?: string;
    name: string;
}) {
    const helpId = `${name}-help`;
    return (
        <div className="specimen-stack">
            <input
                className="field"
                aria-label={name}
                placeholder="owner/repository"
                defaultValue={value}
                disabled={disabled}
                aria-invalid={invalid ? true : undefined}
                aria-describedby={invalid ? helpId : undefined}
            />
            {invalid ? (
                <p className="error" id={helpId}>
                    Enter a repository as owner/name.
                </p>
            ) : null}
        </div>
    );
}

function TextArea({
    invalid,
    disabled,
    value,
    name,
}: {
    invalid?: boolean;
    disabled?: boolean;
    value?: string;
    name: string;
}) {
    const helpId = `${name}-help`;
    return (
        <div className="specimen-stack">
            <textarea
                className="field"
                aria-label={name}
                placeholder="Describe the task"
                rows={3}
                defaultValue={value}
                disabled={disabled}
                aria-invalid={invalid ? true : undefined}
                aria-describedby={invalid ? helpId : undefined}
            />
            {invalid ? (
                <p className="error" id={helpId}>
                    A task needs a description.
                </p>
            ) : null}
        </div>
    );
}

function Checkbox({ checked, disabled, label }: { checked?: boolean; disabled?: boolean; label: string }) {
    return (
        <label className="settings-toggle">
            <input type="checkbox" defaultChecked={checked} disabled={disabled} />
            {label}
        </label>
    );
}

function Banner({
    tone,
    icon,
    title,
}: {
    tone: 'warn' | 'bad' | 'info';
    icon: 'alert-triangle' | 'alert-circle' | 'info';
    title: string;
}) {
    return (
        <div className={`banner-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
            <Icon name={icon} size={24} />
            <div>
                <p className="banner-title">{title}</p>
                <p>The body explains what happened and what to do next.</p>
            </div>
        </div>
    );
}

function DialogPanel({ title, busy }: { title: string; busy?: boolean }) {
    const titleId = `dialog-${busy ? 'busy' : title.length}`;
    return (
        <section className="dialog" role="dialog" aria-labelledby={titleId}>
            <h2 id={titleId}>{title}</h2>
            <p>This permanently deletes the task and its transcript.</p>
            <div className="specimen-row">
                <button type="button" disabled={busy}>
                    Cancel
                </button>
                <button type="button" className="danger" disabled={busy} aria-busy={busy ? true : undefined}>
                    {busy ? 'Removing…' : 'Remove task'}
                </button>
            </div>
        </section>
    );
}

function Disclosure({ open, summary }: { open?: boolean; summary: string }) {
    return (
        <details open={open}>
            <summary>{summary}</summary>
            <p>The disclosed detail: gate output, parameters, the raw log.</p>
        </details>
    );
}

function TableRow({ selected, label }: { selected?: boolean; label: string }) {
    return (
        <table className="data">
            <tbody>
                <tr aria-current={selected ? true : undefined}>
                    <td>{label}</td>
                    <td>
                        <span className="pill pill-ok">Running</span>
                    </td>
                </tr>
            </tbody>
        </table>
    );
}

/** The real primitive (issue 411). The overflow panel is portalled, so the sheet shows the trigger. */
function RowActionsCell({ name, disabled = false }: { name: string; disabled?: boolean }) {
    return (
        <RowActions
            rowName={name}
            // The name is the inline label too, so the Long-content column shows what the primitive
            // does with one rather than hiding it in the trigger's accessible name.
            primary={{ label: name === 'Main ORG' ? 'Edit' : name, onSelect: () => {} }}
            actions={[
                { label: 'Make personal', onSelect: () => {} },
                { label: 'Delete', onSelect: () => {}, danger: true },
            ]}
            disabled={disabled}
        />
    );
}

const button = (className: string | undefined, label: string, busyLabel: string) =>
    ({
        Default: (
            <button type="button" className={className}>
                {label}
            </button>
        ),
        Disabled: (
            <button type="button" className={className} disabled>
                {label}
            </button>
        ),
        Busy: (
            <button type="button" className={className} disabled aria-busy>
                {busyLabel}
            </button>
        ),
        'Long content': (
            <button type="button" className={className}>
                {LONG_LABEL}
            </button>
        ),
    }) satisfies Partial<Record<Column, ReactNode>>;

const CELLS: Record<Row, Partial<Record<Column, ReactNode>>> = {
    'Selector (closed)': {
        Default: <OrgSelector organization={orgs('directory', 'Initech')} onSwitch={noop} />,
        Disabled: <OrgSelector organization={orgs('config', 'Local organization')} />,
        'Long content': <OrgSelector organization={orgs('directory', LONG_LABEL)} onSwitch={noop} />,
    },
    'Selector (open)': {
        Default: <OrgSelector organization={orgs('directory', OPEN_SELECTOR_ORG)} onSwitch={noop} />,
    },
    'Primary button': button('primary', 'Start task', 'Starting…'),
    'Secondary button': button(undefined, 'Cancel', 'Saving…'),
    'Destructive button': button('danger', 'Remove task', 'Removing…'),
    'Text field': {
        Default: <Field name="Repository" />,
        Selected: <Field name="Repository, filled" value="bellows-ai/factory" />,
        Invalid: <Field name="Repository, invalid" value="factory" invalid />,
        Disabled: <Field name="Repository, disabled" value="bellows-ai/factory" disabled />,
        'Long content': <Field name="Repository, long" value={LONG_LABEL} />,
    },
    Textarea: {
        Default: <TextArea name="Task" />,
        Selected: <TextArea name="Task, filled" value="Fix the flaky login redirect." />,
        Invalid: <TextArea name="Task, invalid" value="" invalid />,
        Disabled: <TextArea name="Task, disabled" value="Fix the flaky login redirect." disabled />,
        'Long content': <TextArea name="Task, long" value={LONG_LABEL} />,
    },
    Checkbox: {
        Default: <Checkbox label="Publish a pull request" />,
        Selected: <Checkbox label="Publish a pull request" checked />,
        Disabled: <Checkbox label="Publish a pull request" disabled />,
        'Long content': <Checkbox label={LONG_LABEL} />,
    },
    Pill: {
        Default: (
            <>
                <span className="pill">claude-code</span>
                <span className="pill pill-done">
                    <Icon name="clock" size={14} />
                    Queued
                </span>
                <span className="pill pill-ok">
                    <span className="sidenav-dot sidenav-dot-running" aria-hidden="true" />
                    Running
                </span>
                <span className="pill pill-accent">
                    <Icon name="circle-dot" size={14} />
                    Needs review
                </span>
                <span className="pill pill-bad">
                    <Icon name="alert-circle" size={14} />
                    Failed
                </span>
                <span className="pill pill-warn">
                    <Icon name="alert-triangle" size={14} />
                    Unsaved
                </span>
                <span className="pill pill-done">
                    <Icon name="minus-circle" size={14} />
                    Stopped
                </span>
                <span className="pill pill-done">
                    <Icon name="check-circle" size={14} />
                    Done
                </span>
            </>
        ),
        'Long content': <span className="pill pill-accent">{LONG_LABEL}</span>,
    },
    'Filter chip': {
        Default: (
            <span className="inbox-chip">
                Status: Running
                <button type="button" aria-label="Remove filter: Status">
                    <Icon name="x" size={14} />
                </button>
            </span>
        ),
        'Long content': (
            <span className="inbox-chip">
                Repository: {LONG_LABEL}
                <button type="button" aria-label="Remove filter: Repository">
                    <Icon name="x" size={14} />
                </button>
            </span>
        ),
    },
    'Banner (warn)': {
        Default: <Banner tone="warn" icon="alert-triangle" title="Checkout in progress" />,
        'Long content': <Banner tone="warn" icon="alert-triangle" title={LONG_LABEL} />,
    },
    'Banner (bad)': {
        Default: <Banner tone="bad" icon="alert-circle" title="The run failed" />,
        'Long content': <Banner tone="bad" icon="alert-circle" title={LONG_LABEL} />,
    },
    'Banner (info)': {
        Default: <Banner tone="info" icon="info" title="Your draft was kept" />,
        'Long content': <Banner tone="info" icon="info" title={LONG_LABEL} />,
    },
    Dialog: {
        Default: <DialogPanel title="Remove “Fix login”?" />,
        Busy: <DialogPanel title="Remove “Fix login”?" busy />,
        'Long content': <DialogPanel title={LONG_LABEL} />,
    },
    'Disclosure (closed)': {
        Default: <Disclosure summary="Gate output" />,
        'Long content': <Disclosure summary={LONG_LABEL} />,
    },
    'Disclosure (open)': {
        Default: <Disclosure summary="Gate output" open />,
        'Long content': <Disclosure summary={LONG_LABEL} open />,
    },
    'Table row': {
        Default: <TableRow label="fix-login-redirect" />,
        Selected: <TableRow label="fix-login-redirect" selected />,
        'Long content': <TableRow label={LONG_LABEL} />,
    },
    'Row actions': {
        Default: <RowActionsCell name="Main ORG" />,
        Disabled: <RowActionsCell name="Main ORG" disabled />,
        'Long content': <RowActionsCell name={LONG_LABEL} />,
    },
    Avatar: {
        Default: (
            <>
                <img className="avatar" src="/avatar.png" alt="alice" />
                <span className="avatar avatar-fallback" aria-hidden="true">
                    A
                </span>
                <span className="avatar avatar-fallback" role="img" aria-label="Unknown author">
                    ?
                </span>
            </>
        ),
    },
    Kbd: {
        Default: <kbd>Ctrl Enter</kbd>,
        'Long content': <kbd>{LONG_LABEL}</kbd>,
    },
};

/**
 * Page-level primitives read at page width, not at one column's: their Default cell also covers
 * the state columns they have no entry for. A spanned column must be empty in CELLS.
 */
const SPANS: Partial<Record<Row, Partial<Record<Column, number>>>> = {
    'Banner (warn)': { Default: 5 },
    'Banner (bad)': { Default: 5 },
    'Banner (info)': { Default: 5 },
    Dialog: { Default: 4 },
};

/** The columns a row renders cells for: every column not covered by an earlier cell's span. */
const columnsOf = (row: Row): Column[] => {
    const shown: Column[] = [];
    let covered = 0;
    for (const column of COLUMNS) {
        if (covered > 0) {
            covered--;
            continue;
        }
        shown.push(column);
        covered = (SPANS[row]?.[column] ?? 1) - 1;
    }
    return shown;
};

function Specimen() {
    return (
        <main className="page">
            <PageHeader
                eyebrow="Design system"
                title="Component states"
                description="Every shared primitive in every state, from the app's own stylesheet."
            />
            <table className="specimen-grid">
                <thead>
                    <tr>
                        <th scope="col">Primitive</th>
                        {COLUMNS.map((column) => (
                            <th key={column} scope="col">
                                {column}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {ROWS.map((row) => (
                        <tr key={row}>
                            <th scope="row">{row}</th>
                            {columnsOf(row).map((column) => {
                                const cell = CELLS[row][column];
                                return cell === undefined ? (
                                    <td key={column} className="specimen-na" data-label={column}>
                                        —
                                    </td>
                                ) : (
                                    <td
                                        key={column}
                                        colSpan={SPANS[row]?.[column]}
                                        className={row === 'Selector (open)' ? 'specimen-open-slot' : undefined}
                                        data-label={column}
                                        data-cell={cellId(row, column)}
                                    >
                                        <div className="specimen-cell">{cell}</div>
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </main>
    );
}

createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
        <Specimen />
    </StrictMode>
);
