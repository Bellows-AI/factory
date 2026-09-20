import { useSession } from '../api/useSession.js';
import { AccessTokensSection } from '../panels/AccessTokensPanel.js';
import { IdentityPanel } from '../panels/IdentityPanel.js';
import { TrackedOrgsPanel } from '../panels/TrackedOrgsPanel.js';

/**
 * The member's own account: identity, then the access tokens minted from here (#70). Sections
 * stack as plain `section.panel`s — the vocabulary every other page uses — so a new concern is one
 * more block, not a nav framework.
 *
 * Reached from the app bar's user menu at `/account`, not the sidenav: it is personal, not a
 * section of the dashboard. `/settings/*` belongs to the organization's settings tree (issue 150).
 *
 * Both token sections are hidden under `AUTH_MODE=none`: the hook ignores every credential there,
 * so a mint button would issue a token nothing honours. The org section is admin-gated, and a
 * member gets the sentence saying who manages it rather than a disabled editor. The tracked-
 * organizations section (issue 125) is github-mode only for the same reason: `none` has exactly one
 * local org and no sign-in choice to change.
 */
export function AccountPage() {
    // Unreachable null: LoginGate only mounts the app once a session exists. The hook re-checks
    // on 401, so a session expiring while this page is open unmounts the tree at the gate.
    const { session } = useSession();
    if (!session) return null;
    const github = session.mode === 'github';
    return (
        <>
            <section className="panel">
                <div className="panel-head">
                    <h2>Account</h2>
                </div>
                <IdentityPanel session={session} />
            </section>
            {github ? (
                <>
                    <TrackedOrgsPanel session={session} />
                    <AccessTokensSection scope="personal" />
                    {session.role === 'admin' ? (
                        <AccessTokensSection scope="org" />
                    ) : (
                        <section className="panel">
                            <div className="panel-head">
                                <h2>Organization access tokens</h2>
                            </div>
                            <p className="muted">Organization tokens are minted by an administrator.</p>
                        </section>
                    )}
                </>
            ) : null}
        </>
    );
}
