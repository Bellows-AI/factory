import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useLocation } from 'react-router-dom';
import type { TaskNavigation } from '../api/useTasks.js';
import type { StatsPayload } from '../api/useStats.js';
import { switchOrg } from '../api/org.js';
import { NAV_ITEMS, countLabel } from '../nav-model.js';
import { NavItemLink, NewTaskLink, SettingsSectionItems } from './NavItems.js';
import { OrgSelector } from './OrgSelector.js';

/** What the drawer calls itself, and what its way out says — asserted by name in e2e. */
export const DIALOG_LABEL = 'Navigation';
export const CLOSE_LABEL = 'Close navigation';

/**
 * The mobile navigation drawer (issue 160).
 *
 * The same model as SideNav, in compact mode — `NAV_ITEMS` from the one nav-model module, rendered
 * by the one set of link components (`NavItems.tsx`), never a second route array and never a
 * second spelling of a nav class. What it deliberately does NOT carry is the task
 * tree's rows: a drawer is navigation, not a preview, so it renders the task COUNTS as sentences
 * and the New task link, and nothing that would scroll the route you are looking for off a
 * 360px screen. Focus trapping, Escape, the backdrop and focus restoration are Headless UI's —
 * the same reliance as the repo and executor pickers.
 *
 * `onClose` is the dialog's own contract (Escape, backdrop, the close button all land there);
 * `onNavigate` fires when a link is activated, which AppShell closes the drawer with.
 */
export function MobileNavDialog({
    open,
    onClose,
    onNavigate,
    navigation,
    meta,
}: {
    open: boolean;
    onClose: () => void;
    onNavigate: () => void;
    /** The same prop SideNav gets — the shell's one poll, never a second one. Null off `/tasks*`. */
    navigation: TaskNavigation | null;
    meta: StatsPayload['meta'] | null;
}) {
    // The Settings tree renders only inside the settings area, the same gating SideNav applies —
    // navigation for the section you are in, not a second table of contents.
    const { pathname } = useLocation();
    const onSettings = pathname === '/settings' || pathname.startsWith('/settings/');

    return (
        <Dialog open={open} onClose={onClose} className="dialog-layer">
            <DialogBackdrop className="dialog-backdrop" />
            <div className="dialog-position">
                <DialogPanel className="mobile-nav" id="mobile-nav">
                    <div className="mobile-nav-head">
                        <DialogTitle as="p" className="mobile-nav-title">
                            {DIALOG_LABEL}
                        </DialogTitle>
                        <button type="button" className="mobile-nav-close" onClick={onClose}>
                            {CLOSE_LABEL}
                        </button>
                    </div>
                    {/* The drawer is the compact shell's ONLY navigation landmark: the persistent
                        column is display:none here, so the list carries the Primary label. */}
                    <nav aria-label="Primary">
                        <ul className="sidenav-items">
                            {NAV_ITEMS.map((item) => (
                                <li key={item.to}>
                                    <NavItemLink item={item} pathname={pathname} onNavigate={onNavigate} />
                                </li>
                            ))}
                            {onSettings ? <SettingsSectionItems onNavigate={onNavigate} /> : null}
                        </ul>
                        {navigation !== null ? (
                            <>
                                {/* Counts as sentences, not bare numbers beside dots — and not a
                                    live region: the poll would announce itself on every refresh.
                                    They and the New task link sit inside the landmark, as the
                                    sidenav's preview does. */}
                                <p className="mobile-nav-count">{countLabel('running', navigation.counts.running)}</p>
                                <p className="mobile-nav-count">{countLabel('review', navigation.counts.review)}</p>
                                <p className="mobile-nav-count">{countLabel('past', navigation.counts.past)}</p>
                                <NewTaskLink onNavigate={onNavigate} />
                            </>
                        ) : null}
                    </nav>
                    {meta ? (
                        <div className="mobile-nav-org">
                            <OrgSelector organization={meta.organization} onSwitch={switchOrg} />
                        </div>
                    ) : null}
                </DialogPanel>
            </div>
        </Dialog>
    );
}
