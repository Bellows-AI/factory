import type { TaskNavigation, TaskSummary } from './api/useTasks.js';
import type { IconName } from './components/Icon.js';

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

/** A top-level item: the section tree's rows carry no glyph, the primary column's do (issue 274). */
export interface PrimaryNavItem extends NavItem {
    readonly icon: IconName;
}

/** Observe → act → configure, in that order — the report, then the work, then the configuration. */
export const NAV_ITEMS: readonly PrimaryNavItem[] = [
    { to: '/', label: 'Dashboard', end: true, icon: 'home' },
    { to: '/tasks', label: 'Tasks', icon: 'list' },
    { to: '/settings', label: 'Settings', icon: 'settings' },
];

/**
 * The Settings tree's sections, in the issue's order. Static — no data behind them. Overview is
 * the `/settings` page itself, end-matched so it never stays lit on a section page (issue 274).
 */
export const SETTINGS_SECTIONS: readonly NavItem[] = [
    { to: '/settings', label: 'Overview', end: true },
    { to: '/settings/organization', label: 'Organization' },
    { to: '/settings/workspace', label: 'Workspace' },
    { to: '/settings/repos', label: 'Repositories' },
    { to: '/settings/executors', label: 'Executors' },
];

/**
 * The tree's `aria-current` rule, shared by every renderer of `NAV_ITEMS` (issue 160 keeps the
 * drawer from forking it): a tree marks ONE address as the page. The parent `/settings` link is
 * open and lit anywhere in the settings area but is never the current page — on `/settings` the
 * Overview child owns the marker (issue 274) — so it says `false` instead of claiming it; every other
 * item lets the router decide.
 */
export function ariaCurrentFor(item: NavItem): 'false' | undefined {
    return item.to === '/settings' ? 'false' : undefined;
}

/**
 * The count a primary item carries as a pill (issue 274): the review queue — the member's turn — on
 * Tasks, and nothing anywhere else. Null when there is nothing to show: no navigation (off
 * `/tasks*`, where the poll does not run) or an empty queue.
 */
export function navCount(item: NavItem, navigation: TaskNavigation | null): number | null {
    if (item.to !== '/tasks' || navigation === null || navigation.counts.review === 0) return null;
    return navigation.counts.review;
}

/** A navigation preview never renders more than this many rows, whatever the poll returned. */
export const MAX_PREVIEW = 5;

/** The head of a section's list — the rows a navigation column actually shows. */
export function preview(entries: readonly TaskSummary[]): readonly TaskSummary[] {
    return entries.slice(0, MAX_PREVIEW);
}

/**
 * A count as a sentence, for the drawer's task badges (issue 160) and the Tasks pill's name
 * (issue 274): a bare number next to a colored dot says nothing to a screen reader, so the kind
 * travels with the number. Not a live
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
