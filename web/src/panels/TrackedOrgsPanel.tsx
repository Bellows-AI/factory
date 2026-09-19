import type { Session } from '../api/useSession.js';

/**
 * The account page's view of the sign-in choice (issue 125): the organizations this deployment
 * tracks, and the round trip that changes the choice.
 *
 * There is no in-place editor, and that is not an omission: the GitHub user token that enumerated
 * the installations is discarded at sign-in, so the installation list cannot be re-asked outside
 * an OAuth round trip. The link restarts the sign-in with `?reselect=1`, which reopens the
 * selection screen pre-checked with the stored choice.
 */
export function TrackedOrgsPanel({ session }: { session: Session }) {
    const orgs = session.organizations;
    return (
        <section className="panel">
            <div className="panel-head">
                <h2>Tracked organizations</h2>
            </div>
            <p className="muted">
                {orgs.length === 0
                    ? 'No organizations are tracked yet.'
                    : `Tracking ${orgs.length} organization${orgs.length === 1 ? '' : 's'}: ${orgs
                          .map((org) => org.name)
                          .join(', ')}.`}
            </p>
            <p className="muted">
                Changing the choice re-runs the GitHub sign-in and asks again — the installation list is GitHub's
                answer, not something this dashboard can list on its own.
            </p>
            {/* An anchor, not a button, for the same reason LoginGate is: the flow starts with a
                redirect to github.com, which a fetch cannot follow and the CSP's form-action
                forbids posting to. */}
            <a className="login-button" href="/api/auth/github?returnTo=%2Faccount&reselect=1">
                Change what you track
            </a>
        </section>
    );
}
