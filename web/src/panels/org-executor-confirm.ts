/**
 * The org executor row's two ownership-changing actions (issue 411) and the copy that guards them.
 * Both are org-wide and irreversible for every other member — a delete takes the shared profile and
 * its configuration away from everyone, a demote moves it into the clicking admin's personal list —
 * so neither may fire from a row click, and the confirmation must name the row, so a mis-aimed
 * click is visible before it lands.
 *
 * Pure, so the whole decidable surface is testable with no DOM; the dialog is only its face.
 */

export type OrgRowAction = 'delete' | 'demote';

/**
 * The confirmations the dialog serves: the org row's two actions, and the personal profile's
 * Remove (issue 440), which shares the dialog but not the org write path.
 */
export type ConfirmAction = OrgRowAction | 'remove';

export interface ConfirmRequest {
    action: ConfirmAction;
    /** The profile's name, as the table renders it. */
    name: string;
}

/** The org section's pending action: the subset whose write goes through `confirmedWrite`. */
export interface OrgRowConfirm extends ConfirmRequest {
    action: OrgRowAction;
}

/** Curly quotes, matching TaskRemoveDialog's title. */
export function confirmTitle({ action, name }: ConfirmRequest): string {
    if (action === 'remove') return `Remove “${name}”?`;
    return action === 'delete' ? `Delete “${name}”?` : `Make “${name}” personal?`;
}

export function confirmBody({ action, name }: ConfirmRequest): string {
    if (action === 'remove') {
        return `“${name}” is a personal executor. It is removed from your workspace and its configuration is permanently deleted. This cannot be undone.`;
    }
    return action === 'delete'
        ? `“${name}” is an organization executor. It is removed for every member of this organization and its ` +
              'configuration is permanently deleted. This cannot be undone.'
        : `“${name}” moves into your personal executors and stops being available to every ` +
              'other member of this organization.';
}

export function confirmLabel({ action }: ConfirmRequest): string {
    if (action === 'remove') return 'Remove profile';
    return action === 'delete' ? 'Delete profile' : 'Make personal';
}

export function confirmBusyLabel({ action }: ConfirmRequest): string {
    if (action === 'remove') return 'Removing…';
    return action === 'delete' ? 'Deleting…' : 'Moving…';
}

/**
 * The confirmed write, and the only call site of the two routes: nothing else in the section may
 * reach them, which is what keeps the gate from being bypassed by a later edit.
 */
export function confirmedWrite(
    action: OrgRowAction,
    row: { id: string },
    api: { remove: (id: string) => Promise<string | null>; demote: (id: string) => Promise<string | null> }
): Promise<string | null> {
    return action === 'delete' ? api.remove(row.id) : api.demote(row.id);
}
