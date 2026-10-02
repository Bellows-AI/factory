import { Menu, MenuButton, MenuItem, MenuItems, MenuSeparator } from '@headlessui/react';
import { Fragment } from 'react';
import { useDownwardAnchor } from '../anchor.js';
import { Icon } from './Icon.js';

/**
 * A table row's actions, with a hierarchy (issue 411): the common action stays a visible button and
 * everything else collapses into one overflow menu, so the destructive action is never as inviting
 * as the routine one and four action words never widen the table past a phone.
 *
 * Table-agnostic on purpose — it renders a `div`, never a `td`, so the repos, workflows and members
 * tables can adopt it without re-deciding. A Headless UI `Menu`, the precedent `UserMenu` set:
 * opening, Escape and arrow-key navigation are the library's.
 */

/** One overflow entry. `danger` marks the destructive one; the menu sorts those last by itself. */
export interface RowAction {
    label: string;
    onSelect: () => void;
    danger?: boolean;
}

export function RowActions({
    rowName,
    primary,
    actions,
    disabled,
}: {
    /** The row's name — it, not the verb, is what makes the trigger's accessible name unique. */
    rowName: string;
    /** The one inline action, or null when the row has none (a default row has nothing to do). */
    primary: { label: string; onSelect: () => void } | null;
    /** The overflow entries. Empty renders no trigger at all — never an empty menu. */
    actions: readonly RowAction[];
    disabled: boolean;
}) {
    // Downward-only (issue 224), for the reason UserMenu documents: Headless UI's `anchor` always
    // adds a `flip` middleware, and a row menu that flips upward covers the row it belongs to.
    const { setReference, setFloating, floatingStyles } = useDownwardAnchor('end');
    // The destructive entries go last here rather than by the caller's convention: a caller that
    // listed one first would otherwise get it at the top of the menu, with no separator, silently.
    // Array.sort is stable, so everything else keeps the order it was given in.
    const ordered = [...actions].sort((a, b) => Number(Boolean(a.danger)) - Number(Boolean(b.danger)));
    const firstDanger = ordered.findIndex((action) => action.danger);
    return (
        <div className="row-actions">
            {primary ? (
                <button type="button" disabled={disabled} onClick={primary.onSelect}>
                    {primary.label}
                </button>
            ) : null}
            {actions.length > 0 ? (
                <Menu>
                    <MenuButton
                        ref={setReference}
                        className="row-actions-trigger"
                        disabled={disabled}
                        aria-label={`Actions for ${rowName}`}
                    >
                        {/* Decorative: the button itself carries the row's name. */}
                        <Icon name="more-horizontal" size={20} />
                    </MenuButton>
                    <MenuItems ref={setFloating} style={floatingStyles} portal className="popover">
                        {ordered.map((action, index) => (
                            <Fragment key={action.label}>
                                {/* The destructive answer is fenced off from the routine ones. */}
                                {index === firstDanger && index > 0 ? (
                                    <MenuSeparator className="popover-separator" />
                                ) : null}
                                <MenuItem>
                                    <button
                                        type="button"
                                        className={action.danger ? 'popover-option danger' : 'popover-option'}
                                        onClick={action.onSelect}
                                    >
                                        {action.label}
                                    </button>
                                </MenuItem>
                            </Fragment>
                        ))}
                    </MenuItems>
                </Menu>
            ) : null}
        </div>
    );
}
