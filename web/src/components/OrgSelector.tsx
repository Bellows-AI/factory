import type { OrganizationMeta } from '@factory-ai/core';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';

/**
 * The organization these figures belong to — and, since #99, the one the caller can switch to.
 *
 * `mode` unlocks the control: 'config' (AUTH_MODE=none's single local org) keeps it disabled,
 * 'directory' — the caller is a member of the orgs the server listed — turns it on. `available`
 * drives the options in both modes, so there is no mode-specific branch in the markup; in config
 * mode the server sends a one-element list equal to `current`.
 *
 * The switch is a full page reload, not a state update: every org-scoped cache in the client is
 * keyed to nothing, so the honest move is to re-probe everything rather than stale-proof each hook.
 */
export function OrgSelector({
    organization,
    onSwitch,
}: {
    organization: OrganizationMeta;
    /** Absent only where nothing can switch — the AUTH_MODE=none single-org shape. */
    onSwitch?: (orgId: string) => void;
}) {
    // Keyed on `mode`, never on `available.length < 2`. A directory user who belongs to one
    // organization today can be granted a second tomorrow with no deploy; disabling by list length
    // would be right today by accident and silently wrong then.
    const locked = organization.mode === 'config';

    // WHY it is inactive, not merely that it is. A disabled control with no explanation reads as a
    // bug or as a permissions problem; this says it is a property of the deployment.
    const reason = locked
        ? 'This deployment reports on one organization. Sign in with GitHub to see the installations you belong to.'
        : 'Switch organization';

    return (
        // The title sits on the wrapper, not on the button: a disabled control receives no
        // mouse events in Chrome or Firefox, so a title on the element itself never shows.
        <div className="org-selector" title={reason}>
            <span className="muted">org</span>
            <Listbox value={organization.current.id} onChange={(id) => onSwitch?.(id)} disabled={locked}>
                <ListboxButton className="org-select" aria-label={`Organization: ${organization.current.name}`}>
                    {organization.current.name}
                </ListboxButton>
                <ListboxOptions anchor="bottom start" className="popover">
                    {organization.available.map((org) => (
                        <ListboxOption key={org.id} value={org.id} className="popover-option">
                            {org.name}
                        </ListboxOption>
                    ))}
                </ListboxOptions>
            </Listbox>
        </div>
    );
}
