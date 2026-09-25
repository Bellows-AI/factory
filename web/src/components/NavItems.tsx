import { NavLink } from 'react-router-dom';
import { type NavItem, SETTINGS_SECTIONS, ariaCurrentFor } from '../nav-model.js';

/**
 * The navigation LINKS, shared by the persistent column (SideNav) and the compact drawer
 * (MobileNavDialog).
 *
 * `nav-model.ts` is the one route array; this is the one rendering of it — the class expressions,
 * the `end` flag and the `aria-current` call lived twice before and were the pair most likely to
 * drift, because a class renamed in one column is invisible in the other until a screenshot.
 *
 * It is three link components rather than one list component on purpose: the two callers wrap
 * these links in DIFFERENT chrome, and that difference is a decision, not duplication. SideNav
 * nests the settings sections in a `sidenav-subitems` list inside the Settings row and pins the
 * New task link above its task preview; the drawer carries no preview at all, so its sections are
 * plain siblings and the New task link sits after the list, under the counts. Folding the chrome
 * into one component would mean a mode flag per difference and a different DOM for one of them.
 */

/** One top-level route link. The `aria-current` rule is the model's, never re-derived here. */
export function NavItemLink({
    item,
    pathname,
    onNavigate,
}: {
    item: NavItem;
    pathname: string;
    onNavigate?: (() => void) | undefined;
}) {
    return (
        <NavLink
            to={item.to}
            end={item.end ?? false}
            className={({ isActive }) => (isActive ? 'sidenav-link is-active' : 'sidenav-link')}
            onClick={onNavigate}
            aria-current={ariaCurrentFor(item, pathname)}
        >
            {item.label}
        </NavLink>
    );
}

/**
 * The Settings tree's rows, as bare `<li>`s so the caller owns the list they sit in. Rendered only
 * inside the settings area — that gating is the caller's, because it is what the caller's chrome
 * hangs off.
 */
export function SettingsSectionItems({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
    return (
        <>
            {SETTINGS_SECTIONS.map((section) => (
                <li key={section.to}>
                    <NavLink
                        to={section.to}
                        className={({ isActive }) => (isActive ? 'sidenav-sublink is-active' : 'sidenav-sublink')}
                        onClick={onNavigate}
                    >
                        {section.label}
                    </NavLink>
                </li>
            ))}
        </>
    );
}

/** The composer link. `end`, so a task detail route never lights it. */
export function NewTaskLink({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
    return (
        <NavLink
            to="/tasks/new"
            end
            className={({ isActive }) => (isActive ? 'sidenav-newtask is-active' : 'sidenav-newtask')}
            onClick={onNavigate}
        >
            + New task
        </NavLink>
    );
}
