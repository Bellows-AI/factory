import type { OrganizationMeta } from '@factory-ai/core';
import type { Session } from '../api/useSession.js';
import { OrgSelector } from './OrgSelector.js';
import { UserMenu } from './UserMenu.js';

/**
 * The global app bar — identity and navigation only, no page content and no `h1`. The
 * organization selector and the user menu are its whole desktop contents; the mobile
 * navigation trigger and brand render only once the responsive shell (slice A part 4) wires
 * `onMenuToggle`, so no do-nothing control ships before then.
 *
 * Telemetry chrome (repo coverage, "data as of", Refresh) lives in the dashboard's page
 * header, not here — this bar is identical on every page.
 */
export function AppBar({
    session,
    organization,
    onMenuToggle,
    menuExpanded,
}: {
    session: Session | null;
    /** Null only before the first stats payload; the selector waits rather than flashing empty. */
    organization: OrganizationMeta | null;
    /** Mobile navigation trigger — reserved for slice A part 4; nothing renders until it is wired. */
    onMenuToggle?: () => void;
    menuExpanded?: boolean;
}) {
    return (
        <header className="app-bar">
            {onMenuToggle ? (
                <div className="app-bar-mobile">
                    <button
                        type="button"
                        className="app-bar-trigger"
                        aria-expanded={menuExpanded ?? false}
                        aria-label="Toggle navigation"
                        onClick={onMenuToggle}
                    >
                        ☰
                    </button>
                    <span className="app-bar-brand">Factory</span>
                </div>
            ) : null}
            <div className="app-bar-actions">
                {organization ? (
                    <OrgSelector
                        organization={organization}
                        onSwitch={(orgId) => {
                            // The switch is a server-side session change; on success the reload
                            // makes every org-scoped read re-probe from scratch. A refusal
                            // (403/400 — the membership moved under the selector) leaves the
                            // page untouched: the select's value is bound to the payload, so
                            // the next poll renders it back on the org the session still holds.
                            void fetch('/api/auth/org', {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ orgId }),
                            })
                                .then((response) => {
                                    if (response.ok) window.location.reload();
                                })
                                .catch(() => {});
                        }}
                    />
                ) : null}
                {/* The corner account affordance. Until the session check answers there is nothing
                    to show — an empty chip would flash on every load. */}
                {session ? <UserMenu session={session} /> : null}
            </div>
        </header>
    );
}
