import { NavLink } from 'react-router-dom';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { signOut, type Session } from '../api/useSession.js';

/**
 * The account affordance in the app bar: avatar (or an initial chip when GitHub reports none, as
 * under AUTH_MODE=none), the login, and the way into /account.
 *
 * A Headless UI `Menu`, so opening, closing, Escape and arrow-key navigation are the library's and
 * there is nothing to synchronize. The panel anchors below the button and closes itself when an
 * item is picked — the one behavior the old `<details>` owned by hand was closing on navigation,
 * since the app bar survives it and the menu would otherwise still be open on the page it led to.
 */
export function UserMenu({ session }: { session: Session }) {
    return (
        <Menu>
            <MenuButton className="user-menu-button" title={`${session.user.login} (${session.role})`}>
                {session.user.avatarUrl ? (
                    <img className="avatar" src={session.user.avatarUrl} alt="" width={24} height={24} />
                ) : (
                    <span className="avatar avatar-fallback" aria-hidden="true">
                        {session.user.login.slice(0, 1).toUpperCase()}
                    </span>
                )}
                <span className="user-menu-login">{session.user.login}</span>
            </MenuButton>
            <MenuItems anchor="bottom end" className="popover user-menu-panel">
                <MenuItem>
                    <NavLink to="/account" className="popover-option">
                        Account
                    </NavLink>
                </MenuItem>
                {/*
                    Under AUTH_MODE=none there is no session to end, so no item — a button that can
                    never work is a broken button. A fetch POST and not a <form>: the CSP bans
                    form navigation, and the server refuses GET for the same CSRF reason.
                */}
                {session.mode !== 'none' ? (
                    <MenuItem>
                        <button type="button" className="popover-option" onClick={() => void signOut()}>
                            Sign out
                        </button>
                    </MenuItem>
                ) : null}
            </MenuItems>
        </Menu>
    );
}
