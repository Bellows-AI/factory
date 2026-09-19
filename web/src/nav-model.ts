import type { TaskTreeEntry } from './task-tree.js';

/**
 * The navigation model, and the only route array in the app.
 *
 * Extracted from SideNav so the mobile drawer (issue 160) renders the same model in compact mode
 * — a second array here would be a second place to forget a route. SideNav owns the desktop
 * rendering, the drawer the compact one; both hang their classes and `aria-current` marks off
 * what the router reports, never off this data.
 */

export interface NavItem {
    readonly to: string;
    readonly label: string;
    /** True for `/`, which would otherwise match every path below it. */
    readonly end?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
    { to: '/', label: 'Dashboard', end: true },
    { to: '/settings', label: 'Settings' },
    { to: '/tasks', label: 'Tasks' },
];

/** The Settings tree's sections, in the issue's order. Static — no data behind them. */
export const SETTINGS_SECTIONS: readonly NavItem[] = [
    { to: '/settings/organization', label: 'Organization' },
    { to: '/settings/workspace', label: 'Workspace' },
    { to: '/settings/repos', label: 'Repositories' },
    { to: '/settings/executors', label: 'Executors' },
];

/**
 * The tree's `aria-current` rule, shared by every renderer of `NAV_ITEMS` (issue 160 keeps the
 * drawer from forking it): a tree marks ONE address as the page — on a section page the parent
 * `/settings` link is open and lit but explicitly NOT the current page, so it says `false`
 * instead of claiming the marker; every other item lets the router decide.
 */
export function ariaCurrentFor(item: NavItem, pathname: string): 'page' | 'false' | undefined {
    if (item.to !== '/settings') return undefined;
    return pathname === '/settings' ? 'page' : 'false';
}

/** A navigation preview never renders more than this many rows, whatever the poll returned. */
export const MAX_PREVIEW = 5;

/** The head of a section's list — the rows a navigation column actually shows. */
export function preview(entries: readonly TaskTreeEntry[]): readonly TaskTreeEntry[] {
    return entries.slice(0, MAX_PREVIEW);
}

/**
 * A count as a sentence, for the drawer's task badges (issue 160): a bare number next to a
 * colored dot says nothing to a screen reader, so the kind travels with the number. Not a live
 * region — the counts are polled, and a polite announcement per poll is noise, not information.
 */
export function countLabel(kind: 'running' | 'review' | 'past', n: number): string {
    switch (kind) {
        case 'running':
            return n === 1 ? '1 running task' : `${n} running tasks`;
        case 'review':
            return n === 1 ? '1 task needs review' : `${n} tasks need review`;
        case 'past':
            return n === 1 ? '1 past task' : `${n} past tasks`;
    }
}
