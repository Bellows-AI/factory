import { NavLink } from 'react-router-dom';
import type { StatsPayload } from '../api/useStats.js';
import type { Session } from '../api/useSession.js';
import { switchOrg } from '../api/org.js';
import { OrgSelector } from './OrgSelector.js';
import { UserMenu } from './UserMenu.js';

/**
 * The global app bar (issue 160): chrome, and nothing but chrome.
 *
 * The desktop bar carries the organization selector and the user menu, aligned to the end — no
 * `h1`, no telemetry. The dashboard's figures describe the dashboard, so its repo coverage,
 * timestamp and Refresh live on the dashboard page; a heading would answer "where am I" with the
 * app's name instead of the page's, which is the routed page's job.
 *
 * The mobile bar (at most 900px, see the stylesheet) reveals the navigation trigger and the
 * Factory brand: the trigger's state is OWNED HERE IN THE SHELL — `navOpen`/`onOpenNav` are the
 * drawer's props arriving from AppShell, which renders the dialog the `aria-controls` names.
 * Until the first stats payload lands there is no selector: an empty control would flash, and a
 * placeholder would advertise a choice the payload has not confirmed.
 */
export function AppBar({
    meta,
    session,
    navOpen,
    onOpenNav,
}: {
    meta: StatsPayload['meta'] | null;
    session: Session | null;
    /** Mirrored onto the trigger as `aria-expanded` — the drawer is open or it is not. */
    navOpen: boolean;
    onOpenNav: () => void;
}) {
    return (
        <header className="appbar">
            <button
                type="button"
                className="appbar-trigger"
                aria-expanded={navOpen}
                aria-controls="mobile-nav"
                onClick={onOpenNav}
            >
                Open navigation
            </button>
            <NavLink to="/" className="appbar-brand">
                Factory
            </NavLink>
            <div className="appbar-actions">
                {meta ? (
                    <div className="appbar-org">
                        <OrgSelector organization={meta.organization} onSwitch={switchOrg} />
                    </div>
                ) : null}
                {/* The corner account affordance. Until the session check answers there is nothing
                    to show — an empty chip would flash on every load. */}
                {session ? <UserMenu session={session} /> : null}
            </div>
        </header>
    );
}
