import type { Session } from '../api/useSession.js';
import { KeyValues } from '../components/KeyValues.js';
import { taskTime } from '../format.js';

/**
 * The read-only identity section of the settings page, and its first consumer of the extended
 * `GET /api/auth/me` payload.
 *
 * Presentational on purpose: the page fetches the session, this renders it — the same split as every
 * panel under `panels/`, which is what lets the SSR suite drive it without a fetch to fake.
 *
 * `AUTH_MODE=none` attributes everything to a stand-in account whose login is unrepresentable as a
 * real GitHub login and whose numeric id is 0 — a value GitHub never issues. Neither fact may
 * render as GitHub data: no link, no avatar, no "0", and a sentence saying what the caller actually
 * is, because a page of dashes with no explanation reads as broken.
 */
export function IdentityPanel({ session }: { session: Session }) {
    const { user, role, membership, account, workspacePath, mode } = session;
    const local = mode === 'none' || user.githubUserId === 0;
    return (
        <div className="identity">
            <div className="identity-head">
                {user.avatarUrl ? (
                    <img className="avatar avatar-lg" src={user.avatarUrl} alt="" width={40} height={40} />
                ) : (
                    <span className="avatar avatar-lg avatar-fallback" aria-hidden="true">
                        {user.login.slice(0, 1).toUpperCase()}
                    </span>
                )}
                <div>
                    <p className="identity-name">{user.name ?? user.login}</p>
                    {local ? (
                        <p className="muted">
                            This deployment has authentication off (<code>AUTH_MODE=none</code>); everything is
                            attributed to a local stand-in account.
                        </p>
                    ) : (
                        <p className="muted">{role === 'admin' ? 'Administrator' : 'Member'} of this organization</p>
                    )}
                </div>
            </div>
            <KeyValues
                pairs={[
                    [
                        'Login',
                        local ? (
                            <code>{user.login}</code>
                        ) : (
                            <a href={`https://github.com/${user.login}`}>{user.login}</a>
                        ),
                    ],
                    ['Name', user.name ?? '—'],
                    // A 0 is the stand-in marker, not an id; the dash says "no GitHub id here" and
                    // the sentence above explains why.
                    ['GitHub id', local ? '—' : String(user.githubUserId)],
                    ['Role', role],
                    ['Invited', taskTime(membership.invitedAt)],
                    ['Member since', taskTime(membership.claimedAt)],
                    ['Account created', taskTime(account.createdAt)],
                    ['Last sign-in', taskTime(account.lastLoginAt)],
                    ['Workspace', workspacePath === null ? '—' : <code>{workspacePath}</code>],
                ]}
            />
        </div>
    );
}
