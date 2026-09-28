import type { Session } from '../api/useSession.js';
import { useSession } from '../api/useSession.js';
import { AccessTokensSection } from '../panels/AccessTokensPanel.js';
import { IdentityPanel } from '../panels/IdentityPanel.js';
import { TrackedOrgsPanel } from '../panels/TrackedOrgsPanel.js';
import { Icon } from '../components/Icon.js';
import { PageHeader } from '../components/PageHeader.js';
import { ADMIN_ROLE } from '@factory-ai/core';

/**
 * The account page's sections for one session: identity, then — in github mode — the tracked
 * organizations and the access tokens minted from here (#70). Sections stack as plain
 * `section.panel`s — the vocabulary every other page uses — so a new concern is one more block,
 * not a nav framework. Presentational, so the SSR suite drives it without a session fetch.
 *
 * Both token sections are hidden under `AUTH_MODE=none`: the hook ignores every credential there,
 * so a mint button would issue a token nothing honours. The org section is admin-gated, and a
 * member gets the sentence saying who manages it rather than a disabled editor. The tracked-
 * organizations section (issue 125) is github-mode only for the same reason: `none` has exactly one
 * local org and no sign-in choice to change. Open mode says so in an info banner (issue 284)
 * rather than leaving the page silently short.
 */
export function AccountSections({ session }: { session: Session }) {
    const github = session.mode === 'github';
    return (
        <>
            {github ? null : (
                <div className="banner-info">
                    <Icon name="info" size={24} />
                    <div>
                        <p className="banner-title">Not available with authentication off</p>
                        <p>
                            Access tokens and tracked organizations need GitHub sign-in. This deployment runs with{' '}
                            <code>AUTH_MODE=none</code>: every route is open to anyone who can reach it, so there is no
                            token to mint and no organization to choose.
                        </p>
                    </div>
                </div>
            )}
            <section className="panel">
                <IdentityPanel session={session} />
            </section>
            {github ? (
                <>
                    <TrackedOrgsPanel session={session} />
                    <AccessTokensSection scope="personal" />
                    {session.role === ADMIN_ROLE ? (
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

/**
 * The member's own account (#70). Reached from the app bar's user menu at `/account`, not the
 * sidenav: it is personal, not a section of the dashboard. `/settings/*` belongs to the
 * organization's settings tree (issue 150).
 */
export function AccountPage() {
    // Unreachable null: LoginGate only mounts the app once a session exists. The hook re-checks
    // on 401, so a session expiring while this page is open unmounts the tree at the gate.
    const { session } = useSession();
    if (!session) return null;
    return (
        <>
            <PageHeader
                title="Account"
                description={
                    session.mode === 'github'
                        ? `Signed in with GitHub as ${session.user.login}.`
                        : 'Signed in as the deployment\u2019s local user.'
                }
            />
            <AccountSections session={session} />
        </>
    );
}
