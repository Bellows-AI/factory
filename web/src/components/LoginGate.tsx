import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useSession } from '../api/useSession.js';
import { PublicPageHeader } from './PublicPageHeader.js';
import { ThemeSelector } from './ThemeSelector.js';

/** What the callback redirects back with when it could not sign somebody in. */
const REASONS: Record<string, string> = {
    denied: 'Sign-in was cancelled.',
    state: 'That sign-in link expired. Try again.',
    github: 'GitHub could not be reached. Try again.',
    install:
        'This dashboard is organized by GitHub App installation, and none were found for your account. Install the App, then sign in again.',
    install_cancelled: 'You returned without installing the App. Install it, then sign in again.',
};

/**
 * Stands between the dashboard and anyone who has not signed in.
 *
 * The gate is in the client rather than a redirect on the server, because the SPA's own document is
 * deliberately served without authentication: if index.html 401'd there would be nothing left to
 * render a sign-in button in.
 */
export function LoginGate({ children }: { children: ReactNode }) {
    const { session, loading, error } = useSession();
    const { pathname } = useLocation();

    // Nothing at all until the first answer. A sign-in screen that flashes for 80ms on every load
    // for somebody who is already signed in reads as a bug.
    if (loading) return null;
    // The onboarding screen (issue 125) steps past the gate in both of its states: a first sign-in's
    // caller holds no session at all — the pending cookie is what the page stands on — and a
    // reselect arrives with a live session that must not be required to pass a gate it is about
    // to re-answer. Either way the page answers for itself.
    if (pathname === '/onboarding') return <>{children}</>;
    if (session) return <>{children}</>;

    const params = new URLSearchParams(window.location.search);
    const reason = params.get('auth_error');
    const returnTo = `${window.location.pathname}${window.location.hash}`;

    return (
        <>
            {/* The shared public header (issue 187), with the appearance control (issue 188) in
                its actions cell — the placement the interim header row held before this
                absorbed it. */}
            <PublicPageHeader actions={<ThemeSelector />} />
            <main className="login-gate">
                <h1>Factory Stats</h1>
                {error ? (
                    <p className="login-error">{error}</p>
                ) : (
                    <p>Sign in with GitHub. The organizations you can see are the App installations.</p>
                )}
                {reason ? <p className="login-error">{REASONS[reason] ?? 'Sign-in failed.'}</p> : null}
                {/*
                    A plain link, and it has to be. A `fetch` cannot follow a 302 to github.com, and a
                    <form method="get"> is blocked outright by `form-action 'none'` in the CSP — which is
                    worth keeping, so this stays an anchor.
                */}
                <a className="login-button" href={`/api/auth/github?returnTo=${encodeURIComponent(returnTo)}`}>
                    Sign in with GitHub
                </a>
            </main>
        </>
    );
}
