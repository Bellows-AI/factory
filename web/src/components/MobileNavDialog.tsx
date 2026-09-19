import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { NavLink, useLocation } from 'react-router-dom';
import type { Job } from '../api/useJobs.js';
import type { StatsPayload } from '../api/useStats.js';
import { switchOrg } from '../api/org.js';
import { NAV_ITEMS, SETTINGS_SECTIONS, countLabel } from '../nav-model.js';
import { taskSections } from '../task-tree.js';
import { OrgSelector } from './OrgSelector.js';

/** What the drawer calls itself, and what its way out says — asserted by name in e2e. */
export const DIALOG_LABEL = 'Navigation';
export const CLOSE_LABEL = 'Close navigation';

/**
 * The mobile navigation drawer (issue 160).
 *
 * The same model as SideNav, in compact mode — `NAV_ITEMS` and `SETTINGS_SECTIONS` from the one
 * nav-model module, never a second route array. What it deliberately does NOT carry is the task
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
    tasks,
    meta,
}: {
    open: boolean;
    onClose: () => void;
    onNavigate: () => void;
    /** The same prop SideNav gets — the shell's one poll, never a second one. Null off `/tasks*`. */
    tasks: readonly Job[] | null;
    meta: StatsPayload['meta'] | null;
}) {
    // The Settings tree renders only inside the settings area, the same gating SideNav applies —
    // navigation for the section you are in, not a second table of contents.
    const { pathname } = useLocation();
    const onSettings = pathname === '/settings' || pathname.startsWith('/settings/');
    const sections = taskSections(tasks);

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
                    <ul className="sidenav-items">
                        {NAV_ITEMS.map((item) => (
                            <li key={item.to}>
                                <NavLink
                                    to={item.to}
                                    end={item.end ?? false}
                                    className={({ isActive }) => (isActive ? 'sidenav-link is-active' : 'sidenav-link')}
                                    onClick={onNavigate}
                                    aria-current={
                                        item.to === '/settings'
                                            ? pathname === '/settings'
                                                ? 'page'
                                                : 'false'
                                            : undefined
                                    }
                                >
                                    {item.label}
                                </NavLink>
                            </li>
                        ))}
                        {onSettings
                            ? SETTINGS_SECTIONS.map((section) => (
                                  <li key={section.to}>
                                      <NavLink
                                          to={section.to}
                                          className={({ isActive }) =>
                                              isActive ? 'sidenav-sublink is-active' : 'sidenav-sublink'
                                          }
                                          onClick={onNavigate}
                                      >
                                          {section.label}
                                      </NavLink>
                                  </li>
                              ))
                            : null}
                    </ul>
                    {tasks !== null ? (
                        <>
                            {/* Counts as sentences, not bare numbers beside dots — and not a live
                                region: the poll would announce itself on every refresh. */}
                            <p className="mobile-nav-count">{countLabel('running', sections.running.length)}</p>
                            <p className="mobile-nav-count">{countLabel('review', sections.review.length)}</p>
                            <p className="mobile-nav-count">{countLabel('past', sections.past.length)}</p>
                            <NavLink
                                to="/tasks"
                                end
                                className={({ isActive }) =>
                                    isActive ? 'sidenav-newtask is-active' : 'sidenav-newtask'
                                }
                                onClick={onNavigate}
                            >
                                + New task
                            </NavLink>
                        </>
                    ) : null}
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
