import { NavLink } from 'react-router-dom';

/**
 * The left navigation.
 *
 * `NavLink` rather than an anchor so the current page is marked without this component knowing what
 * the current page is. `aria-current="page"` comes from the router; the class is what the stylesheet
 * hangs off, and both are set from the same source so they cannot disagree.
 */

interface Item {
    readonly to: string;
    readonly label: string;
    /** True for `/`, which would otherwise match every path below it. */
    readonly end?: boolean;
}

const ITEMS: readonly Item[] = [
    { to: '/', label: 'Dashboard', end: true },
    { to: '/workspace', label: 'Workspace' },
    { to: '/tasks', label: 'Tasks' },
];

/*
 * No "n cloning" badge, deliberately.
 *
 * It would have to live here, above the router outlet, so the count would need a second poll of
 * `/api/workspace` running on every page including the dashboard — a request every two seconds for
 * a number nobody is looking at. The Workspace page shows the same thing where it is relevant.
 */
export function SideNav() {
    return (
        <nav className="sidenav" aria-label="Sections">
            <div className="sidenav-brand">Factory</div>
            <ul className="sidenav-items">
                {ITEMS.map((item) => (
                    <li key={item.to}>
                        <NavLink
                            to={item.to}
                            end={item.end ?? false}
                            className={({ isActive }) => (isActive ? 'sidenav-link is-active' : 'sidenav-link')}
                        >
                            {item.label}
                        </NavLink>
                    </li>
                ))}
            </ul>
        </nav>
    );
}
