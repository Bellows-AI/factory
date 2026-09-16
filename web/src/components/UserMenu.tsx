import { useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { signOut, type Session } from '../api/useSession.js';

/**
 * The account affordance in the topbar: avatar (or an initial chip when GitHub reports none, as
 * under AUTH_MODE=none), the login, and the way into /settings.
 *
 * A native `<details>` rather than state, so there is nothing to synchronize: the browser opens and
 * closes it, and a server-side render still carries the panel markup collapsed. The one behavior
 * state WOULD own is closing the panel when a link inside it navigates — the topbar survives
 * navigation, so without this the menu would still be open on the page it just led to.
 */
export function UserMenu({ session }: { session: Session }) {
    const ref = useRef<HTMLDetailsElement>(null);
    const close = () => ref.current?.removeAttribute('open');
    return (
        <details className="user-menu" ref={ref}>
            <summary className="user-menu-button" title={`${session.user.login} (${session.role})`}>
                {session.user.avatarUrl ? (
                    <img className="avatar" src={session.user.avatarUrl} alt="" width={24} height={24} />
                ) : (
                    <span className="avatar avatar-fallback" aria-hidden="true">
                        {session.user.login.slice(0, 1).toUpperCase()}
                    </span>
                )}
                <span className="user-menu-login">{session.user.login}</span>
            </summary>
            <div className="user-menu-panel">
                <NavLink to="/settings" onClick={close}>
                    Settings
                </NavLink>
                {/*
                    Under AUTH_MODE=none there is no session to end, so no item — a button that can
                    never work is a broken button. A fetch POST and not a <form>: the CSP bans
                    form navigation, and the server refuses GET for the same CSRF reason.
                */}
                {session.mode !== 'none' ? (
                    <button
                        type="button"
                        onClick={() => {
                            close();
                            void signOut();
                        }}
                    >
                        Sign out
                    </button>
                ) : null}
            </div>
        </details>
    );
}
