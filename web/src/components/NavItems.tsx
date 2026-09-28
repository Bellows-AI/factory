import { NavLink } from 'react-router-dom';
import { type PrimaryNavItem, SETTINGS_SECTIONS, ariaCurrentFor, countLabel } from '../nav-model.js';
import { Icon } from './Icon.js';

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

/** Nav glyphs are the 20px size (plan §1.4), not the 16px inline default. */
export const NAV_ICON_SIZE = 20;

/**
 * One top-level route link: glyph, label, and — when the caller hands one over — the count pill
 * (issue 274). The pill is decoration: it is `aria-hidden`, and the number travels in the link's name
 * as a sentence instead, because a bare "12" after "Tasks" says nothing to a screen reader. With
 * no count the text content names the link. The `aria-current` rule is the model's, never
 * re-derived here.
 */
export function NavItemLink({
    item,
    count = null,
    onNavigate,
}: {
    item: PrimaryNavItem;
    count?: number | null;
    onNavigate?: (() => void) | undefined;
}) {
    return (
        <NavLink
            to={item.to}
            end={item.end ?? false}
            className={({ isActive }) => (isActive ? 'sidenav-link is-active' : 'sidenav-link')}
            onClick={onNavigate}
            aria-current={ariaCurrentFor(item)}
            aria-label={count === null ? undefined : `${item.label}, ${countLabel('review', count)}`}
        >
            <Icon name={item.icon} size={NAV_ICON_SIZE} />
            {item.label}
            {count === null ? null : (
                <span className="sidenav-count" aria-hidden="true">
                    {count}
                </span>
            )}
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
                        end={section.end ?? false}
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
